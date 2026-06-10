// Wire types for the fc-spawn control plane API.
//
// Every shape here mirrors the Go control-plane response/request structs
// (internal/api/types). Fields use the server's snake_case names so the
// JSON parses without translation.

// ── JSend envelope ──────────────────────────────────────────────────────

/** JSend `success` envelope: the request succeeded and `data` is the payload. */
export interface SuccessEnvelope<T> {
  status: "success";
  data: T;
}

/** JSend `fail` envelope: the request was rejected for a client-side reason (validation). */
export interface FailEnvelope {
  status: "fail";
  /** Usually a field-keyed object; the control plane sometimes sends a plain string. */
  data: Record<string, unknown> | string;
}

/** JSend `error` envelope: the server hit an internal error processing the request. */
export interface ErrorEnvelope {
  status: "error";
  message: string;
  code: number;
}

/** The three JSend envelope shapes the control plane returns. */
export type JSendEnvelope<T> = SuccessEnvelope<T> | FailEnvelope | ErrorEnvelope;

// ── Client configuration ────────────────────────────────────────────────

/** Exponential-backoff retry policy. Omit a field to keep its default. */
export interface RetryOptions {
  /** Extra attempts after the first. Default 2 (3 attempts total). */
  maxRetries?: number;
  /** Base backoff delay in ms. Default 500. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 30000. */
  maxDelayMs?: number;
}

// ── Observability hooks ─────────────────────────────────────────────────

/** Reason a request is being retried. */
export type RetryReason = "network" | "status" | "rate-limit";

/** Context delivered to {@link ClientHooks.onRequest}. */
export interface RequestHookContext {
  /** URL with userinfo stripped and sensitive query params redacted. */
  url: string;
  /** Uppercase HTTP method. */
  method: string;
  /** Outgoing headers with credentials replaced by `"redacted"`. */
  headers: Record<string, string>;
  /** 1 for the first try, 2+ for retries. */
  attempt: number;
}

/** Context delivered to {@link ClientHooks.onResponse}. */
export interface ResponseHookContext extends RequestHookContext {
  /** HTTP status code returned by the server. */
  status: number;
  /** Elapsed time for the fetch call, in milliseconds. */
  durationMs: number;
  /** Server-supplied request id, when present. */
  requestId?: string | undefined;
}

/**
 * Context delivered to {@link ClientHooks.onRetry}.
 *
 * `status` and `requestId` are undefined when the retry was triggered by a
 * network error (`reason: "network"`) — no response was received.
 */
export interface RetryHookContext extends Omit<ResponseHookContext, "status"> {
  /** HTTP status that triggered the retry, or undefined for network errors. */
  status?: number | undefined;
  /** Why the SDK is retrying this request. */
  reason: RetryReason;
  /** Milliseconds the SDK will sleep before the next attempt. */
  delayMs: number;
}

/**
 * Optional lifecycle hooks for plugging in observability without pulling
 * runtime dependencies. Every payload is pre-redacted — credentials in
 * headers and query params never reach a hook. A throw inside a hook is
 * swallowed so a misbehaving observer cannot crash a real request.
 *
 * Hooks are awaited in the request path so a returned promise orders the
 * trace deterministically against the request it describes; an async hook
 * therefore adds its own latency to the call. Keep hook work cheap, or
 * dispatch slow work without returning the promise.
 */
export interface ClientHooks {
  onRequest?: (ctx: RequestHookContext) => void | Promise<void>;
  onResponse?: (ctx: ResponseHookContext) => void | Promise<void>;
  onRetry?: (ctx: RetryHookContext) => void | Promise<void>;
}

/** Construction options for {@link FcClient}. All fields are optional. */
export interface FcClientOptions {
  /** fc-spawn API key sent as X-Api-Key. Falls back to the FC_API_KEY env var. */
  apiKey?: string;
  /** Auth headers used instead of an API key, e.g. your app's session token. */
  authHeaders?: HeadersInit;
  /** Control-plane base URL. Required; falls back to the FC_BASE_URL env var. */
  baseUrl?: string;
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Headers merged into every request. */
  headers?: HeadersInit;
  /** Per-request timeout in ms. Default 60000. 0 disables it. */
  timeoutMs?: number;
  /** Retry policy, or false to disable retries entirely. */
  retry?: RetryOptions | false;
  /** Overrides the User-Agent header. */
  userAgent?: string;
  /** Lifecycle hooks for zero-dep observability. Payloads are pre-redacted. */
  hooks?: ClientHooks;
}

