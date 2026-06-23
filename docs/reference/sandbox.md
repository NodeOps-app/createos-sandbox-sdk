# Sandbox reference

`Sandbox` is the stateful handle returned by `CreateosSandboxClient` factory
methods. It owns a sandbox id and exposes lifecycle, command execution,
file transfer, egress/bandwidth, network, and disk operations. Mutating
calls refresh the handle's cached projection in place; read it via `data`
or the shorthand getters.

`SandboxFiles` handles file transfer for one sandbox. Reached via
`sandbox.files`.

Every method that reaches the control plane throws
`CreateosSandboxServerError` on 5xx and `CreateosSandboxConnectionError`
on network failure. Per-method `throws` entries list only
call-specific conditions.

---

## Static factories

### `Sandbox.create`

```ts
static async create(
  request: CreateSandboxRequest,
  options?: CreateosSandboxClientOptions & CreateSandboxOptions,
): Promise<Sandbox>
```

Creates a sandbox without constructing an `CreateosSandboxClient` first.
Equivalent to `new CreateosSandboxClient(options).createSandbox(request, options)`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `request` | `CreateSandboxRequest` | Sandbox creation body. `shape` is required. |
| `options` | `CreateosSandboxClientOptions & CreateSandboxOptions` | Client config merged with per-request and wait options. |

Returns `Promise<Sandbox>`.

Throws `CreateosSandboxValidationError` on unknown shape or rootfs.
Throws `CreateosSandboxAuthError` on missing or revoked API key.
Throws `CreateosSandboxPermissionError` on quota exceeded.
Throws `CreateosSandboxTimeoutError` on request or wait budget exhaustion.

```ts
import { Sandbox } from "@nodeops-createos/sandbox";
const sandbox = await Sandbox.create({
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
});
console.log(sandbox.id);
```

---

### `Sandbox.connect`

```ts
static async connect(
  id: string,
  options?: CreateosSandboxClientOptions & RequestOptions,
): Promise<Sandbox>
```

Connects to an existing sandbox by id without constructing an
`CreateosSandboxClient`. Equivalent to
`new CreateosSandboxClient(options).getSandbox(id, opts)`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | Sandbox id (`sb_…`). |
| `options` | `CreateosSandboxClientOptions & RequestOptions` | Client config merged with per-request options. |

Returns `Promise<Sandbox>`.

Throws `CreateosSandboxNotFoundError` when no sandbox with that id exists.
Throws `CreateosSandboxAuthError` on missing or revoked API key.
Throws `CreateosSandboxPermissionError` when the sandbox belongs to another
tenant.

```ts
import { Sandbox } from "@nodeops-createos/sandbox";
const sandbox = await Sandbox.connect("sb_01h…");
console.log(sandbox.status);
```

---

## Getters

These read the handle's last-known cached projection without a network
call. Call `sandbox.refresh()` first when you need a fresh view.

| Getter | Type | Description |
|--------|------|-------------|
| `id` | `string` | Sandbox id. |
| `status` | `SandboxStatus` | Current lifecycle state. |
| `ip` | `string \| undefined` | Private IP. `undefined` while the sandbox is still `creating`. |
| `name` | `string \| undefined` | User-facing name, when set. |
| `data` | `SandboxView` | Full last-known projection. Live internal reference — treat as read-only. |
| `files` | `SandboxFiles` | File transfer namespace. |

### `toJSON`

```ts
toJSON(): SandboxView
```

Returns the last-known projection. Called automatically by
`JSON.stringify(sandbox)`.

---

## Lifecycle

### `refresh`

```ts
async refresh(options?: RequestOptions): Promise<this>
```

Re-fetches the sandbox projection and updates the handle in place.

Throws `CreateosSandboxNotFoundError` when the sandbox no longer exists.

```ts
await sandbox.refresh();
console.log(sandbox.status);
```

---

### `pause`

