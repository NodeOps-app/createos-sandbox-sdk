// The Sandbox handle: a stateful object returned by FcClient that owns a
// sandbox id and exposes lifecycle, command, file and network operations.

import { bootstrapClient } from "./client.js";
import { DEFAULT_WAIT_MS } from "./config.js";
import { FcError, FcTimeoutError } from "./errors.js";
import { encodePath, type FcHttp } from "./http.js";
import { pollUntil } from "./poll.js";
import type {
  AddSSHPubkeysResponse,
  AttachDiskOptions,
  BandwidthView,
  CreateSandboxOptions,
  CreateSandboxRequest,
  DestroyedResponse,
  DetachDiskOptions,
  DiskDetachedResponse,
  EgressView,
  ExecOptions,
  ExecResponse,
  ExecStreamEvent,
  ExecStreamFrame,
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

const DEFAULT_PORT_READY_TIMEOUT_MS = 30_000;
const PORT_READY_BUFFER_MS = 5_000;
const DEFAULT_PORT_READY_INTERVAL_MS = 200;

// IPv4 dotted quad (loose; intentionally permissive), bracket-stripped IPv6
// hex+colon, or a DNS hostname (RFC 1123 label rules, no trailing dot).
// Anything else is rejected — the value is interpolated into a bash command
// inside the guest, so we must refuse shell metacharacters categorically.
const PORT_READY_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.\-:]{0,253}[A-Za-z0-9])?$/;

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FcError(`Invalid port: ${port}. Must be an integer in 1-65535.`);
  }
}

/** File transfer scoped to one sandbox. Reached via `sandbox.files`. */
export class SandboxFiles {
  readonly #http: FcHttp;
  readonly #sandboxId: string;

  constructor(http: FcHttp, sandboxId: string) {
    this.#http = http;
    this.#sandboxId = sandboxId;
  }

  /**
   * Uploads raw bytes to an absolute path inside the sandbox.
   *
   * @throws {FcValidationError} when the path is invalid or the body is rejected.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.files.upload("/srv/index.html", "<h1>Hello</h1>");
   */
  async upload(path: string, data: BodyInit, options: RequestOptions = {}): Promise<void> {
    await this.#http.request("PUT", `/v1/sandboxes/${encodePath(this.#sandboxId)}/files`, {
      ...options,
      query: { path },
      rawBody: data,
      contentType: "application/octet-stream",
    });
  }

  /**
   * Downloads a file from the sandbox as raw bytes.
   *
   * @throws {FcNotFoundError} when the sandbox or the path does not exist.
   * @throws {FcValidationError} when the path is invalid.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const buf = await sandbox.files.download("/etc/os-release");
   * console.log(new TextDecoder().decode(buf));
   */
  async download(path: string, options: RequestOptions = {}): Promise<ArrayBuffer> {
    const url = `/v1/sandboxes/${encodePath(this.#sandboxId)}/files`;
    const response = await this.#http.requestRaw("GET", url, {
      ...options,
      query: { path },
    });
    if (!response.ok) {
      await this.#http.throwForResponse(response, "GET", url);
    }
    return response.arrayBuffer();
  }
}

