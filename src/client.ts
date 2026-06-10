// FcClient: the entry point. Owns transport configuration, catalog and
// identity calls, the sandbox factory, and the templates / networks APIs.

import { DEFAULT_WAIT_MS, resolveConfig } from "./config.js";
import { errorFromResponse } from "./errors.js";
import { encodePath, FcHttp } from "./http.js";
import { Sandbox } from "./sandbox.js";
import type {
  CreateSandboxOptions,
  CreateSandboxRequest,
  CreateSandboxResponse,
  DiskCreateRequest,
  DiskCredentials,
  JSendEnvelope,
  DiskDeletedResponse,
  DiskView,
  FcClientOptions,
  GetTemplateOptions,
  HealthzResponse,
  HostPublic,
  ListSandboxesOptions,
  Network,
  NetworkCreateRequest,
  OKResponse,
  ReadyzResponse,
  RequestOptions,
  RootfsData,
  SandboxView,
  Shape,
  TemplateCreateRequest,
  TemplateLogEvent,
  TemplateLogsOptions,
  TemplateView,
  WhoAmIView,
} from "./types.js";

/**
 * Template (custom rootfs) operations. Reached via `client.templates`.
 *
 * Every method also throws {@link FcServerError} on a 5xx response and
 * {@link FcConnectionError} on network failure; per-method `@throws` tags list
 * only the conditions specific to that call.
 */
export class TemplatesApi {
  readonly #http: FcHttp;

  constructor(http: FcHttp) {
    this.#http = http;
  }

  /**
   * Lists every template owned by the caller.
   *
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const templates = await fc.templates.list();
   * console.log(templates.map((t) => t.id));
   */
  list(options: RequestOptions = {}): Promise<TemplateView[]> {
    return this.#http.fetchAllPages<TemplateView>("GET", "/v1/templates", options, {
      legacyKey: "templates",
    });
  }

  /**
   * Streams every template owned by the caller, fetching one page at a time
   * instead of buffering the whole list like {@link list}.
   *
   * @example
   * for await (const t of fc.templates.iterate()) console.log(t.id);
   */
  iterate(options: RequestOptions = {}): AsyncGenerator<TemplateView> {
    return this.#http.iteratePages<TemplateView>("GET", "/v1/templates", options, {
      legacyKey: "templates",
    });
  }

  /**
   * Submits a Dockerfile to build into a sandbox rootfs.
   *
   * @throws {FcValidationError} when the request body is malformed or the Dockerfile is rejected.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the caller hits a quota.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const tpl = await fc.templates.create({
   *   name: "my-devbox",
   *   dockerfile: "FROM debian:trixie-slim\nRUN apt-get update",
   * });
   * console.log(tpl.id, tpl.status);
   */
  create(request: TemplateCreateRequest, options: RequestOptions = {}): Promise<TemplateView> {
    return this.#http.request<TemplateView>("POST", "/v1/templates", {
      ...options,
      body: request,
    });
  }

  /**
   * Looks up a template by id. Pass `include: "dockerfile"` to receive the
   * original build input alongside the projection.
   *
   * @throws {FcNotFoundError} when no template with that id exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the template belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const tpl = await fc.templates.get("tpl_01h…", { include: "dockerfile" });
   * console.log(tpl.status, tpl.dockerfile);
   */
  get(id: string, options: GetTemplateOptions = {}): Promise<TemplateView> {
    const { include, ...rest } = options;
    return this.#http.request<TemplateView>("GET", `/v1/templates/${encodePath(id)}`, {
      ...rest,
      query: { include },
    });
  }

  /**
   * Deletes a template. Existing sandboxes built from it are unaffected.
   *
   * @throws {FcNotFoundError} when the template id does not exist.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the template belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await fc.templates.delete("tpl_01h…");
   */
  delete(id: string, options: RequestOptions = {}): Promise<OKResponse> {
    return this.#http.request<OKResponse>("DELETE", `/v1/templates/${encodePath(id)}`, options);
  }

  /**
   * Fetches the build log so far as plain text.
   *
   * @throws {FcNotFoundError} when no template (or attempt) with that id exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the template belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const logs = await fc.templates.logs("tpl_01h…");
   * process.stdout.write(logs);
   */
  async logs(id: string, options: TemplateLogsOptions = {}): Promise<string> {
    const { attempt, ...rest } = options;
    const path = `/v1/templates/${encodePath(id)}/logs`;
    const response = await this.#http.requestRaw("GET", path, {
      ...rest,
      query: { attempt },
    });
    if (!response.ok) {
      await this.#http.throwForResponse(response, "GET", path);
    }
    return response.text();
  }

  /**
   * Follows the build log, yielding NDJSON events until the build finishes.
   *
   * @throws {FcNotFoundError} when no template (or attempt) with that id exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the template belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * for await (const event of fc.templates.followLogs("tpl_01h…")) {
   *   if (event.line) process.stdout.write(event.line);
   * }
   */
  followLogs(id: string, options: TemplateLogsOptions = {}): AsyncGenerator<TemplateLogEvent> {
    const { attempt, ...rest } = options;
    return this.#http.stream<TemplateLogEvent>("GET", `/v1/templates/${encodePath(id)}/logs`, {
      ...rest,
      query: { attempt, follow: true },
    });
  }
}

