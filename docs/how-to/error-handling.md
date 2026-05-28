# How-to: handle errors

## Problem

You want to react differently to "the user gave me a bad shape" vs
"the rate limit hit" vs "the network is down" without grepping error
messages.

## Solution

Catch by class, never by string. Every failure throws one of:

| Class | Trigger |
| --- | --- |
| `FcAuthError` | HTTP 401 |
| `FcPermissionError` | HTTP 403 |
| `FcNotFoundError` | HTTP 404 |
| `FcValidationError` | HTTP 400 / 409 / 422 |
| `FcRateLimitError` | HTTP 429 (carries `retryAfterSeconds`) |
| `FcServerError` | HTTP 5xx |
| `FcConnectionError` | DNS, TCP, socket reset — no response |
| `FcTimeoutError` | per-request timeout or `waitUntil*` deadline |

```ts
import {
  FcNotFoundError,
  FcRateLimitError,
  FcValidationError,
} from "fc-sandbox-sdk";

try {
  await fc.getSandbox("sb-might-be-gone");
} catch (err) {
  if (err instanceof FcNotFoundError) {
    // Caller-controlled fallback.
    return null;
  }
  if (err instanceof FcRateLimitError) {
    await new Promise((r) => setTimeout(r, (err.retryAfterSeconds ?? 1) * 1000));
    return null;
  }
  if (err instanceof FcValidationError) {
    console.error("bad request:", err.envelope?.data);
  }
  throw err;
}
```

## What every `FcApiError` carries

```ts
err.statusCode      // 404
err.method          // "GET"
err.endpoint        // "/v1/sandboxes/sb-abc123"
err.requestId       // "req_01HFOO…" — quote in support tickets
err.resourceId      // "sb-abc123" — sandbox / template / network id
err.code            // envelope.data.code, when the server set it
err.envelope        // raw JSend fail/error envelope
err.response        // raw Response (already drained)
```

`requestId` is read from `X-Request-Id` first, then `X-Fc-Request-Id`.
Always include it when filing support — it lets the operator find your
exact call in the control plane's logs in O(1).

## Structured logging

Pair the typed errors with hooks for end-to-end visibility — see
[How-to: observability](./observability.md). A common pattern is to log
`onResponse` for every call and let the typed error in your catch
handler carry the diagnostic detail.
