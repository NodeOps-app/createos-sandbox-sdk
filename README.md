# @nodeops-createos/sandbox

TypeScript SDK for the `createos-sandbox` control plane — spawn VM
sandboxes, run commands, move files, expose services, and manage disks
and networks. `createSandbox()` returns a stateful `Sandbox` handle, errors are
a typed hierarchy, and the transport retries transient failures automatically.

Zero runtime dependencies. ESM-only. Runs on Node 20+, Bun, Deno, Cloudflare
Workers, Vercel Edge, and the browser.

## Install

```sh
npm install @nodeops-createos/sandbox
# or: bun add @nodeops-createos/sandbox
```

Requires Node 20+ (or any runtime with global `fetch`, `ReadableStream`, and
`AbortSignal.any` — Bun, Deno, modern edge runtimes).

## Quick start

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

// baseUrl from CREATEOS_SANDBOX_BASE_URL, apiKey from CREATEOS_SANDBOX_API_KEY
const client = new CreateosSandboxClient();

const sandbox = await client.createSandbox({
  shape: "s-4vcpu-4gb",
  rootfs: "devbox:1",
});

try {
  const { result } = await sandbox.runCommand("node", ["--version"]);
  console.log(result.stdout); // "v20.x.x"
} finally {
  await sandbox.destroy();
}
```

`baseUrl` defaults to the production control plane; override it via the
constructor or `CREATEOS_SANDBOX_BASE_URL`. `createSandbox`
blocks until the sandbox reaches `running`. Sandboxes bill while running — tear
down in `finally`, or set an idle `auto_pause_after_seconds`.

## Documentation

Full docs follow the [Diátaxis](https://diataxis.fr/) framework and live under
[`docs/`](docs/index.md):

- **[Quickstart](docs/quickstart.md)** — install, authenticate, first sandbox
- **[Tutorial](docs/tutorial.md)** — build an AI app generator end to end
- **[How-to guides](docs/how-to/)** — files, lifecycle, services, disks, streaming, errors, observability
- **[API reference](docs/reference/)** — every class, method, and type
- **[Explanation](docs/explanation/)** — the VM model, the handle model, lifecycle, reliability
- **[Examples](docs/examples.md)** — runnable programs, one per directory under [`examples/`](examples/)

For AI agents and tools: the machine-readable index is [`llms.txt`](llms.txt)
and the full corpus is bundled in [`llms-full.txt`](llms-full.txt)
([llmstxt.org](https://llmstxt.org/)).

## Key facts

- **Zero runtime dependencies, ESM-only** — a hand-written `fetch` client.
- **Typed errors** — a `CreateosSandboxError` hierarchy with HTTP status →
  class mapping. See [errors](docs/reference/errors.md).
- **Automatic retries** — idempotent requests retry on transient failures with
  backoff, jitter, and `Retry-After`. See [reliability](docs/explanation/reliability.md).
- **Streaming, ingress, snapshots** — NDJSON command streaming, per-sandbox
  preview URLs, and pause / fork / resume.

## Contributing

Working **in** this repository? See [`AGENTS.md`](AGENTS.md) for the contributor
and agent guide. Commits are gated by `.pre-commit-config.yaml` (lint, format,
typecheck, tests, docs-sync).

## License

See [LICENSE](LICENSE).
