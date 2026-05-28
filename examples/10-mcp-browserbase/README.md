# 10 — Browserbase MCP via FC Sandbox

Runs the `@browserbasehq/mcp` server inside an FC microVM sandbox, exposes it
over FC ingress, then drives it from the host using Claude (Anthropic SDK) as
the AI agent. Claude calls Browserbase tools (screenshot, navigate, interact)
through the MCP connection.

## Architecture

```
Host (index.ts)                         FC Sandbox
──────────────────                      ──────────────────────
Claude (Anthropic SDK)                  @browserbasehq/mcp server
  ↓ beta.messages (mcp_servers)         (node, port 8080, 0.0.0.0)
Anthropic API ──────────────────────→  ingress URL → Browserbase cloud
```

Anthropic's API fetches tool definitions and calls tools server-side via the
FC ingress URL. The sandbox environment variable `BROWSERBASE_API_KEY` and
`BROWSERBASE_PROJECT_ID` are passed at creation time so the MCP server can
authenticate with Browserbase cloud.

## Prerequisites

- FC API key (`FC_API_KEY`)
- Anthropic API key (`ANTHROPIC_API_KEY`)
- Browserbase API key (`BROWSERBASE_API_KEY`)
- Browserbase project ID (`BROWSERBASE_PROJECT_ID`)

## Run

```sh
cp .env.example .env  # fill in values
bun index.ts
```

bun auto-loads `.env` from the example dir. The script also fills missing
values from `../.env`.

## FC primitives exercised

| primitive | SDK call |
| --- | --- |
| Create an isolated microVM with HTTP ingress | `client.createSandbox({ ingress_enabled: true })` |
| Pass credentials to sandbox processes | `createSandbox({ envs: { ... } })` |
| Install packages inside sandbox | `sandbox.runCommand("bash", ["-lc", "npm install -g ..."])` |
| Start background services | `sandbox.runCommand("bash", ["-lc", "nohup setsid ... &"])` |
| Poll for readiness | `sandbox.runCommand("bash", ["-lc", "curl -sf ..."])` |
| Get public ingress URL | `sandbox.previewUrl(8080)` |
| Tear down | `sandbox.destroy()` |

## Versions captured at build time

See `versions.txt`.
