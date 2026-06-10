// HTTP transport: URL building, auth, JSend unwrapping, retries with
// exponential backoff, per-request timeouts and AbortSignal composition.

import { DEFAULT_RETRY, mergeRetry, type ResolvedConfig } from "./config.js";
import {
  errorFromResponse,
  FcConnectionError,
  FcError,
  FcTimeoutError,
  parseRetryAfterSeconds,
} from "./errors.js";
import { readNdjson } from "./ndjson.js";
import { sleep } from "./poll.js";
import { redactHeaders, redactUrl, SENSITIVE_HEADER_NAMES } from "./redact.js";
import type { JSendEnvelope, RetryOptions, RetryReason } from "./types.js";

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

/**
 * A request built once and dispatched one or more times (retries reuse it).
 * `url`/`headers`/`body` are what actually goes on the wire; `hookMeta` is the
 * redacted payload derived from those same `headers`, present only when hooks
 * are configured. `path` is retained for error messages.
 */
interface PreparedRequest {
  url: string;
  path: string;
  method: string;
  headers: Headers;
  body: BodyInit | undefined;
  hookMeta: { url: string; method: string; headers: Record<string, string> } | undefined;
}

/** Methods safe to retry on network errors and ambiguous 5xx statuses. */
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);

// Strip the comprehensive credential set documented in redact.ts — keeping a
// second hardcoded list here was the source of a gap (cookie /
// proxy-authorization / x-csrf-token leaked on `auth:false`).
function deleteAuthHeaders(headers: Headers): void {
  for (const name of SENSITIVE_HEADER_NAMES) {
    headers.delete(name);
  }
}

/**
 * The HTTP transport underlying every SDK call. Handles URL building, auth
 * header injection, JSend unwrapping, retries with exponential backoff +
 * jitter (honoring `Retry-After`), per-request timeouts and `AbortSignal`
 * composition. Reached via `client.http` as an escape hatch for endpoints
 * the SDK does not model directly.
 */
export class FcHttp {
  readonly baseUrl: string;
  readonly #config: ResolvedConfig;
  readonly #baseOrigin: string;

  constructor(config: ResolvedConfig) {
    this.#config = config;
    this.baseUrl = config.baseUrl;
    this.#baseOrigin = new URL(config.baseUrl).origin;
  }

  /**
   * Performs a request, unwraps the JSend success envelope, throws on non-2xx.
   *
   * @throws {FcApiError} (or a subclass: FcAuthError, FcPermissionError,
   *   FcNotFoundError, FcValidationError, FcRateLimitError, FcServerError)
   *   on a non-2xx response.
   * @throws {FcConnectionError} when the request never reaches the server.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   * @throws {FcError} when the success body is not valid JSON or not a
   *   `success` envelope.
   */
  async request<T>(method: string, path: string, options: HttpRequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(method, path, options);
    if (!response.ok) {
      await this.throwForResponse(response, method, path);
    }
    return unwrapJSend<T>(response);
  }

  /**
   * Fetches every page of a list endpoint and returns the concatenated
   * items. The control plane wraps list results in a paginated envelope
   * (`{ data: T[], pagination: { total, limit, offset, count } }`); older
   * builds returned a legacy `{ <key>: T[] }` wrapper or a bare array.
   * All three are accepted.
   *
   * Paging is driven by the server-reported `total` and the actual item
   * count, never the requested page size — the control plane clamps
   * `limit` (max 500), so a larger request silently returns fewer rows.
   *
   * @param page.legacyKey property holding the array on the pre-pagination
   *   wrapper (e.g. `"disks"`, `"templates"`, `"shapes"`).
   * @param page.cap stop once this many items are collected and return at
   *   most `cap` rows. Omit to fetch everything.
   */
  async fetchAllPages<T>(
    method: string,
    path: string,
    options: HttpRequestOptions = {},
    page: { legacyKey?: string; cap?: number } = {},
  ): Promise<T[]> {
    const all: T[] = [];
    for await (const item of this.iteratePages<T>(method, path, options, page)) {
      all.push(item);
    }
    return all;
  }

