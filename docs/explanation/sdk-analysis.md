# Sandbox SDK analysis

Before the `v0.2` redesign, seven competing sandbox / compute SDKs were
read in depth — their source, not just their docs. This document records
what each does well, what each does badly, which ideas
`fc-sandbox-sdk` borrowed, and where our SDK now leads.

SDKs surveyed:

| SDK | npm | Product |
| --- | --- | --- |
| E2B | `e2b` | Firecracker microVM sandboxes for AI code |
| Daytona | `@daytona/sdk` | Elastic dev-environment sandboxes |
| ComputeSDK | `computesdk` | Meta-SDK unifying many providers |
| Modal | `modal` | Serverless compute / sandboxes |
| Cloudflare | `@cloudflare/sandbox` | Containers on Durable Objects |
| CodeSandbox | `@codesandbox/sdk` | microVM dev environments |
| Vercel | `@vercel/sdk` | Vercel REST API (incl. Sandbox) |

---

## Per-SDK analysis

### E2B — `e2b`

A `Sandbox` class with static factories (`create` / `connect` / `list`)
and a hidden constructor; sub-namespaces `.files`, `.commands`, `.pty`,
`.git`. REST (`openapi-fetch`) plus gRPC-web for streaming.

**Good**

- Static-factory pattern with a hidden constructor — discoverable,
  funnels every caller through one path.
- Overload-driven return types: `read(path, { format: "bytes" })`
  narrows to `Uint8Array`. Self-documenting in the IDE.
- Typed error hierarchy with a status-code map and *teaching* messages
  (a 502 says "likely a sandbox timeout, call `.setTimeout`").
- `AbortSignal` composition, plus a handshake-timeout that bounds the
  connect phase without killing a long-lived stream.
- Genuinely multi-runtime (node/bun/deno/edge/browser) with per-runtime
  test suites. Owns the bare npm name `e2b`.

**Bad**

- **No retries or backoff** — a real weakness for a microVM service
  whose scheduler returns transient 503s.
- Legacy-only package exports (`main`/`module`/`types`, no `exports`
  map).
- `betaCreate` copy-pastes ~60 lines of `create`.

### Daytona — `@daytona/sdk`

A `Daytona` client whose `create` / `get` / `list` return a `Sandbox`
handle that spreads the DTO (`sandbox.state`, `sandbox.cpu` work
directly). Namespaces `.fs`, `.git`, `.process`, `.computerUse`,
`.codeInterpreter`.

**Good**

- The handle *is* the DTO — no `.data` indirection for hot fields.
- Excellent typed errors: `DaytonaError` + 8 subclasses, a
  `STATUS_CODE_TO_ERROR` map, and an interceptor that converts every
  transport error into a typed one.
- `waitUntilStarted` uses adaptive backoff (100 ms, ramping ×1.1 to a
  1 s cap); `create()` auto-waits and deducts elapsed time from the
  budget.
- Uniform trailing `timeout` argument; first-class JSDoc with runnable
  `@example` blocks driving the docs site.

**Bad**

- **No retries** — `axios-retry` is a dependency but is never wired in.
- The `Sandbox` constructor eagerly builds five sub-clients even when
  unused.
- Redundant surface: `Sandbox` static methods that just delegate to the
  handle.

### ComputeSDK — `computesdk`

A meta-SDK: write once against a universal `Sandbox` interface, swap the
backend provider (E2B, Modal, Daytona, Vercel, Docker…) via config.

**Good**

- `defineProvider()` — a provider is a plain **object of pure
  functions**, and a factory generates the handle/manager classes.
  Trivial to mock and to add a local dev backend.
- Capability-by-presence: omit the `filesystem` method block and callers
  get an auto-injected stub that throws a descriptive error — no
  capability booleans, no silent `undefined`.
- `getInstance()` escape hatch to the raw vendor object, plus an
  `[key: string]: any` options field — a clean typed surface that never
  blocks power users.
- Deliberately flat universal interface — only `.filesystem` is nested.
  A good reminder not to over-namespace.

**Bad**

- **No typed errors at all** — everything is `throw new Error(string)`.
- **No `waitFor` helper** — every provider re-implements its own poll
  loop.
- A `calculateBackoff` utility exists but is dead code, never wired to a
  transport.

### Modal — `modal`

A `ModalClient` with service namespaces; `sandboxes.create` /
`fromId` return a `Sandbox`, and a command yields a separate
`ContainerProcess` handle. Transport is gRPC over HTTP/2.

**Good**

- Best-in-class retries: a middleware chain, exponential backoff, one
  idempotency key reused across attempts, and it honors a
  *server-directed* retry policy decoded from the gRPC trailer.
- `checkForRenamedParams` throws a helpful error when a caller passes an
  old parameter name — excellent migration DX.
- Overloaded signatures for return-type precision; WHATWG stream
  wrappers; normalized exit codes (timeout→124, killed→137).

**Bad**

- **gRPC/protobuf** — checked-in codegen, two `ts-proto` patch hacks,
  and heavy dependencies (`nice-grpc`, `protobufjs`, `long`). Enormous
  build complexity for no user-facing gain over REST + NDJSON.
- Thrown errors carry no `code` / `status` / `requestId` metadata — just
  a name and a message.

### Cloudflare — `@cloudflare/sandbox`

Containers attached to Durable Objects, driven from a Worker.
`getSandbox(ns, id)` is get-or-create.

**Good**

- **Token-authenticated preview URLs** — the standout DX feature.
  `exposePort` returns `{port}-{id}-{token}.{domain}`, a `proxyToSandbox`
  router validates the crypto token with `timingSafeEqual`, and exposed
  ports are persisted and auto-re-exposed after a VM restart.