/** Per-call overrides accepted by every SDK method. */
export interface RequestOptions {
  /** Abort signal to cancel the request (and any in-flight retry backoff). */
  signal?: AbortSignal;
  /** Headers merged into this request, overriding the client defaults. */
  headers?: HeadersInit;
  /** Per-request timeout in ms, overriding the client default. 0 disables it. */
  timeoutMs?: number;
  /** Retry policy for this request, or false to disable retries. Overrides the client default. */
  retry?: RetryOptions | false;
}

// ── Shape / rootfs catalog ──────────────────────────────────────────────

/** A sandbox sizing preset (vCPU / RAM / disk). Returned by `listShapes()`. */
export interface Shape {
  /** Shape id passed as `CreateSandboxRequest.shape`, e.g. `s-1vcpu-256mb`. */
  id: string;
  /** Virtual CPU count. */
  vcpu: number;
  /** Memory in MiB. */
  mem_mib: number;
  /** Default overlay disk size in MiB when the create request omits `disk_mib`. */
  default_disk_mib: number;
  /** cgroup v2 cpu.max quota as a percent of one CPU (`omitempty`; absent =
   *  unlimited). 25 = 0.25 vCPU, 50 = 0.5 vCPU. */
  cpu_quota_pct?: number;
}

/** Metadata for one built-in rootfs image in the catalog. */
export interface RootfsEntry {
  name: string;
  description?: string;
  deprecated?: boolean;
  /** Recommended replacement when this image is deprecated. */
  successor?: string;
}

/** The built-in rootfs catalog. Returned by `listRootfs()`. */
export interface RootfsData {
  /** Available rootfs catalog names usable as `CreateSandboxRequest.rootfs`. */
  rootfs: string[];
  /** Name used when a create request omits `rootfs`. */
  default: string;
  /** Rich per-rootfs metadata; absent when the catalog is empty. */
  entries?: RootfsEntry[];
}

// ── Hosts ───────────────────────────────────────────────────────────────

/** Scheduling state of a worker host: accepting work, winding down, or gone. */
export type HostStatus = "active" | "draining" | "dead";

/** A worker host visible to the caller. Returned by `listHosts()`. */
export interface HostPublic {
  id: string;
  status: HostStatus;
  /** Schedulable memory currently free on the host, in MiB. */
  free_mib: number;
  /** Number of sandboxes currently placed on the host. */
  vm_count: number;
  /** Rootfs images cached on the host. Absent (`omitempty`) when none. */
  rootfses?: string[];
}

// ── Sandbox lifecycle ───────────────────────────────────────────────────

/** References an overlay network by id in `CreateSandboxRequest.networks`. */
export interface NetworkEntry {
  id: string;
}

/** Body of `POST /v1/sandboxes`. Only `shape` is required. */
export interface CreateSandboxRequest {
  /** Required. A shape id from `listShapes()`. */
  shape: string;
  /** Rootfs catalog name or template id/name. Empty = host default. */
  rootfs?: string;
  /** User-facing VM name, unique per user. Empty = auto-generated. */
  name?: string;
  /** Overlay networks to join at create time. */
  networks?: NetworkEntry[];
  /** Overlay disk size in MiB. 0 = shape default. */
  disk_mib?: number;
  /** Egress allowlist. Empty / ["*"] = allow all. */
  egress?: string[];
  /** Env vars injected into every exec inside the VM. */
  envs?: Record<string, string>;
  /** OpenSSH public keys authorized for the SSH gateway. */
  ssh_pubkeys?: string[];
  /** Pin placement to a specific host id. Empty = scheduler picks. */
  host_id?: string;
  /** Scheduler placement labels (k8s NodeSelector semantics). */
  node_selector?: Record<string, string>;
  /** Opt the sandbox into HTTP ingress at create time. */
  ingress_enabled?: boolean;
  /** Disks to mount into the VM at boot. Each entry references a disk by
   *  id or name and an absolute mount path inside the guest. */
  disks?: DiskAttachment[];
  /** Pin the sandbox to a region. Omit to use the control plane's own
   *  configured region. When set it must equal the server's region —
   *  there is no cross-region routing today, and a mismatch is rejected. */
  region?: string;
  /** Idle auto-pause: pause the sandbox after this many seconds with no
   *  detected activity. Valid range 60–86400 (1 min – 24 h); the server
   *  rejects values outside it. Omit to disable. */
  auto_pause_after_seconds?: number;
}

