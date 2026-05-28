// FcClient: the entry point. Owns transport configuration, catalog and
// identity calls, the sandbox factory, and the templates / networks APIs.

import { resolveConfig } from "./config.js";
import { encodePath, FcHttp } from "./http.js";
import { Sandbox } from "./sandbox.js";
import type {
  CreateSandboxOptions,
  CreateSandboxRequest,
  CreateSandboxResponse,
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
  ShapesData,
  TemplateCreateRequest,
  TemplateLogEvent,
  TemplateLogsOptions,
  TemplatesListResponse,
  TemplateView,
  WhoAmIView,
} from "./types.js";

const DEFAULT_WAIT_MS = 120_000;

/** Template (custom rootfs) operations. Reached via `client.templates`. */
export class TemplatesApi {
  readonly #http: FcHttp;

  constructor(http: FcHttp) {
    this.#http = http;
  }

  async list(options: RequestOptions = {}): Promise<TemplateView[]> {
    const data = await this.#http.request<TemplatesListResponse>("GET", "/v1/templates", options);
    return data.templates;
  }

  /** Submits a Dockerfile to build into a sandbox rootfs. */
  create(request: TemplateCreateRequest, options: RequestOptions = {}): Promise<TemplateView> {
    return this.#http.request<TemplateView>("POST", "/v1/templates", {
      ...options,
      body: request,
    });
  }

  get(id: string, options: GetTemplateOptions = {}): Promise<TemplateView> {
    const { include, ...rest } = options;
    return this.#http.request<TemplateView>("GET", `/v1/templates/${encodePath(id)}`, {
      ...rest,
      query: { include },
    });
  }

  delete(id: string, options: RequestOptions = {}): Promise<OKResponse> {
    return this.#http.request<OKResponse>("DELETE", `/v1/templates/${encodePath(id)}`, options);
  }

  /** Fetches the build log so far as plain text. */
  async logs(id: string, options: TemplateLogsOptions = {}): Promise<string> {
    const { attempt, ...rest } = options;
    const path = `/v1/templates/${encodePath(id)}/logs`;
    const response = await this.#http.requestRaw("GET", path, {
      ...rest,
      query: { attempt },
    });
    if (!response.ok) {
      await this.#http.throwForResponse(response, path);
    }
    return response.text();
  }

  /** Follows the build log, yielding NDJSON events until the build finishes. */
  followLogs(id: string, options: TemplateLogsOptions = {}): AsyncGenerator<TemplateLogEvent> {
    const { attempt, ...rest } = options;
    return this.#http.stream<TemplateLogEvent>("GET", `/v1/templates/${encodePath(id)}/logs`, {
      ...rest,
      query: { attempt, follow: true },
    });
  }
}

/** Overlay network operations. Reached via `client.networks`. */
export class NetworksApi {
  readonly #http: FcHttp;

  constructor(http: FcHttp) {
    this.#http = http;
  }

  list(options: RequestOptions = {}): Promise<Network[]> {
    return this.#http.request<Network[]>("GET", "/v1/networks", options);
  }

  create(request: NetworkCreateRequest, options: RequestOptions = {}): Promise<Network> {
    return this.#http.request<Network>("POST", "/v1/networks", { ...options, body: request });
  }

  get(id: string, options: RequestOptions = {}): Promise<Network> {
    return this.#http.request<Network>("GET", `/v1/networks/${encodePath(id)}`, options);
  }

  delete(id: string, options: RequestOptions = {}): Promise<OKResponse> {
    return this.#http.request<OKResponse>("DELETE", `/v1/networks/${encodePath(id)}`, options);
  }
}

export class FcClient {
  /** Low-level transport. An escape hatch for requests the SDK does not model. */
  readonly http: FcHttp;
  readonly templates: TemplatesApi;
  readonly networks: NetworksApi;

  constructor(options: FcClientOptions = {}) {
    this.http = new FcHttp(resolveConfig(options));
    this.templates = new TemplatesApi(this.http);
    this.networks = new NetworksApi(this.http);
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  // ── health / identity ─────────────────────────────────────────────────

  healthz(options: RequestOptions = {}): Promise<HealthzResponse> {
    return this.http.request<HealthzResponse>("GET", "/healthz", { ...options, auth: false });
  }

  /** Readiness probe. Returns `{ ready: false, reason }` instead of throwing on 503. */
  async readyz(options: RequestOptions = {}): Promise<ReadyzResponse> {
    const response = await this.http.requestRaw("GET", "/readyz", {
      ...options,
      auth: false,
      retry: false,
    });
    const text = await response.text();
    try {
      const envelope = JSON.parse(text) as { status?: string; data?: unknown };
      if (
        (envelope.status === "success" || envelope.status === "fail") &&
        envelope.data !== undefined
      ) {
        return envelope.data as ReadyzResponse;
      }
    } catch {
      // Non-JSON body — fall through to the status-derived result.
    }
    return { ready: response.ok };
  }

  whoami(options: RequestOptions = {}): Promise<WhoAmIView> {
    return this.http.request<WhoAmIView>("GET", "/v1/whoami", options);
  }

  // ── catalog ───────────────────────────────────────────────────────────

  async listShapes(options: RequestOptions = {}): Promise<Shape[]> {
    const data = await this.http.request<ShapesData>("GET", "/v1/shapes", options);
    return data.shapes;
  }

  listRootfs(options: RequestOptions = {}): Promise<RootfsData> {
    return this.http.request<RootfsData>("GET", "/v1/rootfs", options);
  }

  listHosts(options: RequestOptions = {}): Promise<HostPublic[]> {
    return this.http.request<HostPublic[]>("GET", "/v1/hosts", options);
  }

  // ── sandboxes ─────────────────────────────────────────────────────────

  /**
   * Creates a sandbox and, by default, waits until it is `running`.
   * Pass `{ wait: false }` to return as soon as the row exists.
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
    const sandbox = new Sandbox(this.http, view, created.ingress_url_template);
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

  /** Connects to an existing sandbox by id. */
  async getSandbox(id: string, options: RequestOptions = {}): Promise<Sandbox> {
    const view = await this.http.request<SandboxView>(
      "GET",
      `/v1/sandboxes/${encodePath(id)}`,
      options,
    );
    return new Sandbox(this.http, view);
  }

  /** Connects to an existing sandbox by its VM IP. */
  async getSandboxByIP(ip: string, options: RequestOptions = {}): Promise<Sandbox> {
    const view = await this.http.request<SandboxView>(
      "GET",
      `/v1/sandboxes/by-ip/${encodePath(ip)}`,
      options,
    );
    return new Sandbox(this.http, view);
  }

  /** Lists the caller's sandboxes as connected handles. */
  async listSandboxes(options: ListSandboxesOptions = {}): Promise<Sandbox[]> {
    const { limit, status, ...rest } = options;
    const views = await this.http.request<SandboxView[]>("GET", "/v1/sandboxes", {
      ...rest,
      query: { limit, status },
    });
    return views.map((view) => new Sandbox(this.http, view));
  }
}

/** Constructs an FcClient. Equivalent to `new FcClient(options)`. */
export function createClient(options: FcClientOptions = {}): FcClient {
  return new FcClient(options);
}

/**
 * Internal bootstrap used by `Sandbox.create()` / `Sandbox.connect()`.
 * Defined here to avoid an import cycle on the FcClient class.
 *
 * @internal
 */
export function bootstrapClient(options: FcClientOptions): FcClient {
  return new FcClient(options);
}
