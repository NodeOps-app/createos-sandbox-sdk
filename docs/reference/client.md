# Client reference

`CreateosSandboxClient` is the SDK entry point. It owns transport
configuration (auth, base URL, timeouts, retries) and exposes catalog
and identity calls, the sandbox factory, and the `templates` / `networks`
/ `disks` sub-APIs.

`createClient(options?)` is a convenience function equivalent to
`new CreateosSandboxClient(options)`.

Every method that reaches the control plane throws
`CreateosSandboxServerError` on 5xx and `CreateosSandboxConnectionError`
on network failure. Per-method `throws` entries list only
call-specific conditions.

---

## Constructor

```ts
new CreateosSandboxClient(options?: CreateosSandboxClientOptions)
```

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
const box = new CreateosSandboxClient({
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY,
});
```

### `CreateosSandboxClientOptions`

All fields are optional.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string?` | `CREATEOS_SANDBOX_API_KEY` env var | API key sent as `X-Api-Key`. |
| `authHeaders` | `HeadersInit?` | — | Auth headers used instead of an API key (e.g. a session token). |
| `baseUrl` | `string?` | `CREATEOS_SANDBOX_BASE_URL` env var or production URL | Control-plane base URL. |
| `fetch` | `typeof fetch?` | `globalThis.fetch` | Custom fetch implementation. |
| `headers` | `HeadersInit?` | — | Headers merged into every request. |
| `timeoutMs` | `number?` | `60000` | Per-request timeout in ms. `0` disables. |
| `retry` | `RetryOptions \| false?` | See [Retry policy](#retry-policy) | Retry policy, or `false` to disable retries entirely. |
| `userAgent` | `string?` | SDK default | Overrides the `User-Agent` header. |
| `hooks` | `ClientHooks?` | — | Lifecycle hooks for observability. Payloads are pre-redacted. |

### Retry policy

`RetryOptions` — all fields optional:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxRetries` | `number?` | `2` | Extra attempts after the first (3 total). |
| `baseDelayMs` | `number?` | `500` | Base backoff delay in ms. |
| `maxDelayMs` | `number?` | `30000` | Backoff ceiling in ms. |

Idempotent methods (`GET`/`HEAD`/`PUT`/`DELETE`) retry on network errors
and `408`/`500`/`502`/`503`/`504`. Non-idempotent methods retry only on
`429`/`503`. Streaming requests are never retried.

### Observability hooks

`ClientHooks`:

| Field | Type | Description |
|-------|------|-------------|
| `onRequest` | `(ctx: RequestHookContext) => void \| Promise<void>` | Called before each attempt. |
| `onResponse` | `(ctx: ResponseHookContext) => void \| Promise<void>` | Called after each response. |
| `onRetry` | `(ctx: RetryHookContext) => void \| Promise<void>` | Called before each retry delay. |

Hooks are awaited in the request path. Keep hook work cheap or dispatch
slow work without returning the promise. A throw inside a hook is
swallowed.

---

## `createClient`

```ts
function createClient(options?: CreateosSandboxClientOptions): CreateosSandboxClient
```

Constructs an `CreateosSandboxClient`. Equivalent to
`new CreateosSandboxClient(options)`.

```ts
import { createClient } from "@nodeops-createos/sandbox";
const box = createClient({ apiKey: process.env.CREATEOS_SANDBOX_API_KEY });
```

---

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `http` | `CreateosSandboxHttp` | Low-level transport. Escape hatch for requests the SDK does not model. |
| `templates` | `TemplatesApi` | Template (custom rootfs) operations. |
| `networks` | `NetworksApi` | Overlay network operations. |
| `disks` | `DisksApi` | S3-disk catalog operations. |
| `baseUrl` | `string` | Resolved base URL (getter). |

---

## Health & identity

### `healthz`

```ts
healthz(options?: RequestOptions): Promise<HealthzResponse>
```

Liveness probe. Unauthenticated. Returns `{ up: true }` once the control
plane is up.

Returns `HealthzResponse`:

| Field | Type | Description |
|-------|------|-------------|
| `up` | `boolean` | `true` when the control plane process is running. |

Throws `CreateosSandboxTimeoutError` on timeout.

```ts
const h = await box.healthz();
console.log(h.up);
```

---

### `readyz`

```ts
async readyz(options?: RequestOptions): Promise<ReadyzResponse>
```

Readiness probe. Returns `{ ready: false, reason }` instead of throwing
on `503`.

Returns `ReadyzResponse`:

| Field | Type | Description |
|-------|------|-------------|
| `ready` | `boolean` | `true` when the control plane is accepting traffic. |
| `reason` | `string?` | Why the plane is not ready, when `ready` is `false`. |
| `scheduler_last_ok_ms_ago` | `number?` | ms since the scheduler last completed a healthy pass. |

```ts
const r = await box.readyz();
if (!r.ready) console.warn("not ready:", r.reason);
```

---

### `whoami`

```ts
whoami(options?: RequestOptions): Promise<WhoAmIView>
```

Returns the identity associated with the configured API key.

Returns `WhoAmIView`:

| Field | Type | Description |
|-------|------|-------------|
| `user_id` | `string` | Stable id of the authenticated user. |
| `stats.running` | `number` | Sandboxes currently `running`. |
| `stats.paused` | `number` | Sandboxes currently `paused`. |
| `stats.other` | `number` | Sandboxes in any other state. |
| `stats.total` | `number` | Total non-destroyed sandboxes. |

Throws `CreateosSandboxAuthError` on missing or revoked API key.

```ts
const me = await box.whoami();
console.log(me.user_id, me.stats);
```

---

## Catalog

### `listShapes`

```ts
listShapes(options?: RequestOptions): Promise<Shape[]>
```

Lists available sandbox shapes (vCPU / RAM presets). Unauthenticated.
Fetches all pages.

Returns `Shape[]`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Shape id, e.g. `s-1vcpu-256mb`. |
| `vcpu` | `number` | Virtual CPU count. |
| `mem_mib` | `number` | Memory in MiB. |
| `default_disk_mib` | `number` | Default overlay disk size in MiB. |
| `cpu_quota_pct` | `number?` | CPU quota as % of one vCPU (`omitempty`). |

```ts
const shapes = await box.listShapes();
console.log(shapes.map((s) => s.id));
```

---

### `listRootfs`

```ts
listRootfs(options?: RequestOptions): Promise<RootfsData>
```

Lists the catalog of built-in rootfs images. Unauthenticated.

Returns `RootfsData`:

| Field | Type | Description |
|-------|------|-------------|
| `rootfs` | `string[]` | Available rootfs names for `CreateSandboxRequest.rootfs`. |
| `default` | `string` | Name used when a create request omits `rootfs`. |
| `entries` | `RootfsEntry[]?` | Rich per-rootfs metadata; absent when catalog is empty. |

```ts
const { rootfs } = await box.listRootfs();
console.log(rootfs);
```

---

### `listHosts`

```ts
listHosts(options?: RequestOptions): Promise<HostPublic[]>
```

Lists worker hosts visible to the caller. Fetches all pages.

Returns `HostPublic[]`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Host id. |
| `status` | `HostStatus` | `"active" \| "draining" \| "dead"` |
| `free_mib` | `number` | Schedulable memory free on the host, in MiB. |
| `vm_count` | `number` | Sandboxes currently placed on the host. |
| `rootfses` | `string[]?` | Rootfs images cached on the host. |

Throws `CreateosSandboxAuthError` on missing or revoked API key.
Throws `CreateosSandboxPermissionError` when the caller cannot enumerate
hosts.

```ts
const hosts = await box.listHosts();
console.log(hosts.map((h) => h.id));
```

---

### `iterateHosts`

```ts
iterateHosts(options?: RequestOptions): AsyncGenerator<HostPublic>
```

Streams worker hosts one page at a time.

```ts
for await (const h of box.iterateHosts()) console.log(h.id);
```

---

## Sandboxes

### `createSandbox`

```ts
async createSandbox(
  request: CreateSandboxRequest,
  options?: CreateSandboxOptions,
): Promise<Sandbox>
```

Creates a sandbox and, by default, waits until it is `running`. Pass
`{ wait: false }` to return as soon as the row is created.

**`CreateSandboxRequest`** — `shape` is the only required field:

| Field | Type | Description |
|-------|------|-------------|
| `shape` | `string` | **Required.** A shape id from `listShapes()`. |
| `rootfs` | `string?` | Rootfs catalog name or template id/name. Empty = host default. |
| `name` | `string?` | User-facing name, unique per user. Empty = auto-generated. |
| `networks` | `NetworkEntry[]?` | Overlay networks to join at create time. |
| `disk_mib` | `number?` | Overlay disk size in MiB. `0` = shape default. |
| `egress` | `string[]?` | Egress allowlist. Empty / `["*"]` = allow all. |
| `envs` | `Record<string,string>?` | Env vars injected into every exec inside the sandbox. |
| `ssh_pubkeys` | `string[]?` | OpenSSH public keys for the SSH gateway. |
| `host_id` | `string?` | Pin placement to a specific host id. |
| `node_selector` | `Record<string,string>?` | Scheduler placement labels. |
| `ingress_enabled` | `boolean?` | Opt into HTTP ingress at create time. |
| `disks` | `DiskAttachment[]?` | Disks to mount at boot. |
| `region` | `string?` | Pin to a region. Must match the server's region. |
| `auto_pause_after_seconds` | `number?` | Idle auto-pause timeout in seconds (60–86400). |

Note: `bandwidth_quota_bytes` is **not** settable at create time; the
server rejects non-zero values. Set it at fork time via
`ForkSandboxRequest.bandwidth_quota_bytes` or top it up later with
`sandbox.rechargeBandwidth()`.

**`CreateSandboxOptions`** extends `RequestOptions`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `wait` | `boolean?` | `true` | Wait until the sandbox reaches `running`. |
| `waitTimeoutMs` | `number?` | `120000` | Wait budget in ms. |

Throws `CreateosSandboxValidationError` on unknown shape or rootfs.
Throws `CreateosSandboxAuthError` on missing or revoked API key.
Throws `CreateosSandboxPermissionError` on quota exceeded.
Throws `CreateosSandboxTimeoutError` on request or wait budget exhaustion.

```ts
const sandbox = await box.createSandbox({
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
});
console.log(sandbox.id, sandbox.ip);
```

---

### `getSandbox`

```ts
async getSandbox(id: string, options?: RequestOptions): Promise<Sandbox>
```

Connects to an existing sandbox by id.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | Sandbox id (`sb_…`). |

Throws `CreateosSandboxNotFoundError` when no sandbox with that id
exists.

```ts
const sandbox = await box.getSandbox("sb_01h…");
console.log(sandbox.status);
```

---

### `getSandboxByIP`

```ts
async getSandboxByIP(ip: string, options?: RequestOptions): Promise<Sandbox>
```

Connects to an existing sandbox by its private IP.

| Parameter | Type | Description |
|-----------|------|-------------|
| `ip` | `string` | Sandbox private IP (e.g. `"10.0.0.42"`). |

Throws `CreateosSandboxNotFoundError` when no sandbox with that IP
exists.

```ts
const sandbox = await box.getSandboxByIP("10.0.0.42");
console.log(sandbox.id);
```

---

### `listSandboxes`

```ts
async listSandboxes(options?: ListSandboxesOptions): Promise<Sandbox[]>
```

Lists the caller's sandboxes as connected handles. Fetches all pages by
default.

**`ListSandboxesOptions`** extends `RequestOptions`:

| Field | Type | Description |
|-------|------|-------------|
| `limit` | `number?` | Cap the number of handles returned. Omit to fetch every page. |
| `status` | `"running" \| "creating" \| "destroyed" \| "failed"?` | Filter to one lifecycle state. |

Note: the `status` filter accepts only `"running"`, `"creating"`,
`"destroyed"`, and `"failed"`. Transitional states
(`pausing`, `paused`, `resuming`, `forking`, `destroying`) are not valid
filter values.

Throws `CreateosSandboxAuthError` on missing or revoked API key.

```ts
const all = await box.listSandboxes({ status: "running" });
for (const s of all) console.log(s.id, s.ip);
```

---

### `iterateSandboxes`

```ts
async *iterateSandboxes(options?: ListSandboxesOptions): AsyncGenerator<Sandbox>
```

Streams the caller's sandboxes as connected handles, one page at a time.
Prefer over `listSandboxes` when the list may be large and you want to
start processing before all pages are fetched.

Same `ListSandboxesOptions` as `listSandboxes`.

```ts
for await (const s of box.iterateSandboxes({ status: "running" })) {
  console.log(s.id, s.ip);
}
```

---

## `client.templates` — `TemplatesApi`

Template (custom rootfs) operations.

### `templates.list`

```ts
list(options?: RequestOptions): Promise<TemplateView[]>
```

Lists every template owned by the caller. Fetches all pages.

```ts
const templates = await box.templates.list();
console.log(templates.map((t) => t.id));
```

---

### `templates.iterate`

```ts
iterate(options?: RequestOptions): AsyncGenerator<TemplateView>
```

Streams templates one page at a time.

```ts
for await (const t of box.templates.iterate()) console.log(t.id);
```

---

### `templates.create`

```ts
create(request: TemplateCreateRequest, options?: RequestOptions): Promise<TemplateView>
```

Submits a Dockerfile to build into a sandbox rootfs.

**`TemplateCreateRequest`:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Template name. |
| `dockerfile` | `string` | Dockerfile source. |
| `base` | `string?` | Base rootfs to build on. Empty = host default. |

Returns `TemplateView` with `status: "pending"` or `"building"` on
return; poll until `status === "ready"`.

```ts
const tpl = await box.templates.create({
  name: "my-devbox",
  dockerfile: "FROM debian:trixie-slim\nRUN apt-get update",
});
console.log(tpl.id, tpl.status);
```

---

### `templates.get`

```ts
get(id: string, options?: GetTemplateOptions): Promise<TemplateView>
```

Looks up a template by id.

| Field | Type | Description |
|-------|------|-------------|
| `options.include` | `"dockerfile"?` | Include the original Dockerfile in the response. |

```ts
const tpl = await box.templates.get("tpl_01h…", { include: "dockerfile" });
console.log(tpl.status, tpl.dockerfile);
```

---

### `templates.delete`

```ts
delete(id: string, options?: RequestOptions): Promise<OKResponse>
```

Deletes a template. Existing sandboxes built from it are unaffected.

```ts
await box.templates.delete("tpl_01h…");
```

---

### `templates.logs`

```ts
async logs(id: string, options?: TemplateLogsOptions): Promise<string>
```

Fetches the build log as plain text.

| Field | Type | Description |
|-------|------|-------------|
| `options.attempt` | `number?` | Filter to one build attempt. |

```ts
const logs = await box.templates.logs("tpl_01h…");
process.stdout.write(logs);
```

---

### `templates.followLogs`

```ts
followLogs(id: string, options?: TemplateLogsOptions): AsyncGenerator<TemplateLogEvent>
```

Follows the build log, yielding NDJSON events until the build finishes.

**`TemplateLogEvent`** fields:

| Field | Type | Description |
|-------|------|-------------|
| `ts` | `string?` | Timestamp. |
| `level` | `string?` | Log level. |
| `line` | `string?` | Log line content. |
| `final` | `boolean?` | `true` on the terminal frame. |
| `status` | `string?` | `"ready"` or `"failed"` on the terminal frame. |

```ts
for await (const ev of box.templates.followLogs("tpl_01h…")) {
  if (ev.line) process.stdout.write(ev.line);
  if (ev.final) console.log("build finished:", ev.status);
}
```

---

## `client.networks` — `NetworksApi`

Overlay network operations.

### `networks.list`

```ts
list(options?: RequestOptions): Promise<Network[]>
```

Lists every overlay network owned by the caller. Fetches all pages.

```ts
const nets = await box.networks.list();
console.log(nets.map((n) => n.id));
```

---

### `networks.iterate`

```ts
iterate(options?: RequestOptions): AsyncGenerator<Network>
```

Streams networks one page at a time.

---

### `networks.create`

```ts
create(request: NetworkCreateRequest, options?: RequestOptions): Promise<Network>
```

Creates an overlay network. Members are attached later via
`sandbox.attachNetwork`.

**`NetworkCreateRequest`:**

| Field | Type |
|-------|------|
| `name` | `string` |

```ts
const net = await box.networks.create({ name: "team-net" });
console.log(net.id);
```

---

### `networks.get`

```ts
get(id: string, options?: RequestOptions): Promise<Network>
```

Looks up a network by id.

```ts
const net = await box.networks.get("net_01h…");
console.log(net.cidr);
```

---

### `networks.delete`

```ts
delete(id: string, options?: RequestOptions): Promise<OKResponse>
```

Deletes an overlay network. Member sandboxes are detached but not
destroyed. Returns `CreateosSandboxValidationError` (409) when the
network still has active members.

```ts
await box.networks.delete("net_01h…");
```

---

## `client.disks` — `DisksApi`

S3-disk catalog operations. Disks are user-registered S3 buckets that can
be mounted into one or more sandboxes. The control plane returns HTTP 503
("disks API not configured") when the operator has not provisioned a
disk-credential cipher key.

### `disks.list`

```ts
list(options?: RequestOptions): Promise<DiskView[]>
```

Lists every registered S3 disk owned by the caller. Fetches all pages.

```ts
const disks = await box.disks.list();
console.log(disks.map((d) => d.name));
```

---

### `disks.iterate`

```ts
iterate(options?: RequestOptions): AsyncGenerator<DiskView>
```

Streams disks one page at a time.

---

### `disks.create`

```ts
create(request: DiskCreateRequest, options?: RequestOptions): Promise<DiskView>
```

Registers an S3 bucket as a mountable disk. The server HEADs the bucket
before accepting; a typo or bad credentials returns 400.

**`DiskCreateRequest`:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | User-scoped name matching `^[a-z0-9][a-z0-9-]{0,62}$`. |
| `kind` | `"s3"` | Storage backend type. |
| `config.bucket` | `string` | S3 bucket name. |
| `config.endpoint` | `string` | S3 endpoint URL. |
| `config.region` | `string?` | S3 region. |
| `config.use_path_style` | `boolean?` | Force path-style addressing (needed for MinIO / R2). |
| `credentials.access_key` | `string` | S3 access key id. |
| `credentials.secret_key` | `string` | S3 secret access key. |

Credentials are AES-GCM-encrypted at rest and never returned by any read
endpoint.

```ts
const disk = await box.disks.create({
  name: "shared-data",
  kind: "s3",
  config: { bucket: "my-bucket", endpoint: "https://s3.amazonaws.com", region: "us-east-1" },
  credentials: { access_key: process.env.AWS_ACCESS_KEY_ID!, secret_key: process.env.AWS_SECRET_ACCESS_KEY! },
});
console.log(disk.id);
```

---

### `disks.get`

```ts
get(idOrName: string, options?: RequestOptions): Promise<DiskView>
```

Looks up a disk by `disk_<ulid>` id or user-scoped name.

```ts
const disk = await box.disks.get("shared-data");
console.log(disk.config.bucket, disk.config.region);
```

---

### `disks.delete`

```ts
delete(idOrName: string, options?: RequestOptions): Promise<DiskDeletedResponse>
```

Deletes a disk. Returns `CreateosSandboxValidationError` (409) when the
disk is still attached to a non-destroyed sandbox — detach first.

Returns `DiskDeletedResponse`:

| Field | Type |
|-------|------|
| `deleted` | `boolean` |

```ts
await box.disks.delete("shared-data");
```

---

### `disks.rotateCredentials`

```ts
rotateCredentials(
  idOrName: string,
  credentials: DiskCredentials,
  options?: RequestOptions,
): Promise<DiskView>
```

Rotates a disk's S3 credentials. Replaces the stored access/secret key.
Non-secret config is untouched. Running sandboxes holding the disk pick
up the new credentials on their next resume.

**`DiskCredentials`:**

| Field | Type |
|-------|------|
| `access_key` | `string` |
| `secret_key` | `string` |

```ts
await box.disks.rotateCredentials("shared-data", {
  access_key: "AKIA…",
  secret_key: "…",
});
```
