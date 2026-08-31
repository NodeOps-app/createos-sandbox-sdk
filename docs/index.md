# createos-sandbox SDK

The TypeScript SDK for **[CreateOS Sandbox](https://createos.sh)** — launch
isolated sandboxes, run commands, move files, expose services, and orchestrate
fleets, from one hand-written `fetch` client with zero runtime dependencies.

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ shape: "s-4vcpu-4gb", rootfs: "devbox:1" });
try {
  const out = await sandbox.runCommand("echo", ["hello from a sandbox"]);
  console.log(out.result.stdout);
} finally {
  await sandbox.destroy();
}
```

A **sandbox** is an isolated Linux runtime with its own kernel boundary that
boots in seconds. That makes it safe to run untrusted or AI-generated code,
stand up a dev server, branch a filesystem, or fan a batch job across a fleet.
The SDK runs on Node 20+, Bun, Deno, Cloudflare Workers, Vercel Edge, and the
browser.

## About CreateOS

[CreateOS](https://createos.sh) is the execution and governance platform for
production AI agents and apps. CreateOS Sandbox gives agent systems an isolated
runtime for code execution, preview services, persistent disks, and networked
workflows.

Read product updates and engineering notes in the
[CreateOS Sandbox docs and blog](https://nodeops.network/es/createos/docs/Sandbox/Overview).

## What you can build

- **Run AI-generated code** safely — an agent writes code, a VM runs it,
  you read back the result.
- **Expose a live service** — start a server inside the sandbox and reach it at
  a per-sandbox [preview URL](./how-to/expose-a-service.md).
- **Branch and snapshot** — [pause, fork, and resume](./how-to/lifecycle.md) a
  sandbox to explore multiple paths from one state.
- **Persist and share data** — [attach S3-backed disks and private
  networks](./how-to/disks-networks-templates.md) across sandboxes.

## Find your way around

These docs follow the [Diátaxis](https://diataxis.fr/) framework — four kinds
of documentation for four kinds of need.

| If you want to… | Go to |
| --- | --- |
| **Learn by building** something end to end | [Tutorial](./tutorial.md) — build an AI app generator |
| **Get going in 30 seconds** | [Quickstart](./quickstart.md) |
| **Solve a specific problem** | [How-to guides](./how-to/) — files, lifecycle, services, disks, streaming, errors, observability |
| **Look up a method or type** | [API reference](./reference/) — client, sandbox, sub-APIs, errors, types, helpers |
| **Understand how it works** | [Explanation](./explanation/) — sandbox model, the handle model, lifecycle, reliability |
| **Copy a working program** | [Examples](./examples.md) — runnable, one per directory |

## Start here

- New to the SDK? Read the [Quickstart](./quickstart.md), then the
  [Tutorial](./tutorial.md).
- New to isolated sandboxes? Read the
  [sandbox model explanation](./explanation/vm-sandboxes.md)
- Building an agent? Jump to the [Tutorial](./tutorial.md) and the
  [examples](./examples.md).

## For AI agents

This documentation is published for machine consumption too. The full index is
at [`llms.txt`](../llms.txt) and the complete corpus is bundled in
[`llms-full.txt`](../llms-full.txt), following the
[llmstxt.org](https://llmstxt.org/) convention.

## Key facts

- **Zero runtime dependencies, ESM-only.** A hand-written `fetch` client.
- **Typed errors + automatic retries.** Idempotent requests retry on transient
  failures with backoff and jitter; see [reliability](./explanation/reliability.md).
- **Sandboxes bill while running.** Every example here tears down with
  `try / finally`; set an idle [auto-pause](./how-to/lifecycle.md) for safety.
- **Not yet on npm.** Install from a local checkout until the first release —
  see the [README](../README.md).
