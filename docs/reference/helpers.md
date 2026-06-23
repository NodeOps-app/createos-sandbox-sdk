# Helpers Reference

Exported utilities from `@nodeops-createos/sandbox`. These are low-level
primitives; most callers never need them directly.

---

## Polling

### `pollUntil<T>(options)`

```ts
function pollUntil<T>(options: PollOptions<T>): Promise<T>
```

Polls `options.poll()` with adaptive backoff until `options.done()` returns
`true`. The interval starts at 250 ms and ramps after 5 s, capped at 2 s.
Backs the `waitUntil*` lifecycle helpers on `Sandbox`.

#### `PollOptions<T>`

| Field | Type | Required | Description |
|---|---|---|---|
| `poll` | `() => Promise<T>` | yes | Fetches the current state. |
| `done` | `(value: T) => boolean` | yes | Returns `true` when the desired state is reached. |
| `failed` | `(value: T) => string \| undefined` | no | Returns an error message when the state is a terminal failure; throwing is skipped when it returns `undefined`. |
| `timeoutMs` | `number` | yes | Overall budget in milliseconds. |
| `signal` | `AbortSignal \| undefined` | no | Aborts the wait early. |

Throws `CreateosSandboxTimeoutError` when `timeoutMs` elapses before `done()`
is satisfied. Throws `CreateosSandboxError` when `failed()` returns a message
or when `signal` is already aborted.

### `sleep(ms, signal?)`

```ts
function sleep(ms: number, signal?: AbortSignal): Promise<void>
```

Resolves after `ms` milliseconds, or immediately if `ms <= 0`. Resolves early
(never rejects) when `signal` aborts. Used internally by `pollUntil` and the
retry logic.

---

## Runtime detection

### `detectRuntime()`

```ts
function detectRuntime(): Runtime
```

Detects the JS runtime the SDK is executing in. Never throws.

```ts
type Runtime =
  | "node"
  | "bun"
  | "deno"
  | "workerd"
  | "edge-light"
  | "browser"
  | "react-native"
  | "unknown"
```

Detection order: Bun → Deno → Next.js edge (`NEXT_RUNTIME=edge`) → Cloudflare
Workers (`WebSocketPair`) → React Native → Node.js → browser → `"unknown"`.

### `runtimeTag()`

```ts
function runtimeTag(): string
```

Returns `"<runtime>-<version>"` for runtimes that expose a version, e.g.
`"node-22.10.0"`, `"bun-1.1.0"`, `"deno-1.44.0"`. Returns just the runtime
name (`"workerd"`, `"browser"`, etc.) for runtimes without a version string.
Stamped into the `User-Agent` and `X-Fc-Runtime` headers.

---

## Redaction helpers

Pure functions; never mutate input. Exported so consumers writing their own
logging middleware can avoid leaking credentials.

### `SENSITIVE_HEADER_NAMES`

```ts
const SENSITIVE_HEADER_NAMES: ReadonlySet<string>
```

Header names that always carry credentials and must be redacted:
`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-access-token`,
`x-auth-token`, `x-csrf-token`, `proxy-authorization`. The transport also
redacts any header whose name ends in `-token` or `-key`.

### `SENSITIVE_QUERY_PARAMS`

```ts
const SENSITIVE_QUERY_PARAMS: ReadonlySet<string>
```

Query-string keys that commonly carry credentials:
`token`, `api_key`, `apikey`, `access_token`, `auth_token`, `password`,
`secret`.

### `redactHeaders(headers)`

```ts
function redactHeaders(headers: Headers | HeadersInit): Record<string, string>
```

Returns a plain object of the headers with sensitive values replaced by
`"redacted"`. Does not mutate the input.

### `redactQuery(query)`

```ts
function redactQuery(query: URLSearchParams): URLSearchParams
```

Returns a copy of the `URLSearchParams` with sensitive values redacted.

### `redactUrl(url)`

```ts
function redactUrl(url: string): string
```

Returns the URL with userinfo stripped and sensitive query params redacted.
Returns the original string unchanged if it does not parse as a URL.

---

## Version

### `VERSION`

```ts
const VERSION: string  // e.g. "0.6.0"
```

SDK version string, kept in sync with `package.json`. Stamped into the
`User-Agent` header as `createos-sandbox-sdk/<VERSION> <runtimeTag>`.

---

## `CreateosSandboxHttp` — escape hatch

```ts
class CreateosSandboxHttp {
  readonly baseUrl: string;

  request<T>(method: string, path: string, options?: HttpRequestOptions): Promise<T>
  requestRaw(method: string, path: string, options?: HttpRequestOptions): Promise<Response>
  stream<T>(method: string, path: string, options?: HttpRequestOptions): AsyncGenerator<T>
  fetchAllPages<T>(method, path, options?, page?): Promise<T[]>
}
```

The transport underlying every SDK call. Reached via `client.http`.

Use it when the SDK does not model an endpoint directly:

- `request<T>` — JSend-unwrapping call; throws on non-2xx.
- `requestRaw` — returns the raw `Response`; caller is responsible for error
  handling. Useful for binary or plain-text responses.
- `stream<T>` — NDJSON async iterator. Not retried.
- `fetchAllPages<T>` — walks pagination automatically and returns a flat array.

#### `HttpRequestOptions`

| Field | Type | Description |
|---|---|---|
| `signal` | `AbortSignal \| undefined` | Abort the request. |
| `headers` | `HeadersInit \| undefined` | Extra request headers. |
| `timeoutMs` | `number \| undefined` | Per-request timeout override. |
| `retry` | `RetryOptions \| false \| undefined` | Retry policy override; `false` disables retries. |
| `query` | `Record<string, string \| number \| boolean \| null \| undefined> \| undefined` | Query string parameters. |
| `body` | `unknown` | JSON request body. |
| `auth` | `boolean \| undefined` | Set `false` to send the request without auth headers. |