- `Process.waitForPort()` is a *server-side* SSE watch — the VM polls and
  streams `ready`/`exited` events, so there is no flaky client poll loop.
- ~45 typed error subclasses over a structured `ErrorResponse` carrying
  `code`, `httpStatus`, `suggestion`, `documentation`.
- Heavy integrations are optional `peerDependencies` — good hygiene.

**Bad**

- `sandbox.ts` is a single 6,295-line file.
- The top-level surface is a flat ~40 methods — the per-domain sub-clients
  exist internally but are not exposed as namespaces.
- Retry is 503-only, with no jitter and no network-error retry.
- Workers-only — not portable to Node.

### CodeSandbox — `@codesandbox/sdk`

A two-layer design: a lightweight `Sandbox` (control plane) and, via
`sandbox.connect()`, a rich `SandboxClient` (data plane over a
WebSocket).

**Good**

- The two-layer split cleanly separates "I have a VM" from "I have a live
  session to it" — natural for resume/reconnect.
- `bootupType` (`RUNNING`/`CLEAN`/`RESUME`/`FORK`) tells the caller
  whether a boot was warm, so agent code can skip re-running setup.
- `fs.batchWrite()` zips many files into one upload — N round-trips
  become one.
- Deprecated standalone `fork()` in favor of `create({ id })` — "one way
  to do each thing."

**Bad**

- **Weak error model** — no unified base class; most failures are plain
  `new Error(prefix + …)`, not discriminable.
- Retries are fixed-delay, with no backoff and no jitter.
- A `withSpan` tracing helper is copy-pasted into ~8 classes.

### Vercel — `@vercel/sdk`

The Vercel REST API SDK (which includes a Sandbox surface), generated
from an OpenAPI spec by Speakeasy.

**Good**

- The strongest proof that OpenAPI codegen scales: 40+ namespaces, and
  the only hand-edited file is `hooks/registration.ts`.
- A mature retry engine — `Permanent`/`Temporary` error sentinels,
  exponential backoff with jitter, honors `Retry-After`, per-call
  overridable.
- Every operation also ships as a standalone tree-shakable function that
  returns a `Result` instead of throwing.
- Typed hooks (`beforeRequest`/`afterSuccess`/`afterError`), zod
  validation on requests and responses, only two runtime dependencies.

**Bad**

- Generated code is verbose and not hand-editable — regeneration is the
  workflow.
- Codegen is overkill for a small API: it pays off at 40+ operations, not
  at ~12.
- No environment-variable auto-read; no stateful handle object (a flat
  API client — a handle would need a hand-written facade on top anyway).

---

## Round 2 (2026-05-28)

Nine more sandbox / compute SDKs surveyed at source level. Same
Good/Bad template. Headlines: atomic N-way fork (Morph), idempotent
snapshot layering by content hash (Morph), TTL reaper + wake-on-traffic
(Morph), Jupyter-shaped execution aggregate with mime bundles
(OpenSandbox), sequence-numbered event bus with replay (Runloop),
H2 pool warming during create (Blaxel), runtime-detection header
(Islo), two-plane URL with per-sandbox capability tokens (Superserve),
W3C `traceparent` returned on every call (Tensorlake), resource-spec
parsers `parseCpu` / `parseMemory` / `parseGpu` (Beam).

| SDK | npm | Product |
| --- | --- | --- |
| Tensorlake | `tensorlake` | Managed micro-VM platform |
| Runloop (remote-agents) | `@runloop/remote-agents-sdk` | ACP/Claude bridge over Axon SSE |
| Morph Labs | `morphcloud` | Snapshot/branch micro-VM cloud (Infinibranch) |
| Islo Labs | `@islo-labs/sdk` | Sandbox/snapshot platform (Fern codegen) |
| Blaxel | `@blaxel/core` | Agentic platform — multi-region sandboxes + agents/models |
| Superserve | `@superserve/sdk` | Firecracker micro-VM control plane |
| OpenSandbox (Alibaba) | `@alibaba-group/opensandbox-code-interpreter` | Open-source Jupyter-style code interpreter |
| OpenComputer (Digger) | `@opencomputer/sdk` | Persistent-VM sandboxes for AI agents |
| Beam Cloud | `@beamcloud/beam-js` | Serverless GPU/CPU compute + sandboxes |

### Tensorlake — `tensorlake`

Hand-written + tsc-built micro-VM SDK. 2 runtime deps (`undici`, `ws`),
Node ≥22.

**Good**

- `Sandbox.create()` / `Sandbox.connect()` static factories return a
  fully-wired handle. Old `SandboxClient` is `console.warn`-deprecated.
- **W3C `traceparent` per request, returned as `Traced<T>`** — every
  SDK return value carries `traceId` so users grep server logs by ID.
- Status→class error map stamps the entity ID onto typed errors via
  path regex (`SandboxNotFoundError.sandboxId`).
- `anySignal(...)` AbortSignal composer + tuned `undici` global
  dispatcher (`keepAliveTimeout: 60_000`, `allowH2: true`).
- `run()` over a single SSE POST: stdout/stderr + exit code in one
  stream. No start-process-then-poll-pid round trip.
- `waitForPortReady` uses bash `/dev/tcp/127.0.0.1/<port>` inside the
  sandbox — kills 502-races without adding a probe endpoint
  server-side.

**Bad**

- Retry policy is naive — exponential without jitter, no `Retry-After`,
  no idempotency awareness.
- Single shared `abortController` per `HttpClient` — concurrent
  requests race each other's timeouts.
