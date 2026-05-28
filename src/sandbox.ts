// The Sandbox handle: a stateful object returned by FcClient that owns a
// sandbox id and exposes lifecycle, command, file and network operations.

import { bootstrapClient } from "./client.js";
import { FcError, FcTimeoutError } from "./errors.js";
import { encodePath, type FcHttp } from "./http.js";
import { pollUntil } from "./poll.js";
import type {
  BandwidthView,
  CreateSandboxOptions,
  CreateSandboxRequest,
  DestroyedResponse,
  DiskDetachedResponse,
  EgressView,
  ExecOptions,
  ExecResponse,
  ExecStreamEvent,
  FcClientOptions,
  ForkSandboxRequest,
  OKResponse,
  RequestOptions,
  ResizeSandboxResponse,
  SandboxDisksListResponse,
  SandboxDiskView,
  SandboxStatus,
  SandboxView,
  WaitOptions,
} from "./types.js";

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_PORT_READY_TIMEOUT_MS = 30_000;
const PORT_READY_BUFFER_MS = 5_000;
const DEFAULT_PORT_READY_INTERVAL_MS = 200;

// IPv4 dotted quad (loose; intentionally permissive), bracket-stripped IPv6
// hex+colon, or a DNS hostname (RFC 1123 label rules, no trailing dot).
// Anything else is rejected — the value is interpolated into a bash command
// inside the guest, so we must refuse shell metacharacters categorically.
const PORT_READY_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.\-:]{0,253}[A-Za-z0-9])?$/;

/** File transfer scoped to one sandbox. Reached via `sandbox.files`. */
export class SandboxFiles {
  readonly #http: FcHttp;
  readonly #sandboxId: string;

  constructor(http: FcHttp, sandboxId: string) {
    this.#http = http;
    this.#sandboxId = sandboxId;
  }

  /** Uploads raw bytes to an absolute path inside the sandbox. */
  async upload(path: string, data: BodyInit, options: RequestOptions = {}): Promise<void> {
    await this.#http.request("PUT", `/v1/sandboxes/${encodePath(this.#sandboxId)}/files`, {
      ...options,
      query: { path },
      rawBody: data,
      contentType: "application/octet-stream",
    });
  }

  /** Downloads a file from the sandbox as raw bytes. */
  async download(path: string, options: RequestOptions = {}): Promise<ArrayBuffer> {
    const url = `/v1/sandboxes/${encodePath(this.#sandboxId)}/files`;
    const response = await this.#http.requestRaw("GET", url, {
      ...options,
      query: { path },
    });
    if (!response.ok) {
      await this.#http.throwForResponse(response, url);
    }
    return response.arrayBuffer();
  }
}

export class Sandbox {
  /** File transfer namespace. */
  readonly files: SandboxFiles;

  readonly #http: FcHttp;
  #data: SandboxView;
  #ingressUrlTemplate: string | undefined;

  constructor(http: FcHttp, view: SandboxView, ingressUrlTemplate?: string) {
    this.#http = http;
    this.#data = view;
    this.#ingressUrlTemplate = ingressUrlTemplate;
    this.files = new SandboxFiles(http, view.id);
  }

  // ── static factories ──────────────────────────────────────────────────

  /**
   * Creates a sandbox without first constructing an `FcClient`. Equivalent
   * to `new FcClient(clientOpts).createSandbox(request, createOpts)`.
   */
  static async create(
    request: CreateSandboxRequest,
    options: FcClientOptions & CreateSandboxOptions = {},
  ): Promise<Sandbox> {
    const { clientOpts, requestOpts } = splitOptions(options);
    const createOpts: CreateSandboxOptions = { ...requestOpts };
    if (options.wait !== undefined) createOpts.wait = options.wait;
    if (options.waitTimeoutMs !== undefined) createOpts.waitTimeoutMs = options.waitTimeoutMs;
    return bootstrapClient(clientOpts).createSandbox(request, createOpts);
  }

  /**
   * Connects to an existing sandbox by id without first constructing an
   * `FcClient`. Equivalent to `new FcClient(clientOpts).getSandbox(id, opts)`.
   */
  static async connect(
    id: string,
    options: FcClientOptions & RequestOptions = {},
  ): Promise<Sandbox> {
    const { clientOpts, requestOpts } = splitOptions(options);
    return bootstrapClient(clientOpts).getSandbox(id, requestOpts);
  }

  get id(): string {
    return this.#data.id;
  }