/**
 * Result of `POST /v1/sandboxes`, returned before the SDK fetches the full
 * {@link SandboxView}. Records the resolved placement and boot timing.
 */
export interface CreateSandboxResponse {
  id: string;
  name: string;
  /** The VM's private IP. */
  ip: string;
  shape: string;
  rootfs: string;
  vcpu: number;
  /** Memory in MiB. */
  mem_mib: number;
  /** Overlay disk size in MiB. */
  disk_mib: number;
  /** Wall-clock time to boot the VM, in milliseconds. */
  spawn_ms: number;
  /** Resolved egress allowlist. */
  egress: string[];
  /** Transferable byte quota. -1 = unmetered. */
  bandwidth_quota_bytes: number;
  /** Ingress URL template with a literal `<port>` placeholder. Set when ingress is on. */
  ingress_url_template?: string;
}

/** Lifecycle state of a sandbox. Transitional states (`pausing`, `resuming`,
 *  `forking`, `creating`, `destroying`) settle into a steady or terminal one. */
export type SandboxStatus =
  | "creating"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "forking"
  | "error"
  | "destroying"
  | "destroyed"
  | "failed";

/**
 * The full server-side projection of a sandbox. Backs the `Sandbox` handle
 * and is returned by the get / list endpoints. Optional fields are omitted
 * by the server (`omitempty`) rather than sent as null.
 */
export interface SandboxView {
  id: string;
  status: SandboxStatus;
  /** The VM's private IP. Absent (`omitempty`) until the VM is assigned
   *  an address — omitted while the sandbox is still `creating`. */
  ip?: string;
  vcpu: number;
  /** Memory in MiB. */
  mem_mib: number;
  /** Overlay disk size in MiB. */
  disk_mib: number;
  /** RFC 3339 timestamp of when the row was created. */
  created_at: string;
  ingress_enabled: boolean;
  /** Ingress URL template with a literal `<port>` placeholder. Present when
   *  `ingress_enabled` and the control plane knows its public domain suffix.
   *  Same shape as {@link CreateSandboxResponse.ingress_url_template}. */
  ingress_url_template?: string;
  name?: string;
  /** RFC 3339 timestamp of when the VM last reached `running`. */
  running_at?: string;
  /** RFC 3339 timestamp of when the VM was destroyed. */
  destroyed_at?: string;
  /** Wall-clock boot time, in milliseconds. */
  spawn_ms?: number;
  shape?: string;
  rootfs?: string;
  region?: string;
  egress?: string[];
  /** Names of env vars stored on the sandbox. Values are never returned. */
  envs?: string[];
  ssh_pubkeys?: string[];
  /** Identity that created the sandbox. */
  created_by?: string;
  /** Inbound bytes observed (never enforced). */
  bandwidth_ingress_bytes?: number;
  /** RFC 3339 timestamp of the last pause. */
  paused_at?: string;
  /** RFC 3339 timestamp of the last resume. */
  last_resumed_at?: string;
  /** Source sandbox id when this sandbox was created via `fork`. */
  forked_from?: string;
  /** Idle auto-pause timeout in seconds. Absent when auto-pause is disabled. */
  auto_pause_after_seconds?: number;
}

/** Filters for `listSandboxes()`. */
export interface ListSandboxesOptions extends RequestOptions {
  /** Cap the number of handles returned. Omit to fetch every page. */
  limit?: number;
  /** Filter to one lifecycle state. Omit to list every status. */
  status?: Extract<SandboxStatus, "running" | "creating" | "destroyed" | "failed">;
}

/** Optional overrides applied to a fork. Omitted fields inherit from the source. */
export interface ForkSandboxRequest {
  /** Keep the fork in `paused` instead of auto-resuming. */
  start_paused?: boolean;
  ssh_pubkeys?: string[];
  egress?: string[];
  ingress_enabled?: boolean;
  envs?: Record<string, string>;
  bandwidth_quota_bytes?: number;
}

/** Body of the sandbox PATCH endpoint, used by `Sandbox.setIngress` and
 *  `Sandbox.setAutoPause`. Omitted fields are left unchanged. */
export interface PatchSandboxRequest {
  ingress_enabled?: boolean;
  /** Idle auto-pause timeout in seconds (60–86400). */
  auto_pause_after_seconds?: number;
  /** When true, clears the auto-pause timeout (disables auto-pause). The
   *  server needs a separate flag because omitting
   *  `auto_pause_after_seconds` means "leave unchanged", not "clear". */
  disable_auto_pause?: boolean;
}