/**
 * Overlay network operations. Reached via `client.networks`.
 *
 * Every method also throws {@link FcServerError} on a 5xx response and
 * {@link FcConnectionError} on network failure; per-method `@throws` tags list
 * only the conditions specific to that call.
 */
export class NetworksApi {
  readonly #http: FcHttp;

  constructor(http: FcHttp) {
    this.#http = http;
  }

  /**
   * Lists every overlay network owned by the caller.
   *
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const nets = await fc.networks.list();
   * console.log(nets.map((n) => n.id));
   */
  list(options: RequestOptions = {}): Promise<Network[]> {
    return this.#http.fetchAllPages<Network>("GET", "/v1/networks", options);
  }

  /**
   * Streams every overlay network owned by the caller, one page at a time.
   *
   * @example
   * for await (const n of fc.networks.iterate()) console.log(n.id);
   */
  iterate(options: RequestOptions = {}): AsyncGenerator<Network> {
    return this.#http.iteratePages<Network>("GET", "/v1/networks", options);
  }

  /**
   * Creates an overlay network. Members are attached later via
   * `sandbox.attachNetwork`.
   *
   * @throws {FcValidationError} when the request body is malformed or the CIDR conflicts.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the caller hits a quota.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const net = await fc.networks.create({ name: "team-net" });
   * console.log(net.id);
   */
  create(request: NetworkCreateRequest, options: RequestOptions = {}): Promise<Network> {
    return this.#http.request<Network>("POST", "/v1/networks", { ...options, body: request });
  }

  /**
   * Looks up an overlay network by id.
   *
   * @throws {FcNotFoundError} when no network with that id exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the network belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const net = await fc.networks.get("net_01h…");
   * console.log(net.cidr);
   */
  get(id: string, options: RequestOptions = {}): Promise<Network> {
    return this.#http.request<Network>("GET", `/v1/networks/${encodePath(id)}`, options);
  }

  /**
   * Deletes an overlay network. Member sandboxes are detached but not destroyed.
   *
   * @throws {FcNotFoundError} when the network id does not exist.
   * @throws {FcValidationError} when the network still has active members.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the network belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await fc.networks.delete("net_01h…");
   */
  delete(id: string, options: RequestOptions = {}): Promise<OKResponse> {
    return this.#http.request<OKResponse>("DELETE", `/v1/networks/${encodePath(id)}`, options);
  }
}

/**
 * S3-disk catalog operations. Reached via `client.disks`.
 *
 * Disks are user-registered S3 buckets that can be mounted into one or
 * more sandboxes. Mount/unmount happens via `Sandbox.attachDisk` and
 * `Sandbox.detachDisk`, or at create time via `CreateSandboxRequest.disks`.
 *
 * The control plane returns HTTP 503 ("disks API not configured") when
 * the operator has not provisioned a disk-credential cipher key — this
 * is a configuration state, not a transient failure.
 *
 * Every method also throws {@link FcServerError} on a 5xx response and
 * {@link FcConnectionError} on network failure; per-method `@throws` tags list
 * only the conditions specific to that call.
 */
export class DisksApi {
  readonly #http: FcHttp;

  constructor(http: FcHttp) {
    this.#http = http;
  }

  /**
   * Lists every registered S3 disk owned by the caller.
   *
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcServerError} on 5xx from the control plane (including 503
   *   when the disks API is not configured by the operator).
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const disks = await fc.disks.list();
   * console.log(disks.map((d) => d.name));
   */
  list(options: RequestOptions = {}): Promise<DiskView[]> {
    return this.#http.fetchAllPages<DiskView>("GET", "/v1/disks", options, { legacyKey: "disks" });
  }

