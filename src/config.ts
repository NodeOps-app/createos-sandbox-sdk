// Configuration resolution: merges explicit options with environment
// variables and defaults into a single frozen ResolvedConfig.

import { FcError } from "./errors.js";
import type { FcClientOptions, RetryOptions } from "./types.js";

/** SDK version, stamped into the User-Agent header. Keep in sync with package.json. */
export const VERSION = "0.2.0";

/** Production control plane, used when no baseUrl is configured. */
export const DEFAULT_BASE_URL = "https://fc-spawn.bhautik.in";

const DEFAULT_TIMEOUT_MS = 60_000;

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

export interface ResolvedConfig {
  apiKey: string | undefined;
  baseUrl: string;
  fetch: typeof fetch;
  defaultHeaders: HeadersInit;
  timeoutMs: number;
  retry: Required<RetryOptions> | false;
  userAgent: string;
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

  const rawBaseUrl = options.baseUrl ?? readEnv("FC_BASE_URL") ?? DEFAULT_BASE_URL;
  if (!rawBaseUrl.trim()) {
    throw new FcError("baseUrl must be a non-empty URL.");
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
    retry = {
      maxRetries: options.retry.maxRetries ?? DEFAULT_RETRY.maxRetries,
      baseDelayMs: options.retry.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
      maxDelayMs: options.retry.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    };
  } else {
    retry = { ...DEFAULT_RETRY };
  }

  return Object.freeze({
    apiKey: options.apiKey ?? readEnv("FC_API_KEY"),
    baseUrl,
    fetch: fetchFn,
    defaultHeaders: options.headers ?? {},
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry,
    userAgent: options.userAgent ?? `fc-sandbox-sdk/${VERSION}`,
  });
}