  /**
   * Lazily yields every item of a paginated list endpoint, fetching one page
   * at a time and walking pages until the server-reported `total` is reached.
   * {@link fetchAllPages} is a thin collector over this; the public `iterate*`
   * helpers expose it so callers can stream a large list without buffering
   * every row in memory. Paging contract is identical to `fetchAllPages`.
   */
  async *iteratePages<T>(
    method: string,
    path: string,
    options: HttpRequestOptions = {},
    page: { legacyKey?: string; cap?: number } = {},
  ): AsyncGenerator<T> {
    const { legacyKey, cap } = page;
    const pageSize = cap !== undefined ? Math.min(cap, 500) : 500;
    const baseQuery = options.query ?? {};
    let yielded = 0;
    let offset = 0;
    for (;;) {
      const payload = await this.request<unknown>(method, path, {
        ...options,
        query: { ...baseQuery, limit: pageSize, offset },
      });
      const { items, total } = extractPage<T>(payload, legacyKey, path);
      for (const item of items) {
        yield item;
        if (cap !== undefined && ++yielded >= cap) return;
      }
      // A missing total means a non-paginated shape (bare array / legacy
      // wrapper) that already returned everything in one response.
      if (total === undefined || items.length === 0 || offset + items.length >= total) {
        return;
      }
      offset += items.length;
    }
  }