- 2 runtime deps; no env-var-driven retry/timeout config.
- Manual `fromSnakeKeys()` in every method — wire-type case translation
  by reflection.

### Runloop — `@runloop/remote-agents-sdk`

Thin ACP / Claude bridge over Axon SSE event bus. **Not** Runloop's
REST sandbox SDK — that is the peer-dep `@runloop/api-client`
(Stainless-generated, not in this repo). Apples-to-oranges with
`fc-sandbox-sdk`; the transport / retry / auth layer is absent here.

**Good**

- `ListenerSet<T>` — error-isolated fan-out, snapshot-iterate, ~40 LOC.
- Typed lifecycle error with discriminant `code` field (`already_connected
  | already_initialized | not_connected | terminated`).
- **Sequence-numbered event bus with replay** — `afterSequence: N` +
  `replay: boolean` resume semantics for the SSE feed.
- Conventional-commit PR-title CI gate; NPM provenance + OIDC publish.

**Bad**

- No HTTP transport / retry / auth / error model / file ops to inspect
  in this layer — all in the peer-dep.
- Single-retry reconnect; no exponential backoff.
- 1100-line `claude/connection.ts` merging transport + protocol +
  lifecycle.

### Morph Labs — `morphcloud`

Snapshot/branch micro-VM cloud (Infinibranch). Hand-written, CJS+ESM
dual via `tsup`. 4 runtime deps.

**Good**

- **`Instance.branch(count)` returns `{snapshot, instances[]}` in one
  server call** — atomic N-way fork beats client-side fan-out.
- **Chain-hash idempotent layering** (`Snapshot.computeChainHash`):
  sha256 from `parentChainHash + effectIdentifier`. Turns
  `.setup("apt install foo")` into Dockerfile-style cached layers.
- Stripe-style `metadata[key]=value` URLSearchParams filter on list
  endpoints — tag snapshots, retrieve by tag.
- **`InstanceTTL`** server-side auto-stop (`ttlSeconds`,
  `ttlAction: "stop"|"pause"`) — leak prevention as a wire feature.
- **`InstanceWakeOn`** (`wakeOnSsh`, `wakeOnHttp`) — paused instance
  auto-resumes on traffic. Cost/warmth dial.
- Separate `undici.Agent` for exec (`headersTimeout: 24h, bodyTimeout: 0`)
  segregates long-poll from normal pool.
- `digest` field on snapshots as user-supplied dedupe key, auto-sha256
  if omitted. Free idempotency on retry.

**Bad**

- No typed error hierarchy — every failure is bare
  `throw new Error("HTTP " + status)` with stringified body.
- No retry layer; single-shot fetch.
- `AbortSignal.timeout()` overwrites any caller signal — external
  cancellation impossible.
- `waitUntilReady` is fixed 1s poll with no jitter.
- 4 runtime deps; module-load-time keypair generation.

### Islo Labs — `@islo-labs/sdk`

Fully Fern-codegen TS SDK (192 files, ~8.8 kLOC). Only 3 hand-written
files (API-key → JWT exchange). Zero runtime deps.

**Good**

- **`HttpResponsePromise` dual-API**: `await client.x.foo()` resolves
  body; `.withRawResponse()` on the same call returns `{data,
  rawResponse}`. Single Promise subclass.
- **Aggressive log redaction** — `Authorization` / `*-token` / `*-key` /
  `cookie` / `csrf` headers, sensitive query params, URL userinfo all
  redacted before `logger.debug` ever sees them.
- Runtime detection (node / bun / deno / browser / workerd / edge /
  web-worker / react-native) → `X-Fern-Runtime` header.
- **TokenProvider with cross-instance cache + in-flight dedupe** —
  module-level `Map<cacheKey, TokenState>`, refresh-margin window,
  shared pending promise so 50 concurrent clients fire one exchange.
- `anySignal()` using the controller's own signal as
  `addEventListener` unsub — leak-free without manual
  `removeEventListener`.
- Passthrough `client.fetch(url, init, opts)` escape hatch that reuses
  SDK auth / retry / logging / timeout / abort.

**Bad**

- 2140-line `SandboxesClient.ts` is codegen boilerplate; same
  `_queryParams` / `_authRequest` / `_response` plumbing inlined every
  method.
- No resource handle — every per-sandbox op is
  `client.sandboxes.X({sandbox_name, body})`.
- Retries `POST` on 408 / 429 / 5xx — wrong policy for non-idempotent.
- `downloadFile` / `uploadFile` typed `unknown` — OpenAPI spec doesn't
  tag content-type.
- Streaming returns raw `ReadableStream`; no parser.

### Blaxel — `@blaxel/core`

Agentic platform (sandboxes + agents + models). Codegen-heavy
(`@hey-api/openapi-ts`) with hand-written H2 pool. 13 runtime deps.

**Good**

- **H2 session pool keyed by edge domain** with `warm()`
  (fire-and-forget background connect) running in parallel with
  `createSandbox` — SETTINGS exchange hidden under the API roundtrip.
  Self-evicts on `goaway` / `error` / `close`.
- **Multi-region routing**: `BL_REGION` env → `any.${region}.bl.run`
  edge domain.
- Multipart upload with transient-marker classifier
  (`ENHANCE_YOUR_CALM`, `NGHTTP2_INTERNAL_ERROR`, `GOAWAY`) +
  error-code chain walk through `cause`.
- NDJSON process streaming with three callback channels
  (`onStdout` / `onStderr` / `onLog`).
- **`Blaxel-Version: 2026-04-16` date-versioned API header** —
  Stripe-style API pinning.
