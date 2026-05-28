# CLAUDE.md — tests

Guidance for writing and maintaining the `fc-sandbox-sdk` test suite.
Read this before adding tests; the root `../CLAUDE.md` covers the SDK
itself.

## Stack and shape

- **Runner:** `bun:test` (`describe` / `test` / `expect`). Not
  `node:test`, not Jest.
- **Target:** tests import the SDK **source** (`../src/*.ts`)
  directly — there is no build step before tests. Public surface comes
  from `../src/index.ts`; internal-only modules (`poll`, `ndjson`,
  `config`, `redact`) are imported from their own file
  (`../src/poll.ts`, …).
- **No live server.** Every test injects a mock via the client `fetch`
  option. `fetch` is the only seam — there is nothing else to stub.
- **One file per module**, named `<module>.test.ts`. Shared fixtures
  live in `helpers.ts` (not a test file). Keep each file under the
  ~1100-line repo cap; if a module's tests outgrow it, split by concern
  (`http-retry`, `http-auth`) rather than reaching for one big file.

Run: `bun test` (all), `bun test tests/http.test.ts` (one file),
`bun run test:watch` (watch). Coverage runs on every invocation
(`bunfig.toml`).

## helpers.ts — the fixture contract

| Export | Use |
| --- | --- |
| `BASE` | The mock base URL (`https://example.test`). |
| `RUNNING_VIEW` | A `running` `SandboxView` — the common GET fixture. |
| `CREATE_RESPONSE` | The `POST /v1/sandboxes` response body. |
| `FAST_RETRY` | `{ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 }` — use in retry tests so they don't sleep for real. |
| `success(data, init?)` | JSend success envelope `Response`. |
| `fail(data, status)` | JSend fail envelope (4xx). |
| `errorEnvelope(msg, code, status)` | JSend error envelope (5xx / coded). |
| `jsonResponse(body, init?)` | Raw JSON `Response` (when you need a non-JSend body). |
| `makeClient(fetchImpl, extra?)` | `FcClient` with test defaults (`apiKey: "sk"`, `baseUrl: BASE`); `extra` overrides. |
| `catchErr(fn)` | Awaits `fn`, returns the thrown error; throws if it resolves. Use to assert on error properties. |
| `streamOf(...chunks)` | `ReadableStream` from string chunks. |
| `ndjsonResponse(stream)` | `application/x-ndjson` `Response`. |

If you add a fixture used by 2+ files, put it here. Don't add a helper
you don't use — `helpers.ts` is in the coverage report and an unused
export shows as a dead function.

## The canonical test

Mock `fetch`, capture what the SDK sent, assert the wire contract
(method, path, query, body) and the unwrapped result:

```ts
import { describe, expect, test } from "bun:test";
import { makeClient, success } from "./helpers.ts";

test("resize posts disk_mib and returns the new size", async () => {
  let body: { disk_mib: number } | undefined;
  const client = makeClient((url, init) => {
    expect(new URL(String(url)).pathname).toBe("/v1/sandboxes/sb_1/resize");
    body = JSON.parse(String(init.body));
    return Promise.resolve(success({ id: "sb_1", disk_mib: 20480 }));
  });
  const sandbox = await client.getSandbox("sb_1");
  const out = await sandbox.resize(20480);
  expect(body).toEqual({ disk_mib: 20480 });
  expect(out.disk_mib).toBe(20480);
});
```

The mock receives `(url, init)`. Read `init.method`, `init.body`
(a string — `JSON.parse` it), and `init.headers` (a `Headers`) to
assert what went over the wire. Read `new URL(url).pathname` /
`.searchParams` for the route and query.

## Per-area patterns

- **Per-sandbox operations** do an implicit `getSandbox` GET first.
  `sandbox.test.ts` defines a local `withSandbox(op)` that routes the
  boot GET (`/v1/sandboxes/sb_1`) to `RUNNING_VIEW` and everything else
  to your `op` responder — copy that pattern, don't route on `method`
  alone (sub-resource reads like `/egress` are also GETs).
- **Errors:** `const err = await catchErr(() => client.x()); expect(err)
  .toBeInstanceOf(FcNotFoundError)` then assert `statusCode`, `code`,
  `endpoint`, `method`, `requestId`, `resourceId`, `retryAfterSeconds`.
  Always pass `retry: false` so the error surfaces on the first
  attempt.
- **Retries:** count attempts with a closure counter; use `FAST_RETRY`.
  Idempotent verbs (GET/PUT/DELETE) retry on `408/500/502/503/504`;
  non-idempotent (POST) retries only on `429/503`. Cover both sides of
  that matrix when touching retry logic.
