# Wire Types Reference

All TypeScript types used in the `createos-sandbox-sdk`. Source of truth is
`src/types.ts`; this page mirrors it. Fields marked **optional** (`?`) are
`omitempty` server-side — the key is absent, not null.

---

## Client Options

### `CreateosSandboxClientOptions`

Construction options for `CreateosSandboxClient`. All fields are optional.

| Field | Type | Description |
|---|---|---|
| `apiKey` | `string?` | API key sent as `X-Api-Key`. Falls back to `CREATEOS_SANDBOX_API_KEY` env var. |
| `authHeaders` | `HeadersInit?` | Auth headers used instead of an API key (e.g. a session token). |
| `baseUrl` | `string?` | Control-plane base URL. Falls back to `CREATEOS_SANDBOX_BASE_URL` env var. |
| `fetch` | `typeof fetch?` | Custom fetch implementation. Defaults to `globalThis.fetch`. |
| `headers` | `HeadersInit?` | Headers merged into every request. |
| `timeoutMs` | `number?` | Per-request timeout in ms. Default `60000`. `0` disables it. |
| `retry` | `RetryOptions \| false?` | Retry policy, or `false` to disable retries. |
| `userAgent` | `string?` | Overrides the `User-Agent` header. |
| `hooks` | `ClientHooks?` | Lifecycle hooks for observability. Payloads are pre-redacted. |

### `RetryOptions`

Exponential-backoff retry policy. Omit a field to keep its default.

| Field | Type | Description |
|---|---|---|
| `maxRetries` | `number?` | Extra attempts after the first. Default `2` (3 total). |
| `baseDelayMs` | `number?` | Base backoff delay in ms. Default `500`. |
| `maxDelayMs` | `number?` | Backoff ceiling in ms. Default `30000`. |

### `ClientHooks`

Optional lifecycle hooks for observability. A throw inside a hook is swallowed.
Hooks are awaited — keep work cheap or dispatch without returning the promise.

| Field | Type | Description |
|---|---|---|
| `onRequest` | `(ctx: RequestHookContext) => void \| Promise<void>` | Fires before each attempt. |
| `onResponse` | `(ctx: ResponseHookContext) => void \| Promise<void>` | Fires after each response. |
| `onRetry` | `(ctx: RetryHookContext) => void \| Promise<void>` | Fires before each retry sleep. |

### `RequestHookContext`

Delivered to `ClientHooks.onRequest`. Credentials are pre-redacted.

| Field | Type | Description |
|---|---|---|
| `url` | `string` | URL with userinfo stripped and sensitive query params redacted. |
| `method` | `string` | Uppercase HTTP method. |
| `headers` | `Record<string, string>` | Outgoing headers with credentials replaced by `"redacted"`. |
| `attempt` | `number` | `1` for the first try, `2+` for retries. |

### `ResponseHookContext`

Extends `RequestHookContext`. Delivered to `ClientHooks.onResponse`.

| Field | Type | Description |
|---|---|---|
| `status` | `number` | HTTP status code. |
| `durationMs` | `number` | Elapsed time for the fetch call in ms. |
| `requestId` | `string?` | Server-supplied request id, when present. |

### `RetryHookContext`

Extends `ResponseHookContext` (with `status` made optional). Delivered to `ClientHooks.onRetry`.

| Field | Type | Description |
|---|---|---|
| `status` | `number?` | HTTP status that triggered the retry. Undefined for network errors. |
| `reason` | `RetryReason` | Why the SDK is retrying: `"network" \| "status" \| "rate-limit"`. |
| `delayMs` | `number` | Milliseconds the SDK will sleep before the next attempt. |

### `RequestOptions`

Per-call overrides accepted by every SDK method.

| Field | Type | Description |
|---|---|---|
| `signal` | `AbortSignal?` | Cancel the request and any in-flight retry backoff. |
| `headers` | `HeadersInit?` | Headers merged into this request, overriding client defaults. |
| `timeoutMs` | `number?` | Per-request timeout in ms, overriding the client default. `0` disables. |
| `retry` | `RetryOptions \| false?` | Retry policy for this request, overriding the client default. |

