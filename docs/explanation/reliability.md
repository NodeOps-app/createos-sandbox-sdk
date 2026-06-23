# Reliability: retries, timeouts, and cancellation

The SDK is built to survive transient failures — dropped connections, rate
limits, momentary server hiccups — without you writing retry loops. At the
same time it never silently re-sends a request the server may have already
processed, because doing so could double-create a sandbox or double-charge
bandwidth.

This document explains how the transport makes those guarantees, and how
you can tune or override them.

---

## Idempotent vs. non-idempotent requests

The key question when deciding whether to retry is: _if the server already
processed this request, will retrying it cause harm?_

For **idempotent methods** — `GET`, `HEAD`, `PUT`, `DELETE` — the answer
is no. A repeated `GET` returns the same data; a repeated `DELETE` on a
resource that was already deleted is still a no-op (or a 404, which is
handled). The SDK therefore retries these methods freely on both network
failures and the set of server statuses that unambiguously signal
transient trouble:

| Trigger | Idempotent (`GET HEAD PUT DELETE`) | Non-idempotent (`POST PATCH`) |
|---|---|---|
| Network error (DNS, connection refused, socket reset) | Retried | Not retried |
| `408 Request Timeout` | Retried | Not retried |
| `500 Internal Server Error` | Retried | Not retried |
| `502 Bad Gateway` | Retried | Not retried |
| `503 Service Unavailable` | Retried | Retried |
| `429 Too Many Requests` | Retried | Retried |
| `504 Gateway Timeout` | Retried | Not retried |

For **non-idempotent methods** — `POST`, `PATCH` — retrying is dangerous
unless the server provably did not act on the request. Two statuses carry
that guarantee: `429` (rate-limit; the server rejected the request before
processing it) and `503` (service unavailable; the upstream never reached
the handler). Every other failure on a `POST` or `PATCH` surfaces
immediately as a typed error, letting your code decide what to do.

Requests with a streaming (`ReadableStream`) body are also never retried,
because the stream is consumed on the first attempt and cannot be
replayed.

---

## Backoff and jitter

Between retry attempts the SDK sleeps for a computed delay. The formula
(from `src/http.ts`, `backoffDelay`):

```
delay = min(
  baseDelayMs × 2^attempt  +  Math.random() × baseDelayMs,
  maxDelayMs
)
```

With the defaults (`baseDelayMs = 500 ms`, `maxDelayMs = 30 000 ms`):

| Attempt | Deterministic term | Jitter range | Approximate ceiling |
|---|---|---|---|
| 0 (first retry) | 500 ms | 0–500 ms | 1 000 ms |
| 1 (second retry) | 1 000 ms | 0–500 ms | 1 500 ms |

The cap (`maxDelayMs = 30 s`) applies to the _sum_ of the deterministic
term and the random jitter, so the result never exceeds 30 s regardless of
how many attempts are made.

**Why jitter?** When many clients hit the same transient error at the same
time (a server restart, a brief overload), a pure exponential backoff
would cause them all to retry in synchronized waves — the thundering-herd
problem. Adding a per-attempt random offset spreads retries across a
window, smoothing the load spike.

### Defaults and overrides

| Parameter | Default | Override scope |
|---|---|---|
| `maxRetries` | `2` (3 total attempts) | Client or per-request |
| `baseDelayMs` | `500 ms` | Client or per-request |
| `maxDelayMs` | `30 000 ms` | Client or per-request |

Set a client-wide policy in the constructor:

```ts
const client = new CreateosSandboxClient({
  retry: { maxRetries: 4, baseDelayMs: 250 },
});
```

Override for a single call, or disable retries entirely for that call:

```ts
// Disable retries for one call (e.g., an idempotent probe you want fast feedback on)
await client.whoami({ retry: false });

// Override max retries for one call
await client.listSandboxes({ retry: { maxRetries: 1 } });
```

Per-request options are merged over the client default, not replaced — a
per-request `{ maxRetries: 1 }` still inherits `baseDelayMs` and
`maxDelayMs` from the client policy.

---

## Retry-After header

When the server returns a `429` or `503` with a `Retry-After` header, the
SDK uses that value instead of its own computed backoff:

```
delay = Retry-After value in seconds × 1000 ms
```

