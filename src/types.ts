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
  data: Record<string, unknown>;
}

export interface ErrorEnvelope {
  status: "error";
  message: string;
  code: number;
}

export type JSendEnvelope<T> = SuccessEnvelope<T> | FailEnvelope | ErrorEnvelope;

export interface FcClientOptions {
  apiKey?: string;
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

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
  entries: RootfsEntry[];
}

export type HostStatus = "active" | "draining" | "dead";

export interface HostPublic {
  id: string;
  status: HostStatus;
  free_mib: number;
  vm_count: number;
  rootfses: string[];
}

export interface NetworkEntry {
  id: string;
}

export interface CreateSandboxRequest {
  shape: string;
  rootfs?: string;
  name?: string;
  networks?: NetworkEntry[];
  disk_mib?: number;
  egress?: string[];
  envs?: Record<string, string>;
  ssh_pubkeys?: string[];
  bandwidth_quota_bytes?: number;
  host_id?: string;
  region?: string;
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
  name: string;
  status: SandboxStatus;
  ip: string;
  vcpu: number;
  mem_mib: number;
  disk_mib: number;
  created_at: string;
  running_at: string | null;
  destroyed_at: string | null;
  spawn_ms: number;
  shape: string;
  rootfs: string;
  region: string;
  egress: string[];
  envs: string[];
  ssh_pubkeys: string[];
  created_by: string;
  ingress_enabled: boolean;
  bandwidth_ingress_bytes: number;
  paused_at: string | null;
  last_resumed_at: string | null;
  forked_from?: string;
}

export interface ListSandboxesOptions extends RequestOptions {
  limit?: number;
  status?: Extract<SandboxStatus, "running" | "creating" | "destroyed" | "failed">;
}

export interface PauseAck {
  id: string;
  status: "pausing" | "paused";
}

export interface ResumeAck {
  id: string;
  status: "resuming" | "running";
}

export interface ForkSandboxRequest {
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

export interface ExecRequest {
  cmd: string;
  args?: string[];
  stdin?: string;
  env?: Record<string, string>;
  stream?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
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
  hb?: boolean;
}

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
  used_bytes: number;
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

export interface DestroyedResponse {
  id: string;
  status: "destroying" | "destroyed";
}

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

export interface TemplateCreateRequest {
  name: string;
  dockerfile: string;
}

export type TemplateStatus = "pending" | "building" | "ready" | "failed";

export interface TemplateView {
  id: string;
  name: string;
  base: string;
  status: TemplateStatus;
  ext4_size_bytes: number;
  created_at: string;
  built_at: string | null;
  dockerfile?: string;
}

export interface TemplatesListResponse {
  templates: TemplateView[];
}

export interface GetTemplateOptions extends RequestOptions {
  include?: "dockerfile";
}

export interface TemplateLogEvent {
  ts?: string;
  level?: string;
  line?: string;
  [key: string]: unknown;
}

export interface GetTemplateLogsOptions extends RequestOptions {
  attempt?: number;
  limit?: number;
}

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

export interface OKResponse {
  ok: boolean;
}

export interface HealthzResponse {
  up: boolean;
}

export interface ReadyzResponse {
  ready: boolean;
}
