// HTTP transport: URL building, auth, JSend unwrapping, retries with
// exponential backoff, per-request timeouts and AbortSignal composition.

import type { ResolvedConfig } from "./config.js";
import {
  errorFromResponse,
  FcConnectionError,
  FcError,
  FcTimeoutError,
  parseRetryAfterSeconds,
} from "./errors.js";
import { readNdjson } from "./ndjson.js";
import { sleep } from "./poll.js";
import { SENSITIVE_HEADER_NAMES } from "./redact.js";
import type { JSendEnvelope, RetryOptions } from "./types.js";

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface HttpRequestOptions {
  signal?: AbortSignal | undefined;
  headers?: HeadersInit | undefined;
  timeoutMs?: number | undefined;
  retry?: RetryOptions | false | undefined;
  query?: Query | undefined;
  /** JSON request body. Serialized with JSON.stringify. */
  body?: unknown;
  /** Raw request body, sent as-is (file uploads). */
  rawBody?: BodyInit | undefined;
  contentType?: string | undefined;
  /** Set false to skip auth credentials (health probes). */
  auth?: boolean | undefined;
}

/** Methods safe to retry on network errors and ambiguous 5xx statuses. */
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

// Strip the comprehensive credential set documented in redact.ts — keeping a
// second hardcoded list here was the source of a gap (cookie /
// proxy-authorization / x-csrf-token leaked on `auth:false`).
function deleteAuthHeaders(headers: Headers): void {
  for (const name of SENSITIVE_HEADER_NAMES) {
    headers.delete(name);
  }
}

export class FcHttp {
  readonly baseUrl: string;
  readonly #config: ResolvedConfig;
  readonly #baseOrigin: string;

  constructor(config: ResolvedConfig) {
    this.#config = config;
    this.baseUrl = config.baseUrl;
    this.#baseOrigin = new URL(config.baseUrl).origin;
  }

  /** Performs a request, unwraps the JSend success envelope, throws on non-2xx. */
  async request<T>(method: string, path: string, options: HttpRequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(method, path, options);
    if (!response.ok) {
      await this.throwForResponse(response, path);
    }
    return unwrapJSend<T>(response);
  }

  /**
   * Performs a request with retries. Returns the raw Response without
   * throwing on HTTP error statuses — callers inspect `response.ok`.
   * Still throws FcConnectionError / FcTimeoutError for transport failures.
   */
  async requestRaw(
    method: string,
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<Response> {
    // A ReadableStream body is consumed by the first attempt and cannot be
    // replayed — retrying would re-send a locked/empty body. Disable retries
    // entirely when the body is non-replayable.
    const nonReplayable = options.rawBody instanceof ReadableStream;
    const retry = nonReplayable ? false : this.#resolveRetry(options.retry);
    const maxRetries = retry ? retry.maxRetries : 0;
    let attempt = 0;

    for (;;) {
      let response: Response;
      try {
        response = await this.#fetchOnce(method, path, options);
      } catch (err) {
        const canRetry =
          err instanceof FcConnectionError &&
          retry !== false &&
          attempt < maxRetries &&
          IDEMPOTENT.has(method.toUpperCase());
        if (canRetry && retry) {
          await sleep(backoffDelay(attempt, retry), options.signal);
          attempt++;
          continue;
        }
        throw err;
      }

      if (
        response.ok ||
        retry === false ||
        attempt >= maxRetries ||
        !isRetryableStatus(method, response.status)
      ) {
        return response;
      }

      const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after"));
      const delay = retryAfter !== undefined ? retryAfter * 1000 : backoffDelay(attempt, retry);
      // Drain the body so the underlying socket can be reused.
      await response.arrayBuffer().catch(() => undefined);
      await sleep(delay, options.signal);
      attempt++;
    }
  }

  /** Streams an NDJSON response as an async iterator. Not retried. */
  async *stream<T>(
    method: string,
    path: string,
    options: HttpRequestOptions = {},
  ): AsyncGenerator<T> {
    const response = await this.#fetchOnce(method, path, options);
    if (!response.ok) {
      await this.throwForResponse(response, path);
    }
    if (!response.body) {
      throw new FcError("The control plane returned an empty stream.");
    }
    yield* readNdjson<T>(response.body);
  }

  /**
   * Reads a non-2xx response and throws the matching typed error. Pass
   * the original request path so the error can carry the addressed
   * resource id; falls back to `response.url` when omitted.
   */
  async throwForResponse(response: Response, requestPath?: string): Promise<never> {
    let envelope: JSendEnvelope<unknown> | undefined;
    if (hasJsonBody(response)) {
      try {
        envelope = (await response.json()) as JSendEnvelope<unknown>;
      } catch {
        envelope = undefined;
      }
    }
    let resolvedPath = requestPath;
    if (resolvedPath === undefined && response.url) {
      try {
        resolvedPath = new URL(response.url).pathname;
      } catch {
        resolvedPath = undefined;
      }
    }
    throw errorFromResponse(response, envelope, resolvedPath);
  }

  async #fetchOnce(method: string, path: string, options: HttpRequestOptions): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? this.#config.timeoutMs;
    const headers = this.#buildHeaders(options);
    const body = buildBody(headers, options);
    const init: RequestInit & { duplex?: "half" } = { method, headers };
    if (body !== undefined) {
      init.body = body;
      // Node's fetch (undici) rejects a streaming body unless duplex is set;
      // browsers ignore the option, so adding it is always safe.
      if (body instanceof ReadableStream) {
        init.duplex = "half";
      }
    }

    // Build the URL before the try: #buildUrl throws FcError on a non-base
    // origin, and that security/config error must not be caught and
    // rewrapped as FcConnectionError below.
    const url = this.#buildUrl(path, options.query);
    const signals: AbortSignal[] = [];
    if (options.signal) {
      signals.push(options.signal);
    }
    let timeout: TimeoutHandle | undefined;
    if (timeoutMs > 0) {
      timeout = createTimeoutSignal(timeoutMs);
      signals.push(timeout.signal);
    }
    if (signals.length > 0) {
      init.signal = AbortSignal.any(signals);
    }

    try {
      return await this.#config.fetch(url, init);
    } catch (err) {
      if (timeout?.signal.aborted === true && options.signal?.aborted !== true) {
        throw new FcTimeoutError(`Request timed out after ${timeoutMs}ms: ${method} ${path}`, {
          cause: err,
        });
      }
      if (options.signal?.aborted === true) {
        throw err;
      }
      throw new FcConnectionError(`Network error: ${method} ${path}`, { cause: err });
    } finally {
      timeout?.clear();
    }
  }