```ts
async pause(options?: RequestOptions): Promise<this>
```

Snapshots the sandbox to storage. The handle updates to the
`pausing`/`paused` view on return.

Throws `CreateosSandboxValidationError` when the sandbox is not in a
pausable state.

```ts
await sandbox.pause();
await sandbox.waitUntilPaused();
```

---

### `resume`

```ts
async resume(options?: RequestOptions): Promise<this>
```

Restores a paused sandbox. The handle updates to the `resuming`/`running`
view on return.

Throws `CreateosSandboxValidationError` when the sandbox is not in a
resumable state.

```ts
await sandbox.resume();
await sandbox.waitUntilRunning();
```

---

### `fork`

```ts
async fork(
  request?: ForkSandboxRequest,
  options?: RequestOptions,
): Promise<Sandbox>
```

Clones a paused sandbox into a new independent `Sandbox`. Returns a new
handle; this handle is unchanged.

| Parameter | Type | Description |
|-----------|------|-------------|
| `request` | `ForkSandboxRequest` | Optional overrides for the fork. Omitted fields inherit from the source. |
| `options` | `RequestOptions` | Per-request options. |

**`ForkSandboxRequest` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `start_paused` | `boolean?` | Keep the fork `paused` instead of auto-resuming. |
| `ssh_pubkeys` | `string[]?` | Override SSH keys on the fork. |
| `egress` | `string[]?` | Override egress rules. |
| `ingress_enabled` | `boolean?` | Toggle ingress on the fork. |
| `envs` | `Record<string,string>?` | Override environment variables. |
| `bandwidth_quota_bytes` | `number?` | Set bandwidth quota on the fork. |

Throws `CreateosSandboxValidationError` when the source is not in a
forkable state.

```ts
await sandbox.pause();
const clone = await sandbox.fork();
console.log(clone.id);
```

---

### `destroy`

```ts
async destroy(options?: RequestOptions): Promise<DestroyedResponse>
```

Destroys the sandbox. The call returns when the row is in `destroying` or
`destroyed`. Use `waitUntilDestroyed` to wait for full reclamation.

Returns `DestroyedResponse`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Sandbox id. |
| `status` | `"destroying" \| "destroyed"` | Status reached by the destroy call. |

```ts
await sandbox.destroy();
await sandbox.waitUntilDestroyed();
```

---

### `resize`

```ts
async resize(diskMib: number, options?: RequestOptions): Promise<ResizeSandboxResponse>
```

Grows the overlay disk to `diskMib`. Disk size can only increase.

| Parameter | Type | Description |
|-----------|------|-------------|
| `diskMib` | `number` | New disk size in MiB. Must exceed current size. |

Returns `ResizeSandboxResponse`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Sandbox id. |
| `disk_mib` | `number` | New disk size in MiB. |

Throws `CreateosSandboxValidationError` when `diskMib` is at or below the
current size.

```ts
await sandbox.resize(4096);
```

---

### `addSSHPubkeys`

```ts
addSSHPubkeys(keys: string[], options?: RequestOptions): Promise<AddSSHPubkeysResponse>
```

Adds OpenSSH public keys to the sandbox's authorized set. Duplicates are
de-duplicated server-side. Works on a live sandbox (no pause required).

| Parameter | Type | Description |
|-----------|------|-------------|
| `keys` | `string[]` | OpenSSH-formatted public keys to add. |

Returns `AddSSHPubkeysResponse`:

| Field | Type | Description |
|-------|------|-------------|
| `count` | `number` | Total `ssh_pubkeys` on the sandbox after the add. |

Throws `CreateosSandboxValidationError` when a key is not a valid OpenSSH
public key.

```ts
const { count } = await sandbox.addSSHPubkeys([pubkey]);
```

---

## Waiters

All `waitUntil*` methods poll with adaptive backoff until the target state
is reached or the budget expires. They update the handle's cached
projection on each poll.

**`WaitOptions`:**

