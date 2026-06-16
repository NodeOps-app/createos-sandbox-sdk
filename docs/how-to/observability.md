# How-to: observability and logging

You want structured logs, metrics, and traces of every SDK HTTP call
without leaking credentials into your log store.

## Wire the hooks

`CreateosSandboxClient` accepts an optional `hooks` bag on the constructor.
Three callbacks fire around every non-streaming request:

| Hook | Fires |
| --- | --- |
| `onRequest` | Before `fetch` is called, on every attempt. |
| `onResponse` | After `fetch` settles (success **or** HTTP error). |
| `onRetry` | Between attempts, after the response (or network error) but before the backoff sleep. |

Hooks are `await`-ed in the request path so an async hook orders
deterministically against the request it describes. Keep hook work cheap,
or dispatch slow side-effects without returning the promise.

A throw inside a hook is swallowed — a misbehaving observer cannot crash
a real request.

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient({
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY,
  hooks: {
    onRequest(ctx) { /* ... */ },
    onResponse(ctx) { /* ... */ },
    onRetry(ctx) { /* ... */ },
  },
});
```

See [`CreateosSandboxClientOptions`](../reference/client.md) for the full
constructor reference.

## Hook payloads

### `onRequest` — `RequestHookContext`

| Field | Type | Notes |
| --- | --- | --- |
| `method` | `string` | Uppercase HTTP verb (`"GET"`, `"POST"`, …). |
| `url` | `string` | Full URL, userinfo stripped, sensitive query params redacted. |
| `headers` | `Record<string, string>` | Outgoing headers; credential values replaced by `"redacted"`. |
| `attempt` | `number` | `1` on the first try, `2+` on retries. |

### `onResponse` — `ResponseHookContext`

Extends `RequestHookContext` with:

| Field | Type | Notes |
| --- | --- | --- |
| `status` | `number` | HTTP status code. |
| `durationMs` | `number` | Elapsed time for this fetch call (ms). |
| `requestId` | `string \| undefined` | `x-request-id` header from the server, when present. |

### `onRetry` — `RetryHookContext`

Extends `ResponseHookContext` (minus `status`) with:

| Field | Type | Notes |
| --- | --- | --- |
| `reason` | `RetryReason` | `"network"` · `"status"` · `"rate-limit"`. |
| `status` | `number \| undefined` | HTTP status that triggered the retry; `undefined` for network errors (no response received). |
| `delayMs` | `number` | Milliseconds the SDK will sleep before the next attempt. |

`RetryReason` breakdown:

- `"network"` — `fetch` threw before a response arrived. `status` and
  `requestId` are `undefined`.
- `"status"` — a retryable status code (`408/500/502/503/504` on
  idempotent methods). `delayMs` is exponential backoff + jitter.
- `"rate-limit"` — server returned `429` or `503` with a `Retry-After`
  header. `delayMs` honors that header value.

## Payloads are pre-redacted

**The SDK redacts hook payloads before your code sees them.** You do not
need to scrub credentials yourself when using the hooks — the values are
never passed to you in the first place.

The `url` and `headers` fields in every hook context are produced by
[`redactUrl`](../reference/helpers.md#redaction) and
[`redactHeaders`](../reference/helpers.md#redaction) at request build
time, before any hook fires. What is redacted:

**Headers** — any header whose lowercased name is in `SENSITIVE_HEADER_NAMES`
(`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-access-token`,
`x-auth-token`, `x-csrf-token`, `proxy-authorization`), plus any header
whose name ends in `"-token"` or `"-key"`. Values become the literal
string `"redacted"`, so your logs stay greppable.

**Query params** — any key in `SENSITIVE_QUERY_PARAMS` (`token`, `api_key`,
`apikey`, `access_token`, `auth_token`, `password`, `secret`). Same
`"redacted"` substitution.

**URL userinfo** — `username:password@` in the URL is stripped.

## Recipe: structured log line per request

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient({
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY,
  hooks: {
    onRequest({ method, url, attempt }) {
      console.debug(JSON.stringify({ event: "sdk.request", method, url, attempt }));
    },
    onResponse({ method, url, status, durationMs, attempt, requestId }) {
      console.debug(
        JSON.stringify({
          event: "sdk.response",
          method,
          url,
          status,
          durationMs: Math.round(durationMs),
          attempt,
          requestId,
        }),
      );
    },
  },
});
```

