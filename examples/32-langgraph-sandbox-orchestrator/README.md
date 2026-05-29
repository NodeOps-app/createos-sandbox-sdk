# 32 — LangGraph Sandbox Orchestrator

A LangGraph graph running on the host uses fc-sdk as its tool layer:
each graph node is an FC sandbox operation — create, upload and run code,
read output, summarise — driven by an OpenAI LLM.

## Run

```sh
cp .env.example .env
# fill in FC_API_KEY and OPENAI_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. The script also reads
`../.env` as a fallback, which is convenient when credentials are shared
across examples.

## What it does

1. Bridges `FCSPAWN_URL` to `FC_BASE_URL` so the SDK finds the control plane.
2. Defines a four-node LangGraph `StateGraph`: `create_sandbox` →
   `generate_code` → `run_in_sandbox` → `summarise`.
3. `create_sandbox` — calls `fc.createSandbox()` and seeds a workspace directory.
4. `generate_code` — sends the task to OpenAI chat completions; the model
   writes Python code targeting the sandbox workspace path.
5. `run_in_sandbox` — uploads the script with `sandbox.files.upload()`,
   runs it with `sandbox.runCommand("python3", […])`, and reads back
   `output.txt` to verify the result.
6. `summarise` — sends the task + output to the LLM for a short summary.
7. A conditional edge routes errors directly to `END`, bypassing the
   summarise node.
8. The `finally` block calls `sandbox.destroy()` regardless of outcome.

## FC primitives exercised

| primitive | SDK call |
| --- | --- |
| Create sandbox | `fc.createSandbox({ shape, rootfs })` |
| Run buffered command | `sandbox.runCommand("python3", […], { timeoutMs })` |
| Upload file to sandbox | `sandbox.files.upload(path, content)` |
| Destroy sandbox | `sandbox.destroy()` |

## Versions captured at build time

See `versions.txt`.
