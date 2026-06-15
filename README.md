# createos-sandbox-sdk

TypeScript SDK for the `createos-sandbox` microVM sandbox control plane — spawn
Firecracker VMs, run commands, move files, and manage networks.

`createSandbox()` returns a stateful `Sandbox` handle, errors are a typed
hierarchy, and the transport retries transient failures automatically.

## Install

```sh
npm install createos-sandbox-sdk
```

> **Not yet published to npm.** Until the first release, install from a
> local checkout (`bun install && bun run build`, then depend on it via a
> `file:` path). The name above is reserved for the first published release.

Requires Node 20+ (or any runtime with global `fetch`, `ReadableStream`
and `AbortSignal.any` — Bun, Deno, modern edge runtimes).

## Quick start

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const box = new CreateosSandboxClient({ apiKey: process.env.CREATEOS_SANDBOX_API_KEY }); // baseUrl from CREATEOS_SANDBOX_BASE_URL

const sandbox = await box.createSandbox({
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
});

try {
  const { result } = await sandbox.runCommand("node", ["--version"]);
  console.log(result.stdout); // "v20.x.x"
} finally {
  await sandbox.destroy();
}
```

`createSandbox` blocks until the sandbox reaches `running`.

## Configuration

`baseUrl` is required: pass it explicitly or set the `CREATEOS_SANDBOX_BASE_URL`
environment variable — the client throws if neither is set. `apiKey` is
optional and falls back to `CREATEOS_SANDBOX_API_KEY`, sent as `X-Api-Key`. Auth is
required for control-plane calls: provide either `apiKey` or `authHeaders`.

```ts
const box = new CreateosSandboxClient({
  apiKey: "sk-...",                 // or env CREATEOS_SANDBOX_API_KEY
  baseUrl: "https://createos-sandbox...",   // or env CREATEOS_SANDBOX_BASE_URL
  timeoutMs: 30_000,                // per-request deadline (default 60s)
  retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 30_000 },
  headers: { "x-team": "platform" },// merged into every request
});
```

Use `authHeaders` when the SDK is talking to your own API/proxy and your app
auth is not a createos-sandbox API key:

```ts
const box = new CreateosSandboxClient({
  baseUrl: "https://api.your-app.com/fc",
  authHeaders: {
    Authorization: `Bearer ${sessionToken}`,
    "X-Workspace-Id": workspaceId,
  },
});
```

`apiKey` and `authHeaders` are mutually exclusive.

```ts
// Reads CREATEOS_SANDBOX_API_KEY + CREATEOS_SANDBOX_BASE_URL from the environment (CREATEOS_SANDBOX_BASE_URL required).
const box = new CreateosSandboxClient();
```

Every method takes a final options argument for per-call overrides:

```ts
await box.whoami({ timeoutMs: 5_000, retry: false, signal: ac.signal });
```

## Creating sandboxes

```ts
const sandbox = await box.createSandbox({
  shape: "s-1vcpu-256mb",          // required — see box.listShapes()
  rootfs: "devbox:1",              // catalog name or template id/name
  name: "build-worker",            // optional; auto-generated if omitted
  envs: { NODE_ENV: "production" },// injected into every command
  egress: ["pypi.org", "1.1.1.1"], // allowlist; omit for allow-all
  disk_mib: 20480,                 // overlay disk; 0 = shape default
  ingress_enabled: true,           // enable public HTTP ingress
  node_selector: { region: "nyc1" },// optional; keys must match host labels
});
```

Return immediately instead of waiting for `running`:

```ts
const sandbox = await box.createSandbox({ shape: "s-1vcpu-256mb" }, { wait: false });
console.log(sandbox.status); // "creating" — or "running" if the spawn already finished
await sandbox.waitUntilRunning({ timeoutMs: 60_000 });
```

Skip the client object entirely for one-off scripts — `Sandbox.create`
constructs the client for you:

```ts
import { Sandbox } from "createos-sandbox-sdk";

const sandbox = await Sandbox.create(
  { shape: "s-1vcpu-256mb", ingress_enabled: true },
  { apiKey: process.env.CREATEOS_SANDBOX_API_KEY }, // baseUrl from CREATEOS_SANDBOX_BASE_URL
);
```

## Connecting to existing sandboxes

```ts
const sandbox = await box.getSandbox("sb_01K...");
const byIp = await box.getSandboxByIP("10.0.0.2");

