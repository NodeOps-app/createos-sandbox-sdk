# Agent-first desktop integration plan

Status: proposed production work. The adjacent Calculator example is the
implemented compatibility proof. This document defines the next work; it
does not advertise additional SDK methods or server endpoints.

Related: [feature issue #59](https://github.com/NodeOps-app/createos-sandbox-sdk/issues/59)
and [proof PR #60](https://github.com/NodeOps-app/createos-sandbox-sdk/pull/60).

## Product direction

Design for agents to initiate, observe, operate, verify, and clean up desktop
jobs. The requester's assumption that 99% of interaction will come from
agents is a product direction, not measured usage. Routine success must
require no human to open noVNC, read a screenshot, approve an input mode, or
dismiss an operating-system prompt.

The caller declares permitted semantic and physical operations at job start.
Policy refusals return structured information for the caller to handle.
The integration must not escalate to physical input because a semantic
operation failed. Optional human access remains available for recovery.

## Architecture and scope

Run the pinned native agent-desktop executable inside the sandbox's
graphical session. Begin with existing SDK command and file operations.
Keep the TypeScript SDK free of new runtime dependencies.

Build a supported image and desktop-session launcher before adding a public
semantic API. If that API needs server behavior, specify and implement the
contract upstream before mirroring it into SDK types. Do not substitute
client-side guesses for a server contract.

Use one sandbox per independent job initially. An agent-desktop session
namespaces references and traces; it does not isolate application state,
clipboard, focus, or the graphical desktop. A shared mutation lock protects
individual commands, not a complete observe/act/verify transaction.

## Capability inventory and release priorities

The review covered all 37 published desktop documentation source pages,
including the 60-command reference, guides, platforms, configuration,
installation, changelog, and C library. Platform support varies; command
presence alone does not establish availability in a deployed image.

| Capability | Agent value | Release treatment |
| --- | --- | --- |
| `status`, `permissions`, `version`, embedded `skills` | Discover readiness, supported surfaces, release and instructions without guesswork | P0 bootstrap |
| `snapshot`, `find`, `get`, `is` | Read and target UI state through structured observations | P0 core |
| Compact, interactive-only, skeleton and subtree reads | Bound output and inspect only the relevant region | P0 core |
| Ref click/right-click, type, set-value, clear, select, toggle, check/uncheck, expand/collapse | Operate supported controls and verify state | P0 core; capability-gated |
| Element/window/text/menu/event waits and actionability checks | Synchronize jobs without fixed sleeps | P0 core |
| Application launch/attach/discovery/close | Prepare jobs and identify processes | P0 core |
| Window listing/focus/move/resize/minimize/maximize/restore | Select and control the intended window | Reuse current SDK operations; validate identity mapping |
| Keyboard chords, hover, drag, coordinate mouse input, wheel and scroll | Reach controls with no semantic route | P1 explicit physical policy on X11 |
| Semantic `scroll-to` | Reveal an accessible target | P0 when the target exposes it |
| Menus, sheets, alerts and surface discovery | Resolve modal UI before continuing | P0 supported app surfaces |
| Text/image/file-reference clipboard | Transfer app content without reconstructing it through input | P1; preserve X11 clipboard helper and readback |
| Sessions and qualified references | Scope observations to a job and prevent accidental cross-job lookup | P0 core |
| JSONL traces, pre/post images, refmaps and HTML export | Diagnose failures programmatically and download evidence | P0 JSONL and artifact manifest; P1 optional images/HTML |
| Bounded sequential batches | Reduce remote round trips for known operations | P1 with entry-level outcomes |
| Fresh Chromium/Electron launch with local CDP endpoint | Use agent-browser for web contents and supported native UI separately | P1 hybrid workflows |
| Cursor labels, highlights, ripples and per-agent profiles | Help a human watch an exceptional run | Optional; off by default |
| Multi-agent cursor mode | Attribute actions in a shared presentation | Optional; not isolation or safe parallel job control |
| Notifications and OS shell surfaces | Operate environment-specific shell UI | Defer on XFCE; Linux notifications need GNOME Shell |
| Held keys/buttons | No usable implementation in reviewed agent-desktop docs | Do not advertise its reserved down/up commands |
| Continuous video | No documented agent-desktop recording command | Separate optional recorder; exclude from core dependency set |
| C library | Embed the engine beside the desktop | Defer; CLI avoids ABI, binding and memory-ownership work |
| Optional `jev` helper | Goal-driven helper requiring checkout and provider credentials | Exclude from the SDK baseline; caller supplies its agent loop |

## Machine-facing contract requirements

These requirements apply to the future integration, not the proof's current
console output. Choose public method names and exact schemas only after the
upstream transport decision.

- Return structured envelopes and discriminated outcomes. Preserve native
  error codes, delivery evidence, retry disposition, and verification scope.
  Do not make agents parse human error messages or terminal formatting.
- Report installed binary version, envelope contract version, supported
  surfaces, and tested capabilities separately. The C ABI is a third version
  domain and is irrelevant to a CLI consumer.
- Report readiness in stages: graphical session, session bus, accessibility
  bus, and target application. A successful `status` invocation may still
  contain denied accessibility; inspect the fields.
- Select screen, application process instance, and window explicitly. Fail
  with candidates when ambiguous. Keep references bound to their session.
- Preserve snapshot completeness and truncation. A partial observation cannot
  prove that an element is absent. `is` with `applicable: false` means unknown.
- Prefer replacement and desired-state actions to insertion and toggles when
  the caller knows the target state. Verify application effects beyond a field
  readback when the workflow needs a save, submission, or file artifact.
- Disable blind transport replay for UI commands. On unsafe or unknown
  delivery, read live state before deciding what to do next. Surface stale
  references and re-observe rather than guessing a replacement target.
- Accept finite deadlines and propagate cancellation through the operation.
  A client abort does not prove that input stopped or was never delivered;
  preserve an uncertain result and require state inspection after reconnect.
- Expose bounded observation depth/output and waits. Default limits must let
  an agent budget a job; report the reason when a limit truncates work.
- For batch calls, retain each entry's result and disposition. Stop dependent
  steps on failure. A batch is non-atomic, has no rollback, and cannot insert
  refs produced by an earlier entry into a later entry's arguments.
- Export machine-readable trace events and an artifact manifest before ending
  the session. Include content type, size, retrieval path, and capture failure
  status. Report trace-budget exhaustion instead of implying a complete log.
- Separate requested action, delivered input, observed state, and verified
  task success. A successful command is not a completed user task.
- Record cleanup outcomes for sessions, processes, and sandboxes. Keep an
  original failure available when cleanup also fails.

## Work packages and acceptance gates

### P0.1: Supported image and readiness

Upstream owner: image/agent repository. Inspect its current image launchers,
screen registration, boot and resume hooks before editing. The earlier live
test found missing AT-SPI, no initial XFCE session, and differing screen-state
directories between deployed image scripts and agent routes.

- [ ] Bake a pinned native release and matching helper into a versioned image;
  verify provenance and checksum, and include AT-SPI/toolkit packages.
- [ ] Reconcile image/agent screen registration and boot/resume startup.
- [ ] Provide a launcher that joins the selected desktop user's existing bus,
  display and runtime directory; refuse missing or ambiguous sessions.
- [ ] Validate fresh boot: readiness, app discovery, complete small-app tree,
  semantic action, screen geometry, PNG capture, and cleanup without a viewer.
- [ ] Validate missing bus and unsupported toolkit failures as structured
  outcomes, with no prompt or automatic policy escalation.

Gate: a fresh supported image completes the existing proof without package
installation or manual desktop startup during the job.

### P0.2: Agent interaction contract

SDK owners: TypeScript first, then Go/Python parity if a public surface ships.
Relevant TypeScript files: `src/types.ts`, `src/sandbox.ts`, `src/index.ts`,
module tests under `tests/`, and `examples/58-agent-desktop/`. Add source files
only if the agreed public surface needs them; keep the command transport proof.

- [ ] Specify the command-based adapter or upstream endpoint contract with
  exact request/result/error shapes and capability/version negotiation.
- [ ] Implement observation, semantic actions and waits against that contract.
- [ ] Test complete versus partial trees, unknown state, multiple matches,
  unsupported action, stale refs, and mismatched session lookup.
- [ ] Test action delivered before verification timeout and client disconnect;
  assert no automatic duplicate click/type/submit occurs.
- [ ] Test field editing and a save-to-file workflow with independent artifact
  verification. Keep app UI content out of generated shell syntax.

Gate: an agent can bootstrap, locate a unique control, act, verify the task
effect, recover from a stale observation, and clean up without human input.

### P0.3: Evidence and unattended lifecycle

Use current SDK file operations for downloadable evidence. Extend the example
and its README; add live tests outside the mocked unit suite.

- [ ] Start job-scoped tracing, export JSONL plus an artifact manifest, end the
  session, and download evidence without requiring the HTML viewer.
- [ ] Test trace/capture failures, storage limits, and cleanup failure reporting.
- [ ] Test cancellation, deadline expiry, application crash, and reconnect;
  preserve delivery uncertainty and inspect live state before more mutations.
- [ ] Test pause/resume and fork with fresh session discovery and observations;
  do not assume pre-restart references remain valid.
- [ ] Validate that independent jobs in separate sandboxes do not share app
  state or clipboard. Keep shared-desktop multi-agent operation out of P0.

Gate: successful and failed jobs both produce interpretable outcomes and
cleanup evidence. No screenshot/video capture is required for ordinary success.

### P1: Broader workflows and efficiency

- [ ] Test supported GTK forms, file manager, menus/dialogs, and clipboard
  representations; publish a toolkit/application capability matrix.
- [ ] Validate batch semantics and measure remote-call reduction separately
  from model usage and task success.
- [ ] Launch fresh Chromium with accessibility enabled and loopback-only CDP;
  run agent-browser in the same sandbox for web contents. Test actual native
  dialogs; Linux Electron dialogs may be absent from the accessibility tree.
- [ ] Test explicitly permitted physical X11 actions and verify their effects.
  Keep GNOME-only notifications unavailable in the XFCE capability report.
- [ ] Validate multiple screens with explicit routing before advertising them.

Gate: unsupported features return an actionable capability result; advertised
features pass live tests on the pinned image and tool release.

### Optional human presentation

- [ ] Validate noVNC, cursor overlays, HTML evidence and a separate recorder
  only after the unattended path works. Enable them per job when requested.
- [ ] Ensure enabling presentation does not change action policy, target
  identity, or the caller's task-success criteria.

## Evaluation and rollout

Run at least 20 fresh attempts per supported benchmark task and mode with
identical model/configuration. Include semantic controls and screenshot/input
baselines. Measure completion, wrong actions, duplicate effects, recovery,
human interventions, elapsed time, remote calls, model usage, and cleanup.
Report setup cost separately. Include failure injection as well as happy paths.

The supported unattended acceptance suite must finish with zero human
interventions and zero duplicate effects. Record denominators and failures;
do not infer a 99% task-success claim from the agent-first design assumption.

Before a public surface lands, search and report sibling status, then update
upstream contract, SDKs, CLI, examples, public docs and integrations in order.
Respect the read-and-report boundary until each sibling change is authorized.
Update the example manifest and run `bun run docs:gen` for catalog changes.

## Evidence boundaries and sources

The live proof verified Calculator arithmetic on Ubuntu 24.04/Xvfb/XFCE with
agent-desktop 1.0.2 through local SDK commands. Fresh runs completed and cleaned
up their sandboxes. The additional capabilities above come from documentation;
they have not yet passed CreateOS live tests. The reviewed source was commit
`9eb9b296192fcb70bda25e918cd6dd66abfa3d0d` of the upstream repository.

- [All commands](https://agent-browser.dev/desktop/commands)
- [Snapshots and refs](https://agent-browser.dev/desktop/snapshots-and-refs)
- [Skeleton and drill-down](https://agent-browser.dev/desktop/skeleton-and-drill-down)
- [Errors and recovery](https://agent-browser.dev/desktop/errors-and-recovery)
- [Waiting](https://agent-browser.dev/desktop/guides/waiting)
- [Batch](https://agent-browser.dev/desktop/guides/batch)
- [Sessions](https://agent-browser.dev/desktop/sessions)
- [Traces](https://agent-browser.dev/desktop/guides/traces)
- [Chromium/Electron](https://agent-browser.dev/desktop/guides/chromium-and-electron)
- [Linux](https://agent-browser.dev/desktop/platforms/linux)
- [Skills](https://agent-browser.dev/desktop/skills)
- [C library](https://agent-browser.dev/desktop/ffi)