- `fromSession({url, token})` constructor builds a handle from a
  shared / preview URL — same handle for owner + shared access.
- Lazy autoload pattern: `import "@blaxel/core"` has zero side effects;
  credential resolution fires on first request.

**Bad**

- 13 runtime deps; 11 `sed -i.bak` patches + a `perl -0777` to fix up
  generated types after every regen.
- Single `ResponseError` class — `JSON.stringify(body)` blob as message.
  No status → class hierarchy.
- No `AbortSignal` composition; `wait()` is `setTimeout` + poll.
- Globally mutable `settings` singleton.

### Superserve — `@superserve/sdk`

TS SDK for a Firecracker micro-VM control plane. Hand-written, zero
runtime deps, ESM+CJS via `tsup`. Closest stylistic peer to ours.

**Good**

- **Two-plane URL design**: control plane at `api.superserve.ai`, data
  plane derived per-sandbox at `boxd-{id}.sandbox.superserve.ai`. Files
  use a per-sandbox `X-Access-Token`, not the master API key. Hard
  separation of blast radius.
- **Per-sandbox capability token rotates on `resume()`** — handle
  transparently rebuilds `sandbox.files` to pick up the new token.
- Two-mode `commands.run()` — switches sync vs SSE stream purely by
  presence of `onStdout` / `onStderr` callbacks.
- **SSE with idle (not absolute) timeout** — resets timer per chunk;
  long-running commands don't get spuriously aborted, but a true wedge
  still trips.
- **`BuildError` with structured `code` / `buildId` / `templateId`** +
  stable-prefix parser for `"<code>: <detail>"` server messages.
- **+5s buffer on client vs server timeout** so the server's
  structured timeout response wins over a client abort.
- 204 / empty-body and `Retry-After` (seconds or HTTP-date) both
  handled explicitly.

**Bad**

- Auth header is `X-API-Key` (not Bearer) — ignores the `Authorization`
  ecosystem (proxies, log scrubbers, OpenAPI tooling).
- Hand-coded `SDK_VERSION = "0.6.0"` while `package.json` is `0.7.1`
  (drift in-repo).
- No `x-request-id` capture in errors; `Response` discarded post-throw.
- `getInfo()` returns a snapshot but doesn't mutate `this.status` /
  `this.metadata` — footgun.
- No NDJSON support — SSE only. Hardcoded retry constants.

### OpenSandbox — `@alibaba-group/opensandbox-code-interpreter`

Alibaba open-source Jupyter-style code interpreter. Two-package split:
`opensandbox` (~8.8 kLOC, lifecycle + execd) and
`opensandbox-code-interpreter` (~575 LOC facade). 2 runtime deps.

**Good**

- **Jupyter-shaped execution aggregate**: `Execution { logs.stdout[],
  logs.stderr[], result: ExecutionResult{ raw: Record<string, unknown>,
  text }, error: { name, value, traceback[] }, complete, executionCount,
  exitCode }`. Preserves mime bundles (`image/png`, `text/html`,
  `application/vnd.plotly.v1+json`).
- **`ExecutionEventDispatcher`** — single state machine consumes
  `ServerStreamEvent.type ∈ {init, stdout, stderr, result,
  execution_count, execution_complete, error}`, mutates the aggregate,
  fires `ExecutionHandlers.{onStdout, onStderr, onResult, onError, ...}`.
  Reused for both code execution and shell command exec.
- **Context primitive**: `codes.createContext(language)` returns a
  stateful REPL session id; `run(code, {context})` persists cwd / env /
  Python kernel state.
- **Bash session primitive** — `createSession()` /
  `runInSession(id, cmd)` reuses shell state. Cheaper than spawning a
  fresh container shell each call.
- SSE / NDJSON tolerant parser handles `data:` SSE frames and raw
  NDJSON in one. Strips `id:` / `event:` / `retry:` / `:comment` lines.
- Separate streaming-fetch path (`sseFetch`, timeout=0) so request
  timeout doesn't kill the stream.
- `readBytesStream(path) → AsyncIterable<Uint8Array>` for large files.

**Bad**

- Codegen-heavy (`openapi-typescript`). `src/api/execd.ts` 1792 LoC,
  `lifecycle.ts` 1451 LoC.
- 2 runtime deps (`undici`, `openapi-fetch`).
- No retry layer, no `Retry-After`, no idempotency awareness.
- Single `SandboxApiException` for all failures.
- Health polling is hand-rolled `while(true)` with a fixed interval.

### OpenComputer — `@opencomputer/sdk`

Persistent-VM sandboxes for AI agents (E2B competitor). Hand-written,
zero runtime deps, ESM-only, ~2.8 kLOC. **Not** computer-use / VNC
despite the name — `rg` finds zero hits for screenshot, mouse,
keyboard, CDP, playwright.

**Good**

- `Sandbox.create()` / `Sandbox.connect(id)` static factories — no
  client object to wire up.
- `hibernate()` / `wake({timeout})` alongside `reboot()` /
  `powerCycle()`.
- **Named checkpoints**: `createCheckpoint(name)`, `listCheckpoints()`,
  `restoreCheckpoint(id)`, `createFromCheckpoint(id)`,
  `deleteCheckpoint(id)`. Plus checkpoint patches as a delta layer.
- **Signed pre-signed URLs**: `downloadUrl(path, {expiresIn})` /
  `uploadUrl(path, {expiresIn})` — sidestep proxying through the
  control plane.
- `createPreviewURL({port, domain?, authConfig?})` +
  `listPreviewURLs()` + `deletePreviewURL(port)`.
