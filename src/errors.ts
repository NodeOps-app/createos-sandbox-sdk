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

export class FcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FcError";
  }
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

  constructor(
    message: string,
    response: Response,
    envelope?: FailEnvelope | ErrorEnvelope,
    resourceId?: string,
  ) {
    super(message);
    this.name = "FcApiError";
    this.statusCode = response.status;
    this.response = response;
    this.envelope = envelope;
    this.requestId = response.headers.get("x-request-id") ?? undefined;
    this.resourceId = resourceId;
    this.code = extractCode(envelope);
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

export class FcAuthError extends FcApiError {
  constructor(
    message: string,
    response: Response,
    envelope?: FailEnvelope | ErrorEnvelope,
    resourceId?: string,
  ) {
    super(message, response, envelope, resourceId);
    this.name = "FcAuthError";
  }
}

export class FcPermissionError extends FcApiError {
  constructor(
    message: string,
    response: Response,
    envelope?: FailEnvelope | ErrorEnvelope,
    resourceId?: string,
  ) {
    super(message, response, envelope, resourceId);
    this.name = "FcPermissionError";
  }
}

export class FcNotFoundError extends FcApiError {
  constructor(
    message: string,
    response: Response,
    envelope?: FailEnvelope | ErrorEnvelope,
    resourceId?: string,
  ) {
    super(message, response, envelope, resourceId);
    this.name = "FcNotFoundError";
  }
}

export class FcValidationError extends FcApiError {
  constructor(
    message: string,
    response: Response,
    envelope?: FailEnvelope | ErrorEnvelope,
    resourceId?: string,
  ) {
    super(message, response, envelope, resourceId);
    this.name = "FcValidationError";
  }
}

export class FcRateLimitError extends FcApiError {
  /** Seconds to wait before retrying, parsed from the Retry-After header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    response: Response,
    envelope?: FailEnvelope | ErrorEnvelope,
    resourceId?: string,
  ) {
    super(message, response, envelope, resourceId);
    this.name = "FcRateLimitError";
    this.retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
  }
}

export class FcServerError extends FcApiError {
  constructor(
    message: string,
    response: Response,
    envelope?: FailEnvelope | ErrorEnvelope,
    resourceId?: string,
  ) {
    super(message, response, envelope, resourceId);
    this.name = "FcServerError";
  }
}

/** The request never reached the server (DNS, connection refused, socket reset). */
export class FcConnectionError extends FcError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FcConnectionError";
  }
}

/** A request or a `waitUntil*` poll exceeded its deadline. */
export class FcTimeoutError extends FcError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FcTimeoutError";
  }
}

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
 * when present, is the parsed JSend `fail` / `error` body. `requestPath`,
 * when supplied, lets the error carry the addressed resource id.
 */
export function errorFromResponse(
  response: Response,
  envelope?: JSendEnvelope<unknown>,
  requestPath?: string,
): FcApiError {
  const typed =
    envelope?.status === "fail" || envelope?.status === "error"
      ? (envelope as FailEnvelope | ErrorEnvelope)
      : undefined;

  const message = buildMessage(response.status, typed);
  const resourceId = extractResourceId(requestPath);

  switch (response.status) {
    case 401:
      return new FcAuthError(message, response, typed, resourceId);
    case 403:
      return new FcPermissionError(message, response, typed, resourceId);
    case 404:
      return new FcNotFoundError(message, response, typed, resourceId);
    case 400:
    case 409:
    case 422:
      return new FcValidationError(message, response, typed, resourceId);
    case 429:
      return new FcRateLimitError(message, response, typed, resourceId);
    default:
      if (response.status >= 500) {
        return new FcServerError(message, response, typed, resourceId);
      }
      return new FcApiError(message, response, typed, resourceId);
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