const running = await box.listSandboxes({ status: "running", limit: 100 });
for (const sbx of running) {
  console.log(sbx.id, sbx.status, sbx.ip);
}
```

`Sandbox.connect` is the client-less analogue of `getSandbox`:

```ts
const sandbox = await Sandbox.connect("sb_01K...", { apiKey: process.env.CREATEOS_SANDBOX_API_KEY }); // baseUrl from CREATEOS_SANDBOX_BASE_URL
```

## The Sandbox handle

```ts
sandbox.id;       // "sb_01K..."
sandbox.status;   // "running" | "paused" | "creating" | ...
sandbox.ip;       // "10.0.0.2"
sandbox.name;     // "build-worker"
sandbox.data;     // the full SandboxView projection

await sandbox.refresh(); // re-fetch the projection in place
```

## Running commands

```ts
// Buffered — resolves when the command exits.
const { result, exec_ms } = await sandbox.runCommand("bash", ["-lc", "ls -la /"]);
console.log(result.stdout, result.stderr, result.exit_code);

// A non-zero exit code is a normal result, not a thrown error.
const check = await sandbox.runCommand("test", ["-f", "/etc/hosts"]);
if (check.result.exit_code !== 0) console.log("missing");

// `sh()` is the throw-on-failure shortcut: it runs the script through
// `bash -lc`, throws CreateosSandboxError on a non-zero exit, and returns the same
// ExecResponse on success. `label` tags the thrown error.
const { result: built } = await sandbox.sh("apt-get update -qq && apt-get install -y curl", {
  label: "apt",
  timeoutMs: 120_000,
});

// Environment variables are set per-sandbox at create time via `envs` and are
// injected into every command. The control plane does not support per-command
// stdin or env overrides — set env when creating or forking the sandbox.
const sandbox = await box.createSandbox({
  shape: "s-1vcpu-256mb",
  envs: { LOG_LEVEL: "info" },
});
const logged = await sandbox.runCommand("printenv", ["LOG_LEVEL"]);
```

Streaming output yields a discriminated union — switch on `event.type`:

```ts
for await (const event of sandbox.streamCommand("bash", [
  "-lc",
  "for i in 1 2 3; do echo line $i; sleep 1; done",
])) {
  switch (event.type) {
    case "stdout":
      process.stdout.write(event.data);
      break;
    case "stderr":
      process.stderr.write(event.data);
      break;
    case "exit":
      console.log("exited", event.exitCode);
      break;
    case "error":
      console.error("agent error:", event.message);
      break;
    case "heartbeat":
      break;
  }
}
```

## Files

```ts
// Upload — accepts any BodyInit (string, Uint8Array, Blob, stream).
await sandbox.files.upload("/tmp/note.txt", "hello");
await sandbox.files.upload("/tmp/data.bin", new Uint8Array([1, 2, 3]));

// Download — returns an ArrayBuffer.
const bytes = await sandbox.files.download("/tmp/note.txt");
console.log(new TextDecoder().decode(bytes));
```

## Lifecycle

```ts
await sandbox.pause();
await sandbox.waitUntilPaused();

await sandbox.resume();
await sandbox.waitUntilRunning();

const clone = await sandbox.fork();                  // clone a paused sandbox
const clone2 = await sandbox.fork({ start_paused: true });

await sandbox.resize(20480);                         // grow the overlay disk
await sandbox.setIngress(true);                      // toggle HTTP ingress

const { destroyed } = await sandbox.destroy();       // destroyed sandbox id — async
```

`pause`, `resume` and `fork` are asynchronous on the server. The
`waitUntil*` helpers poll with adaptive backoff and throw
`CreateosSandboxTimeoutError` if the budget runs out:

```ts
await sandbox.waitUntilRunning({ timeoutMs: 90_000 });
await sandbox.waitUntilDestroyed();
```

A fork/snapshot workflow:

```ts
const base = await box.createSandbox({ shape: "s-1vcpu-256mb" });
await base.runCommand("bash", ["-lc", "apt-get install -y ripgrep"]);
await base.pause();
await base.waitUntilPaused();

