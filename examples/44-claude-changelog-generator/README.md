# 44 — Claude Changelog Generator

Clone a public git repo inside an FC sandbox, run the commit log through
the Claude Messages API (via `@anthropic-ai/sdk`), and download the
generated `CHANGELOG.md` to your terminal.

## Run

```sh
cp .env.example .env
# fill in FC_API_KEY, FCSPAWN_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL
source .env
bun index.ts
```

## What it does

1. Creates an `s-4vcpu-4gb` sandbox with `devbox:1` rootfs and the
   `ANTHROPIC_*` credentials injected as sandbox env vars.
2. Shallow-clones a small public GitHub repo (`--depth=50`) into `/repo`.
3. Captures the last 40 commits with `git log --oneline --no-merges`.
4. Installs `@anthropic-ai/sdk` inside the sandbox via `npm install -g`.
5. Runs a generator script that calls `client.messages.create` with the
   commit log and a system prompt requesting Keep a Changelog format.
6. Downloads `/tmp/CHANGELOG.md` from the sandbox and prints it to stdout.
7. Destroys the sandbox in the `finally` block.

## FC primitives exercised

| Primitive | SDK call |
| --- | --- |
| Create sandbox with env vars | `fc.createSandbox({ envs: { ANTHROPIC_* } })` |
| Run a shell command | `sandbox.sh(script, { label, timeoutMs })` |
| Buffered command execution | `sandbox.runCommand(cmd, args, { timeoutMs })` |
| Upload a file to sandbox | `sandbox.files.upload(path, content)` |
| Download a file from sandbox | `sandbox.files.download(path)` |
| Destroy sandbox | `sandbox.destroy()` |

## Versions captured at build time

See `versions.txt`.
