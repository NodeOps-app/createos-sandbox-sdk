# Changelog

All notable changes to `fc-sandbox-sdk` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

## Deprecation policy

- Anything re-exported from `src/index.ts` is part of the public API.
- We are pre-1.0, so the API is allowed to break in MINOR bumps —
  breaking changes ship as MINOR, and PATCH releases are bug-fix only.
- Where possible, breaking changes are announced one minor before
  removal: the old surface keeps working, the type gains a
  `@deprecated` JSDoc tag, and the CHANGELOG points at the replacement.
- Behavioural and naming changes that have no compatible bridge ship as
  a single MINOR bump with a `BREAKING CHANGE` section in this file
  and the matching commit footer.

## [Unreleased]

## [0.6.0] — 2026-06-10

Reconciled against the `fc-spawn` control plane at `main` `159bbb0`
(two passes: `12ed1a7` response-structure changes, server PRs #219/#364,
then idle auto-pause + credit gating) — see `COMPATIBILITY.md`.

### Changed

- **List endpoints are paginated and now return every page.** The
  control plane switched all list routes to a paginated envelope
  (`{ data: { data, pagination } }`). `templates.list`, `disks.list`,
  `networks.list`, `listShapes`, `listHosts`, `listSandboxes`, and
  `Sandbox.listDisks` transparently walk every page and return the full
  result set (new internal `FcHttp.fetchAllPages`, which still accepts
  the legacy `{ <key>: [] }` wrapper and a bare array).

### Added

- `SandboxView.ingress_url_template?` — the sandbox view now carries the
  ingress URL template (server addition), not just the create response.
- **Idle auto-pause.** `CreateSandboxRequest.auto_pause_after_seconds?`
  (60–86400 s, validated server-side), `SandboxView
  .auto_pause_after_seconds?` (absent when disabled), and
  `PatchSandboxRequest.auto_pause_after_seconds?` /
  `.disable_auto_pause?`. New `Sandbox.setAutoPause(seconds | null)`
  sets or clears the timeout and refreshes the handle from the patched
  view.
- `FcPaymentRequiredError` — the control plane now gates cost-incurring
  actions (sandbox create / resume / fork, bandwidth recharge, disk /
  network / template create) on a positive credit balance and returns
  `402 Payment Required` when the account is out of credit.
  `errorFromResponse` maps 402 to the new class (previously the generic
  `FcApiError`).

### Fixed

- `previewUrl()` now works on any handle that knows its ingress template —
  `connect()` / `getSandbox()` / `listSandboxes()`, not just `create()` —
  by reading the template from the canonical sandbox view instead of a
  create-time-only cache. Re-enabling ingress via `setIngress(true)` now
  repopulates the template (previously a documented one-way limitation).
- `readyz()` no longer reports `{ ready: false }` for unexpected error
  statuses. Only `200` (ready) and `503` (not ready) are treated as
  readiness signals; any other non-OK status now throws the typed
  `FcApiError`, matching the documented contract.
- Observability hooks are now truthful and consistent. The request is built
  once (one canonical URL/headers/body), so `onRequest` / `onResponse`
  report the headers actually sent — including the `Content-Type` set for a
  request body, previously missing from the hook payload. `stream()` now
  fires the same `onRequest` / `onResponse` hooks as buffered requests.

### BREAKING CHANGE

- **`CreateSandboxResponse.mode` removed** along with the
  `SandboxSpawnMode` type — the server dropped `mode` from the create
  response (it was an operational boot-path detail). Read the sandbox
  status from the handle instead.
- **`CreateSandboxRequest.bandwidth_quota_bytes` removed** — the server
  now rejects a non-zero value at create (`400`) and stamps the cluster
  default. Grow the quota after create with
  `Sandbox.rechargeBandwidth(addBytes)`. The field stays on
  `ForkSandboxRequest` (still accepted on fork).
- **`listSandboxes()` default changed from one page (≤50) to all rows.**
  `listSandboxes({ limit })` now treats `limit` as a cap on the number
  of handles returned. A bare `await fc.listSandboxes()` walks every
  page — pass `limit` to bound it.

## [0.5.0] — 2026-06-03

Reconciled against the `fc-spawn` control plane at `main` `52ea6c9` —
see `COMPATIBILITY.md`.

### Added

- `Sandbox.addSSHPubkeys(keys, options?)` — adds OpenSSH public keys to a
  live sandbox (`POST /v1/sandboxes/:id/ssh-pubkeys`) and returns the
  total `ssh_pubkeys` count. Previously keys could only be set at
  `createSandbox` / `fork` time. Adds the `AddSSHPubkeysRequest` /
  `AddSSHPubkeysResponse` wire types.
- `DisksApi.rotateCredentials(idOrName, credentials, options?)` — rotates
  a registered S3 disk's access/secret key (`PATCH /v1/disks/:id`) and
  returns the updated `DiskView`.
- `CreateSandboxRequest.region` — optional region pin at create time.
  Must equal the control plane's own region (no cross-region routing);
  omit to use the server default.
