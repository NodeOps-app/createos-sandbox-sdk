# AGENTS.md

Guidance for AI agents and human contributors working **in** this
repository. Building something **with** the SDK? Start with `README.md`,
the `docs/` guides, `examples/`, and `llms.txt` instead — those are the
consumer-facing docs.

## What this is

`createos-sandbox-sdk` — the TypeScript SDK for the `createos-sandbox` microVM sandbox
control plane. A hand-written HTTP client: **zero runtime dependencies**,
ESM-only, built with `tsc`. The control plane itself is a separate service
maintained by the NodeOps team; this repository is the client SDK only.

Design rationale — why the handle model, the retry policy and the
deliberate non-goals — lives in `docs/explanation/` (the microVM model,
handle model, lifecycle, and reliability pages). The internal competitive
analysis of other sandbox SDKs is **not** in this public repo; it lives in
the private `fc` control-plane repo at `docs/sdk-analysis.md`.

## Commands

```sh
bun run build      # tsc -> dist/
bun run typecheck  # tsc --noEmit (src)
bun run typecheck:examples  # tsc -p examples/tsconfig.json (typechecks examples/)
bun run lint       # oxlint
bun run fmt        # oxfmt (writes); fmt:check to verify, lint:fix to autofix
bun test           # bun test tests/*.test.ts (coverage gated by bunfig.toml)
bun run docs:gen   # regenerate examples index (incl. docs/examples.md), llms.txt + llms-full.txt
```

`tsc` is the type gate. `oxlint` + `oxfmt` lint and format code only —
`oxfmt` skips Markdown (README/docs are hand-wrapped prose). Commits are
gated by `.pre-commit-config.yaml` (oxlint, oxfmt, gitleaks, `tsc
--noEmit` for `src`, tests and `examples`, `bun test` with the coverage
floor, and the docs-sync check); install once with `pre-commit install`.

**Always use `bun`** — not `node`, `npm`, or `npx` — to run scripts,
tests, and tooling.

## Module layout (`src/`)

| File | Responsibility |
| --- | --- |
| `index.ts` | Public exports. Anything not re-exported here is internal. |
| `client.ts` | `CreateosSandboxClient` — entry point; catalog, identity, sandbox factory, `TemplatesApi`, `NetworksApi`, `DisksApi`. |
| `sandbox.ts` | `Sandbox` handle + `SandboxFiles`. Owns a sandbox id; all per-sandbox operations live here. |
| `http.ts` | `CreateosSandboxHttp` transport — URL building, auth, JSend unwrapping, retries, timeouts, `AbortSignal` composition. |
| `errors.ts` | `CreateosSandboxError` hierarchy + `errorFromResponse` status→class mapping. |
| `poll.ts` | `pollUntil` (adaptive backoff) + `sleep`. Backs the `waitUntil*` helpers. |
| `config.ts` | `resolveConfig` — merges options, env vars, defaults. Holds `VERSION`. |
| `types.ts` | All wire types and option interfaces. |
| `ndjson.ts` | NDJSON stream parser. Tolerates SSE control lines (`data:` / `event:` / `id:` / `retry:` / `:comment`). |
| `runtime.ts` | Feature-detects node/bun/deno/workerd/edge-light/browser/react-native; tags `User-Agent` and `X-Fc-Runtime`. |
| `redact.ts` | Pure helpers (`redactHeaders` / `redactUrl` / `redactQuery`) for logging middleware; never wired into the SDK transport. |

Data flow: `CreateosSandboxClient` → `CreateosSandboxHttp` (transport) → returns `Sandbox` handles.
`Sandbox` holds an `CreateosSandboxHttp` reference, never the client.

## Conventions

- **Zero runtime dependencies.** Do not add runtime deps. `devDependencies`
  is build/lint tooling only (`typescript`, `oxlint`, `oxfmt`, `typedoc`).
- **`exactOptionalPropertyTypes` is on.** Spread option objects
  (`{ ...options }`) rather than constructing literals with possibly-
  `undefined` scalar values.
- **Always use `bun`** — not `node`, `npm`, or `npx`.
- Files stay under ~1100 lines.
- Keep `VERSION` in `config.ts` in sync with `package.json` `version`.
- The Sandbox command method is `runCommand` / `streamCommand`, not
  `exec` — a global security hook false-positives on the token `exec`
  followed by `(`. Avoid that literal in source and docs.
- **Keep `examples/` in sync.** Whenever a public-surface change lands in
  `src/` (new/renamed/changed method, new option, removed export, new
  helper worth showcasing), grep `examples/` for the affected symbol and
  update the affected example(s). Drive the check from the diff, not from
  memory. Skip only when the change is purely internal.
