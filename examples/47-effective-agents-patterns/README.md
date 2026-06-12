# 47 — Effective Agent Patterns

Run three foundational LLM agent patterns — prompt-chaining, routing, and
parallelization — using the Vercel AI SDK inside an FC sandbox, with an
OpenAI-compatible model proxy.

## Run

```sh
cp .env.example .env
# fill in FC_BASE_URL, FC_API_KEY, OPENAI_API_KEY, OPENAI_API_URL, OPENAI_MODEL
source .env
bun index.ts
```

## What it does

1. Creates one sandbox (`s-4vcpu-4gb`, `devbox:1`) with the LLM credentials
   bridged in as environment variables.
2. Uploads `agent-patterns.ts` into the sandbox via `files.upload`.
3. Installs `ai` and `@ai-sdk/openai` inside the sandbox with `bun add`.
4. Runs `agent-patterns.ts` with `runCommand`; captures and prints all output.
5. Destroys the sandbox in the `finally` block.

### Pattern 1 — Prompt chaining

Two sequential LLM calls where the output of step 1 feeds step 2.
Step 1 summarises microVMs; step 2 extracts the single key insight from that
summary.

### Pattern 2 — Routing

A classifier call dispatches each user input to one of three specialist
prompts (technical / business / creative) based on the input's intent.

### Pattern 3 — Parallelization

Three independent LLM prompts run concurrently with `Promise.all`; each asks
about a different dimension of microVM benefits (security, performance,
reliability).

## FC primitives exercised

| Primitive | SDK call |
| --- | --- |
| Create sandbox | `Sandbox.create({ shape, rootfs, envs })` |
| Upload file | `sandbox.files.upload(path, content)` |
| Run buffered command | `sandbox.runCommand(cmd, args, { timeoutMs })` |
| Shell helper | `sandbox.sh(script, { label, timeoutMs })` |
| Destroy sandbox | `sandbox.destroy()` |

## Versions captured at build time

See `versions.txt`.
