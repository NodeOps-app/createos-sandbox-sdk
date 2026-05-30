# 33 — Codex CLI in Sandbox

Installs the OpenAI Codex CLI inside an FC sandbox, configures it against a custom
OpenAI-compatible provider, then drives a coding task non-interactively with
`codex exec`. The generated Python file is downloaded and its output verified.

## Run

```sh
cp .env.example .env
# fill in FC_API_KEY, FC_BASE_URL, OPENAI_API_KEY, OPENAI_API_URL, OPENAI_MODEL
bun index.ts
```

bun auto-loads `.env` from this directory.

## What it does

1. Creates an FC sandbox (`s-2vcpu-2gb`, `devbox:1`) with `OPENAI_API_KEY` injected.
2. Installs Node.js 22 (via NodeSource) and `@openai/codex` globally inside the sandbox.
3. Writes `~/.codex/config.toml` pointing Codex at the custom OpenAI-compatible gateway,
   with `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` for headless
   operation.
4. Pipes a coding task to `codex exec --ephemeral --skip-git-repo-check` (non-interactive
   mode); Codex writes `fizzbuzz.py` to `/root/work/` and runs it to confirm correctness.
5. Downloads `/root/work/fizzbuzz.py` via `sandbox.files.download()` and prints the source.
6. Runs `python3 /root/work/fizzbuzz.py` inside the sandbox as end-to-end proof.
7. Destroys the sandbox in a `finally` block.

## FC primitives exercised

| Primitive                             | SDK call                                                        |
| ------------------------------------- | --------------------------------------------------------------- |
| Sandbox create with env injection     | `fc.createSandbox({ shape, rootfs, envs: { OPENAI_API_KEY } })` |
| Buffered command (install, configure) | `sandbox.runCommand("bash", ["-lc", …], { timeoutMs })`         |
| File upload (config + task prompt)    | `sandbox.files.upload(path, content)`                           |
| File download (generated code)        | `sandbox.files.download(path)`                                  |
| Cleanup                               | `sandbox.destroy()`                                             |

## Versions captured at build time

See `versions.txt`.
