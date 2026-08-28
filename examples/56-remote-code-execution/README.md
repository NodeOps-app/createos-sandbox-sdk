# 56 - Remote Code Execution

Run Go, Python, and JavaScript submissions inside a sandbox and collect
Hackerrank-style results: stdin, stdout, stderr, exit code, and duration.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a `devbox:1` sandbox.
2. Uploads one Go, one Python, and one JavaScript source file.
3. Executes each submission through `runCommand`.
4. Passes stdin directly through the exec request.
5. Captures stdout, stderr, exit code, and execution duration.
6. Prints a structured result per language.
7. Destroys the sandbox in a `finally` block.

## createos-sandbox primitives exercised

| Primitive             | SDK call                    |
| --------------------- | --------------------------- |
| Create sandbox        | `Sandbox.create(...)`       |
| Upload source files   | `sandbox.files.upload(...)` |
| Run submitted code    | `sandbox.runCommand(...)`   |
| Pass stdin to process | `runCommand(..., { stdin })` |
| Tear the sandbox down | `sandbox.destroy()`         |
