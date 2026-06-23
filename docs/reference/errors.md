# Error Reference

Every error the SDK throws is an instance of `CreateosSandboxError`. Narrow with
`instanceof` to handle specific conditions.

## Hierarchy

```
CreateosSandboxError
├─ CreateosSandboxApiError          non-2xx HTTP response
│  ├─ CreateosSandboxAuthError      401
│  ├─ CreateosSandboxPaymentRequiredError  402
│  ├─ CreateosSandboxPermissionError      403
│  ├─ CreateosSandboxNotFoundError        404
│  ├─ CreateosSandboxValidationError      400 / 409 / 422
│  ├─ CreateosSandboxRateLimitError       429
│  └─ CreateosSandboxServerError          5xx
├─ CreateosSandboxConnectionError   network failure (no response)
└─ CreateosSandboxTimeoutError      request or wait deadline exceeded
```

## Base class

### `CreateosSandboxError`

| Property | Type | Description |
|---|---|---|
| `message` | `string` | Human-readable description. |
| `name` | `string` | Class name (`new.target.name`). |
| `cause` | `unknown \| undefined` | Underlying error, when available. |

Catch this to handle all SDK failures uniformly:

```ts
import { CreateosSandboxError } from "@nodeops-createos/sandbox";

try {
  await sandbox.stop();
} catch (err) {
  if (err instanceof CreateosSandboxError) {
    console.error(err.message);
  }
}
```

## `CreateosSandboxApiError`

Thrown for any non-2xx response from the control plane. Extends
`CreateosSandboxError`.

| Property | Type | Description |
|---|---|---|
| `statusCode` | `number` | HTTP status code. |
| `response` | `Response` | Raw fetch `Response` object. |
| `envelope` | `FailEnvelope \| ErrorEnvelope \| undefined` | Parsed JSend body, when present. |
| `requestId` | `string \| undefined` | Value of the `x-request-id` response header. |
| `resourceId` | `string \| undefined` | ID parsed from the request path (sandbox, template, network, disk). |
| `code` | `string \| undefined` | Stable machine-readable code from `envelope.data.code`. |
| `endpoint` | `string \| undefined` | URL pathname of the failing request (no host or query). |
| `method` | `string \| undefined` | HTTP method used. |

## Subclasses

### `CreateosSandboxAuthError` — 401

The API key is missing, expired, or revoked.

### `CreateosSandboxPaymentRequiredError` — 402

The account is out of credit. The control plane gates cost-incurring actions
(sandbox create / resume / fork, bandwidth recharge, disk / network / template
create) on a positive credit balance. Top up to continue; retrying without
doing so returns the same error.

### `CreateosSandboxPermissionError` — 403

The API key authenticated but is not authorized to access the resource (quota,
ACL, or tenant mismatch).

### `CreateosSandboxNotFoundError` — 404

The sandbox, template, network, or disk ID does not resolve to an existing
resource in this tenant.

### `CreateosSandboxValidationError` — 400 / 409 / 422

The request shape, body, or current resource state makes the operation invalid:
unknown shape, invalid state transition, or field validation failure.

### `CreateosSandboxRateLimitError` — 429

The caller exceeded the rate limit.

| Extra property | Type | Description |
|---|---|---|
| `retryAfterSeconds` | `number \| undefined` | Parsed `Retry-After` delay (delta-seconds or HTTP-date). |

### `CreateosSandboxServerError` — 5xx

The control plane accepted the request but failed to fulfil it: host capacity
exhausted, internal error, or upstream component unavailable.

## Transport errors

### `CreateosSandboxConnectionError`

The request never reached the server: DNS failure, connection refused, socket
reset. No `statusCode` — the response object was never received.

### `CreateosSandboxTimeoutError`

A per-request timeout or a `waitUntil*` poll deadline elapsed before the
operation completed.

## `errorFromResponse`

Internal factory. Reads `response.status` and returns the matching subclass:

| Status | Class |
|---|---|
| 401 | `CreateosSandboxAuthError` |
| 402 | `CreateosSandboxPaymentRequiredError` |
| 403 | `CreateosSandboxPermissionError` |
| 404 | `CreateosSandboxNotFoundError` |
| 400, 409, 422 | `CreateosSandboxValidationError` |
| 429 | `CreateosSandboxRateLimitError` |
| 5xx | `CreateosSandboxServerError` |
| other non-2xx | `CreateosSandboxApiError` |

Not part of the public API surface, but documented here because it drives every
error the SDK throws.

## `instanceof` narrowing

```ts
import {
  CreateosSandboxError,
  CreateosSandboxNotFoundError,
  CreateosSandboxRateLimitError,
  CreateosSandboxConnectionError,
} from "@nodeops-createos/sandbox";

try {
  const tpl = await client.templates.get("tpl_01h…");
} catch (err) {
  if (err instanceof CreateosSandboxNotFoundError) {
    console.error("template not found:", err.resourceId);
  } else if (err instanceof CreateosSandboxRateLimitError) {
    const wait = err.retryAfterSeconds ?? 5;
    console.error(`rate limited — retry in ${wait}s`);
  } else if (err instanceof CreateosSandboxConnectionError) {
    console.error("network error:", err.message);
  } else if (err instanceof CreateosSandboxError) {
    console.error("sdk error:", err.message);
  }
}
```
