// Typed error hierarchy for the fc-spawn SDK.
//
//   FcError                      base — every SDK error
//   ├─ FcApiError                non-2xx HTTP response
//   │  ├─ FcAuthError            401
//   │  ├─ FcPermissionError      403
//   │  ├─ FcNotFoundError        404
//   │  ├─ FcValidationError      400 / 409 / 422
//   │  ├─ FcRateLimitError       429
//   │  └─ FcServerError          5xx
//   ├─ FcConnectionError         network failure (no response)
//   └─ FcTimeoutError            request or wait deadline exceeded

import type { ErrorEnvelope, FailEnvelope, JSendEnvelope } from "./types.js";

/**
 * Base class for every error the SDK throws. Catch this to handle all SDK
 * failures uniformly; narrow with `instanceof` to a subclass for HTTP-status
 * (`FcApiError` and friends) or transport (`FcConnectionError`,
 * `FcTimeoutError`) handling.
 */
export class FcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Subclasses inherit this constructor; `new.target` resolves to the class
    // actually being instantiated, so each error reports its own name with no
    // per-subclass constructor. A consumer's minifier that mangles class names
    // mangles this too — acceptable for display/stack strings, since callers
    // branch on `instanceof`, not `name`.
    this.name = new.target.name;
  }
}

/** Optional request context attached to every {@link FcApiError}. */
export interface ErrorRequestContext {
  /** URL pathname of the request that produced this error (no host or query). */
  endpoint?: string | undefined;
  /** HTTP method used (`GET`, `POST`, …). */
  method?: string | undefined;
}

/** Thrown for any non-2xx response from the control plane. */
export class FcApiError extends FcError {
  readonly statusCode: number;
  readonly response: Response;
  readonly envelope: FailEnvelope | ErrorEnvelope | undefined;
  /** The control plane's request id, when present. */
  readonly requestId: string | undefined;
  /** The sandbox / template / network id parsed from the request path, when present. */
  readonly resourceId: string | undefined;
  /** Stable machine-readable code from `envelope.data.code`, when present. */
  readonly code: string | undefined;
  /** URL pathname of the request that produced this error (no host or query). */
  readonly endpoint: string | undefined;
  /** HTTP method used (`GET`, `POST`, …). */
  readonly method: string | undefined;

  constructor(
    message: string,
    response: Response,
    envelope?: FailEnvelope | ErrorEnvelope,
    resourceId?: string,
    context?: ErrorRequestContext,
  ) {
    super(message);
    this.statusCode = response.status;
    this.response = response;
    this.envelope = envelope;
    this.requestId =
      response.headers.get("x-request-id") ?? response.headers.get("x-fc-request-id") ?? undefined;
    this.resourceId = resourceId;
    this.code = extractCode(envelope);
    this.endpoint = context?.endpoint;
    this.method = context?.method;
  }
}