  /**
   * Streams every registered S3 disk owned by the caller, one page at a time.
   *
   * @example
   * for await (const d of fc.disks.iterate()) console.log(d.name);
   */
  iterate(options: RequestOptions = {}): AsyncGenerator<DiskView> {
    return this.#http.iteratePages<DiskView>("GET", "/v1/disks", options, { legacyKey: "disks" });
  }

  /**
   * Registers an S3 bucket as a mountable disk. The server HEADs the
   * bucket before accepting; a typo or bad creds returns 400.
   *
   * @throws {FcValidationError} when the bucket HEAD fails or credentials are rejected.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the caller hits a quota.
   * @throws {FcServerError} on 5xx from the control plane (including 503
   *   when the disks API is not configured by the operator).
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const disk = await fc.disks.create({
   *   name: "shared-data",
   *   bucket: "my-bucket",
   *   region: "us-east-1",
   *   access_key_id: process.env.AWS_ACCESS_KEY_ID!,
   *   secret_access_key: process.env.AWS_SECRET_ACCESS_KEY!,
   * });
   * console.log(disk.id);
   */
  create(request: DiskCreateRequest, options: RequestOptions = {}): Promise<DiskView> {
    return this.#http.request<DiskView>("POST", "/v1/disks", { ...options, body: request });
  }

  /**
   * Looks up a disk by id (`disk_<ulid>`) or by user-scoped name.
   *
   * @throws {FcNotFoundError} when no disk with that id or name exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the disk belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const disk = await fc.disks.get("shared-data");
   * console.log(disk.bucket, disk.region);
   */
  get(idOrName: string, options: RequestOptions = {}): Promise<DiskView> {
    return this.#http.request<DiskView>("GET", `/v1/disks/${encodePath(idOrName)}`, options);
  }

  /**
   * Deletes a disk. Returns 409 (FcValidationError) if the disk is still
   * attached to a non-destroyed sandbox — detach first.
   *
   * @throws {FcNotFoundError} when the disk id or name does not exist.
   * @throws {FcValidationError} when the disk is still attached to a sandbox.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the disk belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await fc.disks.delete("shared-data");
   */
  delete(idOrName: string, options: RequestOptions = {}): Promise<DiskDeletedResponse> {
    return this.#http.request<DiskDeletedResponse>(
      "DELETE",
      `/v1/disks/${encodePath(idOrName)}`,
      options,
    );
  }

  /**
   * Rotates a disk's S3 credentials. Replaces the stored access/secret key
   * with `credentials`; the disk's non-secret config is untouched. Running
   * sandboxes holding the disk pick up the new credentials on their next
   * resume. Returns the disk's public view.
   *
   * @throws {FcValidationError} when access_key or secret_key is empty.
   * @throws {FcNotFoundError} when the disk id or name does not exist.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the disk belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * await fc.disks.rotateCredentials("shared-data", {
   *   access_key: "AKIA…",
   *   secret_key: "…",
   * });
   */
  rotateCredentials(
    idOrName: string,
    credentials: DiskCredentials,
    options: RequestOptions = {},
  ): Promise<DiskView> {
    return this.#http.request<DiskView>("PATCH", `/v1/disks/${encodePath(idOrName)}`, {
      ...options,
      body: { credentials },
    });
  }
}

/**
 * The SDK entry point. Owns transport configuration (auth, base URL,
 * timeouts, retries) and exposes catalog and identity calls, the sandbox
 * factory, and the `templates` / `networks` / `disks` sub-APIs.
 *
 * Every method that reaches the control plane also throws {@link FcServerError}
 * on a 5xx response and {@link FcConnectionError} on network failure; per-method
 * `@throws` tags list only the conditions specific to that call.
 *
 * @example
 * const fc = new FcClient({ apiKey: process.env.FC_API_KEY });
 * const sandbox = await fc.createSandbox({ shape: "s-1vcpu-256mb", rootfs: "devbox:1" });
 */
export class FcClient {
  /** Low-level transport. An escape hatch for requests the SDK does not model. */
  readonly http: FcHttp;
  /** Template (custom rootfs) operations. */
  readonly templates: TemplatesApi;
  /** Overlay network operations. */
  readonly networks: NetworksApi;
  /** S3-disk catalog operations. */
  readonly disks: DisksApi;