/** Body of `Sandbox.addSSHPubkeys` — keys to add to a live sandbox. */
export interface AddSSHPubkeysRequest {
  /** OpenSSH-formatted public keys. Keys already present are de-duplicated. */
  keys: string[];
}

/** Result of `Sandbox.addSSHPubkeys`. */
export interface AddSSHPubkeysResponse {
  /** Total `ssh_pubkeys` on the sandbox after the add. */
  count: number;
}

/** Result of `Sandbox.destroy` — the row's status after the destroy call. */
export interface DestroyedResponse {
  /** Id of the sandbox accepted for destruction. */
  id: string;
  /** Status reached by the destroy call. `destroying` for an async
   *  reclaim; `destroyed` when the call was a no-op on an already
   *  terminal row or could be reclaimed inline (paused/error). */
  status: Extract<SandboxStatus, "destroying" | "destroyed">;
}

// ── Exec ────────────────────────────────────────────────────────────────

// No stdin or per-command env: Go's proto.ExecRequest has no stdin field, and
// the control plane overwrites env with the sandbox's persistent `envs`. Both
// were silently dropped server-side. Set env at createSandbox/fork time.
/** Body of `POST /v1/sandboxes/:id/exec`, sent by `runCommand` / `streamCommand`. */
export interface ExecRequest {
  /** Executable to run inside the guest. Not passed through a shell — wrap in
   *  `["bash", "-c", "…"]` for pipes, globbing or redirection. */
  cmd: string;
  /** Arguments passed to `cmd`. */
  args?: string[];
  /** Stream output as NDJSON frames instead of buffering. Set by `streamCommand`. */
  stream?: boolean;
}

/** Buffered output of a completed command. */
export interface ExecResult {
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
  /** Process exit code. 0 = success. */
  exit_code: number;
  /** Agent-level failure (the command could not be started). */
  error?: string;
}

/** Result of `Sandbox.runCommand`: the buffered output plus timing. */
export interface ExecResponse {
  result: ExecResult;
  /** Wall-clock time the command ran, in milliseconds. */
  exec_ms: number;
}

/**
 * Discriminated union yielded by {@link Sandbox.streamCommand}. Switch on
 * `type` to handle each kind of event — TypeScript narrows the payload.
 *
 * @example
 * ```ts
 * for await (const ev of sandbox.streamCommand("npm", ["install"])) {
 *   switch (ev.type) {
 *     case "stdout":    process.stdout.write(ev.data); break;
 *     case "stderr":    process.stderr.write(ev.data); break;
 *     case "exit":      console.log(`exit ${ev.exitCode}`); break;
 *     case "error":     console.error(ev.message); break;
 *     case "heartbeat": break;
 *   }
 * }
 * ```
 */
export type ExecStreamEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string }
  | { type: "heartbeat" };

/**
 * Raw NDJSON frame as emitted by the server. Exposed for advanced users
 * who want to bypass the {@link ExecStreamEvent} projection (e.g. log
 * forwarders that need the snake_case shape).
 */
export interface ExecStreamFrame {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  error?: string;
  /** Heartbeat marker emitted every 5s. */
  hb?: boolean;
}

/** Per-call options for `Sandbox.runCommand` / `Sandbox.streamCommand`. */
export type ExecOptions = RequestOptions;

// ── Egress / bandwidth / resize ─────────────────────────────────────────

/** Body of `Sandbox.setEgress` — replaces the egress allowlist. */
export interface SetEgressRequest {
  /** `host:port` allow rules. `null`, omitted, or `[]` means allow all. */
  egress?: string[] | null;
}

/** The sandbox's current egress allowlist. Returned by `getEgress` / `setEgress`. */
export interface EgressView {
  id: string;
  /** Active `host:port` allow rules. Empty = allow all. */
  egress: string[];
}

/** Bandwidth quota and usage counters. Returned by `getBandwidth` / `rechargeBandwidth`. */
export interface BandwidthView {
  id: string;
  /** Total transferable byte quota. -1 = unmetered. */
  quota_bytes: number;
  /** Egress bytes — billed against the quota. */
  used_bytes: number;
  /** Inbound bytes — observed, never enforced. */
  ingress_bytes: number;
  /** Bytes left before the VM is network-capped. */
  remaining_bytes: number;
  /** True once the quota is exhausted and egress is blocked. */
  capped: boolean;
}

