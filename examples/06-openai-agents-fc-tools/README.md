# 06 — OpenAI Agents SDK with createos-sandbox Tools

An OpenAI Agents SDK agent uses a createos-sandbox sandbox as its isolated filesystem and
code-execution workspace. The host process exposes createos-sandbox-backed tools for listing
files, running Python, and reading generated artifacts.

## Run

```sh
cp .env.example .env  # fill in values
bun index.ts
```

bun auto-loads `.env` from the example dir. The script also fills missing
values from `../.env`, which is convenient when sharing credentials across
these examples. `CREATEOS_SANDBOX_BASE_URL` and `CREATEOS_SANDBOX_API_KEY` are the standard inputs
`createos-sandbox-sdk` consumes. Set `OPENAI_API_KEY` and `OPENAI_MODEL` to use a
live OpenAI model; `OPENAI_API_URL` or `OPENAI_BASE_URL` can point at an
OpenAI-compatible endpoint. Without an OpenAI key, the example uses a
deterministic local model through the Agents SDK runner so the createos-sandbox tool path
still runs end-to-end.

## What it does

1. Creates a `devbox:1` sandbox on createos-sandbox.
2. Seeds a small workspace with `README.md` and `numbers.txt`.
3. Starts an OpenAI Agents SDK `Agent` with createos-sandbox-backed function tools.
4. The agent lists the workspace before computing.
5. The agent uploads and runs Python inside the sandbox with `runCommand`.
6. The Python task writes `answer.json` in the sandbox workspace.
7. The agent reads `answer.json` back before producing its final answer.
8. The sandbox is destroyed in a `finally` block.

## createos-sandbox primitives exercised

| primitive                             | SDK call                 |
| ------------------------------------- | ------------------------ |
| Create an isolated microVM workspace  | `client.createSandbox()` |
| Push files into the workspace         | `sandbox.files.upload()` |
| Run buffered commands for agent tools | `sandbox.runCommand()`   |
| Tear down                             | `sandbox.destroy()`      |

## Versions captured at build time

See `versions.txt`.