Both delta-seconds (`Retry-After: 5`) and HTTP-date formats are parsed.
The server is telling you exactly when it will accept the next request;
overriding that with a shorter client-side backoff would just produce
another `429`.

After the `Retry-After` delay has elapsed, the SDK retries the request
normally. If the server repeats the `429`, the `Retry-After` delay is
honored again, until `maxRetries` is exhausted.

When the SDK surfaces a `CreateosSandboxRateLimitError` after all retries are
exhausted, `err.retryAfterSeconds` carries the last parsed `Retry-After`
value so your code can make its own scheduling decision.

---

## Streaming is never retried

The `stream` method (`src/http.ts`) issues a single dispatch and yields
frames from the response body. There is no retry loop around it.

The reason is fundamental: by the time a streaming error surfaces, the
iterator may have already yielded dozens of frames. There is no safe
replay position. Restarting from the beginning would duplicate output;
seeking to an offset is not possible without server-side support the
control plane does not provide.

If the underlying connection breaks, the async iterator throws and your
`for await` loop unwinds. Wrap the loop with application-level logic if
you need resume behavior.

See [../how-to/streaming.md](../how-to/streaming.md) for streaming usage
patterns.

---

## Timeouts

### Per-request timeout

Every request carries a timeout. The default is **60 000 ms (60 s)**, set
as `DEFAULT_TIMEOUT_MS` in `src/config.ts`. Override it at the client
level or per call:

```ts
// Client-wide — all requests time out after 10 s unless overridden
const client = new CreateosSandboxClient({ timeoutMs: 10_000 });

// Per-call — only this request gets 120 s
await client.createSandbox(req, { timeoutMs: 120_000 });

// Disable the timeout for one call — use with care
await client.someMethod({ timeoutMs: 0 });
```

A `timeoutMs: 0` disables the per-request timeout entirely. The caller is
then responsible for bounding the request's duration (e.g., via an
`AbortSignal`).

The timeout is applied _per dispatch attempt_, not across the entire retry
sequence. Each attempt gets a fresh 60 s budget. A slow server that
returns a `503` on attempt 0 after 59 s, waits for the backoff, and then
times out on attempt 1 after another 60 s has consumed roughly 2 minutes
total.

When the timeout elapses, the SDK throws `CreateosSandboxTimeoutError` with a
message like `Request timed out after 60000ms: GET /v1/sandboxes`.

### Wait timeout

`createSandbox` and the `waitUntil*` lifecycle helpers (`waitUntilRunning`,
`waitUntilStopped`) run a poll loop with a separate budget — **120 000 ms
(120 s)** by default (`DEFAULT_WAIT_MS`). Pass `waitTimeoutMs` to change
it:

```ts
const sandbox = await client.createSandbox(
  { shape: "s-4vcpu-4gb" },
  { waitTimeoutMs: 180_000 },
);
```

When the wait budget is exhausted, `CreateosSandboxTimeoutError` is thrown and the
sandbox (or template) may still be transitioning in the background — it is
not automatically destroyed. Call `destroy()` if you no longer need it:

```ts
const sandbox = await client.createSandbox({ shape: "s-4vcpu-4gb" }).catch(
  async (err) => {
    if (err instanceof CreateosSandboxTimeoutError) {
      // Try to clean up — may itself fail if the sandbox never became reachable.
      await client.destroySandbox(err.sandboxId).catch(() => undefined);
    }
    throw err;
  },
);
```

---

## Cancellation

Pass an `AbortSignal` to cancel a request (and any in-flight backoff sleep)
at any time:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

