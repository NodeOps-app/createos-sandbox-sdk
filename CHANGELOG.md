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