- Targeted error subclasses for known states: `ScalingLockedError`
  (403 + `code: "scaling_locked"`), `PlanLimitError` (402),
  `ShellBusyError`, `ShellClosedError`.
- Claude Agent namespace: `sandbox.agent.start({prompt, model, ...})`
  returns a session with `done: Promise<exitCode>`, `sendPrompt`,
  `interrupt`, `kill`, `close`.
- Declarative `Image` builder — layered steps + content-hashed
  manifest; server caches matching hash as a checkpoint.

**Bad**

- **No transport layer** — every method has its own ~10-line `fetch` +
  status-check + `throw new Error(...)` block. Auth header inlined at
  every call site. ~40+ near-duplicates.
- No retry layer (zero matches for `retry|backoff|jitter|Retry-After`).
- No `AbortSignal` / per-request timeout — none of the public methods
  accept a `signal`.
- Streaming exec is WebSocket with auth tunneled via query string
  (`?token=...`) — known weak pattern.
- `wake()` does `(this as any).files = new Filesystem(...)` to refresh
  JWT — mutation smell.
- Config is hand-resolved each call
  (`process.env.OPENCOMPUTER_API_URL` inside `Sandbox.create` /
  `Sandbox.connect`).

### Beam Cloud — `@beamcloud/beam-js`

Serverless GPU / CPU compute + sandboxes. Hand-written but Python-port
(visible TODOs reference `common.py`). 6 runtime deps. Global mutable
config singleton.

**Good**

- **Resource-spec parsers**: `parseCpu` accepts `2 | "2" | "2000m"`,
  `parseMemory` accepts `"512Mi" | "4Gi" | "2GB" | number`, `parseGpu`
  normalizes enum / array → string.
- **Enum + literal-union dual typing**: `GpuType` enum +
  `GpuTypeLiteral` string union → `GpuTypeAlias`. Same dual treatment
  for `PythonVersion`.
- **`Volume(name, mountPath).getOrCreate()`** lazy-resolve before stub
  creation; volumes pass as an array on Sandbox / Pod config.
- **`exposePort(port) → url`** dynamic port exposure;
  **`listUrls() → Record<port, url>`** returns all exposed ports.
- **`createImageFromFilesystem()`** + `snapshot()` /
  `createFromSnapshot()` static — turn a live sandbox FS into a
  reusable image. Significant product moat.
- **`updateNetworkPermissions(blockNetwork, allowList[])`** runtime
  CIDR allowlist mutation.
- **`findInFiles(pattern, opts) → SandboxFileSearchResult[]`** with
  line / column ranges. Distinctive product feature.
- `Image` builder DSL with chainable `commands`, `pythonPackages`,
  `buildSteps`, `fromDockerfile`; `Image.exists()` short-circuits to a
  cached `imageId`.
- Async-iterable on `process.stdout` / `stderr` / `logs` via
  `[Symbol.asyncIterator]()`.
- `updateTtl(seconds)` + `keepWarmSeconds: -1` no-timeout convention.

**Bad**

- No error hierarchy mapped to HTTP status — three message-only `Error`
  subclasses.
- Global mutable `beamOpts` singleton — not multi-tenant safe.
- No retry layer, no `AbortSignal`, no `Retry-After`.
- Errors discarded with `console.error` returning falsy values; caller
  must check `lastError` after the fact.
- 6 runtime deps; `axios` for transport.
- `console.log` / `process.stdout.write` baked into library code.
- `runCode` returns union `Response | Process` — caller must narrow.
- Reflective camel ↔ snake conversion runs blindly on all keys.

### CodeSandbox refresh — `@codesandbox/sdk` (delta since 2026-05-27)

Re-read at `10f8266` (2025-12-04), v2.4.2.

- New `interpreters` namespace — `javascript(code)` / `python(code)`
  thin helpers wrap `commands.run` with auto-`return` / `print()` of
  the last expression.
- Split `./browser` and `./node` subpath exports; browser variant
  auto-wires `visibilitychange → ping() / reconnect()`.
- Auto-reconnect with `keepActiveWhileConnected` + 10 s keep-alive ping,
  3-fail cooldown.
- `HostTokens` triple — `getUrl(token, port, proto)`,
  `getHeaders(token)`, `getCookies(token)` for signed private-host
  access. Parallel to the unkeyed `tunnel/:port` we intentionally do
  not model.
- Migrated to `@hey-api/client-fetch` OpenAPI codegen. **Skip** —
  violates our hand-written + Go-handler-source-of-truth rule.
- All ops wrapped in `withSpan` via `@opentelemetry/api`. **Skip** —
  adds runtime dep.
- No snapshot / fork pattern changes; `fork` deprecated in favor of
  `create({id})`.

---

## Comparison matrix

