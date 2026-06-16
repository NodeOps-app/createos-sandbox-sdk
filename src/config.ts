// Configuration resolution: merges explicit options with environment
// variables and defaults into a single frozen ResolvedConfig.

import { CreateosSandboxError } from "./errors.js";
import { runtimeTag } from "./runtime.js";
import type { ClientHooks, CreateosSandboxClientOptions, RetryOptions } from "./types.js";

/** SDK version, stamped into the User-Agent header. Keep in sync with package.json. */
export const VERSION = "0.6.0";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Production control-plane base URL, used when neither the `baseUrl` option
 * nor the `CREATEOS_SANDBOX_BASE_URL` environment variable is set.
 */
export const DEFAULT_BASE_URL = "https://api.sb.createos.sh";

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

export function resolveConfig(options: CreateosSandboxClientOptions): ResolvedConfig {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new CreateosSandboxError(
      "No fetch implementation available. Pass `fetch` in CreateosSandboxClientOptions or run on a platform with a global fetch.",
    );
  }

  // Precedence: explicit option > environment variable > production default.
  // A blank option or env var is treated as unset so the next source applies.
  const rawBaseUrl =
    options.baseUrl?.trim() || readEnv("CREATEOS_SANDBOX_BASE_URL")?.trim() || DEFAULT_BASE_URL;

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new CreateosSandboxError(`baseUrl is not a valid URL: ${rawBaseUrl}`);
  }
  // A query string or fragment on the base URL is silently discarded when
  // request paths resolve against it (the URL constructor drops them),
  // losing anything the caller expected to persist. Reject at construction
  // time so the bug surfaces here, not as missing query params at runtime.
  if (parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new CreateosSandboxError(
      `baseUrl must not contain a query string or fragment: ${rawBaseUrl}`,
    );
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

  const apiKey = options.apiKey ?? readEnv("CREATEOS_SANDBOX_API_KEY");
  if (apiKey && options.authHeaders) {
    throw new CreateosSandboxError("Pass either apiKey or authHeaders, not both.");
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
    userAgent: options.userAgent ?? `createos-sandbox-sdk/${VERSION} ${runtime}`,
    runtimeTag: runtime,
    hooks: options.hooks,
  });
}
