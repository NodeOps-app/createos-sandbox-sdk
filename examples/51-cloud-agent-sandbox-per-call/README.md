# 51 — Sandbox as an agent tool (a fresh sandbox per call)

Same architecture as example 50 — a **cloud-hosted** Claude Managed Agent whose
only tool, `run_command`, is served by createos-sandbox — with the opposite
lifecycle: **every tool call gets its own sandbox**, destroyed the moment the
command returns.

```
Claude Managed Agent (Anthropic cloud)
        │  agent.custom_tool_use  { command: "…" }
        ▼
your orchestrator (holds the createos-sandbox API key)
        │  create → runCommand → destroy      ← a new sandbox, every call
        ▼
createos-sandbox sandbox  ──── output ────▶ user.custom_tool_result
```

Nothing is reused, so nothing persists. That is the point: no cross-call
contamination, no long-lived machine to clean up, and the blast radius of any one
command is a machine that is already gone. The right shape for untrusted or
one-shot work.

The trade-off is a cold start per call — about **0.7–1.0 s** in the runs captured
in `versions.txt`. When per-call isolation is not worth that, example 50's
per-session sandbox is the alternative.

## The contrast

The task is deliberately identical to example 50's: write a file in one tool
call, read it back in the next. There, the read succeeds. Here it **fails** —
a different machine ran it, and the first machine no longer exists.

## Setup — credentials

One Managed Agents credential: an **organization API key** with the Managed Agents
beta enabled (Console → API keys). A cloud environment runs on Anthropic's
infrastructure, so there is no self-hosted worker and therefore **no environment
key** — the extra credential examples 36 / 37 / 49 need does not apply here.

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
bun 51-cloud-agent-sandbox-per-call/index.ts
```

## What it does

1. Creates a **cloud** environment (`config: { type: "cloud" }`) and an agent
   whose only tool is `run_command(command)`. **No sandbox yet** — none exists
   until the agent actually asks to run something.
2. Opens the session event stream **before** sending the task, then sends the
   two-step write-then-read task.
3. On every `agent.custom_tool_use`: creates a sandbox, runs the command,
   destroys the sandbox, and replies with `user.custom_tool_result`.
4. The second call lands on a machine that has never seen the file, so `cat`
   exits 1 — and the agent is told so, rather than the orchestrator crashing.

## What you'll see

```
      → tool call 1: hostname > /workspace/note.txt; echo "written by $(hostname)"
      ← sandbox sb-01k…4d (fresh, 1.0s incl. cold start): written by call-tool-1-35951
      ✗ sandbox sb-01k…4d destroyed — nothing it wrote survives
      → tool call 2: cat /workspace/note.txt
      ← sandbox sb-01k…8k (fresh, 0.7s incl. cold start): exit 1 | cat: /workspace/note.txt: No such file or directory
      ✗ sandbox sb-01k…8k destroyed — nothing it wrote survives
The second call did not see the file the first call wrote…
```

## Report failures, do not throw them

`Sandbox.sh` throws on a non-zero exit, which is wrong inside a tool — and this
example depends on the difference: the second call's `cat` *must* fail, and the
agent must see the failure as a tool result. The tool body uses `runCommand`,
which returns the exit code instead of throwing, and sends it back with the
output. Managed Agents also rejects an empty tool result, so empty output is sent
as `(no output)`.

## createos-sandbox primitives exercised

| Primitive | Used for |
| --- | --- |
| `Sandbox.create` | a fresh machine for each tool call |
| `runCommand` | the tool body — runs the agent's command, returns the exit code |
| `destroy` | tears the machine down before the next call begins |

## See also

- **50 — sandbox per session**: the stateful counterpart; same task, one machine,
  the read succeeds.
- **36 / 37 — self-hosted agent worker**: the inverse topology, where the agent's
  own bash runs inside the sandbox.
- **49 — egress-locked agent worker**: self-hosted, plus a network lockdown.

## Versions captured at build time

See `versions.txt`.
