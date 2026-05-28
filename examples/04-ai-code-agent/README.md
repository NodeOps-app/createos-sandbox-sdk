# 04 — AI Code Agent

An AI agent (Claude) uses an FC sandbox as its code-execution environment.

The TypeScript process drives Claude via `tool_use`. When Claude decides to
write code, `run_code` is called — which uploads the script to the sandbox
and runs it with `runCommand`. The output is fed back to Claude until it
reaches `end_turn`.

The `fcctl` path skips the LLM entirely: it uploads a pre-written Python
script and executes it directly, demonstrating the same sandbox primitives.

## Prerequisites

- `fcctl` on `$PATH`, authenticated (`fcctl whoami`)
- `ANTHROPIC_API_KEY` set (sdk path only)

## Run

```sh
# no LLM key required
make fcctl

# requires ANTHROPIC_API_KEY
bun sdk.ts

# both
make all
```
