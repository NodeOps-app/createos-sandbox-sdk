# How-to: handle errors

Calls can fail for several distinct reasons — bad credentials, missing
resources, rate limits, validation errors, server faults, and transport
failures. This guide shows you how to branch on the cause using
`instanceof` narrowing so you never parse error messages.

## Error class overview

Every SDK failure throws a subclass of `CreateosSandboxError`.

```
CreateosSandboxError
├─ CreateosSandboxApiError          non-2xx HTTP response
│  ├─ CreateosSandboxAuthError      401
│  ├─ CreateosSandboxPermissionError  403
│  ├─ CreateosSandboxNotFoundError  404
│  ├─ CreateosSandboxPaymentRequiredError  402
│  ├─ CreateosSandboxValidationError  400 / 409 / 422
│  ├─ CreateosSandboxRateLimitError  429
│  └─ CreateosSandboxServerError    5xx
├─ CreateosSandboxConnectionError   network failure — no response received
└─ CreateosSandboxTimeoutError      request or waitUntil* deadline exceeded
```

See [Errors reference](../reference/errors.md) for full field tables.

## Basic catch-and-branch

Catch the base class to handle all SDK failures uniformly, then narrow
to subclasses for specific recovery logic.

```ts
import {
  CreateosSandboxError,
  CreateosSandboxAuthError,
  CreateosSandboxPermissionError,
  CreateosSandboxNotFoundError,
  CreateosSandboxValidationError,
  CreateosSandboxRateLimitError,
  CreateosSandboxServerError,
  CreateosSandboxConnectionError,
  CreateosSandboxTimeoutError,
} from "@nodeops-createos/sandbox";

try {
  const sandbox = await client.createSandbox({ templateId: "tpl-abc123" });
  try {
    await sandbox.runCommand("echo hello");
  } finally {
    await sandbox.destroy();
  }
} catch (err) {
  if (!(err instanceof CreateosSandboxError)) throw err; // not ours

  if (err instanceof CreateosSandboxAuthError) {
    // 401 — key missing, malformed, or unrecognised.
    console.error("Check CREATEOS_SANDBOX_API_KEY.");
    throw err;
  }

  if (err instanceof CreateosSandboxPermissionError) {
    // 403 — key is valid but cannot access this resource.
    console.error("API key lacks permission for this resource.");
    throw err;
  }

  if (err instanceof CreateosSandboxNotFoundError) {
    // 404 — resource does not exist (or was already destroyed).
    console.error("Resource not found:", err.resourceId);
    return null;
  }

  if (err instanceof CreateosSandboxValidationError) {
    // 400 / 409 / 422 — request shape rejected by the server.
    console.error("Bad request:", err.envelope?.data);
    throw err;
  }

  if (err instanceof CreateosSandboxRateLimitError) {
    // 429 — retries already exhausted by the SDK; see rate-limit recipe below.
    const wait = (err.retryAfterSeconds ?? 5) * 1000;
    console.warn(`Rate limited. Retry in ${wait}ms.`);
    throw err;
  }

  if (err instanceof CreateosSandboxServerError) {
    // 5xx — server accepted the request but failed to fulfil it.
    console.error("Server error:", err.statusCode, err.requestId);
    throw err;
  }

  if (err instanceof CreateosSandboxConnectionError) {
    // Network failure — DNS, TCP reset, socket closed — no response received.
    console.error("Network failure:", err.cause);
    throw err;
  }

  if (err instanceof CreateosSandboxTimeoutError) {
    // Per-request timeout or waitUntil* poll deadline exceeded.
    console.error("Timeout:", err.cause);
    throw err;
  }

  throw err;
}
```

## Recipe: distinguish missing key vs revoked key vs wrong tenant

`CreateosSandboxAuthError` (401) and `CreateosSandboxPermissionError` (403) signal
different problems and require different remediation.

