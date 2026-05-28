# How-to: wire observability

## Problem

You want to track latency, retries, and error rates per endpoint
without bolting an extra HTTP wrapper on top of the SDK.

## Solution

`FcClient` accepts an optional `hooks` bag. Three best-effort observers
fire on every request lifecycle:

| Hook | When |
| --- | --- |
| `onRequest`  | Before the SDK calls `fetch`. |
| `onResponse` | After `fetch` settles (success or HTTP error). |
| `onRetry`    | Before sleeping between attempts. |

All three receive a pre-redacted payload — credentials never reach the
hook. A throw inside a hook is caught and warned, never propagated.

### Minimal logger

```ts
import { FcClient } from "fc-sandbox-sdk";

const fc = new FcClient({
  apiKey: process.env.FC_API_KEY,
  hooks: {
    onRequest: (ctx) =>
      console.debug(`→ ${ctx.method} ${ctx.url} try=${ctx.attempt}`),
    onResponse: (ctx) =>
      console.debug(
        `← ${ctx.status} ${ctx.durationMs.toFixed(0)}ms req=${ctx.requestId ?? "-"}`,
      ),
    onRetry: (ctx) =>
      console.warn(
        `retry ${ctx.reason} in ${ctx.delayMs}ms (status=${ctx.status ?? "network"})`,
      ),
  },
});
```

### OpenTelemetry-style span wrapping

```ts
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("fc-sandbox-sdk");
const spans = new Map<string, ReturnType<(typeof tracer)["startSpan"]>>();

const fc = new FcClient({
  hooks: {
    onRequest: (ctx) => {
      const key = `${ctx.method} ${ctx.url} ${ctx.attempt}`;
      spans.set(key, tracer.startSpan(`fc-spawn ${ctx.method}`, {
        attributes: { "http.method": ctx.method, "http.url": ctx.url, attempt: ctx.attempt },
      }));
    },
    onResponse: (ctx) => {
      const key = `${ctx.method} ${ctx.url} ${ctx.attempt}`;
      const span = spans.get(key);
      span?.setAttribute("http.status_code", ctx.status);
      span?.setAttribute("fc.request_id", ctx.requestId ?? "");
      span?.end();
      spans.delete(key);
    },
  },
});
```

## What's already redacted

The hook payload routes through the SDK's `redact.ts` helpers, so the
following never appear:

- Headers: `Authorization`, `X-Api-Key`, `X-Auth-Token`, `Cookie`,
  `Set-Cookie`, `Proxy-Authorization`, `X-Csrf-Token`.
- Query params: `api_key`, `apikey`, `token`, `access_token`, `key`,
  `password`, `secret`, `signature`.

The values are replaced by the literal string `"redacted"` so your logs
remain greppable but contain no live credentials.

## Streaming requests bypass hooks

`Sandbox.streamCommand` and `TemplatesApi.followLogs` open a single
NDJSON connection and consume it as an async iterator. They take the
fast path through `FcHttp.stream` rather than the retry loop, so hooks
do **not** fire for them. The intent is that streams are owned by your
loop end-to-end — there is no retry to observe, and `onResponse` would
need an artificial "done" point. Wrap your `for await` in your own log
or metric if you need per-stream tracing.

## Retry reasons

`onRetry.reason` distinguishes:

- `"network"` — the underlying `fetch` threw. `status` is undefined.
- `"rate-limit"` — the server returned `Retry-After`; `delayMs` honours it.
- `"status"` — a retryable 4xx/5xx with no `Retry-After` (backoff sleep applied).
