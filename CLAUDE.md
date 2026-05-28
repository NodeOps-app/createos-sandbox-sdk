# CLAUDE.md

Guidance for working in this repository.

## What this is

`fc-sandbox-sdk` — the TypeScript SDK for the `fc-spawn` microVM sandbox
control plane. A hand-written HTTP client: **zero runtime dependencies**,
ESM-only, built with `tsc`.

Design rationale — why the handle model, the retry policy and the
deliberate non-goals — and a competitive analysis of seven other sandbox
SDKs live in `docs/sdk-analysis.md`.

our sandbox service source code @../fc. if you find any issue in sandbox server side, create github issue in git repo @../fc

## Commands

```sh
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm run lint       # oxlint
npm run fmt        # oxfmt (writes); fmt:check to verify, lint:fix to autofix
npm test           # bun test tests/*.test.ts (coverage gated by bunfig.toml)
```

`tsc` is the type gate. `oxlint` + `oxfmt` lint and format code only —
`oxfmt` skips Markdown (README/docs are hand-wrapped prose). Commits are
gated by `.pre-commit-config.yaml` (oxlint, oxfmt, gitleaks, `tsc --noEmit`,
and `bun test` with the coverage floor); install once with
`pre-commit install`.

## Module layout (`src/`)

| File | Responsibility |
| --- | --- |
| `index.ts` | Public exports. Anything not re-exported here is internal. |
| `client.ts` | `FcClient` — entry point; catalog, identity, sandbox factory, `TemplatesApi`, `NetworksApi`. |
| `sandbox.ts` | `Sandbox` handle + `SandboxFiles`. Owns a sandbox id; all per-sandbox operations live here. |
| `http.ts` | `FcHttp` transport — URL building, auth, JSend unwrapping, retries, timeouts, `AbortSignal` composition. |
| `errors.ts` | `FcError` hierarchy + `errorFromResponse` status→class mapping. |
| `poll.ts` | `pollUntil` (adaptive backoff) + `sleep`. Backs the `waitUntil*` helpers. |
| `config.ts` | `resolveConfig` — merges options, env vars, defaults. Holds `VERSION`. |
| `types.ts` | All wire types and option interfaces. |
| `ndjson.ts` | NDJSON stream parser. Tolerates SSE control lines (`data:` / `event:` / `id:` / `retry:` / `:comment`). |
| `runtime.ts` | Feature-detects node/bun/deno/workerd/edge-light/browser/react-native; tags `User-Agent` and `X-Fc-Runtime`. |
| `redact.ts` | Pure helpers (`redactHeaders` / `redactUrl` / `redactQuery`) for logging middleware; never wired into the SDK transport. |

Data flow: `FcClient` → `FcHttp` (transport) → returns `Sandbox` handles.
`Sandbox` holds an `FcHttp` reference, never the client.

## Wire types — source of truth

`types.ts` mirrors the Go control plane's JSON wire format. The
authoritative definitions live in the **sibling `fc` repo**, in priority
order:

1. `../fc/internal/control/*.go` — the control-plane HTTP handlers the
   SDK actually calls (`server.go`, `pause_handlers.go`, `templates.go`,
   `networks.go`).
2. `../fc/internal/api/types/{request,response,errors}.go` — shared
   request/response structs.

`../fc/openapi.yaml` is **stale** — do not trust it over the Go code.
Known drift: it omits `node_selector`, `ingress_enabled`,
`ingress_url_template`, `ingress_bytes`, and describes `getTemplateLogs`
incorrectly. Verify every type against the Go handlers.

When a Go field is `omitempty`, the TS field is optional (`?`) and not
`| null` — `omitempty` omits the key entirely.

## Conventions

- **Zero runtime dependencies.** Do not add runtime deps. `devDependencies`
  is build/lint tooling only (`typescript`, `oxlint`, `oxfmt`).
- **`exactOptionalPropertyTypes` is on.** Spread option objects
  (`{ ...options }`) rather than constructing literals with possibly-
  `undefined` scalar values.
- **Always use `bun`** — not `node`, `npm`, or `npx` — to run scripts,
  tests, and tooling.
- Files stay under ~1100 lines.
- Keep `VERSION` in `config.ts` in sync with `package.json` `version`.
- The Sandbox command method is `runCommand` / `streamCommand`, not
  `exec` — a global security hook false-positives on the token `exec`
  followed by `(`. Avoid that literal in source and docs.
- **Keep `examples/` in sync.** Whenever a public-surface change lands
  in `src/` (new method, renamed method, changed signature, new option,
  removed export, new helper worth showcasing), grep `examples/` for
  the affected symbol and update the affected example(s). Drive the
  check from the diff, not from memory. Skip only when the change is
  purely internal (private fields, retry timing, internal helpers).

## Retry policy

`FcHttp` retries with exponential backoff + jitter and honors
`Retry-After`. Idempotent methods (`GET/HEAD/PUT/DELETE`) retry on
network errors and `408/500/502/503/504`. Non-idempotent methods retry
only on `429/503` — statuses where the server provably did not process
the request. Streaming requests are never retried.

## Adding an endpoint

1. Read the Go handler in `../fc/internal/control/` to learn the exact
   path, method, request/response shapes, and status codes.
2. Add or correct the wire types in `types.ts`.
3. Add the method — on `FcClient` for catalog/cross-sandbox operations,
   on `Sandbox` for per-sandbox operations, or on `TemplatesApi` /
   `NetworksApi`.
4. Use `http.request` for JSend endpoints, `http.requestRaw` for
   binary / text responses, `http.stream` for NDJSON.
5. Add a test in `tests/client.test.mjs`.

## Testing

`tests/*.test.ts` use `bun:test` (`describe` / `test` / `expect`) and
import the SDK **source** directly (`../src/*.ts`) — no build step before
tests. `fetch` is mocked via the `fetch` client option; there is no live
server. One file per module (`http`, `sandbox`, `client`, `templates`,
`networks`, `disks`, `files`, `ndjson`, `config`, `poll`, `redact`,
`runtime`), with shared fixtures in `tests/helpers.ts`. Use a fast `retry`
config (`{ baseDelayMs: 1, maxDelayMs: 5 }`, or the `FAST_RETRY` helper) in
retry tests to keep them quick. Coverage runs on every `bun test` and is
floor-gated by `coverageThreshold` in `bunfig.toml` — raise the floor as
the suite grows; never lower it to make a run pass.

Because tests now hit `src/` instead of the built `dist/`, the packaging
artifact is no longer exercised by the suite. Add a separate `dist/`
smoke test if a build-output regression is a concern.

## Not modeled

`POST /v1/sandboxes/:id/tunnel/:port` (keyless port-forward) is an
HTTP-Upgrade endpoint and is intentionally not exposed — it needs a raw
socket, not `fetch`.
