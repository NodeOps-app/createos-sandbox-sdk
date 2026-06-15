# Compatibility checkpoint

This file records the `fc-spawn` control-plane version this SDK has been
reconciled against, and the known wire gaps at that point. The control
plane is a separate service; its published OpenAPI spec is stale, so this
checkpoint is verified against the live server behavior, never the spec.
See `AGENTS.md` → "Wire types — source of truth".

## Checkpoint

| | |
| --- | --- |
| SDK version | `0.6.0` |
| fc-spawn branch | `main` |
| Audited | 2026-06-12 (live-behavior audit; no wire change since the prior pass) |

**What "compliant" means here:** every endpoint the SDK *models* is
wire-faithful to the server at the audit above — field names, types, and
`omitempty` → optional mapping — except for the known drift listed below.
Endpoints the SDK does not model (next two sections) are a coverage
choice, not a fidelity failure, and do not move this checkpoint.

## Endpoints not modeled

`POST /v1/sandboxes/:id/tunnel/:port` — keyless port-forward (HTTP
Upgrade) — is a documented deliberate non-goal (`AGENTS.md` → "Not
modeled"): it needs a raw socket, not `fetch`.

Two more endpoints are interactive PTYs, neither modeled yet:

- `POST /v1/sandboxes/:id/shell` — PTY over HTTP Upgrade. Same hard
  blocker as `tunnel`: `fetch` cannot hand back the upgraded socket, so
  this is effectively a permanent non-goal for a fetch-only transport.
- `GET /v1/sandboxes/:id/shell-ws` — PTY over WebSocket. This one **is**
  reachable with zero dependencies via the global `WebSocket`
  (browser / Deno / Bun / workerd / Node 22+). It is a duplex,
  event-driven surface unlike the request / stream model, so it is a
  candidate for a future, separately designed addition rather than a
  permanent non-goal.

`Sandbox.sh()` is a `bash -lc` convenience over `/exec`; it is **not** the
PTY shell above.

## Wire behavior surfaced to callers

The current state of the server contract the SDK depends on. Operator-
only surface (host enrolment, certificate management, internal billing,
and other admin controls) is excluded from the SDK by design and is not
tracked here.

- **Ownership checks return 404, not 402.** `PUT .../egress`,
  `POST .../bandwidth/recharge`, and the file upload / download routes
  return `404 "sandbox not found"` (JSend `fail`) for a sandbox the
  caller does not own. The SDK maps 404 → `FcNotFoundError`. On
  `recharge`, the owner check precedes the credit gate, so a non-owned id
  yields 404 rather than 402.
- **Idle auto-pause.** `auto_pause_after_seconds` (`*int`, `omitempty` →
  optional) is accepted on create and patch and returned on
  `SandboxView`, alongside a `disable_auto_pause` bool (clears the
  nullable timeout — `omitempty` can't express "set to null"). Valid
  range 60–86400, server-validated. SDK: fields on
  `CreateSandboxRequest` / `SandboxView` / `PatchSandboxRequest`, plus
  `Sandbox.setAutoPause(seconds | null)`.
- **Credit gating (402).** Cost-incurring endpoints (sandbox create /
  resume / fork, bandwidth recharge, disk / network / template create)
  return `402 Payment Required` (JSend `fail`) when the account has no
  credit. SDK: `errorFromResponse` maps 402 → `FcPaymentRequiredError`.
  402 is not a retry status in either retry class — correct, since
  retrying without topping up cannot succeed.

## Reconciled in 0.6.0

A server response-structure change reshaped the wire format. Changes the
SDK surfaces to callers:

- **List endpoints are now paginated.** `GET /v1/sandboxes`, `/v1/disks`,
  `/v1/networks`, `/v1/templates`, `/v1/hosts`, `/v1/shapes`, and
  `GET /v1/sandboxes/:id/disks` return the doubly-nested envelope
  `{ status, data: { data: [...], pagination: { total, limit, offset,
  count } } }`. The legacy `{ <key>: [...] }` wrappers are deprecated
  server-side. The SDK's list methods now auto-loop every page
  (`FcHttp.fetchAllPages`, accepts paginated / legacy / bare-array
  shapes) and return the full result set. The server clamps `limit` to
  **500**; paging advances by the actual item count, not the requested
  size. `listSandboxes({ limit })` treats `limit` as a cap on handles
  returned. `GET /v1/rootfs` is **not** paginated (still a plain
  `RootfsView`).
- **`CreateSandboxResponse.mode` removed.** The server dropped `mode`
  from the create response (operational detail of the boot path, not part
  of the user contract). The `mode` field and the `SandboxSpawnMode` type
  are gone from the SDK.
- **`bandwidth_quota_bytes` is not settable at create.** The server
  rejects any non-zero value with `400` and stamps the cluster default.
  Removed from `CreateSandboxRequest`. Grow the quota post-create with
  `Sandbox.rechargeBandwidth()` (`POST /v1/sandboxes/:id/bandwidth/
  recharge`, body `{ add_bytes }`). Still accepted on the fork request, so
  it stays on `ForkSandboxRequest`.
- **`SandboxView.ingress_url_template?` added.** The server now returns
  the ingress template on the sandbox view, not just on the create
  response.

## Coverage gaps closed in 0.5.0

All plain-JSON endpoints the server exposes are now modeled:

- `POST /v1/sandboxes/:id/ssh-pubkeys` → `Sandbox.addSSHPubkeys()`.
- `PATCH /v1/disks/:id` (S3 credential rotate) → `DisksApi.rotateCredentials()`.

No user-facing plain-JSON endpoint on the server is currently unmodeled.

## Known wire drift (modeled types)

Fixed in 0.5.0 — every `omitempty`-vs-required mismatch on a type the SDK
*surfaces to callers*:

- `SandboxView.ip` → `ip?: string` (omitted while `creating`).
- `CreateSandboxRequest.region` added.
- `Shape.cpu_quota_pct?` added (cgroup cpu cap percent, `omitempty`).
- `HostPublic.rootfses?` (`omitempty`).
- `NetworkMember.ip?` / `.name?` (both `omitempty`).

Remaining, intentionally left (low):

- `CreateSandboxResponse` marks `name`, `rootfs`, `egress` and
  `bandwidth_quota_bytes` required while the server sends them
  `omitempty`. `createSandbox()` never hands this object to the caller —
  it reads only `id` / `ingress_url_template` and returns a `Sandbox`
  built from a follow-up `GET` — so the mismatch is unreachable in normal
  use. Left as documented drift rather than a forced `?`.

Directly verified wire-faithful at this audit (server response read and
compared field-by-field): `SandboxView`, the create / destroy / resize
responses, `BandwidthView`, `EgressView`, `TemplateView`, the disk types
(`DiskView`, `SandboxDiskView`, `DiskCreateRequest` + `DiskConfig` /
`DiskCredentials`), the network types (`NetworkView` / `Network`,
`NetworkMember`), `Shape`, `HostPublic`, and the exec response envelope
(`ExecResponse`). All endpoint coverage was checked against the route
table (sandbox lifecycle incl. `by-ip`, ssh-pubkeys, files, egress,
bandwidth, templates, disks incl. attach / detach / credential rotate,
networks incl. delete).

Not independently re-read in this pass: the exec **result** and NDJSON
**stream-frame** shapes are agent-protocol types, not part of the HTTP
wire types. The SDK carries an explicit reconciliation note for them
(`src/types.ts`, near `ExecRequest`). Re-verify against the agent proto if
it changes.

## Updating this checkpoint

1. Identify the current `fc-spawn` `main` and review the wire surface
   (request / response types, routes, handlers) changed since the last
   audit.
2. Reconcile `src/types.ts` (and any new method) against the live server
   behavior — not the OpenAPI spec.
3. Update the wire-behavior / drift / coverage sections above, then bump
   the audit date and SDK version.
