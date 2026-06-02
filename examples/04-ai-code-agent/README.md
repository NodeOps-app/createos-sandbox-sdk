# 04 — AI Code Agent

Claude uses an FC sandbox as its code-execution environment. The TypeScript
process drives Claude through a `tool_use` loop: Claude emits Python via a
`run_code` tool, this process uploads and runs it in the microVM with
`runCommand`, feeds the output back, and repeats until Claude stops requesting
tools. The canonical "LLM with a code sandbox" pattern.

## Run

Set the environment variables below (or copy `.env.example` to `.env` and fill
it in), then from this directory:

```sh
bun index.ts
```

## Environment variables

| Variable            | Required | Description                                       |
| ------------------- | -------- | ------------------------------------------------- |
| `FC_BASE_URL`       | yes      | Your fc-spawn control-plane URL                   |
| `FC_API_KEY`        | yes      | FC control-plane API key                          |
| `ANTHROPIC_API_KEY` | yes      | Anthropic API key for the Claude agent loop       |
| `ANTHROPIC_MODEL`   | no       | Override the model (default: `claude-sonnet-4-6`) |