---

## Sandbox

### `SandboxStatus`

```ts
type SandboxStatus =
  | "creating" | "running" | "pausing" | "paused"
  | "resuming" | "forking" | "error"
  | "destroying" | "destroyed" | "failed"
```

Transitional states (`creating`, `pausing`, `resuming`, `forking`, `destroying`)
settle into a steady or terminal state.

### `SandboxView`

Full server-side projection of a sandbox. Returned by get/list endpoints and
backs the `Sandbox` handle. Optional fields are `omitempty` server-side.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Sandbox id. |
| `status` | `SandboxStatus` | Current lifecycle state. |
| `ip` | `string?` | Private IP. Absent while `creating`. |
| `vcpu` | `number` | Virtual CPU count. |
| `mem_mib` | `number` | Memory in MiB. |
| `disk_mib` | `number` | Overlay disk size in MiB. |
| `created_at` | `string` | RFC 3339 creation timestamp. |
| `ingress_enabled` | `boolean` | Whether HTTP ingress is active. |
| `ingress_url_template` | `string?` | Ingress URL template with `<port>` placeholder. Present when `ingress_enabled` and the control plane knows its public domain. |
| `name` | `string?` | User-facing name. |
| `running_at` | `string?` | RFC 3339 timestamp of when the VM last reached `running`. |
| `destroyed_at` | `string?` | RFC 3339 timestamp of destruction. |
| `spawn_ms` | `number?` | Wall-clock boot time in ms. |
| `shape` | `string?` | Shape id used to create the sandbox. |
| `rootfs` | `string?` | Rootfs catalog name or template id. |
| `region` | `string?` | Region the sandbox was placed in. |
| `egress` | `string[]?` | Active egress allowlist. Empty = allow all. |
| `envs` | `string[]?` | Names of env vars stored on the sandbox. Values are never returned. |
| `ssh_pubkeys` | `string[]?` | OpenSSH public keys authorized for the SSH gateway. |
| `created_by` | `string?` | Identity that created the sandbox. |
| `bandwidth_ingress_bytes` | `number?` | Inbound bytes observed (never enforced). |
| `paused_at` | `string?` | RFC 3339 timestamp of the last pause. |
| `last_resumed_at` | `string?` | RFC 3339 timestamp of the last resume. |
| `forked_from` | `string?` | Source sandbox id when created via `fork`. |
| `auto_pause_after_seconds` | `number?` | Idle auto-pause timeout in seconds. Absent when disabled. |

### `CreateSandboxRequest`

Body of `POST /v1/sandboxes`. Only `shape` is required.

| Field | Type | Description |
|---|---|---|
| `shape` | `string` | **Required.** A shape id from `listShapes()`. |
| `rootfs` | `string?` | Rootfs catalog name or template id/name. Empty = host default. |
| `name` | `string?` | User-facing name, unique per user. Empty = auto-generated. |
| `networks` | `NetworkEntry[]?` | Overlay networks to join at create time. |
| `disk_mib` | `number?` | Overlay disk size in MiB. `0` = shape default. |
| `egress` | `string[]?` | Egress allowlist. Empty / `["*"]` = allow all. |
| `envs` | `Record<string, string>?` | Env vars injected into every command inside the sandbox. |
| `ssh_pubkeys` | `string[]?` | OpenSSH public keys authorized for the SSH gateway. |
| `host_id` | `string?` | Pin placement to a specific host. Empty = scheduler picks. |
| `node_selector` | `Record<string, string>?` | Scheduler placement labels (k8s NodeSelector semantics). |
| `ingress_enabled` | `boolean?` | Opt the sandbox into HTTP ingress at create time. |
| `disks` | `DiskAttachment[]?` | Disks to mount into the sandbox at boot. |
| `region` | `string?` | Pin to a region. Must equal the server's region when set. |
| `auto_pause_after_seconds` | `number?` | Idle auto-pause after N seconds (60–86400). Omit to disable. |

