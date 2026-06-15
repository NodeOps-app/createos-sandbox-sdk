# 45 — Claude agent GitHub wiki Q&A

Clone a public GitHub repo into an FC sandbox and let a Claude agent
explore the file tree to answer concrete questions about the codebase.
The agent uses `read_file` and `list_dir` tools backed by
`sandbox.runCommand` so it can introspect any path without extra installs.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_BASE_URL, CREATEOS_SANDBOX_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a `s-4vcpu-4gb` sandbox running `devbox:1`.
2. Clones `bun-community/create-templates` with `--depth=1` (< 2 MB).
3. Builds a top-level file tree snapshot (`find` depth 2) as orientation context.
4. Asks two questions; for each, runs a Claude tool-use agent loop:
   - Seed the conversation with the tree snapshot and the question.
   - Claude calls `read_file` / `list_dir` tools to explore the clone.
   - `sandbox.runCommand` executes each tool call inside the microVM.
   - Loop until `stop_reason !== "tool_use"`.
   - Q1: list and describe every template directory at the root.
   - Q2: find and summarise the main entry-point in the `hono` template.
5. Prints both answers to stdout and destroys the sandbox.

## FC primitives exercised

| primitive           | SDK call                                        |
| ------------------- | ----------------------------------------------- |
| Sandbox create      | `fc.createSandbox({ shape, rootfs })`           |
| Buffered command    | `sandbox.runCommand("sh", ["-c", …])`           |
| Cleanup (required)  | `sandbox.destroy()`                             |

## Versions captured at build time

See `versions.txt`.
