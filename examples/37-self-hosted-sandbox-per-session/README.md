# 37 — Self-hosted Managed Agent, one microVM per session

Runs a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
where Anthropic keeps the orchestration but each agent **session executes in its
own fresh FC microVM**. The host runs a control-plane-only work poller; for every
claimed session it spawns a sandbox, runs the worker inside it, and destroys the
sandbox when the session finishes. True per-session isolation — the same model
the Modal / Daytona / Vercel self-hosted guides use, with FC as the sandbox.

This is the per-session-spawn topology. For a single always-on worker that
handles every session in one VM, see `36-self-hosted-agent-worker`.

## Setup — credentials

You need FC creds (`FC_BASE_URL`, `FC_API_KEY`) in `.env`, and three Anthropic
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
**`sk-ant-oat01-…`**, used with Bearer auth by both the host poller and the
per-session sandbox. A regular `sk-ant-api03-…` API key here fails with
`401 Invalid bearer token`.
→ `ANTHROPIC_ENVIRONMENT_KEY=sk-ant-oat01-…`

The organization key stays on the host (used only to create the agent and
sessions); only the environment key reaches the sandboxes.

### Final `.env.ant`

```sh
# .env.ant  (gitignored — never commit)
ANTHROPIC_API_KEY=sk-ant-api03-…       # org key, Managed Agents beta (host only)
ANTHROPIC_ENVIRONMENT_ID=env_…         # the self_hosted environment
ANTHROPIC_ENVIRONMENT_KEY=sk-ant-oat01-…   # Console > Generate environment key
```

## Run

```sh
cp .env.example .env  # fill in FC creds (or symlink ../.env)
bun index.ts
```

## What it does

1. Creates a Managed Agent and two sessions on the `self_hosted` environment,
   sending each a prompt (which starts a run and enqueues a work item).
2. Runs `work.poller({ drain: true })` on the host — control-plane only; it
   claims each work item with the environment key.
3. For each claimed session: spawns a fresh FC microVM, installs `ant`, and runs
   `ant beta:worker run`, which attaches to that exact session, executes the
   agent's tool calls in-VM, posts results back, and exits on idle.
4. Downloads `/workspace/report.txt` from the per-session VM to prove the work
   ran inside FC, then destroys the VM.

## FC primitives exercised

| primitive                                 | SDK call                                                |
| ----------------------------------------- | ------------------------------------------------------- |
| one sandbox per claimed session           | `Sandbox.create({ shape, rootfs, envs })`               |
| forward the claimed work item into the VM | `envs: { ANTHROPIC_SESSION_ID, ANTHROPIC_WORK_ID, … }`  |
| run the per-session worker                | `sandbox.runCommand("bash", ["ant beta:worker run …"])` |
| read tool output back out of the VM       | `sandbox.files.download("/workspace/report.txt")`       |
| per-session teardown                      | `sandbox.destroy()`                                     |

## Versions captured at build time

See `versions.txt`.
