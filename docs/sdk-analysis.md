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