// Fan out independent copies of the prepared sandbox.
const workers = await Promise.all([base.fork(), base.fork(), base.fork()]);
```

## Preview URLs

```ts
const sandbox = await box.createSandbox({
  shape: "s-1vcpu-256mb",
  ingress_enabled: true,
});
// Redirect the background process's stdio so the buffered runCommand can
// return — otherwise it waits for the inherited stdout pipe to close.
await sandbox.runCommand("bash", ["-lc", "python3 -m http.server 8080 >/dev/null 2>&1 &"]);
await sandbox.waitForPortReady(8080); // block until something listens
console.log(sandbox.previewUrl(8080)); // https://<id>-8080.<domain>
```

`previewUrl` is only available on sandboxes created with
`ingress_enabled: true`. Pass `{ scheme: "http" }` to get an `http://`
URL when the ingress hostname's TLS certificate has not been provisioned
yet:

```ts
const url = sandbox.previewUrl(8080, { scheme: "http" });
```

`waitForPortReady(port, options?)` opens a `/dev/tcp` probe inside the
VM until the port accepts a connection. Defaults: 30 s budget, 200 ms
poll interval, host `127.0.0.1`. Throws `CreateosSandboxTimeoutError` if the port
stays closed. Requires a rootfs with `bash` and GNU `timeout` (both
present in the createos-sandbox default rootfs).

For custom wait loops, `pollUntil({ poll, done, timeoutMs })` and the
cancellable `sleep(ms, signal?)` are exported — the same adaptive-backoff
poller the `waitUntil*` helpers use.

## Egress and bandwidth

```ts
await sandbox.setEgress(["github.com", "registry.npmjs.org"]);
await sandbox.setEgress(null); // null / [] = allow all
console.log(await sandbox.getEgress());

const bw = await sandbox.getBandwidth();
console.log(bw.used_bytes, bw.remaining_bytes, bw.capped);
await sandbox.rechargeBandwidth(10 * 1024 * 1024 * 1024); // +10 GiB
```

## Networks

```ts
const network = await box.networks.create({ name: "backend" });

await sandbox.attachNetwork(network.id);
await otherSandbox.attachNetwork(network.id);
// sandboxes now reach each other by name across the overlay

await box.networks.get(network.id);   // includes members
await box.networks.list();
await sandbox.detachNetwork(network.id);
await box.networks.delete(network.id);
```

## Templates

Build a custom rootfs from a Dockerfile:

```ts
const template = await box.templates.create({
  name: "rg-base",
  dockerfile:
    "FROM your-registry/fc-base:latest\n" + // your createos-sandbox base rootfs image
    "RUN apt-get update && apt-get install -y ripgrep",
});

// Follow the build log until it finishes. Pass a generous timeoutMs — a build
// can outlast the default 60s per-request deadline.
for await (const event of box.templates.followLogs(template.id, { timeoutMs: 600_000 })) {
  if (event.line) console.log(event.line);
  if (event.final) console.log("build", event.status);
}

// Or fetch the log as plain text after the fact.
console.log(await box.templates.logs(template.id));

const ready = await box.templates.get(template.id);
if (ready.status === "ready") {
  await box.createSandbox({ shape: "s-1vcpu-256mb", rootfs: "rg-base" });
}

await box.templates.list();
await box.templates.delete(template.id);
```

## Catalog and identity

```ts
await box.listShapes();   // Shape[] — { id, vcpu, mem_mib, default_disk_mib }
await box.listRootfs();   // { rootfs, default, entries }
await box.listHosts();    // HostPublic[]
await box.whoami();       // { user_id, stats }
await box.healthz();      // { up }
await box.readyz();       // { ready, reason? } — does not throw on 503
```

## Errors

Non-2xx responses throw a typed error. Every one extends `CreateosSandboxError`; HTTP
errors also extend `CreateosSandboxApiError` and carry the request context needed to
file a useful support ticket — `statusCode`, `endpoint`, `method`,
`requestId`, `resourceId`, and the parsed JSend `envelope`.

```ts
import { CreateosSandboxNotFoundError, CreateosSandboxRateLimitError, CreateosSandboxValidationError } from "createos-sandbox-sdk";

try {
  await box.createSandbox({ shape: "does-not-exist" });
} catch (err) {
  if (err instanceof CreateosSandboxValidationError) {
    console.error("bad request:", err.envelope?.data);
  } else if (err instanceof CreateosSandboxNotFoundError) {
    console.error(`not found at ${err.method} ${err.endpoint} (req ${err.requestId})`);
  } else if (err instanceof CreateosSandboxRateLimitError) {
    console.error("retry after", err.retryAfterSeconds, "s");
  } else {
    throw err;
  }
}
```

