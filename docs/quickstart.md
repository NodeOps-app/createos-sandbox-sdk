# Quickstart

The 30-second tour: install, authenticate, spawn a sandbox, run a command,
and tear it down. For a full guided lesson, see the
[tutorial](./tutorial.md); for the conceptual picture, start with
[what a VM sandbox is](./explanation/vm-sandboxes.md).

## 1. Install

```sh
bun add @nodeops-createos/sandbox
# or: npm install @nodeops-createos/sandbox
```

> **Not yet published to npm.** Until the first release, install from a local
> checkout (see the [README](../README.md)).

The SDK is ESM-only with zero runtime dependencies. It runs on Node 20+, Bun,
Deno, Cloudflare Workers, Vercel Edge, and the browser.

## 2. Get an API key

Provision a key through your createos-sandbox control plane (your operator's
identity portal or CLI). The key is per-user — treat it like a database
password and keep it out of source control.

## 3. Configure and authenticate

The client targets the production control plane by default; set `baseUrl` (or
`CREATEOS_SANDBOX_BASE_URL`) only to point at a different one. Give it an API
key. The simplest path is two environment variables:

```sh
export CREATEOS_SANDBOX_BASE_URL="https://your-createos-sandbox-control-plane"
export CREATEOS_SANDBOX_API_KEY="sk_…"
```

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient(); // reads CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY
// or pass them explicitly:
// new CreateosSandboxClient({ baseUrl: "https://…", apiKey: "sk_…" });
```

Confirm the key works before going further:

```ts
console.log(await client.whoami());
```

## 4. Spawn a sandbox

```ts
const sandbox = await client.createSandbox({
  shape: "s-4vcpu-4gb",
  rootfs: "devbox:1",
});
console.log("ready:", sandbox.id, sandbox.status);
```

`createSandbox` blocks until the sandbox is `running` by default. Pass
`{ wait: false }` to return as soon as the row exists and poll yourself with
[`waitUntilRunning`](./reference/sandbox.md). Pick a `shape` from
[`client.listShapes()`](./reference/client.md) and a `rootfs` from
[`client.listRootfs()`](./reference/client.md).

## 5. Run a command

```ts
const result = await sandbox.runCommand("uname", ["-a"]);
console.log(result.result.stdout);
```

`runCommand` buffers stdout/stderr and resolves when the command exits. For
long-running commands, stream the output — see
[How-to: streaming](./how-to/streaming.md).

## 6. Tear down

```ts
await sandbox.destroy();
```

`destroy` is asynchronous on the server; call
[`sandbox.waitUntilDestroyed()`](./reference/sandbox.md) if you need the row
reclaimed before continuing.

## Put it together

Sandboxes bill while they run, so wrap the work in `try / finally` and always
destroy:

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ shape: "s-4vcpu-4gb", rootfs: "devbox:1" });
try {
  const out = await sandbox.runCommand("uname", ["-a"]);
  console.log(out.result.stdout);
} finally {
  await sandbox.destroy();
}
```

> **Cost control.** A sandbox you forget to destroy keeps billing. Either tear
> it down in `finally`, or set an idle auto-pause so it stops billing on its
> own: `createSandbox({ …, auto_pause_after_seconds: 300 })`. See
> [How-to: lifecycle](./how-to/lifecycle.md).

## Troubleshooting

- **[`CreateosSandboxAuthError`](./reference/errors.md) on the first call** —
  the API key is missing or wrong. Verify with `await client.whoami()`.
- **[`CreateosSandboxConnectionError`](./reference/errors.md)** — the control
  plane is unreachable. Check `CREATEOS_SANDBOX_BASE_URL` and any corporate
  proxy or firewall.
- **[`CreateosSandboxTimeoutError`](./reference/errors.md) from
  `createSandbox`** — the sandbox never reached `running` before the wait
  budget elapsed. Increase `waitTimeoutMs`, or pass `{ wait: false }` and poll
  yourself.
- **[`CreateosSandboxServerError`](./reference/errors.md) with status 503** —
  the host pool is saturated. The SDK already retried with backoff; try again
  after the suggested `Retry-After` window. See
  [reliability](./explanation/reliability.md).

## Next steps

- [Tutorial: build an AI app generator](./tutorial.md) — the full guided lesson
- [How-to guides](./how-to/) — task-oriented recipes
- [API reference](./reference/) — every class, method, and type
- [Explanation](./explanation/) — the VM model, lifecycle, and reliability
- [Examples](./examples.md) — runnable, copy-pasteable end-to-end programs