  #buildHeaders(options: HttpRequestOptions): Headers {
    const headers = new Headers(this.#config.defaultHeaders);
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }
    if (!headers.has("user-agent")) {
      headers.set("User-Agent", this.#config.userAgent);
    }
    if (!headers.has("x-fc-runtime")) {
      headers.set("X-Fc-Runtime", this.#config.runtimeTag);
    }
    if (options.auth === false) {
      // auth:false means "no auth on this request" (health probes). Drop any
      // credentials the caller supplied via default/per-request headers
      // too — otherwise the opt-out is incomplete.
      deleteAuthHeaders(headers);
    } else {
      if (this.#config.authHeaders) {
        deleteAuthHeaders(headers);
        new Headers(this.#config.authHeaders).forEach((value, key) => headers.set(key, value));
      } else if (this.#config.apiKey) {
        // The control plane resolves X-Auth-Token/X-Access-Token/Authorization
        // before X-Api-Key. Keep generic headers from shadowing the SDK key.
        deleteAuthHeaders(headers);
        headers.set("X-Api-Key", this.#config.apiKey);
      } else {
        throw new FcError(
          "Authentication is required. Pass apiKey, set FC_API_KEY, or pass authHeaders.",
        );
      }
    }
    return headers;
  }

  #buildUrl(path: string, query: Query | undefined): string {
    const url = new URL(path.replace(/^\/+/, ""), `${this.baseUrl}/`);
    // Security: an absolute path (e.g. "https://elsewhere/...") resolves to a
    // foreign origin yet the request still carries the auth credentials.
    // Reject it before dispatch so the API key never leaves the
    // configured control plane.
    if (url.origin !== this.#baseOrigin) {
      throw new FcError(`Refusing to send a request to a non-base origin: ${url.origin}`);
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  #resolveRetry(perRequest: RetryOptions | false | undefined): Required<RetryOptions> | false {
    if (perRequest === false) {
      return false;
    }
    const base = this.#config.retry;
    if (!perRequest) {
      return base;
    }
    const fallback = base || { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 30_000 };
    return {
      maxRetries: perRequest.maxRetries ?? fallback.maxRetries,
      baseDelayMs: perRequest.baseDelayMs ?? fallback.baseDelayMs,
      maxDelayMs: perRequest.maxDelayMs ?? fallback.maxDelayMs,
    };
  }
}

export function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function isRetryableStatus(method: string, status: number): boolean {
  // 429 / 503 mean the server explicitly did not process the request, so
  // they are safe to retry for any method. Ambiguous 5xx / 408 are retried
  // only for idempotent methods.
  if (status === 429 || status === 503) {
    return true;
  }
  if (IDEMPOTENT.has(method.toUpperCase())) {
    return status === 408 || status === 500 || status === 502 || status === 504;
  }
  return false;
}

function backoffDelay(attempt: number, retry: Required<RetryOptions>): number {
  const exponential = Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
  return exponential + Math.random() * retry.baseDelayMs;
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

interface TimeoutHandle {
  signal: AbortSignal;
  clear: () => void;
}

function createTimeoutSignal(timeoutMs: number): TimeoutHandle {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function hasJsonBody(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("application/json");
}

async function unwrapJSend<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  let envelope: JSendEnvelope<T>;
  try {
    envelope = JSON.parse(text) as JSendEnvelope<T>;
  } catch {
    throw new FcError(
      `Expected a JSON response from the control plane, got: ${text.slice(0, 200)}`,
    );
  }
  if (envelope.status === "success") {
    return envelope.data;
  }
  throw new FcError(
    `The control plane returned a non-success envelope (status="${envelope.status}").`,
  );
}
