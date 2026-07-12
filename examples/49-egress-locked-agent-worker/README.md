# 49 — Egress-locked Managed Agent worker

Runs the same self-hosted [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
worker as example 36, plus the security boundary every self-hosted-sandbox
guide (Vercel, Cloudflare, E2B) leads with: the agent's tool calls run in a
sandbox that can reach a **co-located private service** but **cannot exfiltrate
to the public internet**.

The trick is ordering. Provision with open egress so you can install the worker
CLI, start an internal-only service on loopback, then `setEgress` to an
allowlist of exactly one host — `api.anthropic.com`. Rules apply live, in-kernel,
with no restart. From that point the worker can still talk to Anthropic and the
agent can still reach your internal service, but any outbound call to an unlisted
host is dropped and cannot be bypassed from inside the sandbox.

This is the network-boundary variant. For the isolation topologies without the
egress lock, see `36-self-hosted-agent-worker` (one persistent worker) and
`37-self-hosted-sandbox-per-session` (a fresh sandbox per session).

## Setup — credentials

You need createos-sandbox creds (`CREATEOS_SANDBOX_BASE_URL`, `CREATEOS_SANDBOX_API_KEY`) in `.env`, and three Anthropic
values in `.env.ant`. Both files are gitignored — never commit them. `bun`
auto-loads `.env`; the example reads `.env.ant` itself (kept separate so the
shared `.env`'s internal Anthropic gateway vars can't misroute the real API).

### 1. Organization API key (with Managed Agents beta)

[Console → API keys](https://platform.claude.com/settings/keys) → **Create key**.
Managed Agents is a beta your organization must be enrolled in — verify access:

```sh
curl -sS https://api.anthropic.com/v1/environments \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01"
```

`200` with a JSON list = enrolled. `403`/`404` = request beta access first.
→ `ANTHROPIC_API_KEY=sk-ant-api03-…`

### 2. A self-hosted environment

[Console → Workspace → Environments](https://platform.claude.com/workspaces/default/environments)
→ **New → Self-hosted**. Or via API:

```sh
curl -sS https://api.anthropic.com/v1/environments \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d '{"name":"self-hosted","config":{"type":"self_hosted"}}'
```

Copy the returned `id`. → `ANTHROPIC_ENVIRONMENT_ID=env_…`

### 3. Environment key — NOT a normal API key

Open the environment in the Console → **Generate environment key**. This is
**Console-only — there is no API for it.** It is an OAuth-style token with prefix
**`sk-ant-oat01-…`**, which the worker uses with Bearer auth. A regular
`sk-ant-api03-…` API key here fails with `401 Invalid bearer token`.
→ `ANTHROPIC_ENVIRONMENT_KEY=sk-ant-oat01-…`

The environment key is the **only** credential that enters the sandbox; the
organization key never leaves the host.

### Final `.env.ant`

```sh
# .env.ant  (gitignored — never commit)
ANTHROPIC_API_KEY=sk-ant-api03-…       # org key, Managed Agents beta (host only)
ANTHROPIC_ENVIRONMENT_ID=env_…         # the self_hosted environment
ANTHROPIC_ENVIRONMENT_KEY=sk-ant-oat01-…   # Console > Generate environment key
```

## Run

```sh
cp .env.example .env  # fill in createos-sandbox creds (or symlink ../.env)
bun index.ts
```

## What it does

1. Creates one sandbox with **open egress** — needed to fetch the worker CLI.
2. Installs the `ant` CLI.
3. Starts an internal-only HTTP service on `127.0.0.1:8899` (a stand-in for your
   private API or DB), serving a record that never leaves your environment.
4. **Locks egress to `["api.anthropic.com"]`** with `sandbox.setEgress(…)` — from
   here the sandbox can reach only Anthropic and loopback.
5. Starts `ant beta:worker poll` in the background and binds a Managed Agent
   session to the `self_hosted` environment.
6. Streams the session. The agent runs one bash tool call that curls the private
   service (**succeeds**) and curls a public host (**blocked**), and `tee`s the
   result to `/workspace/report.txt`.
7. Downloads `report.txt` and reads back `sandbox.getEgress()` to prove both the
   reach-private and no-exfil properties, and that the allowlist is enforced.

## What you'll see

```
      ── /workspace/report.txt ──
      ## private internal service (expect a JSON record):
      {"service":"internal-inventory","sku":"ACME-42","stock":128,"note":"reachable only from inside your environment"}
      ## public internet exfil attempt (expect blocked):
      BLOCKED by egress (curl exit 35)
      ── enforced egress allowlist ── ["api.anthropic.com"]
```

The private service returned its record; the public host was dropped in-kernel.
DNS still resolves under the lock — only the connection is filtered — so the
block is a silent connection failure, not a name-resolution error.

## createos-sandbox primitives exercised

| primitive                                | SDK call                                              |
| ---------------------------------------- | ----------------------------------------------------- |
| create the execution boundary            | `Sandbox.create({ shape, rootfs, envs })`             |
| inject the environment key               | `envs` on create (read by `ant` from the environment) |
| install worker + start private service   | `sandbox.runCommand("bash", […])` + `nohup setsid`    |
| lock outbound to an allowlist            | `sandbox.setEgress(["api.anthropic.com"])`            |
| read back the enforced allowlist         | `sandbox.getEgress()`                                 |
| read tool output back out of the sandbox | `sandbox.files.download("/workspace/report.txt")`     |
| teardown                                 | `sandbox.destroy()`                                   |

Egress rules also take `host:port`, `*.host`, and `cidr` forms — see the Egress
REST reference. There is no denylist token: to block one destination you list
every destination you *do* want.

## See also

- `36-self-hosted-agent-worker` — the same worker without the egress lock.
- `37-self-hosted-sandbox-per-session` — a fresh sandbox per session.
- The `createos-sandbox` Claude Code plugin solves a different problem: it
  offloads work off *your* machine into a sandbox from inside Claude Code. The
  examples here are the programmatic path, for agents you host yourself.

## Versions captured at build time

See `versions.txt`.