  get status(): SandboxStatus {
    return this.#data.status;
  }

  get ip(): string {
    return this.#data.ip;
  }

  get name(): string | undefined {
    return this.#data.name;
  }

  /** The full, last-known sandbox projection. */
  get data(): SandboxView {
    return this.#data;
  }

  toJSON(): SandboxView {
    return this.#data;
  }

  #path(suffix = ""): string {
    return `/v1/sandboxes/${encodePath(this.#data.id)}${suffix}`;
  }

  /** Re-fetches the sandbox projection and updates this handle in place. */
  async refresh(options: RequestOptions = {}): Promise<this> {
    this.#data = await this.#http.request<SandboxView>("GET", this.#path(), options);
    return this;
  }

  // ── commands ──────────────────────────────────────────────────────────

  /** Runs a command to completion and returns its buffered output. */
  async runCommand(
    cmd: string,
    args: string[] = [],
    options: ExecOptions = {},
  ): Promise<ExecResponse> {
    return this.#http.request<ExecResponse>("POST", this.#path("/exec"), {
      ...options,
      body: { cmd, args },
    });
  }

  /** Runs a command and yields stdout/stderr events as they arrive. */
  streamCommand(
    cmd: string,
    args: string[] = [],
    options: ExecOptions = {},
  ): AsyncGenerator<ExecStreamEvent> {
    return this.#http.stream<ExecStreamEvent>("POST", this.#path("/exec"), {
      ...options,
      query: { stream: true },
      body: { cmd, args, stream: true },
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /** Snapshots the sandbox to storage. The handle is updated to the pausing/paused view. */
  async pause(options: RequestOptions = {}): Promise<this> {
    this.#data = await this.#http.request<SandboxView>("POST", this.#path("/pause"), options);
    return this;
  }

  /** Restores a paused sandbox. The handle is updated to the resuming/running view. */
  async resume(options: RequestOptions = {}): Promise<this> {
    this.#data = await this.#http.request<SandboxView>("POST", this.#path("/resume"), options);
    return this;
  }

  /** Clones a paused sandbox into a new independent sandbox. */
  async fork(request: ForkSandboxRequest = {}, options: RequestOptions = {}): Promise<Sandbox> {
    const view = await this.#http.request<SandboxView>("POST", this.#path("/fork"), {
      ...options,
      body: request,
    });
    return new Sandbox(this.#http, view);
  }

  /** Destroys the sandbox. Async on the server: the call returns when the
   *  row is in `destroying` (or `destroyed` if it was already terminal or
   *  the host could reclaim it inline). Use `waitUntilDestroyed` to wait
   *  for full reclamation. */
  async destroy(options: RequestOptions = {}): Promise<DestroyedResponse> {
    const result = await this.#http.request<DestroyedResponse>("DELETE", this.#path(), options);
    this.#data = { ...this.#data, status: result.status };
    return result;
  }

  /** Grows the overlay disk to `diskMib`. */
  async resize(diskMib: number, options: RequestOptions = {}): Promise<ResizeSandboxResponse> {
    return this.#http.request<ResizeSandboxResponse>("POST", this.#path("/resize"), {
      ...options,
      body: { disk_mib: diskMib },
    });
  }

  /** Toggles HTTP ingress. The handle is updated to the patched view. */
  async setIngress(enabled: boolean, options: RequestOptions = {}): Promise<this> {
    this.#data = await this.#http.request<SandboxView>("PATCH", this.#path(), {
      ...options,
      body: { ingress_enabled: enabled },
    });
    if (!enabled) {
      // Disabling ingress invalidates the cached URL template. Re-enabling
      // cannot repopulate it — SandboxView omits ingress_url_template
      // (tracked in NodeOps-app/fc#36).
      this.#ingressUrlTemplate = undefined;
    }
    return this;
  }

  // ── waiters ───────────────────────────────────────────────────────────

  /** Polls until the sandbox is `running`. Aborts on terminal failure states
   *  including `destroying`/`destroyed` (a parallel destroy will never
   *  resume into running). */
  async waitUntilRunning(options: WaitOptions = {}): Promise<this> {
    await this.#waitFor(
      (s) => s === "running",
      ["error", "failed", "destroying", "destroyed"],
      options,
    );
    return this;
  }

  /** Polls until the sandbox is `paused`. Aborts on terminal failure states
   *  including `destroying`/`destroyed`. */
  async waitUntilPaused(options: WaitOptions = {}): Promise<this> {
    await this.#waitFor(
      (s) => s === "paused",
      ["error", "failed", "destroying", "destroyed"],
      options,
    );
    return this;
  }

  /** Polls until the sandbox is `destroyed`. `destroying` is an intermediate
   *  step on the way to destroyed and must not abort the wait. */
  async waitUntilDestroyed(options: WaitOptions = {}): Promise<this> {
    await this.#waitFor((s) => s === "destroyed", ["error", "failed"], options);
    return this;
  }

  async #waitFor(
    done: (status: SandboxStatus) => boolean,
    badStates: SandboxStatus[],
    options: WaitOptions,
  ): Promise<void> {
    await pollUntil<SandboxView>({
      poll: async () => {
        // Carry the caller's per-request options (headers, retry, timeout)
        // into every poll refresh, not just the abort signal.
        const refreshOptions: RequestOptions = { ...options.request };
        if (options.signal) {
          refreshOptions.signal = options.signal;
        }
        await this.refresh(refreshOptions);
        return this.#data;
      },
      done: (view) => done(view.status),
      failed: (view) =>
        badStates.includes(view.status)
          ? `Sandbox ${view.id} entered terminal state "${view.status}" while waiting.`
          : undefined,
      timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_MS,
      signal: options.signal,
    });
  }

  // ── egress / bandwidth ────────────────────────────────────────────────

  getEgress(options: RequestOptions = {}): Promise<EgressView> {
    return this.#http.request<EgressView>("GET", this.#path("/egress"), options);
  }

  /** Replaces the egress allowlist. `null` / empty = allow all. */
  setEgress(rules: string[] | null, options: RequestOptions = {}): Promise<EgressView> {
    return this.#http.request<EgressView>("PUT", this.#path("/egress"), {
      ...options,
      body: { egress: rules },
    });
  }

  getBandwidth(options: RequestOptions = {}): Promise<BandwidthView> {
    return this.#http.request<BandwidthView>("GET", this.#path("/bandwidth"), options);
  }

  /** Tops up the bandwidth quota by `addBytes`. */
  rechargeBandwidth(addBytes: number, options: RequestOptions = {}): Promise<BandwidthView> {
    return this.#http.request<BandwidthView>("POST", this.#path("/bandwidth/recharge"), {
      ...options,
      body: { add_bytes: addBytes },
    });
  }

  // ── networks ──────────────────────────────────────────────────────────

  attachNetwork(networkId: string, options: RequestOptions = {}): Promise<OKResponse> {
    return this.#http.request<OKResponse>("POST", this.#path("/networks"), {
      ...options,
      body: { id: networkId },
    });
  }

  detachNetwork(networkId: string, options: RequestOptions = {}): Promise<OKResponse> {
    return this.#http.request<OKResponse>(
      "DELETE",
      this.#path(`/networks/${encodePath(networkId)}`),
      options,
    );
  }

  // ── disks ─────────────────────────────────────────────────────────────

  /** Lists disks attached to this sandbox with per-attachment mount status. */
  async listDisks(options: RequestOptions = {}): Promise<SandboxDiskView[]> {
    const data = await this.#http.request<SandboxDisksListResponse>(
      "GET",
      this.#path("/disks"),
      options,
    );
    return data.disks;
  }

  /**
   * Live-attaches a registered disk into the running sandbox. The server
   * rejects with 409 if the sandbox is not `running` — paused sandboxes
   * pick up new mounts on resume via `CreateSandboxRequest.disks` at
   * create or fork time.
   *
   * @param diskId  disk id (`disk_<ulid>`) or user-scoped name
   * @param mountPath  absolute path inside the guest, e.g. `/mnt/data`
   * @param subPath  optional bucket sub-folder to expose at `mountPath`
   */
  attachDisk(
    diskId: string,
    mountPath: string,
    subPath?: string,
    options: RequestOptions = {},
  ): Promise<OKResponse> {
    const body: { disk_id: string; mount_path: string; sub_path?: string } = {
      disk_id: diskId,
      mount_path: mountPath,
    };
    if (subPath !== undefined) body.sub_path = subPath;
    return this.#http.request<OKResponse>("POST", this.#path("/disks"), {
      ...options,
      body,
    });
  }

  /**
   * Detaches a disk from this sandbox. `mountPath` is required because the
   * same disk may be mounted at multiple paths — the composite key is
   * (sandbox, disk, mount_path). Bucket contents are untouched.
   */
  detachDisk(
    diskId: string,
    mountPath: string,
    options: RequestOptions = {},
  ): Promise<DiskDetachedResponse> {
    return this.#http.request<DiskDetachedResponse>(
      "DELETE",
      this.#path(`/disks/${encodePath(diskId)}`),
      { ...options, query: { mount_path: mountPath } },
    );
  }

  // ── port readiness ────────────────────────────────────────────────────

  /**
   * Polls a TCP port from inside the sandbox until something is listening,
   * using `bash`'s `/dev/tcp` shim. Requires `bash` and GNU `timeout` in
   * the rootfs (both are present in the fc-spawn default rootfs).
   *
   * Resolves to `this` once the port accepts a connection; throws
   * `FcTimeoutError` if the port is still closed when the budget runs out.
   */
  async waitForPortReady(
    port: number,
    options: WaitOptions & { intervalMs?: number; host?: string } = {},
  ): Promise<this> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new FcError(`Invalid port: ${port}. Must be an integer in 1-65535.`);
    }
    const host = options.host ?? "127.0.0.1";
    if (!PORT_READY_HOST_RE.test(host)) {
      throw new FcError(
        `Invalid host: ${JSON.stringify(host)}. Must be an IPv4/IPv6 literal or DNS hostname.`,
      );
    }
    const intervalMs = options.intervalMs ?? DEFAULT_PORT_READY_INTERVAL_MS;
    const budgetMs = options.timeoutMs ?? DEFAULT_PORT_READY_TIMEOUT_MS;
    const timeoutSec = Math.max(1, Math.ceil(budgetMs / 1000));
    const sleepSec = (Math.max(50, intervalMs) / 1000).toFixed(3);
    const script = `timeout ${timeoutSec} bash -c 'until (echo > /dev/tcp/${host}/${port}) 2>/dev/null; do sleep ${sleepSec}; done'`;
    const execOptions: ExecOptions = {
      ...options.request,
      timeoutMs: budgetMs + PORT_READY_BUFFER_MS,
    };
    if (options.signal) {
      execOptions.signal = options.signal;
    }
    const result = await this.runCommand("bash", ["-c", script], execOptions);
    if (result.result.exit_code !== 0) {
      throw new FcTimeoutError(
        `Port ${port} did not become ready on sandbox ${this.id} within ${timeoutSec}s.`,
      );
    }
    return this;
  }

  // ── ingress ───────────────────────────────────────────────────────────

  /**
   * Builds the public ingress URL for a port. Only available when the
   * sandbox was created with `ingress_enabled: true`.
   */
  previewUrl(port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new FcError(`Invalid port: ${port}. Must be an integer in 1-65535.`);
    }
    // Guard on current ingress state, not just the cached template — a
    // handle whose ingress was disabled must not hand back a dead URL.
    if (!this.#data.ingress_enabled || !this.#ingressUrlTemplate) {
      throw new FcError(
        "No ingress URL is available. Create the sandbox with ingress_enabled: true.",
      );
    }
    return this.#ingressUrlTemplate.replace("<port>", String(port));
  }
}

function splitOptions(options: FcClientOptions & RequestOptions): {
  clientOpts: FcClientOptions;
  requestOpts: RequestOptions;
} {
  const clientOpts: FcClientOptions = {};
  if (options.apiKey !== undefined) clientOpts.apiKey = options.apiKey;
  if (options.authHeaders !== undefined) clientOpts.authHeaders = options.authHeaders;
  if (options.baseUrl !== undefined) clientOpts.baseUrl = options.baseUrl;
  if (options.fetch !== undefined) clientOpts.fetch = options.fetch;
  if (options.userAgent !== undefined) clientOpts.userAgent = options.userAgent;
  if (options.headers !== undefined) clientOpts.headers = options.headers;
  if (options.timeoutMs !== undefined) clientOpts.timeoutMs = options.timeoutMs;
  if (options.retry !== undefined) clientOpts.retry = options.retry;

  const requestOpts: RequestOptions = {};
  if (options.signal !== undefined) requestOpts.signal = options.signal;
  if (options.headers !== undefined) requestOpts.headers = options.headers;
  if (options.timeoutMs !== undefined) requestOpts.timeoutMs = options.timeoutMs;
  if (options.retry !== undefined) requestOpts.retry = options.retry;

  return { clientOpts, requestOpts };
}
