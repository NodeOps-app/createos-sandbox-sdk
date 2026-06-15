# 05 — Filesystem Snapshots

Demonstrates FC's snapshot + branching primitive: pause a running sandbox
to persist its full memory + disk state, then fork it into an independent
clone that inherits everything written before the pause but diverges from
that point on.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_BASE_URL` defaults to the
production control plane and only needs to be set to override.

## What it does

1. Creates a base sandbox on `devbox:1`.
2. Writes `/root/seed.txt` in the base.
3. `pause()` — snapshots the base to storage and waits for `paused`.
4. `fork()` — clones the paused base into a new independent sandbox that
   auto-resumes.
5. Reads `/root/seed.txt` in the fork (inherited from the snapshot).
6. Writes `/root/fork-only.txt` in the fork only.
7. `resume()` the base and confirms the base does **not** see
   `/root/fork-only.txt` — proving the fork diverged independently.
8. Destroys both sandboxes.

## FC primitives exercised

| primitive                                        | SDK call                                  |
| ------------------------------------------------ | ----------------------------------------- |
| Snapshot a running sandbox to storage            | `sandbox.pause()` + `waitUntilPaused()`   |
| Clone a paused sandbox into a new independent VM | `sandbox.fork()`                          |
| Restore a paused sandbox in place                | `sandbox.resume()` + `waitUntilRunning()` |
| Push a file into a sandbox                       | `sandbox.files.upload()`                  |
| Run a buffered command                           | `sandbox.runCommand()`                    |
| Tear down                                        | `sandbox.destroy()`                       |

## Versions captured at build time

See `versions.txt`.
