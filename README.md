# fc-sandbox-sdk

TypeScript SDK for the `fc-spawn` microVM sandbox control plane — spawn
Firecracker VMs, run commands, move files, and manage networks.

`v0.2` is a redesign: `createSandbox()` returns a stateful `Sandbox`
handle instead of a raw response, errors are a typed hierarchy, and the
transport retries transient failures automatically.

## Install

```sh
npm install fc-sandbox-sdk
```

Requires Node 20+ (or any runtime with global `fetch`, `ReadableStream`
and `AbortSignal.any` — Bun, Deno, modern edge runtimes).

## Quick start

```ts
import { FcClient } from "fc-sandbox-sdk";

const fc = new FcClient({ apiKey: process.env.FC_API_KEY });

const sandbox = await fc.createSandbox({
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

Every option is optional. `apiKey` and `baseUrl` fall back to the
`FC_API_KEY` and `FC_BASE_URL` environment variables. `apiKey` is sent as
`X-Api-Key`. Auth is required for control-plane calls: provide either
`apiKey` or `authHeaders`.

```ts
const fc = new FcClient({
  apiKey: "sk-...",                 // or env FC_API_KEY
  baseUrl: "https://fc-spawn...",   // or env FC_BASE_URL
  timeoutMs: 30_000,                // per-request deadline (default 60s)
  retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 30_000 },
  headers: { "x-team": "platform" },// merged into every request
});
```

Use `authHeaders` when the SDK is talking to your own API/proxy and your app
auth is not an fc-spawn API key:

```ts
const fc = new FcClient({
  baseUrl: "https://api.your-app.com/fc",
  authHeaders: {
    Authorization: `Bearer ${sessionToken}`,
    "X-Workspace-Id": workspaceId,
  },
});
```

`apiKey` and `authHeaders` are mutually exclusive.

```ts
// Zero-config: reads FC_API_KEY + FC_BASE_URL from the environment.
const fc = new FcClient();
```

Every method takes a final options argument for per-call overrides:

```ts
await fc.whoami({ timeoutMs: 5_000, retry: false, signal: ac.signal });
```

## Creating sandboxes

```ts
const sandbox = await fc.createSandbox({
  shape: "s-1vcpu-256mb",          // required — see fc.listShapes()
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
const sandbox = await fc.createSandbox({ shape: "s-1vcpu-256mb" }, { wait: false });
console.log(sandbox.status); // "creating" — or "running" if the spawn already finished
await sandbox.waitUntilRunning({ timeoutMs: 60_000 });
```

Skip the client object entirely for one-off scripts — `Sandbox.create`
constructs the client for you:

```ts
import { Sandbox } from "fc-sandbox-sdk";

const sandbox = await Sandbox.create(
  { shape: "s-1vcpu-256mb", ingress_enabled: true },
  { apiKey: process.env.FC_API_KEY },
);
```

## Connecting to existing sandboxes

```ts
const sandbox = await fc.getSandbox("sb_01K...");
const byIp = await fc.getSandboxByIP("10.0.0.2");

const running = await fc.listSandboxes({ status: "running", limit: 100 });
for (const sbx of running) {
  console.log(sbx.id, sbx.status, sbx.ip);
}
```

`Sandbox.connect` is the client-less analogue of `getSandbox`:

```ts
const sandbox = await Sandbox.connect("sb_01K...", { apiKey: process.env.FC_API_KEY });
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

// Environment variables are set per-sandbox at create time via `envs` and are
// injected into every command. The control plane does not support per-command
// stdin or env overrides — set env when creating or forking the sandbox.
const box = await fc.createSandbox({
  shape: "s-1vcpu-256mb",
  envs: { LOG_LEVEL: "info" },
});
const logged = await box.runCommand("printenv", ["LOG_LEVEL"]);
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
`FcTimeoutError` if the budget runs out:

```ts
await sandbox.waitUntilRunning({ timeoutMs: 90_000 });
await sandbox.waitUntilDestroyed();
```

A fork/snapshot workflow:

```ts
const base = await fc.createSandbox({ shape: "s-1vcpu-256mb" });
await base.runCommand("bash", ["-lc", "apt-get install -y ripgrep"]);
await base.pause();
await base.waitUntilPaused();

// Fan out independent copies of the prepared sandbox.
const workers = await Promise.all([base.fork(), base.fork(), base.fork()]);
```

## Preview URLs

```ts
const sandbox = await fc.createSandbox({
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
`ingress_enabled: true`.

`waitForPortReady(port, options?)` opens a `/dev/tcp` probe inside the
VM until the port accepts a connection. Defaults: 30 s budget, 200 ms
poll interval, host `127.0.0.1`. Throws `FcTimeoutError` if the port
stays closed. Requires a rootfs with `bash` and GNU `timeout` (both
present in the fc-spawn default rootfs).

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
const network = await fc.networks.create({ name: "backend" });

await sandbox.attachNetwork(network.id);
await otherSandbox.attachNetwork(network.id);
// sandboxes now reach each other by name across the overlay

await fc.networks.get(network.id);   // includes members
await fc.networks.list();
await sandbox.detachNetwork(network.id);
await fc.networks.delete(network.id);
```

## Templates

Build a custom rootfs from a Dockerfile:

```ts
const template = await fc.templates.create({
  name: "rg-base",
  dockerfile:
    "FROM bhautikchudasama/fc-base:debian-1\n" +
    "RUN apt-get update && apt-get install -y ripgrep",
});

// Follow the build log until it finishes. Pass a generous timeoutMs — a build
// can outlast the default 60s per-request deadline.
for await (const event of fc.templates.followLogs(template.id, { timeoutMs: 600_000 })) {
  if (event.line) console.log(event.line);
  if (event.final) console.log("build", event.status);
}

// Or fetch the log as plain text after the fact.
console.log(await fc.templates.logs(template.id));

const ready = await fc.templates.get(template.id);
if (ready.status === "ready") {
  await fc.createSandbox({ shape: "s-1vcpu-256mb", rootfs: "rg-base" });
}

await fc.templates.list();
await fc.templates.delete(template.id);
```

## Catalog and identity

```ts
await fc.listShapes();   // Shape[] — { id, vcpu, mem_mib, default_disk_mib }
await fc.listRootfs();   // { rootfs, default, entries }
await fc.listHosts();    // HostPublic[]
await fc.whoami();       // { user_id, stats }
await fc.healthz();      // { up }
await fc.readyz();       // { ready, reason? } — does not throw on 503
```

## Errors

Non-2xx responses throw a typed error. Every one extends `FcError`; HTTP
errors also extend `FcApiError` and carry `statusCode`, `response`,
`requestId`, and the parsed JSend `envelope`.

```ts
import { FcNotFoundError, FcRateLimitError, FcValidationError } from "fc-sandbox-sdk";

try {
  await fc.createSandbox({ shape: "does-not-exist" });
} catch (err) {
  if (err instanceof FcValidationError) {
    console.error("bad request:", err.envelope?.data);
  } else if (err instanceof FcNotFoundError) {
    console.error("not found");
  } else if (err instanceof FcRateLimitError) {
    console.error("retry after", err.retryAfterSeconds, "s");
  } else {
    throw err;
  }
}
```

| Error | Cause |
| --- | --- |
| `FcAuthError` | 401 — missing / invalid API key |
| `FcPermissionError` | 403 |
| `FcNotFoundError` | 404 |
| `FcValidationError` | 400 / 409 / 422 |
| `FcRateLimitError` | 429 — exposes `retryAfterSeconds` |
| `FcServerError` | 5xx |
| `FcConnectionError` | network failure, no response |
| `FcTimeoutError` | request or `waitUntil*` deadline exceeded |

## Retries and timeouts

The transport retries transient failures with exponential backoff and
jitter, and honors the `Retry-After` header. Idempotent methods retry on
network errors and `408/500/502/503/504`; non-idempotent methods retry
only on `429/503`, where the server demonstrably did not act.

```ts
const fc = new FcClient({ retry: { maxRetries: 4, baseDelayMs: 250 } });

await fc.whoami({ retry: false });               // disable for one call
await fc.createSandbox(req, { timeoutMs: 120_000 });
```

## Cancellation

Every method accepts an `AbortSignal`:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000);

const sandbox = await fc.createSandbox(
  { shape: "s-1vcpu-256mb" },
  { signal: ac.signal },
);
```

## Escape hatch

`fc.http` exposes the low-level transport (`request`, `requestRaw`,
`stream`) for endpoints the SDK does not model:

```ts
const data = await fc.http.request("GET", "/v1/some/new/endpoint");
```

## Design

The handle model, typed-error hierarchy and retry policy were
benchmarked against seven other sandbox / compute SDKs (E2B, Daytona,
ComputeSDK, Modal, Cloudflare, CodeSandbox, Vercel). See
[docs/sdk-analysis.md](docs/sdk-analysis.md) for the full competitive
analysis — what each does well and badly, which ideas this SDK borrowed,
and where it leads.

## Publishing

```sh
npm whoami
npm version patch
npm run publish:dry
npm run publish:npm
git push --follow-tags
```

`prepublishOnly` runs the test and typecheck gates before a real publish.
If publish fails with `E401`, the local npm token is invalid — run
`npm login --registry=https://registry.npmjs.org/` and retry.
