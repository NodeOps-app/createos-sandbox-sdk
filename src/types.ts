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

export interface FcClientOptions {
  /** Bearer API key. Falls back to the FC_API_KEY env var. */
  apiKey?: string;
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
  /** Id of the sandbox accepted for destruction. The control plane returns
   *  only this field — destroy is async and reports no status. */
  destroyed: string;
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

export interface ExecStreamEvent {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  error?: string;
  /** Heartbeat marker emitted every 5s; ignore it. */
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