| Field | Type | Description |
|-------|------|-------------|
| `timeoutMs` | `number?` | Wait budget in ms. Default 120000. |
| `signal` | `AbortSignal?` | Abort signal to cancel the wait. |
| `request` | `RequestOptions?` | Per-request options applied to each poll refresh. |

---

### `waitUntilRunning`

```ts
async waitUntilRunning(options?: WaitOptions): Promise<this>
```

Polls until `status === "running"`. Aborts early on `error`, `failed`,
`destroying`, or `destroyed`.

Throws `CreateosSandboxError` when a terminal failure state is entered.
Throws `CreateosSandboxTimeoutError` when the budget elapses.

```ts
await sandbox.waitUntilRunning({ timeoutMs: 60_000 });
```

---

### `waitUntilPaused`

```ts
async waitUntilPaused(options?: WaitOptions): Promise<this>
```

Polls until `status === "paused"`. Aborts early on `error`, `failed`,
`destroying`, or `destroyed`.

```ts
await sandbox.pause();
await sandbox.waitUntilPaused();
```

---

### `waitUntilDestroyed`

```ts
async waitUntilDestroyed(options?: WaitOptions): Promise<this>
```

Polls until `status === "destroyed"`. `destroying` is an intermediate
step and does not abort the wait.

```ts
await sandbox.destroy();
await sandbox.waitUntilDestroyed();
```

---

## Commands

### `runCommand`

```ts
async runCommand(
  cmd: string,
  args?: string[],
  options?: ExecOptions,
): Promise<ExecResponse>
```

Runs a command to completion and returns buffered output.

| Parameter | Type | Description |
|-----------|------|-------------|
| `cmd` | `string` | Executable to run. Not passed through a shell — use `"bash"` with `["-c", "…"]` for shell features. |
| `args` | `string[]` | Arguments passed to `cmd`. Default `[]`. |
| `options` | `ExecOptions` | Per-request options (`timeoutMs`, `signal`, `headers`, `retry`). |

Returns `ExecResponse`:

| Field | Type | Description |
|-------|------|-------------|
| `result.stdout` | `string` | Captured standard output. |
| `result.stderr` | `string` | Captured standard error. |
| `result.exit_code` | `number` | Process exit code. 0 = success. |
| `result.error` | `string?` | Agent-level failure (command could not be started). |
| `exec_ms` | `number` | Wall-clock run time in ms. |

Throws `CreateosSandboxValidationError` when the command shape is
rejected.

```ts
const out = await sandbox.runCommand("uname", ["-a"]);
console.log(out.result.stdout);

// Shell features — wrap in bash:
const { result } = await sandbox.runCommand("bash", ["-c", "ls -la /tmp | wc -l"]);
```

---

### `streamCommand`

```ts
async *streamCommand(
  cmd: string,
  args?: string[],
  options?: ExecOptions,
): AsyncGenerator<ExecStreamEvent>
```

Runs a command and yields a discriminated-union event stream as output
arrives. Streaming requests are never retried.

| Parameter | Type | Description |
|-----------|------|-------------|
| `cmd` | `string` | Executable to run. |
| `args` | `string[]` | Arguments. Default `[]`. |
| `options` | `ExecOptions` | Per-request options. |

**`ExecStreamEvent` union:**

| `type` | Extra fields | Description |
|--------|-------------|-------------|
| `"stdout"` | `data: string` | A chunk of standard output. |
| `"stderr"` | `data: string` | A chunk of standard error. |
| `"exit"` | `exitCode: number` | Process exited. |
| `"error"` | `message: string` | Agent-level failure. |
| `"heartbeat"` | — | Keep-alive frame emitted every 5 s. |

```ts
for await (const ev of sandbox.streamCommand("tail", ["-f", "/var/log/syslog"])) {
  switch (ev.type) {
    case "stdout":    process.stdout.write(ev.data); break;
    case "stderr":    process.stderr.write(ev.data); break;
    case "exit":      console.log("exit:", ev.exitCode); break;
    case "error":     console.error(ev.message); break;
    case "heartbeat": break;
  }
}
```