| | Handle model | Typed errors | Retries | `waitUntil*` | Transport | Runtime deps |
| --- | --- | --- | --- | --- | --- | --- |
| E2B | class + static factories | yes (rich) | **none** | template-only | REST + gRPC-web | several |
| Daytona | handle, spreads DTO | yes (rich) | **none** (unwired) | yes (adaptive) | axios + WS | many |
| ComputeSDK | manager singleton | **none** | **none** | **none** | per-provider | minimal |
| Modal | handle + process handle | yes (no metadata) | yes (excellent) | yes | gRPC | heavy |
| Cloudflare | get-or-create handle | yes (rich) | 503-only | server-side | HTTP/WS/RPC | 4 |
| CodeSandbox | two-layer handle | **weak** | fixed-delay | yes | REST + WS | many |
| Vercel | flat API client | yes (per-op) | yes (excellent) | n/a | fetch | 2 |
| Tensorlake | static factory + class | yes (rich, ID-stamped) | no jitter, no `Retry-After` | hand-rolled | REST + SSE + WS | 2 |
| Runloop (remote-agents) | bridge (no handle) | discriminant-`code` | single-retry reconnect | n/a | SSE over Axon | peer-dep |
| Morph | rich handle + `branch(N)` | **none** (bare `Error`) | **none** | fixed 1s poll | REST + raw stream | 4 |
| Islo | flat API client | yes (per-status switch) | yes (wrong on POST) | **none** | fetch | zero |
| Blaxel | rich handle | **weak** (one class) | only multipart parts | deprecated `wait()` | REST + H2 + NDJSON | 13 |
| Superserve | rich handle (2-plane) | yes (rich + `BuildError`) | yes (no idempotency split) | yes (poll-driven) | REST + SSE | zero |
| OpenSandbox | adapter facade | **none** (one class) | **none** | hand-rolled `while(true)` | REST + SSE/NDJSON | 2 |
| OpenComputer | static factory | weak (2 named, rest bare) | **none** | n/a | REST + SSE + WS | zero |
| Beam | resource handle + singleton | **weak** (3 message-only) | **none** | busy-poll | axios + WS | 6 |
| **fc-sandbox-sdk** | **handle + factory** | **yes (10 classes)** | **yes (method-aware)** | **yes (adaptive)** | **REST + NDJSON** | **zero** |

---

## What fc-sandbox-sdk borrowed