Every `CreateosSandboxApiError` exposes:

- `statusCode` — HTTP status as a number.
- `endpoint` — request pathname (no host, no query). Stable enough to
  bucket errors in dashboards.
- `method` — HTTP verb.
- `requestId` — server-issued id (`X-Request-Id` or `X-Fc-Request-Id`)
  for cross-referencing with the control plane's logs.
- `resourceId` — sandbox / template / network / disk id parsed from the
  path, when present.
- `code` — the stable machine-readable code from `envelope.data.code`,
  when present.

| Error | Cause |
| --- | --- |
| `CreateosSandboxAuthError` | 401 — missing / invalid API key |
| `CreateosSandboxPermissionError` | 403 |
| `CreateosSandboxNotFoundError` | 404 |
| `CreateosSandboxValidationError` | 400 / 409 / 422 |
| `CreateosSandboxRateLimitError` | 429 — exposes `retryAfterSeconds` |
| `CreateosSandboxServerError` | 5xx |
| `CreateosSandboxConnectionError` | network failure, no response |
| `CreateosSandboxTimeoutError` | request or `waitUntil*` deadline exceeded |

## Observability

The client takes optional lifecycle hooks. Wire them into OpenTelemetry,
your structured logger, or a metrics sink — the SDK does not pull any
runtime dependency for this.

```ts
const box = new CreateosSandboxClient({
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY,
  hooks: {
    onRequest: (ctx) => log.debug("→", ctx.method, ctx.url, `try ${ctx.attempt}`),
    onResponse: (ctx) =>
      log.debug("←", ctx.status, `${ctx.durationMs.toFixed(0)}ms`, ctx.requestId),
    onRetry: (ctx) => log.warn("retry", ctx.reason, "in", ctx.delayMs, "ms"),
  },
});
```

Hook context is pre-redacted: `Authorization`, `X-Api-Key`,
`X-Auth-Token`, `Cookie`, `Proxy-Authorization`, `X-Csrf-Token`, and
common credential query params never reach a hook payload. A throw
inside a hook is caught and warned — a flaky observer will not crash
the request.

`onRetry.reason` is one of `"network"` (the fetch threw),
`"rate-limit"` (the server set `Retry-After`), or `"status"` (a
retryable 4xx/5xx without a Retry-After).

Streaming requests (`Sandbox.streamCommand`, `TemplatesApi.followLogs`)
take a separate transport path and **do not fire hooks** — they aren't
retried and live for the lifetime of their `for await` loop. Wrap that
loop yourself if you need per-stream tracing.

## Retries and timeouts

The transport retries transient failures with exponential backoff and
jitter, and honors the `Retry-After` header. Idempotent methods retry on
network errors and `408/500/502/503/504`; non-idempotent methods retry
only on `429/503`, where the server demonstrably did not act.

```ts
const box = new CreateosSandboxClient({ retry: { maxRetries: 4, baseDelayMs: 250 } });

await box.whoami({ retry: false });               // disable for one call
await box.createSandbox(req, { timeoutMs: 120_000 });
```

## Cancellation

Every method accepts an `AbortSignal`:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000);

const sandbox = await box.createSandbox(
  { shape: "s-1vcpu-256mb" },
  { signal: ac.signal },
);
```

## Escape hatch

`box.http` exposes the low-level transport (`request`, `requestRaw`,
`stream`) for endpoints the SDK does not model:

```ts
const data = await box.http.request("GET", "/v1/some/new/endpoint");
```

## Docs

- [Quickstart](docs/quickstart.md) — install, auth, first sandbox
- How-to:
  - [Streaming command output](docs/how-to/streaming.md)
  - [Error handling](docs/how-to/error-handling.md)
  - [Observability](docs/how-to/observability.md)
- [API reference](docs/reference/index.html) — generated by TypeDoc
  (run `npm run docs:api`)
- [Design rationale](docs/explanation/sdk-analysis.md)

## Design

The handle model, typed-error hierarchy and retry policy were
benchmarked against seven other sandbox / compute SDKs (E2B, Daytona,
ComputeSDK, Modal, Cloudflare, CodeSandbox, Vercel). See
[docs/explanation/sdk-analysis.md](docs/explanation/sdk-analysis.md) for the full competitive
analysis — what each does well and badly, which ideas this SDK borrowed,
and where it leads.