/**
 * A stateful handle to one sandbox, returned by the `FcClient` factory
 * methods. Owns a sandbox id and exposes lifecycle (pause / resume / fork /
 * destroy), command execution, file transfer (`files`), egress / bandwidth,
 * network and disk operations, and the `waitUntil*` pollers. Mutating calls
 * refresh the cached projection in place; read it via `data` or the
 * `id` / `status` / `ip` / `name` getters.
 *
 * @example
 * const sandbox = await fc.createSandbox({ shape: "s-1vcpu-256mb", rootfs: "devbox:1" });
 * const out = await sandbox.runCommand("uname", ["-a"]);
 * await sandbox.destroy();
 */
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
   *
   * @throws {FcValidationError} when shape or rootfs are unknown.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the caller hits a quota.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout or wait budget elapses.
   *
   * @example
   * import Sandbox from "fc-sandbox-sdk";
   * const sandbox = await Sandbox.create({
   *   shape: "s-1vcpu-256mb",
   *   rootfs: "devbox:1",
   * });
   * console.log(sandbox.id);
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
   *
   * @throws {FcNotFoundError} when no sandbox with that id exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * import Sandbox from "fc-sandbox-sdk";
   * const sandbox = await Sandbox.connect("sb_01h…");
   * console.log(sandbox.status);
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

  /** The VM's private IP, or `undefined` while the sandbox is still `creating`. */
  get ip(): string | undefined {
    return this.#data.ip;
  }

  get name(): string | undefined {
    return this.#data.name;
  }

  /** The full, last-known sandbox projection. */
  get data(): SandboxView {
    return this.#data;
  }

  /**
   * Returns the last-known sandbox projection. Used by `JSON.stringify`.
   *
   * @example
   * console.log(JSON.stringify(sandbox));
   */
  toJSON(): SandboxView {
    return this.#data;
  }

  #path(suffix = ""): string {
    return `/v1/sandboxes/${encodePath(this.#data.id)}${suffix}`;
  }

  /**
   * Re-fetches the sandbox projection and updates this handle in place.
   *
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.refresh();
   * console.log(sandbox.status);
   */
  async refresh(options: RequestOptions = {}): Promise<this> {
    this.#data = await this.#http.request<SandboxView>("GET", this.#path(), options);
    return this;
  }

  // ── commands ──────────────────────────────────────────────────────────

  /**
   * Runs a command to completion and returns its buffered output.
   *
   * @throws {FcValidationError} when the command shape is rejected.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const out = await sandbox.runCommand("uname", ["-a"]);
   * console.log(out.result.stdout);
   */
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

  /**
   * Runs a command and yields a discriminated union of events as they
   * arrive. Switch on `event.type` to handle each kind — see
   * {@link ExecStreamEvent} for the payload shape.
   *
   * @throws {FcValidationError} when the command shape is rejected.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * for await (const event of sandbox.streamCommand("tail", ["-f", "/var/log/syslog"])) {
   *   if (event.type === "stdout") process.stdout.write(event.data);
   *   if (event.type === "exit") console.log("exit:", event.exitCode);
   * }
   */
  async *streamCommand(
    cmd: string,
    args: string[] = [],
    options: ExecOptions = {},
  ): AsyncGenerator<ExecStreamEvent> {
    const frames = this.#http.stream<ExecStreamFrame>("POST", this.#path("/exec"), {
      ...options,
      query: { stream: true },
      body: { cmd, args, stream: true },
    });
    for await (const frame of frames) {
      if (frame.hb) {
        yield { type: "heartbeat" };
        continue;
      }
      if (frame.stdout !== undefined) yield { type: "stdout", data: frame.stdout };
      if (frame.stderr !== undefined) yield { type: "stderr", data: frame.stderr };
      if (frame.error !== undefined) yield { type: "error", message: frame.error };
      if (frame.exit_code !== undefined) yield { type: "exit", exitCode: frame.exit_code };
    }
  }

  /**
   * Runs a shell script inside the sandbox via `bash -lc` and returns its
   * buffered output, throwing if it exits non-zero. The throw-on-failure
   * counterpart to {@link Sandbox.runCommand}: use it when a non-zero exit
   * should abort the caller instead of being inspected by hand. The thrown
   * `FcError` carries the optional `label`, the exit code, the run duration
   * and the tail of stdout/stderr.
   *
   * @param script - Shell script passed to `bash -lc`; pipes, redirection,
   *   globbing and `&&` chains all work.
   * @param options - `label` tags the thrown error; any other
   *   {@link ExecOptions} (`timeoutMs`, `signal`, `headers`, `retry`) pass
   *   through to the underlying exec.
   *
   * @throws {FcError} when the command exits non-zero or the agent reports a
   *   start failure.
   * @throws {FcValidationError} when the command shape is rejected.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.sh("apt-get update -qq && apt-get install -y curl", {
   *   label: "apt",
   *   timeoutMs: 300_000,
   * });
   * const { result } = await sandbox.sh("cat /etc/os-release");
   * console.log(result.stdout);
   */
  async sh(script: string, options: ExecOptions & { label?: string } = {}): Promise<ExecResponse> {
    const { label, ...execOptions } = options;
    const response = await this.runCommand("bash", ["-lc", script], execOptions);
    const { result, exec_ms } = response;
    if (result.exit_code !== 0 || result.error) {
      const tag = label ? `${label}: ` : "";
      const parts = [`${tag}command exited ${result.exit_code} after ${exec_ms}ms`];
      if (result.error) parts.push(`error: ${result.error}`);
      if (result.stdout) parts.push(`stdout: ${result.stdout.slice(-2000)}`);
      if (result.stderr) parts.push(`stderr: ${result.stderr.slice(-2000)}`);
      throw new FcError(parts.join("\n"));
    }
    return response;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /**
   * Snapshots the sandbox to storage. The handle is updated to the pausing/paused view.
   *
   * @throws {FcValidationError} when the sandbox is in an invalid state for pause.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.pause();
   * await sandbox.waitUntilPaused();
   */
  async pause(options: RequestOptions = {}): Promise<this> {
    this.#data = await this.#http.request<SandboxView>("POST", this.#path("/pause"), options);
    return this;
  }

  /**
   * Restores a paused sandbox. The handle is updated to the resuming/running view.
   *
   * @throws {FcValidationError} when the sandbox is not in a resumable state.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.resume();
   * await sandbox.waitUntilRunning();
   */
  async resume(options: RequestOptions = {}): Promise<this> {
    this.#data = await this.#http.request<SandboxView>("POST", this.#path("/resume"), options);
    return this;
  }

  /**
   * Clones a paused sandbox into a new independent sandbox.
   *
   * @throws {FcValidationError} when the source sandbox is not in a forkable state.
   * @throws {FcNotFoundError} when the source sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant or the caller hits a quota.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.pause();
   * const clone = await sandbox.fork();
   * console.log(clone.id);
   */
  async fork(request: ForkSandboxRequest = {}, options: RequestOptions = {}): Promise<Sandbox> {
    const view = await this.#http.request<SandboxView>("POST", this.#path("/fork"), {
      ...options,
      body: request,
    });
    return new Sandbox(this.#http, view);
  }

  /**
   * Destroys the sandbox. Async on the server: the call returns when the
   * row is in `destroying` (or `destroyed` if it was already terminal or
   * the host could reclaim it inline). Use `waitUntilDestroyed` to wait
   * for full reclamation.
   *
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.destroy();
   * await sandbox.waitUntilDestroyed();
   */
  async destroy(options: RequestOptions = {}): Promise<DestroyedResponse> {
    const result = await this.#http.request<DestroyedResponse>("DELETE", this.#path(), options);
    this.#data = { ...this.#data, status: result.status };
    return result;
  }

  /**
   * Grows the overlay disk to `diskMib`.
   *
   * @param diskMib - New disk size in MiB. Must exceed the current size.
   *
   * @throws {FcValidationError} when `diskMib` is invalid or below the current size.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant or the caller hits a quota.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.resize(4096);
   */
  async resize(diskMib: number, options: RequestOptions = {}): Promise<ResizeSandboxResponse> {
    const result = await this.#http.request<ResizeSandboxResponse>("POST", this.#path("/resize"), {
      ...options,
      body: { disk_mib: diskMib },
    });
    this.#data = { ...this.#data, disk_mib: result.disk_mib };
    return result;
  }

  /**
   * Toggles HTTP ingress. The handle is updated to the patched view.
   *
   * @throws {FcValidationError} when the sandbox is in an invalid state for the patch.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.setIngress(true);
   * console.log(sandbox.previewUrl(8080));
   */
  async setIngress(enabled: boolean, options: RequestOptions = {}): Promise<this> {
    this.#data = await this.#http.request<SandboxView>("PATCH", this.#path(), {
      ...options,
      body: { ingress_enabled: enabled },
    });
    if (!enabled) {
      // Disabling ingress invalidates the cached URL template. Re-enabling
      // cannot repopulate it — SandboxView omits ingress_url_template
      // (a known control-plane limitation).
      this.#ingressUrlTemplate = undefined;
    }
    return this;
  }

  /**
   * Adds OpenSSH public keys to this sandbox's authorized set. Keys already
   * present are de-duplicated server-side. Returns the total `ssh_pubkeys`
   * count after the add. Unlike `createSandbox({ ssh_pubkeys })`, this works
   * on a live sandbox.
   *
   * @throws {FcValidationError} when a key is not a valid OpenSSH public key.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const { count } = await sandbox.addSSHPubkeys([pubkey]);
   */
  addSSHPubkeys(keys: string[], options: RequestOptions = {}): Promise<AddSSHPubkeysResponse> {
    return this.#http.request<AddSSHPubkeysResponse>("POST", this.#path("/ssh-pubkeys"), {
      ...options,
      body: { keys },
    });
  }

  // ── waiters ───────────────────────────────────────────────────────────

  /**
   * Polls until the sandbox is `running`. Aborts on terminal failure states
   * including `destroying`/`destroyed` (a parallel destroy will never
   * resume into running).
   *
   * @throws {FcError} when the sandbox enters a terminal failure state.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the wait budget elapses.
   *
   * @example
   * await sandbox.waitUntilRunning({ timeoutMs: 60_000 });
   */
  async waitUntilRunning(options: WaitOptions = {}): Promise<this> {
    await this.#waitFor(
      (s) => s === "running",
      ["error", "failed", "destroying", "destroyed"],
      options,
    );
    return this;
  }

  /**
   * Polls until the sandbox is `paused`. Aborts on terminal failure states
   * including `destroying`/`destroyed`.
   *
   * @throws {FcError} when the sandbox enters a terminal failure state.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the wait budget elapses.
   *
   * @example
   * await sandbox.pause();
   * await sandbox.waitUntilPaused();
   */
  async waitUntilPaused(options: WaitOptions = {}): Promise<this> {
    await this.#waitFor(
      (s) => s === "paused",
      ["error", "failed", "destroying", "destroyed"],
      options,
    );
    return this;
  }

  /**
   * Polls until the sandbox is `destroyed`. `destroying` is an intermediate
   * step on the way to destroyed and must not abort the wait.
   *
   * @throws {FcError} when the sandbox enters a non-destroy terminal failure state.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the wait budget elapses.
   *
   * @example
   * await sandbox.destroy();
   * await sandbox.waitUntilDestroyed();
   */
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

  /**
   * Returns the current egress allowlist and counters.
   *
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const egress = await sandbox.getEgress();
   * console.log(egress.egress);
   */
  getEgress(options: RequestOptions = {}): Promise<EgressView> {
    return this.#http.request<EgressView>("GET", this.#path("/egress"), options);
  }

  /**
   * Replaces the egress allowlist. `null` / empty = allow all.
   *
   * @param rules - `host:port` allow rules, or `null` / `[]` to allow all egress.
   *
   * @throws {FcValidationError} when a rule is malformed.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.setEgress(["api.openai.com:443", "registry.npmjs.org:443"]);
   */
  setEgress(rules: string[] | null, options: RequestOptions = {}): Promise<EgressView> {
    return this.#http.request<EgressView>("PUT", this.#path("/egress"), {
      ...options,
      body: { egress: rules },
    });
  }

  /**
   * Returns the current bandwidth quota and usage.
   *
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const bw = await sandbox.getBandwidth();
   * console.log(bw.used_bytes, bw.quota_bytes);
   */
  getBandwidth(options: RequestOptions = {}): Promise<BandwidthView> {
    return this.#http.request<BandwidthView>("GET", this.#path("/bandwidth"), options);
  }

  /**
   * Tops up the bandwidth quota by `addBytes`.
   *
   * @param addBytes - Bytes to add to the quota.
   *
   * @throws {FcValidationError} when `addBytes` is invalid.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant or the caller hits a quota.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.rechargeBandwidth(10 * 1024 * 1024 * 1024); // +10 GiB
   */
  rechargeBandwidth(addBytes: number, options: RequestOptions = {}): Promise<BandwidthView> {
    return this.#http.request<BandwidthView>("POST", this.#path("/bandwidth/recharge"), {
      ...options,
      body: { add_bytes: addBytes },
    });
  }

  // ── networks ──────────────────────────────────────────────────────────

  /**
   * Attaches this sandbox to an overlay network.
   *
   * @throws {FcValidationError} when the sandbox is in an invalid state.
   * @throws {FcNotFoundError} when the sandbox or network does not exist.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the network belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.attachNetwork("net_01h…");
   */
  attachNetwork(networkId: string, options: RequestOptions = {}): Promise<OKResponse> {
    return this.#http.request<OKResponse>("POST", this.#path("/networks"), {
      ...options,
      body: { id: networkId },
    });
  }

  /**
   * Detaches this sandbox from an overlay network.
   *
   * @throws {FcNotFoundError} when the sandbox or attachment does not exist.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the network belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.detachNetwork("net_01h…");
   */
  detachNetwork(networkId: string, options: RequestOptions = {}): Promise<OKResponse> {
    return this.#http.request<OKResponse>(
      "DELETE",
      this.#path(`/networks/${encodePath(networkId)}`),
      options,
    );
  }

  // ── disks ─────────────────────────────────────────────────────────────

  /**
   * Lists disks attached to this sandbox with per-attachment mount status.
   *
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const disks = await sandbox.listDisks();
   * for (const d of disks) console.log(d.disk_id, d.mount_path, d.mount_state);
   */
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
   * @throws {FcValidationError} when the sandbox is not running or the mount path collides.
   * @throws {FcNotFoundError} when the sandbox or disk no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the disk belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.attachDisk({
   *   diskId: "shared-data",
   *   mountPath: "/mnt/data",
   * });
   */
  attachDisk(opts: AttachDiskOptions, options: RequestOptions = {}): Promise<OKResponse> {
    const body: { disk_id: string; mount_path: string; sub_path?: string } = {
      disk_id: opts.diskId,
      mount_path: opts.mountPath,
    };
    if (opts.subPath !== undefined) body.sub_path = opts.subPath;
    return this.#http.request<OKResponse>("POST", this.#path("/disks"), {
      ...options,
      body,
    });
  }

  /**
   * Detaches a disk from this sandbox. `mountPath` is required because the
   * same disk may be mounted at multiple paths — the composite key is
   * (sandbox, disk, mountPath). Bucket contents are untouched.
   *
   * @throws {FcValidationError} when the sandbox is in an invalid state for detach.
   * @throws {FcNotFoundError} when the sandbox, disk, or attachment does not exist.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the disk belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await sandbox.detachDisk({
   *   diskId: "shared-data",
   *   mountPath: "/mnt/data",
   * });
   */
  detachDisk(opts: DetachDiskOptions, options: RequestOptions = {}): Promise<DiskDetachedResponse> {
    return this.#http.request<DiskDetachedResponse>(
      "DELETE",
      this.#path(`/disks/${encodePath(opts.diskId)}`),
      { ...options, query: { mount_path: opts.mountPath } },
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
   *
   * @throws {FcError} when `port` or `host` are invalid.
   * @throws {FcNotFoundError} when the sandbox no longer exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcServerError} on 5xx from the control plane.
   * @throws {FcConnectionError} when the network fails.
   * @throws {FcTimeoutError} when the wait budget elapses without the port opening.
   *
   * @example
   * await sandbox.runCommand("sh", ["-c", "python3 -m http.server 8080 &"]);
   * await sandbox.waitForPortReady(8080, { timeoutMs: 10_000 });
   */
  async waitForPortReady(
    port: number,
    options: WaitOptions & { intervalMs?: number; host?: string } = {},
  ): Promise<this> {
    assertValidPort(port);
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
   *
   * @param port - The in-guest port to route to.
   * @param options - `scheme` overrides the URL scheme; defaults to `https`.
   *   Pass `"http"` when the ingress TLS certificate is not yet provisioned
   *   for the sandbox's hostname.
   *
   * @throws {FcError} when `port` is invalid or ingress is not enabled
   *   for this sandbox.
   *
   * @example
   * const url = sandbox.previewUrl(8080);
   * console.log(url);
   * // TLS cert may lag on a fresh ingress hostname — force http:
   * const plain = sandbox.previewUrl(8080, { scheme: "http" });
   */
  previewUrl(port: number, options: { scheme?: "http" | "https" } = {}): string {
    assertValidPort(port);
    // Guard on current ingress state, not just the cached template — a
    // handle whose ingress was disabled must not hand back a dead URL.
    if (!this.#data.ingress_enabled || !this.#ingressUrlTemplate) {
      throw new FcError(
        "No ingress URL is available. Create the sandbox with ingress_enabled: true.",
      );
    }
    const url = this.#ingressUrlTemplate.replace("<port>", String(port));
    return options.scheme === "http" ? url.replace(/^https:/, "http:") : url;
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