/** Body of `Sandbox.rechargeBandwidth`. */
export interface RechargeBandwidthRequest {
  /** Bytes to add to the quota. */
  add_bytes: number;
}

/** Body of `Sandbox.resize`. */
export interface ResizeSandboxRequest {
  /** New overlay disk size in MiB. Must be larger than the current size. */
  disk_mib: number;
}

/** Result of `Sandbox.resize` — the disk size after the grow. */
export interface ResizeSandboxResponse {
  id: string;
  /** New overlay disk size in MiB. */
  disk_mib: number;
}

// ── Identity ────────────────────────────────────────────────────────────

/** Per-state sandbox counts for the calling identity. */
export interface WhoAmIStatsView {
  /** Sandboxes currently `running`. */
  running: number;
  /** Sandboxes currently `paused`. */
  paused: number;
  /** Sandboxes in any other state. */
  other: number;
  /** Total non-destroyed sandboxes. */
  total: number;
}

/** Identity behind the configured API key. Returned by `whoami()`. */
export interface WhoAmIView {
  /** Stable id of the authenticated user. */
  user_id: string;
  /** Sandbox counts grouped by lifecycle state. */
  stats: WhoAmIStatsView;
}

// ── Templates ───────────────────────────────────────────────────────────

/** Body of `templates.create` — a Dockerfile to build into a sandbox rootfs. */
export interface TemplateCreateRequest {
  name: string;
  /** Dockerfile source built into the rootfs image. */
  dockerfile: string;
  /** Base rootfs catalog name to build on top of. Empty = host default. */
  base?: string;
}

/** Build state of a template. `ready` once the rootfs image is usable. */
export type TemplateStatus = "pending" | "building" | "ready" | "failed";

/** A custom rootfs template. Returned by the templates endpoints. */
export interface TemplateView {
  id: string;
  name: string;
  /** Base rootfs the template was built on. */
  base: string;
  status: TemplateStatus;
  /** Size of the built ext4 rootfs image, in bytes. */
  ext4_size_bytes: number;
  /** RFC 3339 timestamp of when the template row was created. */
  created_at: string;
  /** RFC 3339 timestamp of when the build finished. Absent until `ready`. */
  built_at?: string;
  /** Present only on detail GET with `include: "dockerfile"`. */
  dockerfile?: string;
}

/** Options for `templates.get`. */
export interface GetTemplateOptions extends RequestOptions {
  /** Set to `"dockerfile"` to include the original build source in the response. */
  include?: "dockerfile";
}

/** One line of a `?follow=true` template log stream. */
export interface TemplateLogEvent {
  ts?: string;
  level?: string;
  line?: string;
  attempt?: number;
  /** Terminal frame: `{ final: true, status: "ready" | "failed" }`. */
  final?: boolean;
  status?: string;
  [key: string]: unknown;
}

/** Options for `templates.logs` / `templates.followLogs`. */
export interface TemplateLogsOptions extends RequestOptions {
  /** Filter to one build attempt. Default = all attempts. */
  attempt?: number;
}

// ── Disks ───────────────────────────────────────────────────────────────

/** Storage backend for a registered disk. Only `s3` today. */
export type DiskKind = "s3";

/** Non-secret S3 disk configuration. Persisted server-side as JSON. */
export interface DiskConfig {
  bucket: string;
  endpoint: string;
  region?: string;
  /** Force path-style addressing (`endpoint/bucket/key`) instead of
   *  virtual-hosted (`bucket.endpoint/key`). Needed for MinIO / R2 with
   *  custom domains. */
  use_path_style?: boolean;
}

/** Bucket credentials. Sent only on create; AES-GCM-encrypted at rest and
 *  never returned by any read endpoint. */
export interface DiskCredentials {
  access_key: string;
  secret_key: string;
}

/** Body of `POST /v1/disks`. */
export interface DiskCreateRequest {
  /** User-scoped name. Must match `^[a-z0-9][a-z0-9-]{0,62}$`. */
  name: string;
  kind: DiskKind;
  config: DiskConfig;
  credentials: DiskCredentials;
}

/** User-facing projection of a registered disk. Credentials never appear here. */
export interface DiskView {
  id: string;
  name: string;
  kind: DiskKind;
  /** Server returns this as a JSON blob; the SDK exposes it as parsed JSON. */
  config: DiskConfig;
  created_at: string;
}

/** One element of `CreateSandboxRequest.disks` or the body of
 *  `POST /v1/sandboxes/:id/disks`. */
