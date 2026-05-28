// Wire types for the fc-spawn control plane API.
//
// Every shape here mirrors the Go control-plane response/request structs
// (internal/api/types). Fields use the server's snake_case names so the
// JSON parses without translation.

// ── JSend envelope ──────────────────────────────────────────────────────

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SuccessEnvelope<T> {
  status: "success";
  data: T;
}

export interface FailEnvelope {
  status: "fail";
  /** Usually a field-keyed object; the control plane sometimes sends a plain string. */
  data: Record<string, unknown> | string;
}

export interface ErrorEnvelope {
  status: "error";
  message: string;
  code: number;
}

export type JSendEnvelope<T> = SuccessEnvelope<T> | FailEnvelope | ErrorEnvelope;

// ── Client configuration ────────────────────────────────────────────────

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
 */
export interface ClientHooks {
  onRequest?: (ctx: RequestHookContext) => void | Promise<void>;
  onResponse?: (ctx: ResponseHookContext) => void | Promise<void>;
  onRetry?: (ctx: RetryHookContext) => void | Promise<void>;
}

export interface FcClientOptions {
  /** fc-spawn API key sent as X-Api-Key. Falls back to the FC_API_KEY env var. */
  apiKey?: string;
  /** Auth headers used instead of an API key, e.g. your app's session token. */
  authHeaders?: HeadersInit;
  /** Control-plane base URL. Falls back to FC_BASE_URL, then the default. */
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
  signal?: AbortSignal;
  headers?: HeadersInit;
  timeoutMs?: number;
  retry?: RetryOptions | false;
}

// ── Shape / rootfs catalog ──────────────────────────────────────────────

export interface Shape {
  id: string;
  vcpu: number;
  mem_mib: number;
  default_disk_mib: number;
}

export interface ShapesData {
  shapes: Shape[];
}

export interface RootfsEntry {
  name: string;
  description?: string;
  deprecated?: boolean;
  successor?: string;
}

export interface RootfsData {
  rootfs: string[];
  default: string;
  /** Rich per-rootfs metadata; absent when the catalog is empty. */
  entries?: RootfsEntry[];
}

// ── Hosts ───────────────────────────────────────────────────────────────

export type HostStatus = "active" | "draining" | "dead";

export interface HostPublic {
  id: string;
  status: HostStatus;
  free_mib: number;
  vm_count: number;
  rootfses: string[];
}

// ── Sandbox lifecycle ───────────────────────────────────────────────────

export interface NetworkEntry {
  id: string;
}

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
  /** Total transferable bytes before the VM is capped. 0 = default, -1 = unmetered. */
  bandwidth_quota_bytes?: number;
  /** Pin placement to a specific host id. Empty = scheduler picks. */
  host_id?: string;
  /** Scheduler placement labels (k8s NodeSelector semantics). */
  node_selector?: Record<string, string>;
  /** Opt the sandbox into HTTP ingress at create time. */
  ingress_enabled?: boolean;
  /** Disks to mount into the VM at boot. Each entry references a disk by
   *  id or name and an absolute mount path inside the guest. */
  disks?: DiskAttachment[];
}

export type SandboxSpawnMode = "snapshot" | "cold";

export interface CreateSandboxResponse {
  id: string;
  name: string;
  ip: string;
  mode: SandboxSpawnMode;
  shape: string;
  rootfs: string;
  vcpu: number;
  mem_mib: number;
  disk_mib: number;
  spawn_ms: number;
  egress: string[];
  bandwidth_quota_bytes: number;
  /** Ingress URL template with a literal `<port>` placeholder. Set when ingress is on. */
  ingress_url_template?: string;
}

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

export interface SandboxView {
  id: string;
  status: SandboxStatus;
  ip: string;
  vcpu: number;
  mem_mib: number;
  disk_mib: number;
  created_at: string;
  ingress_enabled: boolean;
  name?: string;
  running_at?: string;
  destroyed_at?: string;
  spawn_ms?: number;
  shape?: string;
  rootfs?: string;
  region?: string;
  egress?: string[];
  /** Names of env vars stored on the sandbox. Values are never returned. */
  envs?: string[];
  ssh_pubkeys?: string[];
  created_by?: string;
  bandwidth_ingress_bytes?: number;
  paused_at?: string;
  last_resumed_at?: string;
  forked_from?: string;
}

