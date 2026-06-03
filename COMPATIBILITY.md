# Compatibility checkpoint

This file records the `fc-spawn` control-plane commit this SDK has been
reconciled against, and the known gaps at that point. The control plane
is a separate, private service; its published OpenAPI spec is stale, so
this checkpoint is verified against the **live handler source**
(`internal/control/handlers/*` and `internal/httpx/types/*`), never the
spec. See `AGENTS.md` → "Wire types — source of truth".

## Checkpoint

| | |
| --- | --- |
| SDK version | `0.5.0` |
| fc-spawn branch | `main` |
| fc-spawn commit | `52ea6c9` ("chore: worker detachment", 2026-06-02) |
| Audited | 2026-06-03 |

**What "compliant" means here:** every endpoint the SDK *models* is
wire-faithful to the server structs at the commit above — field names,
types, and `omitempty` → optional mapping — except for the known drift
listed below. Endpoints the SDK does not model (next two sections) are a
coverage choice, not a fidelity failure, and do not move this checkpoint.

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

## Coverage gaps closed in 0.5.0

All plain-JSON endpoints the server exposes are now modeled:

- `POST /v1/sandboxes/:id/ssh-pubkeys` → `Sandbox.addSSHPubkeys()`.
- `PATCH /v1/disks/:id` (S3 credential rotate) → `DisksApi.rotateCredentials()`.

No user-facing plain-JSON endpoint on the server is currently unmodeled.

## Known wire drift (modeled types)

Fixed in 0.5.0 — every `omitempty`-vs-required mismatch on a type the SDK
*surfaces to callers*:

- `SandboxView.ip` → `ip?: string` (omitted while `creating`).
- `CreateSandboxRequest.region` added (server `CreateReq.Region`).
- `Shape.cpu_quota_pct?` added (cgroup cpu cap percent, `omitempty`).
- `HostPublic.rootfses?` (server `PublicHostView`, `omitempty`).
- `NetworkMember.ip?` / `.name?` (server `NetworkMemberView`, both
  `omitempty`).

Remaining, intentionally left (low):

- `CreateSandboxResponse` marks `name`, `rootfs`, `egress` and
  `bandwidth_quota_bytes` required while the server sends them
  `omitempty`. `createSandbox()` never hands this object to the caller —
  it reads only `id` / `ingress_url_template` and returns a `Sandbox`
  built from a follow-up `GET` — so the mismatch is unreachable in normal
  use. Left as documented drift rather than a forced `?`.

Directly verified wire-faithful at this commit (server struct read and
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
**stream-frame** shapes are agent-protocol (`proto`) types, not part of
`internal/httpx/types`. The SDK carries an explicit reconciliation note
for them (`src/types.ts`, near `ExecRequest`). Re-verify against the agent
proto if it changes.

## Updating this checkpoint

1. `git -C ../fc log -1 main` — note the new `main` HEAD.
2. Diff the wire surface since the recorded commit:
   `git -C ../fc diff <recorded-sha>..main -- internal/httpx/types
   internal/control/routes internal/control/handlers`.
3. Reconcile `src/types.ts` (and any new method) against the live
   handlers — not the OpenAPI spec.
4. Update the table and the drift/gap lists above, then bump the commit.