- `Shape.cpu_quota_pct` — the catalog now surfaces a shape's cgroup v2
  CPU-cap percent when set (`omitempty`; absent = unlimited).

### Changed

- **BREAKING:** `SandboxView.ip` is now optional (`ip?: string`). The
  control plane omits `ip` (`omitempty`) while a sandbox is still
  `creating`, so the previous required type could surface `undefined` at
  runtime. Read it as `sandbox.ip ?? …`, or wait for `running` before
  relying on it.
- **BREAKING (types):** response fields that the server sends `omitempty`
  are now optional to match the wire contract — `HostPublic.rootfses?`,
  `NetworkMember.ip?`, and `NetworkMember.name?`. Reading them may yield
  `undefined`.

## [0.4.0] — 2026-06-03

### Added

- `Sandbox.sh(script, options?)` — runs `bash -lc <script>` and throws
  `FcError` on a non-zero exit (or agent start error), surfacing the
  optional `label`, the exit code, the run duration and the tail of
  stdout/stderr. The throw-on-failure counterpart to `runCommand`.
- `Sandbox.previewUrl(port, { scheme })` — optional `scheme` override
  (`"http"` | `"https"`, default `"https"`) for ingress hostnames whose
  TLS certificate has not been provisioned yet.
- `pollUntil`, `sleep` and the `PollOptions` type are now exported — the
  adaptive-backoff poller that backs the `waitUntil*` helpers, for
  building custom wait loops.

### Changed

- **BREAKING:** a base URL is now required. `FcClient` / `resolveConfig`
  no longer fall back to a built-in default control plane — pass `baseUrl`
  or set the `FC_BASE_URL` environment variable, otherwise construction
  throws. The previous fallback pointed at a non-public host.

### Docs

- Prepared the repository for public release: added `AGENTS.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR
  templates, and a machine-readable `examples/manifest.json`.
- The example catalog in `examples/README.md` and `llms.txt`, plus the
  `llms-full.txt` bundle, are generated from the manifest
  (`bun run docs:gen`; verified by `bun run docs:check`).
- Completed TSDoc coverage across the exported wire types and entry-point
  classes.

## [0.3.0] — 2026-05-28

### Added

- `FcApiError.endpoint` and `FcApiError.method` — every HTTP error now
  carries the request pathname and verb so support tickets and
  structured logs can pin the failure to its exact call site.
- `FcApiError.requestId` now also reads `X-Fc-Request-Id` in addition
  to `X-Request-Id`.
- `ClientHooks` (`onRequest`, `onResponse`, `onRetry`) on `FcClient`
  for zero-dependency observability. Payloads are pre-redacted through
  the existing `redact.ts` helpers; a throw inside a hook is caught and
  warned rather than propagated.
- `ExecStreamFrame` — the raw NDJSON frame shape, exported for
  advanced users who want to bypass the discriminated-union projection.
- `ErrorRequestContext` — the optional context bag accepted by every
  `FcApiError` constructor and `errorFromResponse`.
- `AttachDiskOptions` / `DetachDiskOptions` interfaces.
- Full JSDoc coverage on the public surface (TypeDoc-ready).

### Changed

- **BREAKING:** `Sandbox.streamCommand` now yields a discriminated
  union (`{ type: "stdout" | "stderr" | "exit" | "error" | "heartbeat", ... }`)
  instead of the flat `{ stdout?, stderr?, exit_code?, ... }` shape.
  Switch on `event.type`. The wire format is unchanged — only the SDK
  projection differs.
- **BREAKING:** `Sandbox.attachDisk` and `Sandbox.detachDisk` take a
  single options object (`{ diskId, mountPath, subPath? }`) instead of
  positional arguments. The previous signature was a v0.2 addition; no
  bridge is kept.

## [0.2.1] — 2026-05-28

### Added

- S3-backed disks: `client.disks` API, `Sandbox.attachDisk` /
  `detachDisk` / `listDisks`, and `disks` field on
  `CreateSandboxRequest`.
- Runtime detection (`detectRuntime`, `runtimeTag`) — User-Agent and
  `X-Fc-Runtime` headers carry the host runtime.
- Header / URL / query redaction helpers (`redactHeaders`,
  `redactUrl`, `redactQuery`) for logging middleware.
- Server-Sent-Events control-line tolerance in the NDJSON parser.
- `Sandbox.waitForPortReady` for opportunistic readiness polling.

### Changed

- Authentication header switched from `Authorization: Bearer` to
  `X-Api-Key`, matching the control plane.

## [0.2.0] — 2026-05-23

### Added

- Stateful `Sandbox` handle returned by every factory.
- `TemplatesApi`, `NetworksApi`.
- Typed error hierarchy with status-mapped subclasses.
- Retry policy with exponential backoff + jitter, `Retry-After` honoured.
- Per-request timeout + `AbortSignal` composition.

## [0.1.x]

- Initial proof-of-concept transport. Not documented.