export interface DiskAttachment {
  /** A `disk_<ulid>` id or the user-scoped disk name. */
  disk_id: string;
  /** Absolute path inside the VM, e.g. `/mnt/data`. */
  mount_path: string;
  /** Optional bucket sub-folder to expose at `mount_path`. Empty = bucket
   *  root. Must not start with `/` and must not contain `..`. */
  sub_path?: string;
}

/** Mount status reported by the in-VM agent. */
export type DiskMountStatus = "pending" | "mounted" | "error" | "unmounting";

/** Per-attachment projection returned from
 *  `GET /v1/sandboxes/:id/disks`. */
export interface SandboxDiskView {
  /** The `disk_<ulid>` id of the registered disk. */
  disk_id: string;
  name: string;
  kind: DiskKind;
  config: DiskConfig;
  /** Absolute path inside the guest where the disk is mounted. */
  mount_path: string;
  /** Bucket sub-folder exposed at `mount_path`, when set. */
  sub_path?: string;
  mount_status: DiskMountStatus;
  /** Failure detail when `mount_status` is `error`. */
  mount_error?: string;
}

/** Result of `disks.delete`. */
export interface DiskDeletedResponse {
  deleted: boolean;
}

/** Result of `Sandbox.detachDisk`. */
export interface DiskDetachedResponse {
  detached: boolean;
}

/** Options for {@link Sandbox.attachDisk}. */
export interface AttachDiskOptions {
  /** A `disk_<ulid>` id or the user-scoped disk name. */
  diskId: string;
  /** Absolute path inside the guest, e.g. `/mnt/data`. */
  mountPath: string;
  /** Optional bucket sub-folder to expose at `mountPath`. */
  subPath?: string;
}

/** Options for {@link Sandbox.detachDisk}. */
export interface DetachDiskOptions {
  /** A `disk_<ulid>` id or the user-scoped disk name. */
  diskId: string;
  /**
   * Absolute path inside the guest where the disk is currently mounted.
   * Required — the same disk may be attached at multiple paths and the
   * composite key is (sandbox, disk, mountPath).
   */
  mountPath: string;
}

// ── Networks ────────────────────────────────────────────────────────────

/** Body of `networks.create`. */
export interface NetworkCreateRequest {
  name: string;
}

/** A sandbox attached to an overlay network, with its address on that network. */
export interface NetworkMember {
  sandbox_id: string;
  status: string;
  /** The member's IP on this overlay network. Absent (`omitempty`) until
   *  the membership is programmed. */
  ip?: string;
  /** The member sandbox's user-facing name, when set (`omitempty`). */
  name?: string;
}

/** An overlay network. Returned by the networks endpoints. */
export interface Network {
  id: string;
  name: string;
  /** RFC 3339 timestamp of when the network was created. */
  created_at: string;
  /** Number of attached sandboxes. Present on list responses. */
  member_count?: number;
  /** Attached sandboxes with their per-network addresses. Present on detail GET. */
  members?: NetworkMember[];
}

// ── Misc ────────────────────────────────────────────────────────────────

/** Generic acknowledgement returned by endpoints with no richer payload. */
export interface OKResponse {
  ok: boolean;
}

/** Liveness probe result. Returned by `healthz()`. */
export interface HealthzResponse {
  /** True once the control plane process is up. */
  up: boolean;
}

/** Readiness probe result. Returned by `readyz()`. */
export interface ReadyzResponse {
  ready: boolean;
  /** Why the control plane is not ready, when `ready` is false. */
  reason?: string;
  /** Milliseconds since the scheduler last completed a healthy pass. */
  scheduler_last_ok_ms_ago?: number;
}

// ── Handle option types ─────────────────────────────────────────────────

/** Options for `createSandbox` / `Sandbox.create`: per-request overrides plus the wait policy. */
export interface CreateSandboxOptions extends RequestOptions {
  /** Wait until the sandbox reaches `running` before resolving. Default true. */
  wait?: boolean;
  /** Budget for the wait, in ms. Default 120000. */
  waitTimeoutMs?: number;
}

/** Options for the `Sandbox.waitUntil*` pollers. */
export interface WaitOptions {
  /** Wait budget in ms. Default 120000. */
  timeoutMs?: number;
  /** Abort signal to cancel the wait. */
  signal?: AbortSignal;
  /** Per-request options (headers, retry, per-request timeout) applied to
   *  each poll refresh. `timeoutMs` above is the wait budget, not the
   *  per-request timeout, so per-request options are carried separately. */
  request?: RequestOptions;
}