---

### `sh`

```ts
async sh(
  script: string,
  options?: ExecOptions & { label?: string },
): Promise<ExecResponse>
```

Runs a shell script via `bash -lc` and throws if it exits non-zero.
Convenience wrapper around `runCommand("bash", ["-lc", script])`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `script` | `string` | Shell script. Pipes, redirection, `&&` chains, and globbing all work. |
| `options.label` | `string?` | Tags the thrown error message on non-zero exit. |

Throws `CreateosSandboxError` when the command exits non-zero or the
agent reports a start failure. The error includes the label, exit code,
run duration, and the tail of stdout/stderr.

```ts
await sandbox.sh("apt-get update -qq && apt-get install -y curl", {
  label: "apt",
  timeoutMs: 300_000,
});
const { result } = await sandbox.sh("cat /etc/os-release");
console.log(result.stdout);
```

---

## Files (`SandboxFiles`)

Reached via `sandbox.files`.

### `upload`

```ts
async upload(
  path: string,
  data: BodyInit,
  options?: RequestOptions,
): Promise<void>
```

Uploads raw bytes to an absolute path inside the sandbox.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | Absolute path inside the sandbox, e.g. `/srv/index.html`. |
| `data` | `BodyInit` | Content to upload (`string`, `Uint8Array`, `ArrayBuffer`, `Blob`, etc.). |

Throws `CreateosSandboxValidationError` on invalid path or rejected body.
Throws `CreateosSandboxNotFoundError` when the sandbox no longer exists.

```ts
await sandbox.files.upload("/srv/index.html", "<h1>Hello</h1>");

// From a local file (Node/Bun):
import { readFileSync } from "fs";
await sandbox.files.upload("/app/data.json", readFileSync("data.json"));
```

---

### `download`

```ts
async download(
  path: string,
  options?: RequestOptions,
): Promise<ArrayBuffer>
```

Downloads a file from the sandbox as raw bytes.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | Absolute path inside the sandbox. |

Returns `Promise<ArrayBuffer>`.

Throws `CreateosSandboxNotFoundError` when the sandbox or path does not
exist.

```ts
const buf = await sandbox.files.download("/etc/os-release");
console.log(new TextDecoder().decode(buf));
```

---

## Ingress & ports

### `setIngress`

```ts
async setIngress(enabled: boolean, options?: RequestOptions): Promise<this>
```

Enables or disables HTTP ingress. The handle updates to the patched view.

| Parameter | Type | Description |
|-----------|------|-------------|
| `enabled` | `boolean` | `true` to enable, `false` to disable. |

```ts
await sandbox.setIngress(true);
console.log(sandbox.previewUrl(8080));
```

---

### `previewUrl`

```ts
previewUrl(port: number, options?: { scheme?: "http" | "https" }): string
```

Builds the public ingress URL for a port. Synchronous — no network call.
Only available when the sandbox was created with `ingress_enabled: true`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `port` | `number` | In-guest port (1–65535). |
| `options.scheme` | `"http" \| "https"` | URL scheme override. Default `"https"`. |

Throws `CreateosSandboxError` when `port` is invalid or ingress is not
enabled.

```ts
const url = sandbox.previewUrl(8080);
// Force HTTP when the TLS cert is not yet provisioned:
const plain = sandbox.previewUrl(8080, { scheme: "http" });
```

---

### `setAutoPause`

```ts
async setAutoPause(
  seconds: number | null,
  options?: RequestOptions,
): Promise<this>
```

Sets or clears the idle auto-pause timeout. The handle updates to the
patched view.

| Parameter | Type | Description |
|-----------|------|-------------|
| `seconds` | `number \| null` | Idle timeout in **seconds** (60–86400), or `null` to disable. |