### `CreateSandboxOptions`

Extends `RequestOptions`. Passed to `createSandbox()`.

| Field | Type | Description |
|---|---|---|
| `wait` | `boolean?` | Wait until `running` before resolving. Default `true`. |
| `waitTimeoutMs` | `number?` | Budget for the wait in ms. Default `120000`. |

### `ListSandboxesOptions`

Extends `RequestOptions`. Filters for `listSandboxes()`.

| Field | Type | Description |
|---|---|---|
| `limit` | `number?` | Cap the number of handles returned. Omit to fetch every page. |
| `status` | `"running" \| "creating" \| "destroyed" \| "failed"?` | Filter to one lifecycle state. |

### `ForkSandboxRequest`

Optional overrides applied to a fork. Omitted fields inherit from the source sandbox.

| Field | Type | Description |
|---|---|---|
| `start_paused` | `boolean?` | Keep the fork `paused` instead of auto-resuming. |
| `ssh_pubkeys` | `string[]?` | Replace the source's SSH keys. |
| `egress` | `string[]?` | Replace the source's egress allowlist. |
| `ingress_enabled` | `boolean?` | Override the source's ingress setting. |
| `envs` | `Record<string, string>?` | Replace the source's env vars. |
| `bandwidth_quota_bytes` | `number?` | Override the fork's bandwidth quota. |

### `PatchSandboxRequest`

Body of the sandbox PATCH endpoint. Used by `Sandbox.setIngress` and `Sandbox.setAutoPause`.
Omitted fields are left unchanged.

| Field | Type | Description |
|---|---|---|
| `ingress_enabled` | `boolean?` | Enable or disable HTTP ingress. |
| `auto_pause_after_seconds` | `number?` | Idle auto-pause timeout in seconds (60–86400). |
| `disable_auto_pause` | `boolean?` | When `true`, clears the auto-pause timeout. Needed because omitting `auto_pause_after_seconds` means "leave unchanged". |

### `AddSSHPubkeysRequest`

Body of `Sandbox.addSSHPubkeys`.

| Field | Type | Description |
|---|---|---|
| `keys` | `string[]` | OpenSSH-formatted public keys. Already-present keys are de-duplicated. |

### `AddSSHPubkeysResponse`

Result of `Sandbox.addSSHPubkeys`.

| Field | Type | Description |
|---|---|---|
| `count` | `number` | Total `ssh_pubkeys` on the sandbox after the add. |

### `DestroyedResponse`

Result of `Sandbox.destroy`.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Id of the sandbox accepted for destruction. |
| `status` | `"destroying" \| "destroyed"` | `"destroying"` for async reclaim; `"destroyed"` when already terminal or reclaimed inline. |

---

## Commands

Commands run inside the sandbox guest. Set env vars at create/fork time — they
cannot be passed per-command.

### `ExecRequest`

Body of `POST /v1/sandboxes/:id/exec`. Sent by `runCommand` / `streamCommand`.

| Field | Type | Description |
|---|---|---|
| `cmd` | `string` | Executable to run. Not passed through a shell — use `["bash", "-c", "…"]` for pipes/globs. |
| `args` | `string[]?` | Arguments passed to `cmd`. |
| `stream` | `boolean?` | Stream output as NDJSON frames. Set automatically by `streamCommand`. |

### `ExecResponse`

Result of `Sandbox.runCommand`. Buffered output plus timing.

| Field | Type | Description |
|---|---|---|
| `result` | `ExecResult` | Captured output and exit code. |
| `exec_ms` | `number` | Wall-clock time the command ran in ms. |

### `ExecResult`

Nested in `ExecResponse`.

| Field | Type | Description |
|---|---|---|
| `stdout` | `string` | Captured standard output. |
| `stderr` | `string` | Captured standard error. |
| `exit_code` | `number` | Process exit code. `0` = success. |
| `error` | `string?` | Agent-level failure message (command could not be started). |

