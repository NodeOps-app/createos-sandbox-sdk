# 36 — Self-hosted Managed Agent worker (one FC microVM)

Runs a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
where Anthropic keeps the orchestration but **tool execution happens inside an
FC microVM you control**. One long-lived sandbox runs an always-on environment
worker that claims every session assigned to the environment and executes the
agent's tool calls locally — agent code, files, and network egress never leave
FC.

This is the always-on, single-worker topology. For one fresh microVM per
session, see `37-self-hosted-sandbox-per-session`.

## Setup — credentials

You need FC creds (`CREATEOS_SANDBOX_BASE_URL`, `CREATEOS_SANDBOX_API_KEY`) in `.env`, and three Anthropic
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
cp .env.example .env  # fill in FC creds (or symlink ../.env)
bun index.ts
```

## What it does

1. Creates one FC microVM — the self-hosted execution boundary.
2. Installs the `ant` CLI and starts `ant beta:worker poll` in the background
   (claims sessions, runs an in-process tool runner for each).
3. Creates a Managed Agent and a session bound to the `self_hosted` environment.
4. Streams the session: agent reasoning and tool calls print live; the tool
   calls actually run inside the microVM.
5. Downloads `/workspace/report.txt` straight from the microVM to prove the work
   executed inside FC (the file contains the guest's `uname -a`).

## FC primitives exercised

| primitive                           | SDK call                                              |
| ----------------------------------- | ----------------------------------------------------- |
| create the execution boundary       | `Sandbox.create({ shape, rootfs, envs })`             |
| inject the environment key          | `envs` on create (read by `ant` from the environment) |
| install + daemonize the worker      | `sandbox.runCommand("bash", […])` + `nohup setsid`    |
| read tool output back out of the VM | `sandbox.files.download("/workspace/report.txt")`     |
| teardown                            | `sandbox.destroy()`                                   |

The worker itself is the `ant` CLI; the SDK also ships an in-process
`EnvironmentWorker` (`@anthropic-ai/sdk/helpers/beta/environments`) if you prefer
to run the tool loop in TypeScript instead of shelling out to `ant`.

## Versions captured at build time

See `versions.txt`.
