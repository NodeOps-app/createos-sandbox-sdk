// Redaction helpers for headers / URLs / query params. Pure functions,
// never mutate the input. Exported so consumers writing their own
// logging middleware can avoid leaking credentials.

const REDACTED = "redacted";

/** Header names that always carry credentials and must be redacted. */
export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-access-token",
  "x-auth-token",
  "x-csrf-token",
  "proxy-authorization",
]);

/** Query-string keys that commonly carry credentials. */
export const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "token",
  "api_key",
  "apikey",
  "access_token",
  "auth_token",
  "password",
  "secret",
]);

function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return true;
  return lower.endsWith("-token") || lower.endsWith("-key");
}

function isSensitiveQueryName(name: string): boolean {
  return SENSITIVE_QUERY_PARAMS.has(name.toLowerCase());
}

/**
 * Returns a plain object of the headers with sensitive values replaced
 * by `"redacted"`. Does not mutate the input.
 */
export function redactHeaders(headers: Headers | HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = isSensitiveHeaderName(key) ? REDACTED : value;
  });
  return out;
}

/** Returns a copy of the URLSearchParams with sensitive values redacted. */
export function redactQuery(query: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of query) {
    out.append(key, isSensitiveQueryName(key) ? REDACTED : value);
  }
  return out;
}

/**
 * Returns the URL with userinfo stripped and sensitive query params
 * redacted. Returns the original string unchanged if it does not parse
 * as a URL.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.username = "";
  parsed.password = "";
  const redactedQuery = redactQuery(parsed.searchParams);
  parsed.search = redactedQuery.toString();
  return parsed.toString();
}
