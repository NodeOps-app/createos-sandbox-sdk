# 09 — Claude Code CLI in an FC Sandbox

Installs the `@anthropic-ai/claude-code` CLI inside a fresh FC sandbox and
uses `claude -p` (print mode) to run a coding task: write and execute a Python
script that generates Fibonacci numbers and identifies which are prime.

## What it does

1. Creates an FC sandbox (`devbox:1`, 1 vCPU / 1 GB)
2. Installs `@anthropic-ai/claude-code` via npm inside the sandbox (`--prefix /usr/local`)
3. Creates a non-root user (`sandboxuser`) — required because Claude Code blocks
   `--dangerously-skip-permissions` when running as root, and devbox:1 runs as root
4. Streams the coding task through `claude -p --dangerously-skip-permissions`
5. Destroys the sandbox

## Prerequisites

A valid `FC_API_KEY` in `../.env`. The env file at that path is read
automatically at startup via `loadParentEnvFallback()`.

## Setup

```sh
# ensure ../.env has a valid FC_API_KEY
# then run from this directory:
bun index.ts
```

Or copy `.env.example` to `.env` and fill in the values, then:

```sh
bun index.ts
```

## Environment variables

| Variable               | Required | Description                                                    |
| ---------------------- | -------- | -------------------------------------------------------------- |
| `FC_API_KEY`           | yes      | FC control-plane API key                                       |
| `ANTHROPIC_API_KEY`    | yes\*    | Anthropic API key                                              |
| `ANTHROPIC_AUTH_TOKEN` | yes\*    | Alternative to `ANTHROPIC_API_KEY` (custom proxy)              |
| `ANTHROPIC_BASE_URL`   | no       | Custom Anthropic proxy URL                                     |
| `ANTHROPIC_MODEL`      | no       | Model to use inside the sandbox (default: `claude-sonnet-4-6`) |

\* Either `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is required.

## Why the non-root user workaround?

`devbox:1` sandboxes run all commands as `root`. Claude Code v2+ refuses
`--dangerously-skip-permissions` under root for security reasons. The script
creates a `sandboxuser` via `useradd` and runs the coding task via `su`, which
makes Claude Code accept the flag.
