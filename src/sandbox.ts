// The Sandbox handle: a stateful object returned by FcClient that owns a
// sandbox id and exposes lifecycle, command, file and network operations.

import { FcError } from "./errors.js";
import { encodePath, type FcHttp } from "./http.js";
import { pollUntil } from "./poll.js";
import type {
  BandwidthView,
  DestroyedResponse,
  EgressView,
  ExecOptions,
  ExecResponse,
  ExecStreamEvent,
  ForkSandboxRequest,
  OKResponse,
  RequestOptions,
  ResizeSandboxResponse,
  SandboxStatus,
  SandboxView,
  WaitOptions,
} from "./types.js";

const DEFAULT_WAIT_MS = 120_000;

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
    const response = await this.#http.requestRaw(
      "GET",
      `/v1/sandboxes/${encodePath(this.#sandboxId)}/files`,
      { ...options, query: { path } },
    );
    if (!response.ok) {
      await this.#http.throwForResponse(response);
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

  /** Destroys the sandbox. */
  async destroy(options: RequestOptions = {}): Promise<DestroyedResponse> {
    return this.#http.request<DestroyedResponse>("DELETE", this.#path(), options);
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

  /** Polls until the sandbox is `running`. */
  async waitUntilRunning(options: WaitOptions = {}): Promise<this> {
    await this.#waitFor((s) => s === "running", ["error", "failed", "destroyed"], options);
    return this;
  }

  /** Polls until the sandbox is `paused`. */
  async waitUntilPaused(options: WaitOptions = {}): Promise<this> {
    await this.#waitFor((s) => s === "paused", ["error", "failed", "destroyed"], options);
    return this;
  }

  /** Polls until the sandbox is `destroyed`. */
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