### `ExecStreamEvent`

Discriminated union yielded by `Sandbox.streamCommand`. Switch on `type`.

| `type` | Additional fields | Description |
|---|---|---|
| `"stdout"` | `data: string` | A chunk of standard output. |
| `"stderr"` | `data: string` | A chunk of standard error. |
| `"exit"` | `exitCode: number` | Process exit code. Terminal event. |
| `"error"` | `message: string` | Agent-level failure. Terminal event. |
| `"heartbeat"` | — | Server keepalive, emitted every ~5s. |

### `ExecStreamFrame`

Raw NDJSON frame as emitted by the server. Exposed for advanced users who need
the snake_case wire shape (e.g. log forwarders). `ExecStreamEvent` is the
preferred higher-level type.

| Field | Type | Description |
|---|---|---|
| `stdout` | `string?` | Standard output chunk. |
| `stderr` | `string?` | Standard error chunk. |
| `exit_code` | `number?` | Process exit code. |
| `error` | `string?` | Agent-level failure. |
| `hb` | `boolean?` | Heartbeat marker. |

### `ExecOptions`

Type alias for `RequestOptions`. Per-call overrides for `runCommand` / `streamCommand`.

---

## Files

File upload and download (`Sandbox.uploadFile` / `Sandbox.downloadFile`) transfer
raw binary — there are no dedicated request or response wrapper types. Use
`RequestOptions` for per-call overrides.

---

## Ingress

Ingress is not a separate resource — it is a field on `SandboxView`:

| Field | Description |
|---|---|
| `ingress_enabled` | Whether HTTP ingress is active. |
| `ingress_url_template` | URL template with a literal `<port>` placeholder. Replace `<port>` with the guest port to get the public URL. Present when `ingress_enabled` is true. |

Enable/disable via `Sandbox.setIngress()`, which patches `ingress_enabled`.

---

## Egress

### `EgressView`

Returned by `getEgress()` / `setEgress()`.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Sandbox id. |
| `egress` | `string[]` | Active `host:port` allow rules. Empty = allow all. |

### `SetEgressRequest`

Body of `Sandbox.setEgress`. Replaces the entire egress allowlist.

| Field | Type | Description |
|---|---|---|
| `egress` | `string[] \| null?` | Allow rules. `null`, omitted, or `[]` means allow all. |

---

## Bandwidth

### `BandwidthView`

Returned by `getBandwidth()` / `rechargeBandwidth()`.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Sandbox id. |
| `quota_bytes` | `number` | Total transferable byte quota. `-1` = unmetered. |
| `used_bytes` | `number` | Egress bytes billed against the quota. |
| `ingress_bytes` | `number` | Inbound bytes observed (never enforced). |
| `remaining_bytes` | `number` | Bytes left before the sandbox is network-capped. |
| `capped` | `boolean` | `true` once the quota is exhausted and egress is blocked. |

### `RechargeBandwidthRequest`

Body of `Sandbox.rechargeBandwidth`.

| Field | Type | Description |
|---|---|---|
| `add_bytes` | `number` | Bytes to add to the quota. |

---

## Resize

### `ResizeSandboxRequest`

Body of `Sandbox.resize`.

| Field | Type | Description |
|---|---|---|
| `disk_mib` | `number` | New overlay disk size in MiB. Must be larger than the current size. |

### `ResizeSandboxResponse`

Result of `Sandbox.resize`.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Sandbox id. |
| `disk_mib` | `number` | New overlay disk size in MiB after the grow. |

---

## Networks

### `NetworkEntry`

References an overlay network by id in `CreateSandboxRequest.networks`.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Network id. |

### `NetworkCreateRequest`

Body of `networks.create`.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | User-scoped network name. |

### `Network`

An overlay network. Returned by the networks endpoints.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Network id. |
| `name` | `string` | User-facing name. |
| `created_at` | `string` | RFC 3339 creation timestamp. |
| `member_count` | `number?` | Number of attached sandboxes. Present on list responses. |
| `members` | `NetworkMember[]?` | Attached sandboxes with per-network addresses. Present on detail GET. |

