# 20 — Google ADK agent with createos-sandbox sandbox tools

A [Google Agent Development Kit](https://google.github.io/adk-docs/) (ADK)
agent runs on the host in Python; its tools execute inside a createos-sandbox microVM. The
agent reasons over a small coding task and drives it entirely through the
sandbox: it writes a Python script, runs it, and reads the result back — each
step is an ADK tool call that hits the createos-sandbox HTTP API.

This is the Python analogue of example 06 (OpenAI Agents SDK, TypeScript) and
shows the same pattern in a second agent framework.

## Run

```sh
cp .env.example .env  # or rely on the symlinked ../.env

# One-time: create the host Python venv (no host node-deps are touched).
python3 -m venv .venv
.venv/bin/pip install google-adk litellm

bun index.ts
```

bun auto-loads `.env`. Required vars: `CREATEOS_SANDBOX_API_KEY`, the LLM proxy trio
`OPENAI_API_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`, and optionally
`CREATEOS_SANDBOX_BASE_URL` (defaults to the production control plane). See `.env.example`.

## What it does

1. `index.ts` creates one `devbox:1` sandbox with `createos-sandbox-sdk` and owns
   its lifecycle.
2. It spawns `adk_agent.py` as a child process, passing the sandbox id and the
   createos-sandbox + LLM credentials via environment variables.
3. `adk_agent.py` builds a Google ADK `Agent` whose three tools call the createos-sandbox
   HTTP API directly:
   - `write_file` → `PUT /v1/sandboxes/{id}/files` (upload a script)
   - `run_command` → `POST /v1/sandboxes/{id}/exec` (run it)
   - `read_file` → `GET /v1/sandboxes/{id}/files` (read the output back)
4. The agent is asked to compute a value, told never to compute it itself, and
   driven by an LLM reached through LiteLLM over an OpenAI-compatible proxy.
5. The host prints the full tool-call trace (function call + response per step)
   and the agent's final, sandbox-grounded answer.
6. `index.ts` destroys the sandbox in a `finally` block. The Python child never
   tears it down — only the host does.

## Architecture — why the split

ADK is a Python framework, but these examples are bun/TypeScript entry points.
The thin `index.ts` owns the createos-sandbox sandbox (create → spawn driver → destroy),
mirroring examples 13/14/15 where a TS entry sequences Python payload files.
The ADK driver runs on the host (not inside the sandbox) so the agent's tools
treat the sandbox as a remote execution target reached over the createos-sandbox HTTP API
with the same `CREATEOS_SANDBOX_API_KEY` — exactly how a production agent would.

The LLM defaults in ADK target Google Gemini. This example points ADK at the
OpenAI-compatible proxy instead via `LiteLlm(model="openai/<model>", api_base,
api_key)`, so no Google API key is needed.

## createos-sandbox primitives exercised

| primitive                      | API call                                             |
| ------------------------------ | ---------------------------------------------------- |
| Create an isolated microVM     | `client.createSandbox({ shape, rootfs })` (index.ts) |
| Upload a script (agent tool)   | `PUT /v1/sandboxes/{id}/files` (adk_agent.py)        |
| Run a command (agent tool)     | `POST /v1/sandboxes/{id}/exec` (adk_agent.py)        |
| Download a result (agent tool) | `GET /v1/sandboxes/{id}/files` (adk_agent.py)        |
| Tear down                      | `sandbox.destroy()` (index.ts)                       |

## Versions captured at build time

See `versions.txt`.