  constructor(options: FcClientOptions = {}) {
    this.http = new FcHttp(resolveConfig(options));
    this.templates = new TemplatesApi(this.http);
    this.networks = new NetworksApi(this.http);
    this.disks = new DisksApi(this.http);
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  // ── health / identity ─────────────────────────────────────────────────

  /**
   * Liveness probe. Unauthenticated; returns `{ up: true }` once the
   * control plane is up.
   *
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const ok = await fc.healthz();
   * console.log(ok);
   */
  healthz(options: RequestOptions = {}): Promise<HealthzResponse> {
    return this.http.request<HealthzResponse>("GET", "/healthz", { ...options, auth: false });
  }

  /**
   * Readiness probe. Returns `{ ready: false, reason }` instead of throwing on 503.
   *
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const r = await fc.readyz();
   * if (!r.ready) console.warn("not ready:", r.reason);
   */
  async readyz(options: RequestOptions = {}): Promise<ReadyzResponse> {
    const response = await this.http.requestRaw("GET", "/readyz", {
      ...options,
      auth: false,
      retry: false,
    });
    const text = await response.text();
    let envelope: { status?: string; data?: unknown } | undefined;
    try {
      envelope = JSON.parse(text) as { status?: string; data?: unknown };
    } catch {
      // Non-JSON body — fall through to the status-derived result.
    }
    // 200 (ready) and 503 (not ready) are the readiness signals; any other
    // non-OK status is a real error, not a "not ready" verdict.
    if (response.ok || response.status === 503) {
      if (
        (envelope?.status === "success" || envelope?.status === "fail") &&
        envelope.data !== undefined
      ) {
        return envelope.data as ReadyzResponse;
      }
      return { ready: response.ok };
    }
    throw errorFromResponse(response, envelope as JSendEnvelope<unknown> | undefined, {
      endpoint: "/readyz",
      method: "GET",
    });
  }

  /**
   * Returns the identity associated with the configured API key.
   *
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const me = await fc.whoami();
   * console.log(me.user_id, me.stats);
   */
  whoami(options: RequestOptions = {}): Promise<WhoAmIView> {
    return this.http.request<WhoAmIView>("GET", "/v1/whoami", options);
  }

  // ── catalog ───────────────────────────────────────────────────────────

  /**
   * Lists the available sandbox shapes (vCPU / RAM presets).
   * Unauthenticated.
   *
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const shapes = await fc.listShapes();
   * console.log(shapes.map((s) => s.id));
   */
  listShapes(options: RequestOptions = {}): Promise<Shape[]> {
    return this.http.fetchAllPages<Shape>(
      "GET",
      "/v1/shapes",
      { ...options, auth: false },
      { legacyKey: "shapes" },
    );
  }

  /**
   * Lists the catalog of built-in rootfs images. Unauthenticated.
   *
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const { rootfs } = await fc.listRootfs();
   * console.log(rootfs.map((r) => r.id));
   */
  listRootfs(options: RequestOptions = {}): Promise<RootfsData> {
    return this.http.request<RootfsData>("GET", "/v1/rootfs", { ...options, auth: false });
  }

  /**
   * Lists the worker hosts visible to the caller.
   *
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the caller cannot enumerate hosts.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const hosts = await fc.listHosts();
   * console.log(hosts.map((h) => h.id));
   */
  listHosts(options: RequestOptions = {}): Promise<HostPublic[]> {
    return this.http.fetchAllPages<HostPublic>("GET", "/v1/hosts", options);
  }

  /**
   * Streams the worker hosts visible to the caller, one page at a time.
   *
   * @example
   * for await (const h of fc.iterateHosts()) console.log(h.id);
   */
  iterateHosts(options: RequestOptions = {}): AsyncGenerator<HostPublic> {
    return this.http.iteratePages<HostPublic>("GET", "/v1/hosts", options);
  }

  // ── sandboxes ─────────────────────────────────────────────────────────

  /**
   * Creates a sandbox and, by default, waits until it is `running`.
   * Pass `{ wait: false }` to return as soon as the row exists.
   *
   * @throws {FcValidationError} when shape or rootfs are unknown.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the caller hits a quota.
   * @throws {FcTimeoutError} when the per-request timeout or wait budget elapses.
   *
   * @example
   * const sandbox = await fc.createSandbox({
   *   shape: "s-1vcpu-256mb",
   *   rootfs: "devbox:1",
   * });
   * console.log(sandbox.id, sandbox.ip);
   */
  async createSandbox(
    request: CreateSandboxRequest,
    options: CreateSandboxOptions = {},
  ): Promise<Sandbox> {
    const { wait, waitTimeoutMs, ...reqOptions } = options;
    const created = await this.http.request<CreateSandboxResponse>("POST", "/v1/sandboxes", {
      ...reqOptions,
      body: request,
    });
    // Reuse reqOptions so the follow-up GET inherits the caller's headers,
    // timeout and retry policy — not just the abort signal.
    const view = await this.http.request<SandboxView>(
      "GET",
      `/v1/sandboxes/${encodePath(created.id)}`,
      reqOptions,
    );
    // A freshly-created view may not carry the ingress template yet (still
    // `creating`); the create response computed it synchronously, so seed it
    // onto the canonical view when the GET hasn't populated it.
    const seeded =
      view.ingress_url_template === undefined && created.ingress_url_template !== undefined
        ? { ...view, ingress_url_template: created.ingress_url_template }
        : view;
    const sandbox = new Sandbox(this.http, seeded);
    if (wait !== false) {
      await sandbox.waitUntilRunning({
        timeoutMs: waitTimeoutMs ?? DEFAULT_WAIT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
        // Carry headers/retry/per-request timeout into each poll refresh.
        request: reqOptions,
      });
    }
    return sandbox;
  }

  /**
   * Connects to an existing sandbox by id.
   *
   * @throws {FcNotFoundError} when no sandbox with that id exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const sandbox = await fc.getSandbox("sb_01h…");
   * console.log(sandbox.status);
   */
  async getSandbox(id: string, options: RequestOptions = {}): Promise<Sandbox> {
    const view = await this.http.request<SandboxView>(
      "GET",
      `/v1/sandboxes/${encodePath(id)}`,
      options,
    );
    return new Sandbox(this.http, view);
  }

  /**
   * Connects to an existing sandbox by its VM IP.
   *
   * @throws {FcNotFoundError} when no sandbox with that IP exists.
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcPermissionError} when the sandbox belongs to another tenant.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * @example
   * const sandbox = await fc.getSandboxByIP("10.0.0.42");
   * console.log(sandbox.id);
   */
  async getSandboxByIP(ip: string, options: RequestOptions = {}): Promise<Sandbox> {
    const view = await this.http.request<SandboxView>(
      "GET",
      `/v1/sandboxes/by-ip/${encodePath(ip)}`,
      options,
    );
    return new Sandbox(this.http, view);
  }

  /**
   * Lists the caller's sandboxes as connected handles.
   *
   * @throws {FcAuthError} when the API key is missing or revoked.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   *
   * Walks every page by default; pass `limit` to cap the number of
   * handles returned.
   *
   * @example
   * const all = await fc.listSandboxes({ status: "running" });
   * for (const s of all) console.log(s.id, s.ip);
   */
  async listSandboxes(options: ListSandboxesOptions = {}): Promise<Sandbox[]> {
    const { limit, status, ...rest } = options;
    const views = await this.http.fetchAllPages<SandboxView>(
      "GET",
      "/v1/sandboxes",
      { ...rest, query: { status } },
      limit !== undefined ? { cap: limit } : {},
    );
    return views.map((view) => new Sandbox(this.http, view));
  }

  /**
   * Streams the caller's sandboxes as connected handles, fetching one page at
   * a time. Prefer over {@link listSandboxes} when the list may be large and
   * you want to start processing before every page is fetched. `limit` caps
   * the total handles yielded.
   *
   * @example
   * for await (const s of fc.iterateSandboxes({ status: "running" })) {
   *   console.log(s.id, s.ip);
   * }
   */
  async *iterateSandboxes(options: ListSandboxesOptions = {}): AsyncGenerator<Sandbox> {
    const { limit, status, ...rest } = options;
    const views = this.http.iteratePages<SandboxView>(
      "GET",
      "/v1/sandboxes",
      { ...rest, query: { status } },
      limit !== undefined ? { cap: limit } : {},
    );
    for await (const view of views) {
      yield new Sandbox(this.http, view);
    }
  }
}

/**
 * Constructs an FcClient. Equivalent to `new FcClient(options)`.
 *
 * @example
 * import { createClient } from "fc-sandbox-sdk";
 * const fc = createClient({ apiKey: process.env.FC_API_KEY });
 */
export function createClient(options: FcClientOptions = {}): FcClient {
  return new FcClient(options);
}