### `NetworkMember`

A sandbox attached to an overlay network.

| Field | Type | Description |
|---|---|---|
| `sandbox_id` | `string` | The member sandbox's id. |
| `status` | `string` | Membership status. |
| `ip` | `string?` | The member's IP on this overlay network. Absent until membership is programmed. |
| `name` | `string?` | The member sandbox's user-facing name, when set. |

---

## Disks

### `DiskKind`

```ts
type DiskKind = "s3"
```

Storage backend for a registered disk. Only `"s3"` today.

### `DiskConfig`

Non-secret S3 disk configuration. Persisted server-side.

| Field | Type | Description |
|---|---|---|
| `bucket` | `string` | S3 bucket name. |
| `endpoint` | `string` | S3-compatible endpoint URL. |
| `region` | `string?` | AWS/S3 region. |
| `use_path_style` | `boolean?` | Force path-style addressing. Needed for MinIO/R2 with custom domains. |

### `DiskCredentials`

Bucket credentials. Sent only on create. AES-GCM-encrypted at rest; never returned by any read endpoint.

| Field | Type | Description |
|---|---|---|
| `access_key` | `string` | S3 access key id. |
| `secret_key` | `string` | S3 secret access key. |

### `DiskCreateRequest`

Body of `POST /v1/disks`.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | User-scoped name. Must match `^[a-z0-9][a-z0-9-]{0,62}$`. |
| `kind` | `DiskKind` | Storage backend. |
| `config` | `DiskConfig` | Non-secret S3 configuration. |
| `credentials` | `DiskCredentials` | Bucket credentials (write-only). |

### `DiskView`

User-facing projection of a registered disk. Credentials never appear here.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Disk id. |
| `name` | `string` | User-scoped name. |
| `kind` | `DiskKind` | Storage backend. |
| `config` | `DiskConfig` | Non-secret S3 configuration. |
| `created_at` | `string` | RFC 3339 creation timestamp. |

### `DiskDeletedResponse`

Result of `disks.delete`.

| Field | Type | Description |
|---|---|---|
| `deleted` | `boolean` | Confirmation that the disk was deleted. |

### `DiskAttachment`

One element of `CreateSandboxRequest.disks` or the body of `POST /v1/sandboxes/:id/disks`.

| Field | Type | Description |
|---|---|---|
| `disk_id` | `string` | A `disk_<ulid>` id or the user-scoped disk name. |
| `mount_path` | `string` | Absolute path inside the sandbox, e.g. `/mnt/data`. |
| `sub_path` | `string?` | Bucket sub-folder to expose at `mount_path`. Empty = bucket root. Must not start with `/` or contain `..`. |

### `DiskMountStatus`

```ts
type DiskMountStatus = "pending" | "mounted" | "error" | "unmounting"
```

Mount status reported by the in-sandbox agent.

### `SandboxDiskView`

Per-attachment projection returned from `GET /v1/sandboxes/:id/disks`.

| Field | Type | Description |
|---|---|---|
| `disk_id` | `string` | The `disk_<ulid>` id of the registered disk. |
| `name` | `string` | User-scoped disk name. |
| `kind` | `DiskKind` | Storage backend. |
| `config` | `DiskConfig` | Non-secret S3 configuration. |
| `mount_path` | `string` | Absolute path inside the sandbox where the disk is mounted. |
| `sub_path` | `string?` | Bucket sub-folder exposed at `mount_path`, when set. |
| `mount_status` | `DiskMountStatus` | Current mount state. |
| `mount_error` | `string?` | Failure detail when `mount_status` is `"error"`. |

### `DiskDetachedResponse`

Result of `Sandbox.detachDisk`.

| Field | Type | Description |
|---|---|---|
| `detached` | `boolean` | Confirmation that the disk was detached. |

### `AttachDiskOptions`

