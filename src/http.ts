import { FcApiError } from "./errors.js";
import { readNdjson } from "./ndjson.js";
import type { FcClientOptions, JSendEnvelope, RequestOptions } from "./types.js";

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface HttpRequestOptions extends RequestOptions {
  query?: Query;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  auth?: boolean;
}

export class FcHttp {
  readonly baseUrl: string;

  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly defaultHeaders: HeadersInit;

  constructor(options: FcClientOptions) {
    const fetchFn = options.fetch ?? globalThis.fetch;
    if (!fetchFn) {
      throw new Error("A fetch implementation is required.");
    }

    if (!options.baseUrl?.trim()) {
      throw new Error("baseUrl is required.");
    }

    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchFn = fetchFn;
    this.defaultHeaders = options.headers ?? {};
  }

  async request<T>(method: string, path: string, options: HttpRequestOptions = {}): Promise<T> {
    const response = await this.fetchRaw(method, path, options);

    if (!response.ok) {
      await this.throwApiError(response);
    }

    return readSuccessEnvelope<T>(response);
  }

  async requestWithEmptyFallback<T>(
    method: string,
    path: string,
    input: { options: RequestOptions | undefined; fallback: T }
  ): Promise<T> {
    const response = await this.fetchRaw(method, path, input.options);

    if (!response.ok) {
      await this.throwApiError(response);
    }

    if (!hasJsonBody(response)) {
      return input.fallback;
    }

    return readSuccessEnvelope<T>(response);
  }

  async *stream<T>(method: string, path: string, options: HttpRequestOptions = {}): AsyncGenerator<T> {
    const response = await this.fetchRaw(method, path, options);

    if (!response.ok) {
      await this.throwApiError(response);
    }

    if (!response.body) {
      throw new FcApiError("fc-spawn API returned an empty stream.", response);
    }

    yield* readNdjson<T>(response.body);
  }

  fetchRaw(method: string, path: string, options: HttpRequestOptions = {}): Promise<Response> {
    const headers = this.buildHeaders(options);
    const body = buildBody(headers, options);
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      init.body = body;
    }

    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    return this.fetchFn(this.buildUrl(path, options.query), init);
  }

  async throwApiError(response: Response): Promise<never> {
    if (hasJsonBody(response)) {
      try {
        const envelope = (await response.json()) as JSendEnvelope<unknown>;
        if (envelope.status === "fail") {
          throw new FcApiError(`fc-spawn request failed with ${response.status}.`, response, envelope);
        }

        if (envelope.status === "error") {
          throw new FcApiError(envelope.message, response, envelope);
        }
      } catch (error) {
        if (error instanceof FcApiError) {
          throw error;
        }
      }
    }

    throw new FcApiError(`fc-spawn request failed with ${response.status}.`, response);
  }

  private buildHeaders(options: HttpRequestOptions): Headers {
    const headers = new Headers(this.defaultHeaders);
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }

    if (options.auth !== false) {
      if (!this.apiKey) {
        throw new Error("An apiKey is required for authenticated fc-spawn requests.");
      }
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    return headers;
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(path.replace(/^\/+/, ""), `${this.baseUrl}/`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }
}

export function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.toString().replace(/\/+$/, "");
}

function buildBody(headers: Headers, options: HttpRequestOptions): BodyInit | undefined {
  if (options.rawBody !== undefined) {
    if (options.contentType) {
      headers.set("Content-Type", options.contentType);
    }
    return options.rawBody;
  }

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    return JSON.stringify(options.body);
  }

  return undefined;
}

async function readSuccessEnvelope<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as JSendEnvelope<T>;
  if (envelope.status === "success") {
    return envelope.data;
  }

  throw new FcApiError("fc-spawn API returned an unsuccessful envelope.", response, envelope);
}

function hasJsonBody(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json");
}