  /**
   * Performs a request with retries. Returns the raw Response without
   * throwing on HTTP error statuses — callers inspect `response.ok`.
   * Still throws FcConnectionError / FcTimeoutError for transport failures.
   *
   * @throws {FcConnectionError} when the request never reaches the server.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   * @throws {FcError} when the resolved URL would target a non-base origin.
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

    // Build the request once: URL, headers and body are identical across
    // retry attempts, and the hook payload is derived from the headers
    // actually sent (so observers don't drift from the wire).
    const prepared = this.#prepare(method, path, options);
    const hookMeta = prepared.hookMeta;

    for (;;) {
      let response: Response;
      let startMs = 0;
      try {
        await this.#fireRequestHook(hookMeta, attempt);
        startMs = performance.now();
        response = await this.#dispatch(prepared, options);
        await this.#fireResponseHook(hookMeta, attempt, startMs, response);
      } catch (err) {
        const canRetry =
          err instanceof FcConnectionError &&
          retry !== false &&
          attempt < maxRetries &&
          IDEMPOTENT.has(method.toUpperCase());
        if (canRetry && retry) {
          const delay = backoffDelay(attempt, retry);
          if (hookMeta) {
            await this.#fireRetryHook(hookMeta, attempt, {
              durationMs: performance.now() - startMs,
              reason: "network",
              delayMs: delay,
            });
          }
          await sleep(delay, options.signal);
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
      if (hookMeta) {
        await this.#fireRetryHook(hookMeta, attempt, {
          status: response.status,
          durationMs: performance.now() - startMs,
          requestId: response.headers.get("x-request-id") ?? undefined,
          reason: retryAfter !== undefined ? "rate-limit" : "status",
          delayMs: delay,
        });
      }
      // Drain the body so the underlying socket can be reused.
      await response.arrayBuffer().catch(() => undefined);
      await sleep(delay, options.signal);
      attempt++;
    }
  }

  /**
   * Builds the canonical request once: the real URL, the headers (including
   * the Content-Type that {@link buildBody} stamps on), the body, and — when
   * hooks are configured — the redacted hook payload derived from those same
   * headers. Deriving the hook payload here (not separately) is what keeps
   * observers truthful: they see exactly the headers that were sent. Shared
   * by `requestRaw` (re-dispatched per retry attempt) and `stream`.
   *
   * `#buildUrl` is called here so its non-base-origin `FcError` propagates
   * before any dispatch — it must never be rewrapped as a connection error.
   */
  #prepare(method: string, path: string, options: HttpRequestOptions): PreparedRequest {
    const httpMethod = method.toUpperCase();
    const headers = this.#buildHeaders(options);
    const body = buildBody(headers, options);
    const url = this.#buildUrl(path, options.query);
    const hookMeta = this.#config.hooks
      ? { url: redactUrl(url), method: httpMethod, headers: redactHeaders(headers) }
      : undefined;
    return { url, path, method: httpMethod, headers, body, hookMeta };
  }

  /** Fires onRequest with the redacted meta. No-op when no hooks are configured. */
  #fireRequestHook(hookMeta: HookMeta | undefined, attempt: number): Promise<void> {
    if (!hookMeta) return Promise.resolve();
    return fireHook(this.#config.hooks?.onRequest, {
      url: hookMeta.url,
      method: hookMeta.method,
      headers: hookMeta.headers,
      attempt: attempt + 1,
    });
  }

  /** Fires onResponse with the redacted meta and timing. No-op when no hooks are configured. */
  #fireResponseHook(
    hookMeta: HookMeta | undefined,
    attempt: number,
    startMs: number,
    response: Response,
  ): Promise<void> {
    if (!hookMeta) return Promise.resolve();
    return fireHook(this.#config.hooks?.onResponse, {
      url: hookMeta.url,
      method: hookMeta.method,
      headers: hookMeta.headers,
      attempt: attempt + 1,
      status: response.status,
      durationMs: performance.now() - startMs,
      requestId: response.headers.get("x-request-id") ?? undefined,
    });
  }

  /**
   * Fires the onRetry hook with the shared meta merged in. The two retry
   * paths (network error vs retryable status) decide *whether* to retry on
   * their own different conditions — this only constructs the payload they
   * share once that decision is made.
   */
  #fireRetryHook(
    hookMeta: HookMeta,
    attempt: number,
    detail: {
      durationMs: number;
      reason: RetryReason;
      delayMs: number;
      status?: number | undefined;
      requestId?: string | undefined;
    },
  ): Promise<void> {
    return fireHook(this.#config.hooks?.onRetry, {
      url: hookMeta.url,
      method: hookMeta.method,
      headers: hookMeta.headers,
      attempt: attempt + 1,
      ...detail,
    });
  }

  /**
   * Streams an NDJSON response as an async iterator. Not retried.
   *
   * @throws {FcApiError} (or a subclass) on a non-2xx response.
   * @throws {FcConnectionError} when the request never reaches the server.
   * @throws {FcTimeoutError} when the per-request timeout elapses.
   * @throws {FcError} when the control plane returns an empty stream body.
   */
  async *stream<T>(
    method: string,
    path: string,
    options: HttpRequestOptions = {},
  ): AsyncGenerator<T> {
    // Streams aren't retried, but they fire the same onRequest / onResponse
    // hooks as buffered requests so observability is consistent across both.
    const prepared = this.#prepare(method, path, options);
    const hookMeta = prepared.hookMeta;
    await this.#fireRequestHook(hookMeta, 0);
    const startMs = performance.now();
    const response = await this.#dispatch(prepared, options);
    await this.#fireResponseHook(hookMeta, 0, startMs, response);
    if (!response.ok) {
      await this.throwForResponse(response, prepared.method, prepared.path);
    }
    if (!response.body) {
      throw new FcError("The control plane returned an empty stream.");
    }
    yield* readNdjson<T>(response.body);
  }

  /**
   * Reads a non-2xx response and throws the matching typed error. The
   * method + request path are stamped onto the error so callers can
   * surface them in logs and bug reports; `requestPath` falls back to
   * `response.url`'s pathname when omitted.
   *
   * @throws {FcApiError} (or a subclass: FcAuthError, FcPermissionError,
   *   FcNotFoundError, FcValidationError, FcRateLimitError, FcServerError)
   *   matching the response status. Always throws — never returns.
   */
  async throwForResponse(response: Response, method: string, requestPath?: string): Promise<never> {
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
    throw errorFromResponse(response, envelope, {
      endpoint: resolvedPath,
      method: method.toUpperCase(),
    });
  }

  /**
   * Dispatches a single prepared request: composes the timeout +
   * caller-supplied abort signals and calls `fetch`. Re-invoked per retry
   * attempt with the same prepared object. The URL was already built (and
   * origin-validated) in `#prepare`, so any `FcError` surfaced there, not
   * here — keeping the `catch` below free to classify only network /
   * timeout failures.
   */
  async #dispatch(prepared: PreparedRequest, options: HttpRequestOptions): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? this.#config.timeoutMs;
    const init: RequestInit & { duplex?: "half" } = {
      method: prepared.method,
      headers: prepared.headers,
    };
    if (prepared.body !== undefined) {
      init.body = prepared.body;
      // Node's fetch (undici) rejects a streaming body unless duplex is set;
      // browsers ignore the option, so adding it is always safe.
      if (prepared.body instanceof ReadableStream) {
        init.duplex = "half";
      }
    }

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
      return await this.#config.fetch(prepared.url, init);
    } catch (err) {
      if (timeout?.signal.aborted === true && options.signal?.aborted !== true) {
        throw new FcTimeoutError(
          `Request timed out after ${timeoutMs}ms: ${prepared.method} ${prepared.path}`,
          { cause: err },
        );
      }
      if (options.signal?.aborted === true) {
        throw err;
      }
      throw new FcConnectionError(`Network error: ${prepared.method} ${prepared.path}`, {
        cause: err,
      });
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
    // Always strip any credentials the caller supplied via default/per-request
    // headers: on auth:false the opt-out must be complete, and otherwise generic
    // credential headers must not shadow the SDK's own (the control plane
    // resolves X-Auth-Token/X-Access-Token/Authorization before X-Api-Key).
    deleteAuthHeaders(headers);
    if (options.auth === false) {
      // auth:false means "no auth on this request" (health probes).
      return headers;
    }
    if (this.#config.authHeaders) {
      new Headers(this.#config.authHeaders).forEach((value, key) => headers.set(key, value));
    } else if (this.#config.apiKey) {
      headers.set("X-Api-Key", this.#config.apiKey);
    } else {
      throw new FcError(
        "Authentication is required. Pass apiKey, set FC_API_KEY, or pass authHeaders.",
      );
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
    return mergeRetry(perRequest, base || DEFAULT_RETRY);
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
  // Cap the jittered value, not the exponential term: clamping before adding
  // jitter let the result exceed maxDelayMs by up to baseDelayMs.
  const jittered = retry.baseDelayMs * 2 ** attempt + Math.random() * retry.baseDelayMs;
  return Math.min(jittered, retry.maxDelayMs);
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

/** Redacted request metadata shared by the onRequest / onResponse / onRetry hooks. */
type HookMeta = { url: string; method: string; headers: Record<string, string> };

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

/**
 * Invokes a hook with best-effort semantics: a throw or rejection is
 * caught and warned (not propagated) so a misbehaving observer cannot
 * crash an otherwise-healthy request.
 */
async function fireHook<C>(
  hook: ((ctx: C) => void | Promise<void>) | undefined,
  ctx: C,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(ctx);
  } catch (err) {
    // Mirror what most logging libraries do: avoid throwing in I/O paths.
    // eslint-disable-next-line no-console
    console.warn("fc-sandbox-sdk: client hook threw, ignoring", err);
  }
}

/**
 * Normalizes a list payload into `{ items, total }`. Accepts the paginated
 * envelope (`{ data, pagination }`), a legacy `{ <legacyKey>: [] }` wrapper,
 * or a bare array. `total` is `undefined` for the non-paginated shapes.
 */
function extractPage<T>(
  payload: unknown,
  legacyKey: string | undefined,
  path: string,
): { items: T[]; total: number | undefined } {
  if (Array.isArray(payload)) {
    return { items: payload as T[], total: undefined };
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      const pagination = obj.pagination as { total?: number } | undefined;
      const total = typeof pagination?.total === "number" ? pagination.total : undefined;
      return { items: obj.data as T[], total };
    }
    if (legacyKey && Array.isArray(obj[legacyKey])) {
      return { items: obj[legacyKey] as T[], total: undefined };
    }
  }
  // No recognized shape. Returning an empty page here would silently drop
  // every row and report success — the exact failure mode that hid the
  // listShapes paginated-envelope regression. Fail loudly instead.
  const preview = typeof payload === "string" ? payload : JSON.stringify(payload);
  throw new FcError(
    `Unrecognized list payload shape from ${path}: ${(preview ?? String(payload)).slice(0, 200)}`,
  );
}

async function unwrapJSend<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    // A JSend endpoint always returns an envelope. The only legitimate empty
    // body is an explicit no-content status; anything else (a proxy stripping
    // the body, the wrong endpoint) is a contract break and must not be
    // silently coerced to `undefined` and handed back as a typed `T`.
    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }
    throw new FcError(
      `The control plane returned an empty body with status ${response.status}; expected a JSend envelope.`,
    );
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