## Recipe: retry counter metric

Wire `onRetry` to a metrics counter. The `reason` field lets you split
rate-limit retries from transient 5xx:

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

// Replace with your metrics client (Prometheus, Datadog, etc.).
function incrementCounter(name: string, labels: Record<string, string>): void {
  /* ... */
}

const client = new CreateosSandboxClient({
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY,
  hooks: {
    onRetry({ method, url, reason, status, delayMs, attempt }) {
      incrementCounter("sdk_retry_total", {
        method,
        reason,
        status: String(status ?? "network"),
      });
      console.warn(
        JSON.stringify({ event: "sdk.retry", method, url, reason, status, delayMs, attempt }),
      );
    },
  },
});
```

## Recipe: safe logging outside hooks

If you log raw `fetch` calls or HTTP details from **your own code** (not
inside a hook), use the exported redaction helpers. They are pure
functions — non-mutating, no side effects — and mirror exactly what the
SDK applies to hook payloads internally.

```ts
import {
  CreateosSandboxClient,
  redactHeaders,
  redactUrl,
} from "createos-sandbox-sdk";

// Your own middleware / interceptor — not a hook:
function logOutbound(method: string, url: string, headers: Headers): void {
  console.debug(
    JSON.stringify({
      event: "custom.request",
      method,
      url: redactUrl(url),            // strips userinfo, redacts sensitive params
      headers: redactHeaders(headers), // replaces credential values with "redacted"
    }),
  );
}
```

These helpers are **not** auto-wired into your logger — call them
explicitly wherever you construct or log raw requests. See
[`redactHeaders` / `redactUrl` / `redactQuery`](../reference/helpers.md#redaction)
for full signatures, plus `SENSITIVE_HEADER_NAMES` and
`SENSITIVE_QUERY_PARAMS` if you need to inspect the lists.

## Recipe: OpenTelemetry span per request

Start a span in `onRequest`, end it in `onResponse`. Key on
`method + url + attempt` to correlate across the pair, because retries
fire both hooks with an incremented `attempt`.

```ts
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const tracer = trace.getTracer("createos-sandbox-sdk");
const spans = new Map<string, ReturnType<typeof tracer.startSpan>>();

const client = new CreateosSandboxClient({
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY,
  hooks: {
    onRequest({ method, url, attempt }) {
      const key = `${method} ${url} ${attempt}`;
      spans.set(
        key,
        tracer.startSpan(`createos-sandbox ${method}`, {
          attributes: { "http.method": method, "http.url": url, "sdk.attempt": attempt },
        }),
      );
    },
    onResponse({ method, url, status, durationMs, requestId, attempt }) {
      const key = `${method} ${url} ${attempt}`;
      const span = spans.get(key);
      if (span) {
        span.setAttributes({
          "http.status_code": status,
          "sdk.duration_ms": Math.round(durationMs),
          ...(requestId ? { "sdk.request_id": requestId } : {}),
        });
        if (status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        spans.delete(key);
      }
    },
  },
});
```

## Streaming requests bypass hooks

`Sandbox.streamCommand` and `TemplatesApi.followLogs` open a persistent
NDJSON connection and go through `CreateosSandboxHttp.stream`, not the retry loop.
Hooks **do not fire** for streaming requests — there is no retry to observe
and no clean "done" point for `onResponse`. Wrap your `for await` loop in
your own log or metric if you need per-stream tracing.

## Reference

- [`CreateosSandboxClientOptions`](../reference/client.md) — full constructor options including `hooks`.
- [`redactHeaders` / `redactUrl` / `redactQuery`](../reference/helpers.md#redaction) — pure redaction helpers and the `SENSITIVE_HEADER_NAMES` / `SENSITIVE_QUERY_PARAMS` constants.
