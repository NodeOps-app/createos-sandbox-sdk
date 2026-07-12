# 50 — Sandbox as an agent tool (one sandbox per session)

Give a **cloud-hosted** Claude Managed Agent a `run_command` tool backed by a
createos-sandbox sandbox, and keep **one sandbox for the whole session** so state
survives between the agent's tool calls.

This is the **inverse** of examples 36 / 37 / 49. There, the agent's own bash ran
*inside* a sandbox (a `self_hosted` environment, with a worker polling
Anthropic's work queue). Here Anthropic hosts the agent loop, and the sandbox is
a discrete **tool** the agent reaches for:

```
Claude Managed Agent (Anthropic cloud)
        │  agent.custom_tool_use  { command: "…" }
        ▼
your orchestrator (holds the createos-sandbox API key)
        │  sandbox.runCommand("bash", ["-lc", command])
        ▼
createos-sandbox sandbox  ──── output ────▶ user.custom_tool_result
```

The agent gets **only** the custom tool — no built-in agent toolset — so the
sandbox is its single execution path. Nothing runs anywhere else.

Example 51 is the same architecture with the opposite lifecycle: a fresh,
throwaway sandbox per tool call.

## Setup — credentials

One Managed Agents credential, and that is all: an **organization API key** with
the Managed Agents beta enabled (Console → API keys). A cloud environment runs on
Anthropic's infrastructure, so there is no self-hosted worker and therefore **no
environment key** — the extra credential examples 36 / 37 / 49 need does not
apply here.

Keep it out of the shared `.env`: that file points `ANTHROPIC_BASE_URL` /
`ANTHROPIC_AUTH_TOKEN` at an internal gateway, which is the wrong endpoint and
auth scheme for Managed Agents. The example scrubs those vars and reads a
separate file:

```sh
# .env.ant  (gitignored — never commit)
ANTHROPIC_API_KEY=sk-ant-...
```

The control-plane credentials (`CREATEOS_SANDBOX_BASE_URL`,
`CREATEOS_SANDBOX_API_KEY`) come from the shared `.env` as usual, and stay on
your host — the agent never sees them.

## Run

```sh
cd examples
bun 50-cloud-agent-sandbox-tool/index.ts
```

## What it does

1. Creates **one** sandbox (`s-4vcpu-4gb`, `devbox:1`) — the session's machine.
2. Creates a **cloud** environment (`config: { type: "cloud" }`) and an agent
   whose only tool is `run_command(command)`.
3. Opens the session event stream **before** sending the task — events between
   session creation and the first read would otherwise be lost — then sends a
   two-step task: write a file, then read it back in a *separate* tool call.
4. On every `agent.custom_tool_use`, runs the command in that one sandbox and
   replies with `user.custom_tool_result` carrying the output.
5. Proves persistence: the second call reads the file the first call wrote, and
   the hostnames match. The host then downloads the same file directly.
6. Destroys the sandbox, session and environment.

## What you'll see

```
      → tool call 1: hostname > /workspace/note.txt; echo "written by $(hostname)"
      ← sandbox sb-01k…: written by sess-tool-47731
      → tool call 2: cat /workspace/note.txt
      ← sandbox sb-01k…: sess-tool-47731
The second call successfully read the file written by the first call, and both
hostnames are identical (sess-tool-47731).
```

## Two things worth copying

**Report failures, do not throw them.** `Sandbox.sh` throws on a non-zero exit,
which is wrong inside a tool — a failing command is a *result* the agent must see
and reason about, not an orchestrator crash. The tool body uses `runCommand` and
returns the exit code alongside the output. And because Managed Agents rejects an
empty tool result, an empty output is sent as `(no output)`.

**Hold the stream open.** The agent blocks on your tool result. If the
orchestrator drops the SSE stream mid-call, the session strands. A single-shot
script like this one is fine; a long-lived service needs reconnect handling.

## createos-sandbox primitives exercised

| Primitive | Used for |
| --- | --- |
| `Sandbox.create` | the one sandbox that serves the whole session |
| `runCommand` | the tool body — runs the agent's command, returns the exit code |
| `files.download` | host-side read of the file the agent wrote |
| `destroy` | tears the sandbox down when the session ends |

## See also

- **51 — sandbox per tool call**: the stateless counterpart; same task, fresh
  machine each call, so the read fails.
- **36 / 37 — self-hosted agent worker**: the inverse topology, where the agent's
  own bash runs inside the sandbox.
- **49 — egress-locked agent worker**: self-hosted, plus a network lockdown.

## Versions captured at build time

See `versions.txt`.