Options for `Sandbox.attachDisk`.

| Field | Type | Description |
|---|---|---|
| `diskId` | `string` | A `disk_<ulid>` id or the user-scoped disk name. |
| `mountPath` | `string` | Absolute path inside the sandbox, e.g. `/mnt/data`. |
| `subPath` | `string?` | Optional bucket sub-folder to expose at `mountPath`. |

### `DetachDiskOptions`

Options for `Sandbox.detachDisk`.

| Field | Type | Description |
|---|---|---|
| `diskId` | `string` | A `disk_<ulid>` id or the user-scoped disk name. |
| `mountPath` | `string` | Absolute path where the disk is currently mounted. Required — the same disk may be attached at multiple paths, and the composite key is `(sandbox, disk, mountPath)`. |

---

## Templates

### `TemplateStatus`

```ts
type TemplateStatus = "pending" | "building" | "ready" | "failed"
```

Build state of a template. Usable as a rootfs once `"ready"`.

### `TemplateCreateRequest`

Body of `templates.create`.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Template name. |
| `dockerfile` | `string` | Dockerfile source built into the rootfs image. |
| `base` | `string?` | Base rootfs catalog name to build on top of. Empty = host default. |

### `TemplateView`

A custom rootfs template. Returned by the templates endpoints.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Template id. |
| `name` | `string` | User-facing name. |
| `base` | `string` | Base rootfs the template was built on. |
| `status` | `TemplateStatus` | Current build state. |
| `ext4_size_bytes` | `number` | Size of the built ext4 rootfs image in bytes. |
| `created_at` | `string` | RFC 3339 creation timestamp. |
| `built_at` | `string?` | RFC 3339 timestamp of when the build finished. Absent until `"ready"`. |
| `dockerfile` | `string?` | Original build source. Present only on detail GET with `include: "dockerfile"`. |

### `GetTemplateOptions`

Extends `RequestOptions`. Options for `templates.get`.

| Field | Type | Description |
|---|---|---|
| `include` | `"dockerfile"?` | Set to include the original Dockerfile source in the response. |

### `TemplateLogsOptions`

Extends `RequestOptions`. Options for `templates.logs` / `templates.followLogs`.

| Field | Type | Description |
|---|---|---|
| `attempt` | `number?` | Filter to one build attempt. Default = all attempts. |

### `TemplateLogEvent`

One line of a `?follow=true` template log stream.

| Field | Type | Description |
|---|---|---|
| `ts` | `string?` | Log timestamp. |
| `level` | `string?` | Log level. |
| `line` | `string?` | Log line text. |
| `attempt` | `number?` | Build attempt number. |
| `final` | `boolean?` | `true` on the terminal frame. |
| `status` | `string?` | Terminal status: `"ready"` or `"failed"`. |
| `[key]` | `unknown` | Additional server fields (open-ended). |

---

## Catalog

### `Shape`

A sandbox sizing preset. Returned by `listShapes()`.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Shape id, e.g. `s-1vcpu-256mb`. Pass as `CreateSandboxRequest.shape`. |
| `vcpu` | `number` | Virtual CPU count. |
| `mem_mib` | `number` | Memory in MiB. |
| `default_disk_mib` | `number` | Default overlay disk size in MiB when `disk_mib` is omitted at create. |
| `cpu_quota_pct` | `number?` | cgroup v2 cpu.max quota as a percent of one CPU. Absent = unlimited. `25` = 0.25 vCPU. |

### `RootfsEntry`

Metadata for one built-in rootfs image.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Catalog name. |
| `description` | `string?` | Human-readable description. |
| `deprecated` | `boolean?` | Whether this image is deprecated. |
| `successor` | `string?` | Recommended replacement when deprecated. |

### `RootfsData`

The built-in rootfs catalog. Returned by `listRootfs()`.

