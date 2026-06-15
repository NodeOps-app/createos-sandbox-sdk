# 15 — ACP Hello World

Spawns a minimal [Agent Client Protocol](https://agentclientprotocol.com/)
agent inside a createos-sandbox sandbox and drives a single prompt turn over JSON-RPC 2.0.
Shows `files.upload` (payload injection), `runCommand` (executing the driver),
and the ACP baseline handshake — `initialize` → `session/new` → `session/prompt`.

## Run

```sh
cp .env.example .env  # fill in values
bun index.ts
```

bun auto-loads `.env`. Only `CREATEOS_SANDBOX_API_KEY` is required — the ACP agent is a
self-contained Python echo implementation, so no LLM provider key is needed.

## What it does

1. Creates a `devbox:1` createos-sandbox sandbox.
2. Uploads two Python scripts: `acp_agent.py` (a ~100-line ACP echo agent
   that speaks JSON-RPC 2.0 over stdio) and `acp_driver.py` (an in-sandbox
   driver that spawns the agent as a subprocess and walks one prompt turn).
3. Runs the driver with `runCommand`. The driver performs `initialize`,
   `session/new`, then `session/prompt` with the host-supplied text. It
   logs every wire frame to stderr, then prints a structured JSON summary
   on stdout containing the agent's reply and the final `stopReason`.
4. Destroys the sandbox.

The host prints both streams so the ACP traffic is visible end-to-end.

## createos-sandbox primitives exercised

| primitive                     | SDK call                               |
| ----------------------------- | -------------------------------------- |
| Create an isolated microVM    | `Sandbox.create({ shape, rootfs })`    |
| Inject payload scripts        | `sandbox.files.upload(path, bytes)`    |
| Run the in-sandbox ACP driver | `sandbox.runCommand("python3", [...])` |
| Tear down                     | `sandbox.destroy()`                    |

## Why an echo agent

ACP is transport-agnostic JSON-RPC 2.0. A 100-line echo agent demonstrates
the full handshake (capability negotiation, session creation, streamed
`session/update` notifications, terminal `stopReason`) without pulling in an
LLM dependency. Swap `acp_agent.py` for any ACP-compatible agent
(e.g. Gemini CLI, OpenCode) and the driver works unchanged — only the prompt
content and provider key change.

## Versions captured at build time

See `versions.txt`.