| Feature in our SDK | Inspired by |
| --- | --- |
| `Sandbox` handle returned by `createSandbox` / `getSandbox` | E2B, Daytona, Modal, CodeSandbox (universal pattern) |
| Handle exposes `status` / `ip` getters over a `SandboxView` | Daytona (DTO-on-handle) |
| Single `.files` namespace, everything else flat on the handle | ComputeSDK (don't over-namespace) |
| `FcError` hierarchy + status→class map + teaching messages | Daytona, E2B, Cloudflare |
| Retry with backoff + jitter, honors `Retry-After` | Vercel |
| Method-aware retry idempotency (POST retried only on 429/503) | Modal (method-aware) + Cloudflare (conservative) |
| `waitUntil*` with adaptive backoff; `createSandbox` auto-waits | Daytona |
| `AbortSignal` composition + per-request timeout | E2B |
| Env-var config (`FC_API_KEY` / `FC_BASE_URL`) | E2B, Daytona, CodeSandbox |
| Versioned `User-Agent` header | Daytona, E2B |
| `previewUrl(port)` helper | Cloudflare (token preview URLs) |
| `exports` map, `sideEffects: false`, ESM-only | Vercel |
| `fc.http` low-level escape hatch | ComputeSDK (`getInstance()`) |
| Streaming surfaced as an async iterator | E2B, Modal |

## Where fc-sandbox-sdk leads

- **Zero runtime dependencies.** Lighter than every SDK surveyed — E2B
  carries a gRPC-web stack, Daytona pulls `axios` + `@aws-sdk/*`, Modal a
  full protobuf toolchain, Cloudflare four packages, CodeSandbox many.
  Ours: none.
- **Retries done correctly.** We beat E2B (none), Daytona (none),
  ComputeSDK (none), CodeSandbox (fixed-delay), and Cloudflare (503-only,
  no jitter). On par with Vercel/Modal — backoff + jitter + `Retry-After`
  — but the policy is *method-aware*: idempotent verbs retry broadly,
  non-idempotent verbs retry only on statuses where the server provably
  did not act.
- **Typed errors with metadata.** A 10-class hierarchy carrying
  `statusCode`, `requestId`, and the parsed envelope — better than
  ComputeSDK (none), CodeSandbox (weak), and Modal (no metadata).
- **`waitUntil*` built in.** E2B and ComputeSDK ship no client-side
  poller at all.
- **Types verified against the server, not the spec.** Wire types are
  checked against the Go control-plane handlers, since the published
  `openapi.yaml` has drifted (see `CLAUDE.md`).
- **Small and readable.** Nine focused modules, each well under 300
  lines — no 6,000-line monolith, no checked-in codegen.

## Deliberate non-goals

- **gRPC / protobuf (Modal).** No DX gain over REST + NDJSON; large build
  and dependency cost.
- **OpenAPI codegen (Vercel).** Overkill for ~12 endpoints. Worth
  revisiting only if the control-plane API grows past ~40 operations.
- **WebSocket data plane (CodeSandbox, Daytona).** The control plane is
  REST + NDJSON only — there is no socket endpoint to consume.
- **Two-layer handle (CodeSandbox).** One handle is enough; there is no
  separate data-plane connection to model.
- **`.git` / `.pty` / code-interpreter namespaces (E2B, Daytona).**
  fc-spawn exposes no such endpoints.
- **CJS build.** ESM-only is a defensible modern choice (Vercel does the
  same). Revisit if consumers need CJS.

---

## Round 2 borrow candidates

Patterns from the 2026-05-28 survey worth backporting into
`fc-sandbox-sdk` — ordered by effort. ✅ marks items shipped in v0.2.1.

### Cheap wins (~10–40 LOC)

- ✅ **`Sandbox.create()` / `Sandbox.connect()` static factories** alongside
  the existing `client.createSandbox()` path — one less concept for
  ad-hoc scripts. Shipped in v0.2.1 (Tensorlake, OpenComputer).
- **`anySignal([...])` AbortSignal composer** — superseded by platform
  `AbortSignal.any()` already in `http.ts:175`. Nothing to do.
- ✅ **Path-aware error mapping** — `FcApiError.resourceId` populated
  from the request path. Shipped in v0.2.1 (Tensorlake).
- ✅ **Sensitive-header / query / userinfo redaction set** — exported as
  `redactHeaders` / `redactUrl` / `redactQuery` for consumers writing
  logging middleware. Shipped in v0.2.1 (Islo).
- ✅ **Runtime-detection `User-Agent` + `X-Fc-Runtime` header** —
  node / bun / deno / workerd / edge-light / browser / react-native.
  Shipped in v0.2.1 (Islo).
- **W3C `traceparent` per request** — deferred; user opted out for
  this batch.
- **+5s buffer on client vs server timeout** — awaits server-side
  `ExecRequest.timeout_ms` field. File a control-plane issue first (Superserve).
- **Idle (not absolute) timeout for streaming reads** — deferred until
  long-poll timeouts become a known pain point (Superserve).
- ✅ **NDJSON parser tolerant of SSE control lines** — `src/ndjson.ts`
  now skips `:` / `event:` / `id:` / `retry:` and strips a `data: `
  prefix. Shipped in v0.2.1 (OpenSandbox).
- ✅ **Body-`code` discriminated errors** — `FcApiError.code` populated
  from `envelope.data.code` for stable machine-readable branching
  without parsing prose (OpenComputer, Islo). Shipped in v0.2.1.
- **Stable error-code prefix parser** — `"<code>: <detail>"` split.
  Subsumed by the body-`code` field above once fc-spawn standardizes
  emitting `code` (Superserve).

### Medium effort (~100–300 LOC)

- **`HttpResponsePromise<T>` dual-API** — keep the current `await`
  shape; add `.withRawResponse()` for users who need `Retry-After` /
  rate-limit headers. Single Promise subclass (Islo).
- **Two-mode `runCommand({onStdout?, onStderr?, signal})`** — collapse
  `runCommand` + `streamCommand` into one method that switches on
  callback presence. Better DX than two methods (Superserve, Blaxel).
- **Async-iterable on `streamCommand` result** for `proc.stdout` /
  `proc.stderr` / `proc.logs` — adds `[Symbol.asyncIterator]()`
  alongside callbacks (Beam, OpenSandbox).
- **Streaming-fetch path** that bypasses the request timeout — current
  `AbortSignal.timeout(timeoutMs)` could kill long streams
  (OpenSandbox).
- **Resource-spec parsers** (`parseCpu`, `parseMemory`, `parseGpu`) so
  callers can pass `"512Mi"` / `"1Gi"` / `"2000m"` / `GpuType.H100`
  uniformly. ~50 LOC each, zero deps (Beam).
- **Enum + literal-union dual typing** for any future enum fields —
  autocomplete + string-literal flexibility (Beam).
- **`Sandbox.fromSession({url, token})` constructor** — same handle
  for owner + shared / preview access. Useful for our future tunnel /
  preview endpoints (Blaxel, Superserve).
- ✅ **`Sandbox.waitForPortReady(port, options?)` via in-sandbox bash
  `/dev/tcp/<host>/<port>`** — defeats the 502-race on fresh VMs
  without a server-side probe. Shipped in v0.2.1 (Tensorlake).
- **Targeted error subclasses for known body `code` values** —
  `FcScalingLockedError` (403 + `code: "scaling_locked"`),
  `FcPlanLimitError` (402). Awaits server-side commitment to a `code`
  taxonomy; the field is already wired (OpenComputer).

### Conditional / awaits server feature

- **Code-interpreter primitive** (`Sandbox.code.run(code, {language,
  context, handlers, signal})`) returning a Jupyter-shaped aggregate
  with mime-bundle `result.raw` — only useful once fc-spawn exposes
  Jupyter execd endpoints (OpenSandbox).
- **`ExecutionEventDispatcher` shared state machine** consumed by both
  `streamCommand` and a future `code.run` — same dispatcher fans out
  to handlers (OpenSandbox).
- **H2 connection pool warming during `createSandbox`** — only matters
  if fc-spawn goes multi-region with edge domains (Blaxel).
- **Sequence-numbered event subscriptions with `afterSequence` resume**
  if FC adds an event bus (Runloop).
- **Multipart upload with parallel parts and transient-marker
  classifier** if FC adds a large-file endpoint (Blaxel).

### Stylistic / testing

- **MSW + chainable mock builder** for tests as the suite outgrows
  `fetch`-option mocking (Islo).
- **`tsconfig.check.json` extending build tsconfig with
  `noEmit: true`** — explicit split for `npm run typecheck` (Runloop).
- **PR-title scope CI gate**
  (`amannn/action-semantic-pull-request`) with explicit scope
  allowlist (Runloop).
- **NPM provenance + OIDC publish** on the release workflow (Runloop).

---

## Server-side ideas worth filing with the control-plane team

These require control-plane changes, not SDK changes alone. File them as
control-plane issues, not SDK issues.

### Snapshot / fork ergonomics

- **`POST /v1/sandboxes/:id/branch` returning `{snapshot,
  sandboxes[]}`** — atomic N-way fork in one round-trip vs N
  client-driven calls (Morph).
- **Stripe-style `metadata` map on snapshots + `GET
  /snapshots?metadata[k]=v` filter** — tag and retrieve, backbone for
  any layering / caching system (Morph).
- **`digest` field on snapshots** — server-side content hash,
  dedupe-on-create. Free idempotency across retries (Morph).
- **Boot a snapshot with different vcpu / mem / disk than capture
  time** (`POST /snapshots/:id/boot` with overrides) — decouples
  capture-time from boot-time sizing (Morph).
- **Named checkpoints registry** — `createCheckpoint(name)` + restore
  by name, plus checkpoint patches as a delta layer (OpenComputer).
- **Live-FS → image conversion** — `POST
  /v1/sandboxes/:id/image-from-filesystem → {image_id}`. Significant
  moat (Beam).
- **Two-stage snapshot ready signal**: `local_ready` (resumable) vs
  `completed` (uploaded / durable). `waitUntil*` callers can return as
  soon as resume is possible without waiting for durable persistence
  (Tensorlake).
- **Resume token rotation** — `POST /v1/sandboxes/:id/resume` mints a
  fresh per-sandbox capability token and invalidates the old one. A
  leaked, long-paused token is auto-revoked (Superserve).

### Lifecycle / cost / cleanup

- **TTL on sandbox create** — `ttl_seconds`, `ttl_action: "stop" |
  "pause"`. Server-side reaper, not client-side cleanup (Morph, Beam).
- **`wake_on_ssh` / `wake_on_http` on paused instances** — auto-resume
  on incoming traffic. Cost vs warmth dial (Morph).
- **`POST /v1/sandboxes/:id/ttl` runtime keep-warm extension**;
  `keep_warm_seconds: -1` for no timeout (Beam).
- **`createIfNotExist` query param** on sandbox create — handles the
  race where two clients try to create the same named sandbox (Blaxel).

### Streaming / exec ergonomics

- **Single `/v1/sandboxes/:id/run` SSE / NDJSON endpoint** emitting
  typed-event frames `{type: "stdout" | "stderr" | "result", data}`
  plus a final `{exit_code | signal}` — replaces start-process +
  follow-stdout + follow-stderr + poll-pid (Tensorlake, Blaxel).
- **Jupyter-style execd endpoints** (`POST /code` SSE stream, `POST
  /code/context`, `GET / DELETE /code/contexts`) with mime-bundle
  `result.results` map (`text/plain`, `text/html`, `image/png`,
  `application/json`). Renders charts / dataframes natively in chat
  UIs (OpenSandbox).
- **Bash session lifecycle** — `POST /session`, `POST /session/:id/run`
  (SSE), `DELETE /session/:id`. Persists env / cwd between commands;
  cheaper than spawning a fresh container shell each call
  (OpenSandbox).
- **`execution_count` + `execution_complete{execution_time}` events**
  for REPL parity (OpenSandbox).

### Networking / preview

- **`POST /v1/sandboxes/:id/network/update {block_network,
  allow_list[]}`** runtime CIDR allowlist mutation (Beam).
- **`GET /v1/sandboxes/:id/urls` → `{port: url}`** convenience listing
  of all exposed ports (Beam).
- **Preview URLs as first-class resources** — per-port lifecycle +
  optional auth config + custom domains. Beyond the current static
  `ingress_url_template` (OpenComputer).
- **WS-Upgrade TCP tunnel endpoint** — keyed forwarding
  (`/v1/tunnels/tcp?port=N`), complementing the unkeyed unmodeled
  `tunnel/:port` (Tensorlake).
- **SSH key rotation endpoint** — `instance.sshKeyRotate()` regenerates
  and returns a fresh keypair (Morph).

### Event bus / observability

- **Sequence-numbered event records + `after_sequence=N` query param
  on streaming endpoints** — clients resume by passing the last
  sequence they saw. Strictly better than "tail from now" for
  reconnect / multi-client / late-joiners (Runloop).
- **Typed system event taxonomy** (`turn.started`, `devbox.{running,
  suspended, shutdown, failed}`, `broker.error`, ...) instead of raw
  log lines (Runloop).
- **W3C `traceparent` honored end-to-end** so the SDK's returned
  `traceId` pivots straight into server APM traces (Tensorlake).
- **`API-Version: YYYY-MM-DD` date header** — Stripe-style API
  pinning; SDK upgrades don't break old clients (Blaxel).

### Error contract

- **Stable `code` field on every error response** — typed SDK error
  mapping is trivial when the server always sends a known string code,
  not just an HTTP status (Islo).
- **Build error envelope** `{code, build_id, template_id, message}`
  rather than free-form prose (Superserve).
- **`402 PlanLimit` / `403 scaling_locked` as discrete error codes**
  with structured `{code, error}` body (OpenComputer).

### Resource spec ergonomics

- **Accept `cpu: 2 | "2" | "2000m"`, `memory: "512Mi" | "1Gi" | "2GB"
  | number`, `gpu: "H100" | ["A100", "H100"]`** on create — server
  normalizes to canonical wire form. Friendlier DX than strict numeric
  (Beam).
- **Volumes API** — `POST /v1/volumes {name, mount_path}` →
  `{volume_id}`; sandbox create accepts `volumes: [{id, mount_path}]`
  (Beam).
- **Per-language preinstalled image** (Python / Node / Go / Java) —
  template catalog entry for code-interpreter workloads (OpenSandbox).

### Data plane / blast radius

- **Two-plane URL design** — `boxd-{id}.sandbox.example.com` data
  plane with per-sandbox capability tokens; master API key never
  touches file / exec paths. Limits leak blast radius (Superserve).
- **Signed download / upload URLs** for file paths inside a sandbox —
  presigned S3-style, time-bound; browsers PUT / GET without an API
  key (OpenComputer, Morph).
- **In-sandbox grep**: `POST /v1/sandboxes/:id/files/find` returning
  ranges (Beam).
- **Object cache by content hash**: `HEAD
  /v1/gateway/objects/:hash` → presigned upload PUT — dedupe multipart
  sync across sandboxes in one workspace (Beam).