| Field | Type | Description |
|---|---|---|
| `rootfs` | `string[]` | Available catalog names usable as `CreateSandboxRequest.rootfs`. |
| `default` | `string` | Name used when a create request omits `rootfs`. |
| `entries` | `RootfsEntry[]?` | Rich per-rootfs metadata. Absent when the catalog is empty. |

### `HostStatus`

```ts
type HostStatus = "active" | "draining" | "dead"
```

Scheduling state of a worker host.

### `HostPublic`

A worker host visible to the caller. Returned by `listHosts()`.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Host id. |
| `status` | `HostStatus` | Scheduling state. |
| `free_mib` | `number` | Schedulable memory currently free on the host, in MiB. |
| `vm_count` | `number` | Number of sandboxes currently placed on the host. |
| `rootfses` | `string[]?` | Rootfs images cached on the host. Absent when none. |

### `WhoAmIStatsView`

Per-state sandbox counts for the calling identity.

| Field | Type | Description |
|---|---|---|
| `running` | `number` | Sandboxes currently `"running"`. |
| `paused` | `number` | Sandboxes currently `"paused"`. |
| `other` | `number` | Sandboxes in any other state. |
| `total` | `number` | Total non-destroyed sandboxes. |

### `WhoAmIView`

Identity behind the configured API key. Returned by `whoami()`.

| Field | Type | Description |
|---|---|---|
| `user_id` | `string` | Stable id of the authenticated user. |
| `stats` | `WhoAmIStatsView` | Sandbox counts grouped by lifecycle state. |

---

## HTTP Envelopes

### `JSendEnvelope<T>`

Union of the three JSend envelope shapes returned by the control plane.

```ts
type JSendEnvelope<T> = SuccessEnvelope<T> | FailEnvelope | ErrorEnvelope
```

| Shape | `status` | Payload | Meaning |
|---|---|---|---|
| `SuccessEnvelope<T>` | `"success"` | `data: T` | Request succeeded. |
| `FailEnvelope` | `"fail"` | `data: Record<string, unknown> \| string` | Rejected for a client-side reason (validation). |
| `ErrorEnvelope` | `"error"` | `message: string`, `code: number` | Server internal error. |

The transport layer (`CreateosSandboxHttp`) unwraps the envelope and throws on `fail`/`error`.

### `OKResponse`

Generic acknowledgement from endpoints with no richer payload.

| Field | Type | Description |
|---|---|---|
| `ok` | `boolean` | Acknowledgement flag. |

### `HealthzResponse`

Liveness probe result. Returned by `healthz()`.

| Field | Type | Description |
|---|---|---|
| `up` | `boolean` | `true` once the control plane process is up. |

### `ReadyzResponse`

Readiness probe result. Returned by `readyz()`.

| Field | Type | Description |
|---|---|---|
| `ready` | `boolean` | Whether the control plane is ready to serve requests. |
| `reason` | `string?` | Why the control plane is not ready, when `ready` is `false`. |
| `scheduler_last_ok_ms_ago` | `number?` | Milliseconds since the scheduler last completed a healthy pass. |

---

## Poll

### `PollOptions<T>`

Internal options for the `pollUntil` primitive. Backs all `waitUntil*` helpers.

| Field | Type | Description |
|---|---|---|
| `poll` | `() => Promise<T>` | Fetches the current state. |
| `done` | `(value: T) => boolean` | Returns `true` once the desired state is reached. |
| `failed` | `((value: T) => string \| undefined)?` | Returns an error message when the state is a terminal failure. |
| `timeoutMs` | `number` | Overall budget in ms. |
| `signal` | `AbortSignal?` | Abort signal to cancel the wait. |

### `WaitOptions`

Options for the `Sandbox.waitUntil*` pollers.

| Field | Type | Description |
|---|---|---|
| `timeoutMs` | `number?` | Wait budget in ms. Default `120000`. |
| `signal` | `AbortSignal?` | Abort signal to cancel the wait. |
| `request` | `RequestOptions?` | Per-request options (headers, retry, per-request timeout) applied to each poll refresh. Separate from `timeoutMs`, which is the overall budget. |
