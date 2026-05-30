# 14 — Jupyter Singleton (long-lived kernel + snapshot/branch)

One persistent Python kernel inside a sandbox, driven cell-by-cell
over a Unix socket — shared Python state across calls, like a Jupyter
notebook. Pause the sandbox mid-session, then fork two branches that
inherit the kernel checkpoint and diverge independently.

> The fork stage is currently blocked on
> [fc#42](https://github.com/NodeOps-app/fc/issues/42) (fork stuck in
> `forking` state on prod). The example degrades cleanly: it still
> verifies the singleton kernel and `pause()` end-to-end, prints the
> blocker note, and exits 0.

## Run

```sh
cp .env.example .env  # fill in FC_API_KEY
bun index.ts
```

bun auto-loads `.env`. `FC_API_KEY` is required; `FC_BASE_URL` defaults
to the production control plane and only needs to be set to override.

## What it does

1. Creates a parent sandbox on `s-1vcpu-1gb` + `devbox:1`.
2. Uploads `kernel_daemon.py` (long-lived IPython InteractiveShell
   listening on a Unix socket) and `cell_client.py` (per-cell shim
   that pipes code to the daemon and prints the JSON reply).
3. Boots the daemon with `nohup setsid python3 kernel_daemon.py &`
   and waits for the ready marker (Unix socket + sentinel file).
   No extra packages — the daemon is stdlib-only.
4. Runs three cells in sequence — imports `statistics`, builds a
   dataset, defines a helper. Each cell reuses state from the prior
   one (the daemon never restarts).
5. `pause()` + `waitUntilPaused()` snapshots the kernel mid-session.
6. `fork({ start_paused: true })` branch A — resumes, runs a cell
   that uses inherited `xs` + `transform`, prints divergent output,
   destroys the fork.
7. Same dance for branch B with a different transform, proving two
   branches diverged from the identical kernel checkpoint.
8. Destroys the parent.

Sandboxes are sequenced (parent → fork A → destroy A → fork B →
destroy B → parent) so no more than two are alive at once — friendly
to the shared concurrent-sandbox cap.

## Kernel transport — trade-off

This example uses approach **A**: an in-sandbox driver script with a
Unix-socket protocol. Pros: no ingress needed, no Jupyter wire
protocol, every cell is a normal buffered `runCommand`. Cons: less
realistic than a real Jupyter Server.

Approach **B** (not shipped) would boot `jupyter kernel` on `0.0.0.0`,
enable `ingress_enabled: true`, and drive the kernel from `index.ts`
over the Jupyter ZMQ-over-WS protocol. More authentic but adds the
ingress URL + WebSocket wire-format on top of the same FC primitives.

## FC primitives exercised

| primitive                | SDK call                                  |
| ------------------------ | ----------------------------------------- |
| Create sandbox           | `fc.createSandbox()`                      |
| Upload payload files     | `sandbox.files.upload()`                  |
| Buffered command         | `sandbox.runCommand()`                    |
| Snapshot the live kernel | `sandbox.pause()` + `waitUntilPaused()`   |
| Branch from snapshot     | `sandbox.fork({ start_paused: true })`    |
| Resume a forked branch   | `sandbox.resume()` + `waitUntilRunning()` |
| Tear down                | `sandbox.destroy()`                       |

## Versions captured at build time

See `versions.txt`.