try {
  const sandbox = await client.createSandbox(
    { shape: "s-4vcpu-4gb" },
    { signal: controller.signal },
  );
  try {
    // ...
  } finally {
    await sandbox.destroy();
  }
} catch (err) {
  if (err instanceof CreateosSandboxError) {
    // Includes the case where signal fired mid-request
  }
}
```

Internally the SDK composes your signal with its own per-request timeout
signal using `AbortSignal.any([userSignal, timeoutSignal])`. Whichever
fires first wins:

- If the user-supplied signal fires first, the underlying `fetch` rejects
  and the SDK re-throws the browser/runtime `AbortError` as-is (not
  wrapped) so your code can distinguish deliberate cancellation from other
  errors.
- If the timeout signal fires first (and the user signal has _not_ fired),
  the SDK wraps the error as `CreateosSandboxTimeoutError`.

Signals also cancel the sleep between retry attempts. If you abort during
a backoff window, the sleep resolves immediately and the pending retry is
abandoned.

---

## Polling backoff (`pollUntil`)

`waitUntilRunning`, `waitUntilStopped`, and the exported `pollUntil`
helper use a separate adaptive backoff that is tuned for lifecycle
transitions, not for HTTP retry:

- **First 5 seconds of wall time:** poll every **250 ms** — fast sandbox
  startups resolve in under a second and should not be penalized by a long
  initial interval.
- **After 5 seconds:** the interval grows by ×1.25 per iteration, capped
  at **2 000 ms (2 s)**. A build that takes two minutes does not busyloop.

The poller respects the overall `waitTimeoutMs` budget: each sleep is
capped at `min(interval, time_remaining)` so it wakes up promptly when the
deadline arrives.

`pollUntil` is exported for custom poll loops that need the same behavior:

```ts
import { pollUntil } from "@nodeops-createos/sandbox";

const result = await pollUntil({
  poll: () => client.getSandbox(id),
  done: (v) => v.status === "running",
  failed: (v) =>
    v.status === "error" ? `Sandbox entered error state` : undefined,
  timeoutMs: 120_000,
  signal: controller.signal,
});
```

See [../reference/helpers.md](../reference/helpers.md) for the full
`PollOptions` interface.

---

## How failures surface

After all retries are exhausted — or immediately for non-retryable
conditions — the SDK throws a typed error. Import and narrow with
`instanceof`:

```ts
import {
  CreateosSandboxError,
  CreateosSandboxConnectionError,
  CreateosSandboxTimeoutError,
  CreateosSandboxRateLimitError,
  CreateosSandboxServerError,
} from "@nodeops-createos/sandbox";

try {
  const sandbox = await client.createSandbox({ shape: "s-4vcpu-4gb" });
  try {
    // ...
  } finally {
    await sandbox.destroy();
  }
} catch (err) {
  if (err instanceof CreateosSandboxConnectionError) {
    // Never reached the server. All retries exhausted.
    // err.cause holds the original network error.
  } else if (err instanceof CreateosSandboxTimeoutError) {
    // Per-request timeout or waitUntil* budget exceeded.
  } else if (err instanceof CreateosSandboxRateLimitError) {
    // 429 after all retries. err.retryAfterSeconds from last Retry-After header.
  } else if (err instanceof CreateosSandboxServerError) {
    // 5xx after all retries.
  } else if (err instanceof CreateosSandboxError) {
    // Anything else the SDK threw.
  }
}
```

| Error class | When thrown | Retried before throw? |
|---|---|---|
| `CreateosSandboxConnectionError` | Network failure (DNS, refused, reset) | Yes — idempotent only, up to `maxRetries` |
| `CreateosSandboxTimeoutError` | Per-request or wait-loop deadline exceeded | No |
| `CreateosSandboxRateLimitError` | `429` after all retries | Yes — any method |
| `CreateosSandboxServerError` | `5xx` after all retries | Yes — idempotent only (except 503, any method) |
| `CreateosSandboxAuthError` | `401` | No |
| `CreateosSandboxPermissionError` | `403` | No |
| `CreateosSandboxNotFoundError` | `404` | No |
| `CreateosSandboxValidationError` | `400`, `409`, `422` | No |
| `CreateosSandboxPaymentRequiredError` | `402` | No |

Full per-class field reference: [../reference/errors.md](../reference/errors.md).

For recipes — retry-after handling, fallback logic, logging retries via
hooks — see [../how-to/error-handling.md](../how-to/error-handling.md).

---

## Summary

| Dimension | Default | Override |
|---|---|---|
| Max retries | `2` (3 attempts total) | `retry.maxRetries` on client or per-call |
| Base backoff delay | `500 ms` | `retry.baseDelayMs` |
| Backoff ceiling | `30 000 ms` | `retry.maxDelayMs` |
| Per-request timeout | `60 000 ms` | `timeoutMs` on client or per-call |
| Wait-loop timeout | `120 000 ms` | `waitTimeoutMs` on `createSandbox` / `waitUntil*` |
| Streaming | Never retried | — |
| `Retry-After` honored | Yes — overrides backoff formula | — |
| Abort support | `AbortSignal` composed with timeout | `signal` per-call |
