# CLAUDE.md

This repository's agent and contributor guide is **`AGENTS.md`** — one
file, read by every AI tool. It is imported below so Claude Code loads it
automatically. Edit `AGENTS.md`, not this file.

@AGENTS.md

The two sections below cover the sibling-language SDKs, which sit outside the
repo mesh described in `AGENTS.md`.

## The CreateOS SDK family

This is one of three clients for the **same** CreateOS Sandbox API. They are
separate repositories that are expected to stay behaviourally in sync. A change
worth making here is usually worth making in the siblings.

| Language | Repository | Package | Agent guide | Local sibling |
| --- | --- | --- | --- | --- |
| TypeScript | this repo | `@nodeops-createos/sandbox` | [`AGENTS.md`](AGENTS.md) | — |
| Go | [createos-go-sdk](https://github.com/NodeOps-app/createos-go-sdk) | `github.com/NodeOps-app/createos-go-sdk` | [`CLAUDE.md`](https://github.com/NodeOps-app/createos-go-sdk/blob/main/CLAUDE.md) | `../createos-go-sdk` |
| Python | [createos-python-sdk](https://github.com/NodeOps-app/createos-python-sdk) | `createos-sandbox` | [`CLAUDE.md`](https://github.com/NodeOps-app/createos-python-sdk/blob/main/CLAUDE.md) | `../createos-python-sdk` |

Upstream of all three:

- **Service** — `../fc` (`nodeops-app/fc`). Source of truth for the wire
  contract: `openapi.yaml`, plus `CLAUDE.md` / `AGENT.md` for its own rules.
  If the SDKs disagree about what the API does, the service wins.
- **Public docs** — `../website-04/content/docs/Sandbox/`, published at
  <https://createos.sh/docs/Sandbox>. Language snippets are **not** written in
  Markdown: they live in `lib/docs/sdk-code-examples.ts` and render through
  `<SdkCodeTabs example="..." />`, one entry per language. A new SDK capability
  that users should see is not shipped until that file has it.

## Cross-SDK parity protocol

Run this before you call any change to this repo done. It is a read-and-report
protocol — **do not edit a sibling repository unless the user asks you to.**

1. **Classify the change.**
   - *Wire contract* (new endpoint, changed field, new request/response shape)
     → affects all three SDKs and usually the docs.
   - *Behaviour* (retry policy, timeout default, stream framing, error
     mapping) → affects all three SDKs.
   - *Bug fix* → check whether the siblings have the same bug. They were
     written from the same spec, so they usually do.
   - *Ergonomics* (an `await using` disposable handle, a narrowed literal
     union) → often has a natural equivalent in the siblings; propose it,
     don't assume it.
   - *Repo-local* (packaging, lint config, CI) → no parity obligation.
2. **Check the siblings.** Read the matching file under
   `../createos-go-sdk/sandbox/` and `../createos-python-sdk/src/createos/`. If
   a sibling checkout is missing, say so rather than guessing.
3. **Report.** End the task with a short parity note: what ports to which SDK,
   what does not, and why. Name the file the sibling change would land in.
4. **Docs.** If the change adds or alters a user-visible capability, say
   whether `sdk-code-examples.ts` and the affected page under
   `content/docs/Sandbox/` need updating.

The same protocol runs in reverse: when the Go or Python SDK gains a feature or
fix, check whether it belongs here.

### Current parity baseline

The Go and Python SDKs expose the same surface and ship the same nine examples
(`hello_world`, `command_streaming`, `files_and_snapshots`, `ingress_preview`,
`managed_process`, `network`, `custom_template`, `desktop`,
`execution_server`). This repo has the same core surface plus a much larger
integration-example corpus under `examples/`. Treat a gap against Go or Python
as a real gap; treat a gap against a TypeScript *integration example* as
optional in the siblings.
