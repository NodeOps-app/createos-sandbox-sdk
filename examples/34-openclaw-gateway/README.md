# 34 — OpenClaw Gateway in Sandbox

Install the [OpenClaw](https://github.com/openclaw/openclaw) AI-assistant gateway
inside an FC sandbox, expose it via HTTP ingress, and verify the Control UI and
OpenAI-compatible `/v1/models` endpoint are reachable through the public preview URL.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_API_KEY and optionally OPENCLAW_GATEWAY_TOKEN
bun index.ts
```

Bun auto-loads `.env` from the working directory. `CREATEOS_SANDBOX_API_KEY` is the only required
key; `OPENCLAW_GATEWAY_TOKEN` defaults to a built-in demo value if omitted.

Expected run time: ~90 seconds (install 372 packages + gateway startup).

## What it does

1. Creates a `s-1vcpu-2gb` FC sandbox with `ingress_enabled: true`.
2. Verifies the sandbox ships Node 24 (OpenClaw requires 22.19+).
3. Installs `openclaw@latest` globally via npm (streamed live so progress is visible).
4. Writes a minimal `~/.openclaw/openclaw.json` configuring the gateway token and
   LAN bind so the ingress proxy can reach port 18789.
5. Starts the OpenClaw gateway in foreground mode via `nohup setsid` (no systemd in
   FC; `;` before `nohup` prevents `runCommand` from holding the stdout pipe).
6. Waits for port 18789 to accept connections with `sandbox.waitForPortReady()`.
7. Probes `/` and `/v1/models` from inside the sandbox as a sanity check.
8. Polls the public preview URL from the host until an HTTP 200 is received.
9. Destroys the sandbox in the `finally` block.

## FC primitives exercised

| Primitive                   | SDK call                                              |
| --------------------------- | ----------------------------------------------------- |
| Sandbox create with ingress | `fc.createSandbox({ ingress_enabled: true })`         |
| Env injection               | `createSandbox({ envs: { OPENCLAW_GATEWAY_TOKEN } })` |
| Buffered command            | `sandbox.runCommand("bash", ["-lc", script])`         |
| Streaming command           | `sandbox.streamCommand("bash", ["-lc", script])`      |
| Port readiness poll         | `sandbox.waitForPortReady(18789)`                     |
| Public preview URL          | `sandbox.previewUrl(18789)`                           |
| Cleanup                     | `sandbox.destroy()`                                   |

## Versions captured at build time

See `versions.txt`.
