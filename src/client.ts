import { FcHttp, encodePath } from "./http.js";
import type {
  BandwidthView,
  CreateSandboxRequest,
  CreateSandboxResponse,
  DestroyedResponse,
  EgressView,
  ExecRequest,
  ExecResponse,
  ExecStreamEvent,
  FcClientOptions,
  ForkSandboxRequest,
  GetTemplateLogsOptions,
  GetTemplateOptions,
  HealthzResponse,
  HostPublic,
  Network,
  NetworkCreateRequest,
  NetworkEntry,
  OKResponse,
  PatchSandboxRequest,
  PauseAck,
  ReadyzResponse,
  RechargeBandwidthRequest,
  ResumeAck,
  RequestOptions,
  ResizeSandboxRequest,
  ResizeSandboxResponse,
  RootfsData,
  SandboxView,
  SetEgressRequest,
  ShapesData,
  TemplateCreateRequest,
  TemplateLogEvent,
  TemplatesListResponse,
  TemplateView,
  WhoAmIView
} from "./types.js";

export class FcClient {
  private readonly http: FcHttp;

  constructor(options: FcClientOptions) {
    this.http = new FcHttp(options);
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  healthz(options?: RequestOptions): Promise<HealthzResponse> {
    return this.http.request("GET", "/healthz", { ...options, auth: false });
  }

  readyz(options?: RequestOptions): Promise<ReadyzResponse> {
    return this.http.request("GET", "/readyz", { ...options, auth: false });
  }

  whoami(options?: RequestOptions): Promise<WhoAmIView> {
    return this.http.request("GET", "/v1/whoami", options);
  }

  listShapes(options?: RequestOptions): Promise<ShapesData> {
    return this.http.request("GET", "/v1/shapes", options);
  }

  listRootfs(options?: RequestOptions): Promise<RootfsData> {
    return this.http.request("GET", "/v1/rootfs", options);
  }

  listHosts(options?: RequestOptions): Promise<HostPublic[]> {
    return this.http.request("GET", "/v1/hosts", options);
  }

  listSandboxes(options: { limit?: number; status?: string } & RequestOptions = {}): Promise<SandboxView[]> {
    const { limit, status, ...requestOptions } = options;
    return this.http.request("GET", "/v1/sandboxes", {
      ...requestOptions,
      query: { limit, status }
    });
  }

  createSandbox(body: CreateSandboxRequest, options?: RequestOptions): Promise<CreateSandboxResponse> {
    return this.http.request("POST", "/v1/sandboxes", { ...options, body });
  }

  getSandbox(id: string, options?: RequestOptions): Promise<SandboxView> {
    return this.http.request("GET", `/v1/sandboxes/${encodePath(id)}`, options);
  }

  destroySandbox(id: string, options?: RequestOptions): Promise<DestroyedResponse> {
    return this.http.request("DELETE", `/v1/sandboxes/${encodePath(id)}`, options);
  }

  patchSandbox(id: string, body: PatchSandboxRequest, options?: RequestOptions): Promise<SandboxView> {
    return this.http.request("PATCH", `/v1/sandboxes/${encodePath(id)}`, { ...options, body });
  }

  pauseSandbox(id: string, options?: RequestOptions): Promise<PauseAck> {
    return this.http.requestWithEmptyFallback("POST", `/v1/sandboxes/${encodePath(id)}/pause`, {
      options,
      fallback: { id, status: "paused" }
    });
  }

  resumeSandbox(id: string, options?: RequestOptions): Promise<ResumeAck> {
    return this.http.requestWithEmptyFallback("POST", `/v1/sandboxes/${encodePath(id)}/resume`, {
      options,
      fallback: { id, status: "running" }
    });
  }

  forkSandbox(id: string, body: ForkSandboxRequest = {}, options?: RequestOptions): Promise<SandboxView> {
    return this.http.request("POST", `/v1/sandboxes/${encodePath(id)}/fork`, { ...options, body });
  }

  getSandboxByIP(ip: string, options?: RequestOptions): Promise<SandboxView> {
    return this.http.request("GET", `/v1/sandboxes/by-ip/${encodePath(ip)}`, options);
  }

  execSandbox(id: string, body: ExecRequest, options?: RequestOptions): Promise<ExecResponse> {
    const { stream: _stream, ...bufferedBody } = body;
    return this.http.request("POST", `/v1/sandboxes/${encodePath(id)}/exec`, {
      ...options,
      body: bufferedBody
    });
  }

  execSandboxStream(
    id: string,
    body: Omit<ExecRequest, "stream">,
    options?: RequestOptions
  ): AsyncGenerator<ExecStreamEvent> {
    return this.http.stream("POST", `/v1/sandboxes/${encodePath(id)}/exec`, {
      ...options,
      query: { stream: true },
      body: { ...body, stream: true }
    });
  }

  async uploadFile(
    id: string,
    path: string,
    bytes: BodyInit,
    options?: RequestOptions
  ): Promise<unknown> {
    return this.http.request("PUT", `/v1/sandboxes/${encodePath(id)}/files`, {
      ...options,
      query: { path },
      rawBody: bytes,
      contentType: "application/octet-stream"
    });
  }

  async downloadFile(id: string, path: string, options?: RequestOptions): Promise<ArrayBuffer> {
    const response = await this.http.fetchRaw("GET", `/v1/sandboxes/${encodePath(id)}/files`, {
      ...options,
      query: { path }
    });

    if (!response.ok) {
      await this.http.throwApiError(response);
    }

    return response.arrayBuffer();
  }

  getEgress(id: string, options?: RequestOptions): Promise<EgressView> {
    return this.http.request("GET", `/v1/sandboxes/${encodePath(id)}/egress`, options);
  }

  setEgress(id: string, body: SetEgressRequest, options?: RequestOptions): Promise<EgressView> {
    return this.http.request("PUT", `/v1/sandboxes/${encodePath(id)}/egress`, { ...options, body });
  }

  getBandwidth(id: string, options?: RequestOptions): Promise<BandwidthView> {
    return this.http.request("GET", `/v1/sandboxes/${encodePath(id)}/bandwidth`, options);
  }

  rechargeBandwidth(
    id: string,
    body: RechargeBandwidthRequest,
    options?: RequestOptions
  ): Promise<BandwidthView> {
    return this.http.request("POST", `/v1/sandboxes/${encodePath(id)}/bandwidth/recharge`, {
      ...options,
      body
    });
  }

  resizeSandbox(
    id: string,
    body: ResizeSandboxRequest,
    options?: RequestOptions
  ): Promise<ResizeSandboxResponse> {
    return this.http.request("POST", `/v1/sandboxes/${encodePath(id)}/resize`, { ...options, body });
  }

  listTemplates(options?: RequestOptions): Promise<TemplatesListResponse> {
    return this.http.request("GET", "/v1/templates", options);
  }

  submitTemplate(body: TemplateCreateRequest, options?: RequestOptions): Promise<TemplateView> {
    return this.http.request("POST", "/v1/templates", { ...options, body });
  }

  getTemplate(id: string, options: GetTemplateOptions = {}): Promise<TemplateView> {
    const { include, ...requestOptions } = options;
    return this.http.request("GET", `/v1/templates/${encodePath(id)}`, {
      ...requestOptions,
      query: { include }
    });
  }

  deleteTemplate(id: string, options?: RequestOptions): Promise<DestroyedResponse> {
    return this.http.request("DELETE", `/v1/templates/${encodePath(id)}`, options);
  }

  getTemplateLogs(id: string, options: GetTemplateLogsOptions = {}): AsyncGenerator<TemplateLogEvent> {
    const { attempt, limit, ...requestOptions } = options;
    return this.http.stream("GET", `/v1/templates/${encodePath(id)}/logs`, {
      ...requestOptions,
      query: { attempt, limit }
    });
  }

  listNetworks(options?: RequestOptions): Promise<Network[]> {
    return this.http.request("GET", "/v1/networks", options);
  }

  createNetwork(body: NetworkCreateRequest, options?: RequestOptions): Promise<Network> {
    return this.http.request("POST", "/v1/networks", { ...options, body });
  }

  getNetwork(id: string, options?: RequestOptions): Promise<Network> {
    return this.http.request("GET", `/v1/networks/${encodePath(id)}`, options);
  }

  deleteNetwork(id: string, options?: RequestOptions): Promise<OKResponse> {
    return this.http.request("DELETE", `/v1/networks/${encodePath(id)}`, options);
  }

  attachNetwork(id: string, body: NetworkEntry, options?: RequestOptions): Promise<OKResponse> {
    return this.http.request("POST", `/v1/sandboxes/${encodePath(id)}/networks`, { ...options, body });
  }

  detachNetwork(id: string, network: string, options?: RequestOptions): Promise<OKResponse> {
    return this.http.request(
      "DELETE",
      `/v1/sandboxes/${encodePath(id)}/networks/${encodePath(network)}`,
      options
    );
  }
}

export function createClient(options: FcClientOptions): FcClient {
  return new FcClient(options);
}
