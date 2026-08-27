# 54 - Managed Process Lifecycle

Start and control long-running pipe processes and interactive PTYs through the
managed process API.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a `devbox:1` sandbox.
2. Starts a pipe process that waits for stdin.
3. Lists and inspects managed processes.
4. Writes stdin, closes stdin, waits for the complete process tree, and replays
   stdout/stderr output.
5. Starts a PTY shell, runs a command, resizes the terminal, runs another
   command, exits, and replays the combined PTY output.
6. Starts a long-running process and terminates its process tree.
7. Destroys the sandbox in a `finally` block.

## createos-sandbox primitives exercised

| Primitive                     | SDK call                            |
| ----------------------------- | ----------------------------------- |
| Create sandbox                | `Sandbox.create(...)`               |
| Start managed process or PTY  | `sandbox.processes.create(...)`     |
| List and inspect processes    | `sandbox.processes.list/get(...)`   |
| Replay process output         | `sandbox.processes.connect(...)`    |
| Send stdin                    | `sandbox.processes.input(...)`      |
| Close pipe stdin              | `sandbox.processes.closeStdin(...)` |
| Resize PTY                    | `sandbox.processes.resize(...)`     |
| Wait for process tree         | `sandbox.processes.wait(...)`       |
| Terminate process tree        | `sandbox.processes.delete(...)`     |
| Tear the sandbox down         | `sandbox.destroy()`                 |