- **Timeouts / cancellation:** the mock must reject when the signal
  aborts — `init.signal?.addEventListener("abort", () =>
  reject(new DOMException("aborted", "AbortError")))` — with a small
  `timeoutMs`. A fired timeout → `FcTimeoutError`; a caller-aborted
  signal re-throws the original `AbortError`.
- **Streaming:** build the body with `streamOf(...)` + `ndjsonResponse`.
  Test the NDJSON parser itself against `readNdjson` directly
  (`ndjson.test.ts`), including early `break` (reader cancel path) and
  SSE control lines. Streaming requests are never retried — assert that.
- **Config / env:** `resolveConfig` is imported from `../src/config.ts`.
  Tests that set `process.env.FC_*` must **save and restore** the
  original values (`beforeEach` snapshots + deletes, `afterEach`
  restores) — not just `delete` in `afterEach`. A bare delete corrupts a
  dev shell that already has those vars set and leaks state between
  tests. See the `TRACKED_ENV_KEYS` block in `config.test.ts` /
  `http.test.ts`.

## Coverage gate — read before you fight it

`bunfig.toml` sets `coverageThreshold = { lines = 0.9, functions = 0.9 }`.
Two things that are easy to get wrong:

1. **bun enforces the threshold PER FILE, not as an aggregate.** A new
   source file at 80% lines fails the gate even if the project average
   is 99%. When you add a `src/` module, add its test file in the same
   change.
2. **`statements` is intentionally omitted.** A single number
   (`coverageThreshold = 0.9`) gates lines, functions *and* statements;
   the table only prints lines and functions, so a statements failure
   looks like a phantom non-zero exit. Gate on the two visible metrics.

`src/runtime.ts` and `tests/` are in `coveragePathIgnorePatterns`:
runtime detection branches across 7 JS runtimes and only the running
one is reachable, so its coverage has a structural ceiling — excluding
it keeps the floor honest rather than weak. **Raise the floor as the
suite grows; never lower it to make a run pass.**

## Lint / format / typecheck

- oxlint lints test `.ts` (correctness + suspicious = error). Common
  trip: `no-underscore-dangle` on a throwaway loop var (`_event`). Name
  it and use it (`expect(event).toBeDefined()`) instead of prefixing
  `_`.
- oxfmt formats test `.ts` — run `bun run fmt` before committing
  (pre-commit also enforces it).
- Tests **are** typechecked, separately from the build: `bun run
  typecheck:tests` (`tsconfig.test.json`, which adds `tests/**` and
  `allowImportingTsExtensions`, types from `@types/bun`). It runs in
  pre-commit and `prepublishOnly`. `bun run typecheck` stays src-only
  (the real build config, `.js` import extensions). Both must pass.
- Stub `fetch` as `(() => …) as unknown as typeof fetch` — a bare cast
  trips `TS2741` (the `fetch` type requires a `preconnect` method).
- Fixtures in `helpers.ts` are typed against the wire types
  (`RUNNING_VIEW: SandboxView`, `CREATE_RESPONSE: CreateSandboxResponse`)
  so a drift between a fixture and `src/types.ts` fails typecheck. Keep
  it that way — type new fixtures too.
- **Capture vars assigned only inside the `fetch` closure:** declare them
  `let x: string | null | undefined;` with **no `= null` initializer**.
  A `let x: … = null` narrows to `null` at the later `expect(x)` (TS
  can't see the closure ran), and `.toBe("…")` then fails to typecheck.
- The command method is `runCommand` / `streamCommand`, never `exec` —
  a global security hook false-positives on the token `exec(`. Don't
  write that literal in tests either.

## Wire types are the contract

Assertions on request/response shape mirror the Go control plane, not
`../fc/openapi.yaml` (stale). When a test's expected path, body key, or
status code is in question, verify against the handlers in
`../fc/internal/control/*.go` — see the root `../CLAUDE.md`. When you
fix a server-side mismatch, the bug is in `../fc`; when the SDK sends
the wrong thing, fix `src/` and add the test that proves it
(test-first — write the failing assertion, watch it fail, then fix).

## Deliberately not covered

- `src/runtime.ts` non-running-runtime branches (excluded; unhittable).
- `src/config.ts` no-`fetch`-available throw (a global `fetch` always
  exists under bun).
- `src/poll.ts` backoff ramp (only after 5s of real polling).
- The built `dist/` artifact — tests hit `src/`. `prepublishOnly`
  (build + typecheck) catches compile-level packaging breaks; add a
  `dist/` smoke test if a runtime packaging regression becomes a
  concern.
