# 46 — Mastra agent in a sandbox

Runs a [Mastra](https://mastra.ai) TypeScript AI agent entirely inside an FC
microVM. The sandbox installs bun, the Mastra framework, and the `@ai-sdk/openai`
provider; the agent script is uploaded from the host and invoked with a single
prompt. The LLM provider is the OpenAI-compatible gateway supplied via
`OPENAI_API_KEY` / `OPENAI_API_URL` / `OPENAI_MODEL`.

## Run

```sh
cp .env.example .env        # populate FC_BASE_URL, FC_API_KEY, OPENAI_* vars
# or: the shared examples/.env is already symlinked / present
bun index.ts
```

bun auto-loads `.env` from the current directory.

## What it does

1. Creates an `s-4vcpu-4gb` sandbox with `devbox:1` rootfs; injects
   `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` as sandbox env vars.
2. Installs bun inside the sandbox via the official install script.
3. Scaffolds a minimal bun project and installs `@mastra/core`, `@ai-sdk/openai`,
   and `ai` as dependencies inside the sandbox.
4. Uploads `agent.ts` (a small Mastra `Agent` that calls `generate()`) to the
   sandbox and runs it with `bun run agent.ts`.
5. Streams the agent's stdout response to the host console, then destroys the
   sandbox.

## FC primitives exercised

| Primitive                  | SDK call                                                     |
| -------------------------- | ------------------------------------------------------------ |
| Sandbox create with envs   | `fc.createSandbox({ shape, rootfs, envs: { … } })`          |
| Buffered shell command      | `sandbox.sh(script, { label, timeoutMs })`                  |
| Buffered command with args  | `sandbox.runCommand(cmd, args, { timeoutMs })`               |
| File upload                 | `sandbox.files.upload(path, content)`                       |
| Cleanup                     | `sandbox.destroy()`                                         |

## Versions captured at build time

See `versions.txt`.