function extractCode(envelope?: FailEnvelope | ErrorEnvelope): string | undefined {
  if (!envelope) return undefined;
  if (envelope.status === "fail" && envelope.data && typeof envelope.data === "object") {
    const code = (envelope.data as Record<string, unknown>).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return undefined;
}

/**
 * Thrown for `401 Unauthorized` responses — the API key is missing,
 * revoked, or otherwise rejected by the control plane.
 */
export class FcAuthError extends FcApiError {}

/**
 * Thrown for `403 Forbidden` responses — the API key authenticated but is
 * not authorized to access the resource (quota, ACL, or tenant mismatch).
 */
export class FcPermissionError extends FcApiError {}

/**
 * Thrown for `404 Not Found` responses — the sandbox, template, network,
 * or disk id does not resolve to an existing resource in this tenant.
 */
export class FcNotFoundError extends FcApiError {}

/**
 * Thrown for `400 Bad Request`, `409 Conflict`, and `422 Unprocessable
 * Entity` responses — the request shape, body, or current resource state
 * makes the operation invalid (unknown shape, invalid state transition,
 * field validation failure).
 */
export class FcValidationError extends FcApiError {}

/**
 * Thrown for `429 Too Many Requests` responses — the caller exceeded the
 * rate limit. {@link retryAfterSeconds} carries the parsed `Retry-After`
 * delay when the server provided one.
 */
export class FcRateLimitError extends FcApiError {
  /** Seconds to wait before retrying, parsed from the Retry-After header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    response: Response,
    envelope?: FailEnvelope | ErrorEnvelope,
    resourceId?: string,
    context?: ErrorRequestContext,
  ) {
    super(message, response, envelope, resourceId, context);
    this.retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
  }
}

/**
 * Thrown for any `5xx` response — the control plane accepted the request
 * but failed to fulfil it (host capacity exhausted, internal error, or
 * upstream component unavailable).
 */
export class FcServerError extends FcApiError {}

/** The request never reached the server (DNS, connection refused, socket reset). */
export class FcConnectionError extends FcError {}

/** A request or a `waitUntil*` poll exceeded its deadline. */
export class FcTimeoutError extends FcError {}

/** Parses a Retry-After header value (delta-seconds or HTTP-date) to seconds. */
export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.round((date - Date.now()) / 1000));
  }
  return undefined;
}

/**
 * Builds the right FcApiError subclass for a non-2xx response. The envelope,
 * when present, is the parsed JSend `fail` / `error` body. `context.endpoint`
 * lets the error carry the request pathname (also drives resource-id parsing);
 * `context.method` records the HTTP method used.
 */
export function errorFromResponse(
  response: Response,
  envelope?: JSendEnvelope<unknown>,
  context?: ErrorRequestContext,
): FcApiError {
  const typed =
    envelope?.status === "fail" || envelope?.status === "error"
      ? (envelope as FailEnvelope | ErrorEnvelope)
      : undefined;

  const message = buildMessage(response.status, typed);
  const resourceId = extractResourceId(context?.endpoint);

  switch (response.status) {
    case 401:
      return new FcAuthError(message, response, typed, resourceId, context);
    case 403:
      return new FcPermissionError(message, response, typed, resourceId, context);
    case 404:
      return new FcNotFoundError(message, response, typed, resourceId, context);
    case 400:
    case 409:
    case 422:
      return new FcValidationError(message, response, typed, resourceId, context);
    case 429:
      return new FcRateLimitError(message, response, typed, resourceId, context);
    default:
      if (response.status >= 500) {
        return new FcServerError(message, response, typed, resourceId, context);
      }
      return new FcApiError(message, response, typed, resourceId, context);
  }
}

const RESOURCE_PATH_RE = /\/v1\/(?:sandboxes|templates|networks)\/([^/?#]+)/;

function extractResourceId(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const match = RESOURCE_PATH_RE.exec(path);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return match[1];
  }
}

function buildMessage(status: number, envelope?: FailEnvelope | ErrorEnvelope): string {
  if (envelope?.status === "error") {
    return envelope.message;
  }
  if (envelope?.status === "fail") {
    const data = envelope.data;
    if (typeof data === "string") {
      if (data) {
        return `fc-spawn request failed (${status}): ${data}`;
      }
    } else if (data && typeof data === "object") {
      // data may be null despite the FailEnvelope type — the control plane
      // can send {status:"fail",data:null}. Guard before Object.entries.
      const fields = Object.entries(data)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(", ");
      if (fields) {
        return `fc-spawn request failed (${status}): ${fields}`;
      }
    }
  }

  switch (status) {
    case 401:
      return "Unauthorized (401): missing or invalid API key. Set FC_API_KEY or pass apiKey.";
    case 403:
      return "Forbidden (403): the API key cannot access this resource.";
    case 404:
      return "Not found (404).";
    case 429:
      return "Rate limited (429): too many requests. Retry after the Retry-After delay.";
    case 503:
      return "Service unavailable (503): no host with capacity. Retry shortly.";
    default:
      return `fc-spawn request failed with ${status}.`;
  }
}