- **The example index is generated.** `examples/manifest.json` is the
  single source of truth for the example catalog. The table in
  `examples/README.md`, the example list in `llms.txt`, and the whole of
  `docs/examples.md` (capability-bucketed from the manifest) are generated
  from it by `bun run docs:gen` (and verified in CI / pre-commit via
  `bun run docs:check`). Edit the manifest, then regenerate — never hand-
  edit the generated regions or `docs/examples.md`.
- **`llms-full.txt` bundles the whole `docs/` corpus.** Its file list is
  `LLMS_FULL_DOCS` in `scripts/gen-docs.mjs`. When you add a new page under
  `docs/`, add it to that list (and link it from `llms.txt`) or it is left
  out of the bundle; then run `bun run docs:gen`. Avoid the literal `exec(`
  token in docs — the security hook above false-positives on it.

## Wire types — source of truth

`types.ts` is the source of truth for the JSON wire format in this repo;
it mirrors the `createos-sandbox` control plane's HTTP API. The control plane is a
separate service — contributors with access reconcile these types against
its handlers; its published OpenAPI spec is **stale** and must not be
trusted over the live server behavior.

`COMPATIBILITY.md` records the `createos-sandbox` control-plane version the SDK
was last reconciled against, plus the known wire drift and coverage gaps
at that point. Update it whenever you re-reconcile against a newer
`createos-sandbox` `main`.

Known drift to watch for: the spec has omitted `node_selector`,
`ingress_enabled`, `ingress_url_template`, and `ingress_bytes`, and has
described `getTemplateLogs` incorrectly. Verify every type against the
live API, not the spec.

When a server field is `omitempty`, the TS field is optional (`?`) and not
`| null` — `omitempty` omits the key entirely.

**List endpoints are paginated.** Every list route (`sandboxes`, `disks`,
`networks`, `templates`, `hosts`, `shapes`, per-sandbox `disks`) returns a
doubly-nested envelope `{ data: { data: [...], pagination: { total, limit,
offset, count } } }`; `rootfs` is the lone exception (plain view). Fetch
all pages with `CreateosSandboxHttp.fetchAllPages` (accepts the paginated envelope, the
legacy `{ <key>: [...] }` wrapper, and a bare array). The server clamps
`limit` to **500** — drive paging by the reported `total` and the actual
item count, never the requested page size. `bandwidth_quota_bytes` is not
settable at create (server `400`s a non-zero value); grow it post-create
with `Sandbox.rechargeBandwidth()`.

## Retry policy

`CreateosSandboxHttp` retries with exponential backoff + jitter and honors
`Retry-After`. Idempotent methods (`GET/HEAD/PUT/DELETE`) retry on network
errors and `408/500/502/503/504`. Non-idempotent methods retry only on
`429/503` — statuses where the server provably did not process the
request. Streaming requests are never retried.

## Adding an endpoint

1. Confirm the exact path, method, request/response shapes, and status
   codes against the control-plane API.
2. Add or correct the wire types in `types.ts`.
3. Add the method — on `CreateosSandboxClient` for catalog/cross-sandbox operations, on
   `Sandbox` for per-sandbox operations, or on `TemplatesApi` /
   `NetworksApi` / `DisksApi`.
4. Use `http.request` for JSend endpoints, `http.requestRaw` for
   binary / text responses, `http.stream` for NDJSON.
5. Add a test under `tests/` (one file per module). See `tests/CLAUDE.md`.
6. If the public surface changed, update `examples/` and the
   `examples/manifest.json` catalog, then run `bun run docs:gen`.

## Testing

`tests/*.test.ts` use `bun:test` (`describe` / `test` / `expect`) and
import the SDK **source** directly (`../src/*.ts`) — no build step before
tests. `fetch` is mocked via the `fetch` client option; there is no live
server. One file per module, with shared fixtures in `tests/helpers.ts`.
Coverage runs on every `bun test` and is floor-gated by
`coverageThreshold` in `bunfig.toml` — raise the floor as the suite grows;
never lower it to make a run pass. Full test conventions live in
`tests/CLAUDE.md`.

Because tests hit `src/` instead of the built `dist/`, the packaging
artifact is not exercised by the suite. Add a separate `dist/` smoke test
if a build-output regression is a concern.

## Not modeled

`POST /v1/sandboxes/:id/tunnel/:port` (keyless port-forward) is an
HTTP-Upgrade endpoint and is intentionally not exposed — it needs a raw
socket, not `fetch`.
