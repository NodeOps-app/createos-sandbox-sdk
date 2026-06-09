// Configuration resolution: merges explicit options with environment
// variables and defaults into a single frozen ResolvedConfig.

import { FcError } from "./errors.js";
import { runtimeTag } from "./runtime.js";
import type { ClientHooks, FcClientOptions, RetryOptions } from "./types.js";

/** SDK version, stamped into the User-Agent header. Keep in sync with package.json. */
export const VERSION = "0.6.0";

const DEFAULT_TIMEOUT_MS = 60_000;

export const DEFAULT_RETRY: Required<RetryOptions> = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

/** Default wait budget in ms for `createSandbox` and the `waitUntil*` helpers. */
export const DEFAULT_WAIT_MS = 120_000;

/** Merges a partial retry policy over a fully-resolved fallback. */
export function mergeRetry(
  options: RetryOptions,
  fallback: Required<RetryOptions>,
): Required<RetryOptions> {
  return {
    maxRetries: options.maxRetries ?? fallback.maxRetries,
    baseDelayMs: options.baseDelayMs ?? fallback.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? fallback.maxDelayMs,
  };
}

export interface ResolvedConfig {
  apiKey: string | undefined;
  authHeaders: HeadersInit | undefined;
  baseUrl: string;
  fetch: typeof fetch;
  defaultHeaders: HeadersInit;
  timeoutMs: number;
  retry: Required<RetryOptions> | false;
  userAgent: string;
  runtimeTag: string;
  hooks: ClientHooks | undefined;
}

/** Reads an environment variable in a way that is safe in non-Node runtimes. */
export function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
}

export function resolveConfig(options: FcClientOptions): ResolvedConfig {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new FcError(
      "No fetch implementation available. Pass `fetch` in FcClientOptions or run on a platform with a global fetch.",
    );
  }

  const rawBaseUrl = options.baseUrl ?? readEnv("FC_BASE_URL");
  if (!rawBaseUrl || !rawBaseUrl.trim()) {
    throw new FcError(
      "No base URL configured. Pass `baseUrl` in FcClientOptions or set the FC_BASE_URL environment variable.",
    );
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new FcError(`baseUrl is not a valid URL: ${rawBaseUrl}`);
  }
  // A query string or fragment on the base URL is silently discarded when
  // request paths resolve against it (the URL constructor drops them),
  // losing anything the caller expected to persist. Reject at construction
  // time so the bug surfaces here, not as missing query params at runtime.
  if (parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new FcError(`baseUrl must not contain a query string or fragment: ${rawBaseUrl}`);
  }
  const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");

  let retry: Required<RetryOptions> | false;
  if (options.retry === false) {
    retry = false;
  } else if (options.retry) {
    retry = mergeRetry(options.retry, DEFAULT_RETRY);
  } else {
    retry = { ...DEFAULT_RETRY };
  }

  const apiKey = options.apiKey ?? readEnv("FC_API_KEY");
  if (apiKey && options.authHeaders) {
    throw new FcError("Pass either apiKey or authHeaders, not both.");
  }

  const runtime = runtimeTag();

  return Object.freeze({
    apiKey,
    authHeaders: options.authHeaders,
    baseUrl,
    fetch: fetchFn,
    defaultHeaders: options.headers ?? {},
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry,
    userAgent: options.userAgent ?? `fc-sandbox-sdk/${VERSION} ${runtime}`,
    runtimeTag: runtime,
    hooks: options.hooks,
  });
}