```ts
import {
  CreateosSandboxAuthError,
  CreateosSandboxPermissionError,
} from "@nodeops-createos/sandbox";

async function run() {
  const sandbox = await client.createSandbox({ templateId: "tpl-abc123" });
  try {
    await sandbox.runCommand("ls /");
  } finally {
    await sandbox.destroy();
  }
}

try {
  await run();
} catch (err) {
  if (err instanceof CreateosSandboxAuthError) {
    // The key is absent, malformed, or unknown to the control plane.
    // Fix: set CREATEOS_SANDBOX_API_KEY or pass apiKey to the client.
    console.error("Authentication failed — check your API key.");
    return;
  }
  if (err instanceof CreateosSandboxPermissionError) {
    // The key authenticated but is not allowed to touch this resource.
    // Could be: wrong tenant, ACL restriction, or quota exhausted.
    // Fix: use a key that has access, or contact support with err.requestId.
    console.error(
      "Permission denied. RequestId:",
      err.requestId,
      "Resource:",
      err.resourceId,
    );
    return;
  }
  throw err;
}
```

## Recipe: handle a rate limit

The SDK already auto-retries `429` responses with exponential backoff before
surfacing `CreateosSandboxRateLimitError` — see
[Reliability](../explanation/reliability.md). When the error reaches your
`catch` block, retries are exhausted and you must decide what to do next.

```ts
import { CreateosSandboxRateLimitError } from "@nodeops-createos/sandbox";

async function withRateLimitBackoff<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CreateosSandboxRateLimitError) {
        const delay = (err.retryAfterSeconds ?? 2 ** attempt) * 1000;
        console.warn(`Rate limited. Waiting ${delay}ms before retry ${attempt + 1}.`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Rate limit not resolved after 3 retries.");
}
```

`retryAfterSeconds` is parsed from the `Retry-After` response header (both
delta-seconds and HTTP-date formats). It is `undefined` when the header is
absent or unparseable — fall back to a fixed delay or exponential backoff.

## Recipe: read rich fields from `CreateosSandboxApiError` for logging

Every HTTP error (`CreateosSandboxApiError` and all its subclasses) carries a
structured set of fields. Use them for observability instead of parsing
`err.message`.

```ts
import {
  CreateosSandboxApiError,
  CreateosSandboxError,
} from "@nodeops-createos/sandbox";

function logSdkError(err: unknown): void {
  if (err instanceof CreateosSandboxApiError) {
    console.error({
      type: err.name,               // e.g. "CreateosSandboxNotFoundError"
      statusCode: err.statusCode,   // 404
      method: err.method,           // "GET"
      endpoint: err.endpoint,       // "/v1/sandboxes/sb-abc123"
      resourceId: err.resourceId,   // "sb-abc123" — parsed from path
      requestId: err.requestId,     // quote this in support tickets
      code: err.code,               // stable machine-readable code, when set
      envelopeData: err.envelope?.data,
    });
  } else if (err instanceof CreateosSandboxError) {
    // Transport errors (ConnectionError, TimeoutError) — no HTTP fields.
    console.error({
      type: err.name,
      message: err.message,
      cause: err.cause,
    });
  }
}

// Use alongside your catch block:
try {
  const sandbox = await client.createSandbox({ templateId: "tpl-abc123" });
  try {
    await sandbox.runCommand("echo hello");
  } finally {
    await sandbox.destroy();
  }
} catch (err) {
  logSdkError(err);
  throw err;
}
```

`requestId` is read from `X-Request-Id` first, then `X-Fc-Request-Id`.
Always include it when filing a support ticket — it lets the operator
locate your exact call in the control plane logs in O(1).

## Note: `error.cause` for transport errors

`CreateosSandboxConnectionError` and `CreateosSandboxTimeoutError` do not extend
`CreateosSandboxApiError` — there is no HTTP response to inspect. The underlying
network or abort error is chained on `err.cause` when available.

```ts
import {
  CreateosSandboxConnectionError,
  CreateosSandboxTimeoutError,
} from "@nodeops-createos/sandbox";

try {
  await client.createSandbox({ templateId: "tpl-abc123" });
} catch (err) {
  if (err instanceof CreateosSandboxConnectionError) {
    // err.cause: underlying fetch / socket error
    console.error("No response from server:", err.cause);
  }
  if (err instanceof CreateosSandboxTimeoutError) {
    // err.cause: AbortError from the AbortController
    console.error("Request timed out:", err.cause);
  }
}
```

## See also

- [Errors reference](../reference/errors.md) — full field tables for every class.
- [Reliability](../explanation/reliability.md) — retry policy, backoff strategy, and
  which methods are retried automatically.
- [How-to: observability](./observability.md) — hook-based request/response logging.