Throws `CreateosSandboxValidationError` when `seconds` is outside
60–86400.

```ts
await sandbox.setAutoPause(600);  // pause after 10 min idle
await sandbox.setAutoPause(null); // disable
```

---

### `waitForPortReady`

```ts
async waitForPortReady(
  port: number,
  options?: WaitOptions & { intervalMs?: number; host?: string },
): Promise<this>
```

Polls a TCP port from inside the sandbox using `bash`'s `/dev/tcp` shim
until something is listening. Requires `bash` and GNU `timeout` in the
rootfs.

| Parameter | Type | Description |
|-----------|------|-------------|
| `port` | `number` | Port to probe (1–65535). |
| `options.host` | `string?` | Host to probe. Default `"127.0.0.1"`. |
| `options.timeoutMs` | `number?` | Wait budget in ms. Default 30000. |
| `options.intervalMs` | `number?` | Poll interval in ms. Default 200. |

Throws `CreateosSandboxTimeoutError` when the port is still closed when
the budget runs out.
Throws `CreateosSandboxError` when `port` or `host` are invalid.

```ts
await sandbox.runCommand("sh", ["-c", "python3 -m http.server 8080 &"]);
await sandbox.waitForPortReady(8080, { timeoutMs: 10_000 });
```

---

## Egress

### `getEgress`

```ts
getEgress(options?: RequestOptions): Promise<EgressView>
```

Returns the current egress allowlist and counters.

Returns `EgressView`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Sandbox id. |
| `egress` | `string[]` | Active `host:port` allow rules. Empty = allow all. |

```ts
const egress = await sandbox.getEgress();
console.log(egress.egress);
```

---

### `setEgress`

```ts
setEgress(rules: string[] | null, options?: RequestOptions): Promise<EgressView>
```

Replaces the egress allowlist. `null` or `[]` opens all egress.

| Parameter | Type | Description |
|-----------|------|-------------|
| `rules` | `string[] \| null` | `host:port` allow rules. `null` or `[]` = allow all. |

Throws `CreateosSandboxValidationError` when a rule is malformed.

```ts
await sandbox.setEgress(["api.openai.com:443", "registry.npmjs.org:443"]);
await sandbox.setEgress(null); // open all
```

---

## Bandwidth

### `getBandwidth`

```ts
getBandwidth(options?: RequestOptions): Promise<BandwidthView>
```

Returns the current bandwidth quota and usage.

Returns `BandwidthView`:

| Field | Type | Description |
|-------|------|-------------|
| `quota_bytes` | `number` | Total byte quota. -1 = unmetered. |
| `used_bytes` | `number` | Egress bytes billed against the quota. |
| `ingress_bytes` | `number` | Inbound bytes (observed, never enforced). |
| `remaining_bytes` | `number` | Bytes left before the sandbox is network-capped. |
| `capped` | `boolean` | `true` when the quota is exhausted and egress is blocked. |

```ts
const bw = await sandbox.getBandwidth();
console.log(bw.used_bytes, bw.quota_bytes);
```

---

### `rechargeBandwidth`

```ts
rechargeBandwidth(addBytes: number, options?: RequestOptions): Promise<BandwidthView>
```

Tops up the bandwidth quota by `addBytes`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `addBytes` | `number` | Bytes to add to the quota. |

Note: `bandwidth_quota_bytes` is not settable at create time; set it at
fork time via `ForkSandboxRequest.bandwidth_quota_bytes` or top it up
here post-create.

```ts
await sandbox.rechargeBandwidth(10 * 1024 * 1024 * 1024); // +10 GiB
```

---

## Networks

### `attachNetwork`

```ts
attachNetwork(networkId: string, options?: RequestOptions): Promise<OKResponse>
```

Attaches the sandbox to an overlay network.

| Parameter | Type | Description |
|-----------|------|-------------|
| `networkId` | `string` | Network id (`net_…`). |

