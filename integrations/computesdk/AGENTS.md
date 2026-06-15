# AGENTS.md — `integrations/computesdk/`

Guidance for AI agents and contributors working **in this directory**. This
is a self-contained nested package inside the `createos-sandbox-sdk` repo; it does
**not** inherit the root SDK's build, test, or lint pipeline. For the parent
SDK's conventions see the repo-root `AGENTS.md` — but note the exceptions
below, which deliberately diverge from it.

## What this is

`@computesdk/createos-sandbox` — a [ComputeSDK](https://github.com/computesdk/computesdk)
provider that exposes NodeOps' createos-sandbox Firecracker microVM sandboxes through
ComputeSDK's unified provider interface. It is a **thin adapter over the
parent `createos-sandbox-sdk`** (imported as a sibling via `file:../..`), built with
`@computesdk/provider`'s `defineProvider` factory.

`src/index.ts` is the whole implementation. It wraps an `CreateosSandboxClient` + `Sandbox`
handle and bridges the semantic gaps between createos-sandbox and ComputeSDK.

## Relationship to the parent SDK

- **This is a staging / dev copy.** The package's real upstream home is the
  ComputeSDK monorepo — `package.json` `repository.directory` points at
  `packages/createos-sandbox`. It lives here so it can be developed against
  the unreleased local `createos-sandbox-sdk` before that SDK version is published.
- **The dep `createos-sandbox-sdk: "file:../.."` resolves to the parent repo's
  `dist/`.** You must `bun run build` at the repo root **first**, or imports
  fail. The published npm `createos-sandbox-sdk` lags the local source; until the
  matching version is on npm, keep the `file:` link.
- This package carries a **runtime dependency** (`@computesdk/provider`). That
  is intentional and scoped to this directory — it does **not** relax the
  parent SDK's zero-runtime-deps rule, which still applies to `src/` at the
  repo root.

## Tooling is NOT gated by the repo-root pre-commit

The root `.pre-commit-config.yaml` typecheck / test hooks are project-scoped
(`tsc` over `src/**`, `bun test tests/`) and **skip this subdir**. Root
`oxlint` / `oxfmt` are explicitly `exclude: '^integrations/'` so the SDK's JS
ruleset never governs this package — only gitleaks and the whitespace fixers
run repo-wide here. **Run this package's own gates manually** from this
directory:

```sh
bun install        # installs @computesdk/provider + resolves file:../..
bun run typecheck  # tsc --noEmit
bun run test       # vitest run (mock mode when no creds set)
bun run build      # tsup -> dist/
bun run lint       # oxlint .
```

`node_modules/` and `dist/` here are gitignored by this directory's own
`.gitignore` — never commit them.

## Tests

`src/__tests__/` uses **Vitest** (not the parent repo's `bun:test`).

- `index.test.ts` — ComputeSDK conformance suite via `@computesdk/test-utils`.
  Runs in **mock mode** with no credentials (no live API).
- `integration.test.ts` / `snapshot.integration.test.ts` — live conformance
  against a real control plane. **Skipped unless `CREATEOS_SANDBOX_API_KEY` (and
  `CREATEOS_SANDBOX_BASE_URL`) are set.** Never hardcode a live host — all hosts come
  from env; committed examples use `createos-sandbox.example.com` placeholders.

## How the adapter maps the two models

- **Shapes, not free-form sizing — fetched live, never hardcoded.** createos-sandbox
  sizes VMs from a shape catalog. `create()` fetches it via
  `client.listShapes()` (`GET /v1/shapes`) and `pickShape()` maps
  `cpus`/`memoryMb` onto the smallest fit. The catalog is sorted client-side
  first (the server gives no ordering guarantee). An explicit `shape` /
  `config.shape` overrides and **skips the fetch**, so the explicit path never
  depends on `/v1/shapes`. With no size pinned, `defaultShape()` picks the
  smallest live shape meeting `DEFAULT_SHAPE_MIN_MIB` — a policy floor, the one
  shape constant that can't be server-derived (the CP names no default and
  `shape` is required). Do **not** reintroduce a hardcoded shape table or a
  hardcoded disk-size menu: `ephemeralDiskMb` passes straight through to
  `disk_mib` (the CP validates; `0`/omitted = the shape's default disk).
- **Snapshot = pause.** createos-sandbox has no decoupled snapshot object.
  `snapshot.create` pauses the sandbox; the paused sandbox id **is** the
  snapshot id. `create({ snapshotId })` forks that paused bundle.
- **Per-command env/cwd are synthesised.** The control plane sets env at
  sandbox create time and drops per-exec env, so `runCommand` env/cwd are
  emulated by wrapping the command in an inline `bash -lc` script.
- **`getInstance()` is the escape hatch.** It returns the native
  `createos-sandbox-sdk` `Sandbox` handle, exposing the full stateful API
  (pause / resume / fork / disks / networks / bandwidth) that ComputeSDK's
  core surface does not model. Reach for it when a feature isn't in the
  portable interface.

## Changing the adapter

If the parent `createos-sandbox-sdk` public surface changes (renamed method, new
option, changed wire type), reconcile `src/index.ts` against it and re-run
`bun run build` at the repo root before this package's `bun run typecheck`.
Keep the `defineProvider` method set in sync with `@computesdk/provider`'s
current `ProviderSandboxManager` / `ProviderTemplateManager` /
`ProviderSnapshotManager` contracts.