export interface ListSandboxesOptions extends RequestOptions {
  /** Default 50, max 500. */
  limit?: number;
  status?: Extract<SandboxStatus, "running" | "creating" | "destroyed" | "failed">;
}

export interface ForkSandboxRequest {
  /** Keep the fork in `paused` instead of auto-resuming. */
  start_paused?: boolean;
  ssh_pubkeys?: string[];
  egress?: string[];
  ingress_enabled?: boolean;
  envs?: Record<string, string>;
  bandwidth_quota_bytes?: number;
}

export interface PatchSandboxRequest {
  ingress_enabled?: boolean;
}

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
export interface ExecRequest {
  cmd: string;
  args?: string[];
  stream?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  /** Agent-level failure (the command could not be started). */
  error?: string;
}

export interface ExecResponse {
  result: ExecResult;
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

export interface SetEgressRequest {
  egress?: string[] | null;
}

export interface EgressView {
  id: string;
  egress: string[];
}

export interface BandwidthView {
  id: string;
  quota_bytes: number;
  /** Egress bytes — billed against the quota. */
  used_bytes: number;
  /** Inbound bytes — observed, never enforced. */
  ingress_bytes: number;
  remaining_bytes: number;
  capped: boolean;
}

export interface RechargeBandwidthRequest {
  add_bytes: number;
}

export interface ResizeSandboxRequest {
  disk_mib: number;
}

export interface ResizeSandboxResponse {
  id: string;
  disk_mib: number;
}

// ── Identity ────────────────────────────────────────────────────────────

export interface WhoAmIStatsView {
  running: number;
  paused: number;
  other: number;
  total: number;
}

export interface WhoAmIView {
  user_id: string;
  stats: WhoAmIStatsView;
}

// ── Templates ───────────────────────────────────────────────────────────

export interface TemplateCreateRequest {
  name: string;
  dockerfile: string;
  base?: string;
}

export type TemplateStatus = "pending" | "building" | "ready" | "failed";

export interface TemplateView {
  id: string;
  name: string;
  base: string;
  status: TemplateStatus;
  ext4_size_bytes: number;
  created_at: string;
  built_at?: string;
  /** Present only on detail GET with `include: "dockerfile"`. */
  dockerfile?: string;
}

export interface TemplatesListResponse {
  templates: TemplateView[];
}

export interface GetTemplateOptions extends RequestOptions {
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
  disk_id: string;
  name: string;
  kind: DiskKind;
  config: DiskConfig;
  mount_path: string;
  sub_path?: string;
  mount_status: DiskMountStatus;
  mount_error?: string;
}

export interface DisksListResponse {
  disks: DiskView[];
}

export interface SandboxDisksListResponse {
  disks: SandboxDiskView[];
}

export interface DiskDeletedResponse {
  deleted: boolean;
}

export interface DiskDetachedResponse {
  detached: boolean;
}

// ── Networks ────────────────────────────────────────────────────────────

export interface NetworkCreateRequest {
  name: string;
}

export interface NetworkMember {
  sandbox_id: string;
  status: string;
  ip: string;
  name: string;
}

export interface Network {
  id: string;
  name: string;
  created_at: string;
  member_count?: number;
  members?: NetworkMember[];
}

// ── Misc ────────────────────────────────────────────────────────────────

export interface OKResponse {
  ok: boolean;
}

export interface HealthzResponse {
  up: boolean;
}

export interface ReadyzResponse {
  ready: boolean;
  reason?: string;
  scheduler_last_ok_ms_ago?: number;
}

// ── Handle option types ─────────────────────────────────────────────────

export interface CreateSandboxOptions extends RequestOptions {
  /** Wait until the sandbox reaches `running` before resolving. Default true. */
  wait?: boolean;
  /** Budget for the wait, in ms. Default 120000. */
  waitTimeoutMs?: number;
}

export interface WaitOptions {
  /** Wait budget in ms. Default 120000. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Per-request options (headers, retry, per-request timeout) applied to
   *  each poll refresh. `timeoutMs` above is the wait budget, not the
   *  per-request timeout, so per-request options are carried separately. */
  request?: RequestOptions;
}