Throws `CreateosSandboxNotFoundError` when the network does not exist.

```ts
await sandbox.attachNetwork("net_01h…");
```

---

### `detachNetwork`

```ts
detachNetwork(networkId: string, options?: RequestOptions): Promise<OKResponse>
```

Detaches the sandbox from an overlay network.

```ts
await sandbox.detachNetwork("net_01h…");
```

---

## Disks

### `listDisks`

```ts
listDisks(options?: RequestOptions): Promise<SandboxDiskView[]>
```

Lists all disks attached to this sandbox with per-attachment mount
status. Fetches all pages.

Returns `SandboxDiskView[]`:

| Field | Type | Description |
|-------|------|-------------|
| `disk_id` | `string` | Registered disk id. |
| `name` | `string` | Disk name. |
| `mount_path` | `string` | Absolute path in the guest. |
| `sub_path` | `string?` | Bucket sub-folder, when set. |
| `mount_status` | `DiskMountStatus` | `"pending" \| "mounted" \| "error" \| "unmounting"` |
| `mount_error` | `string?` | Failure detail when `mount_status` is `"error"`. |

```ts
const disks = await sandbox.listDisks();
for (const d of disks) console.log(d.disk_id, d.mount_path, d.mount_status);
```

---

### `iterateDisks`

```ts
iterateDisks(options?: RequestOptions): AsyncGenerator<SandboxDiskView>
```

Streams disks one page at a time instead of buffering the whole list.

```ts
for await (const d of sandbox.iterateDisks()) console.log(d.disk_id);
```

---

### `attachDisk`

```ts
attachDisk(opts: AttachDiskOptions, options?: RequestOptions): Promise<OKResponse>
```

Live-attaches a registered disk into a running sandbox. The server
rejects with 409 if the sandbox is not `running`.

**`AttachDiskOptions`:**

| Field | Type | Description |
|-------|------|-------------|
| `diskId` | `string` | `disk_<ulid>` id or user-scoped disk name. |
| `mountPath` | `string` | Absolute path inside the guest, e.g. `/mnt/data`. |
| `subPath` | `string?` | Optional bucket sub-folder to expose at `mountPath`. |

Throws `CreateosSandboxValidationError` when the sandbox is not running
or the mount path collides.
Throws `CreateosSandboxNotFoundError` when the sandbox or disk does not
exist.

```ts
await sandbox.attachDisk({ diskId: "shared-data", mountPath: "/mnt/data" });
```

---

### `detachDisk`

```ts
detachDisk(opts: DetachDiskOptions, options?: RequestOptions): Promise<DiskDetachedResponse>
```

Detaches a disk. `mountPath` is required because the same disk may be
attached at multiple paths.

**`DetachDiskOptions`:**

| Field | Type | Description |
|-------|------|-------------|
| `diskId` | `string` | `disk_<ulid>` id or user-scoped disk name. |
| `mountPath` | `string` | Absolute path where the disk is currently mounted. |

Returns `DiskDetachedResponse`:

| Field | Type |
|-------|------|
| `detached` | `boolean` |

```ts
await sandbox.detachDisk({ diskId: "shared-data", mountPath: "/mnt/data" });
```

---

## Common option types

### `RequestOptions`

Accepted by every SDK method as the last parameter.

| Field | Type | Description |
|-------|------|-------------|
| `signal` | `AbortSignal?` | Abort signal. |
| `headers` | `HeadersInit?` | Headers merged into this request, overriding client defaults. |
| `timeoutMs` | `number?` | Per-request timeout in ms. `0` disables. |
| `retry` | `RetryOptions \| false?` | Retry policy override. `false` disables retries. |

### `SandboxStatus`

```ts
type SandboxStatus =
  | "creating" | "running" | "pausing" | "paused" | "resuming"
  | "forking" | "error" | "destroying" | "destroyed" | "failed";
```
