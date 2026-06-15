# 01 — Hello World

Smoke test the fc-sdk surface: create → run one buffered command → destroy.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_BASE_URL` defaults to the
production control plane and only needs to be set to override.

## What it does

1. Creates a sandbox on the smallest shape (`s-1vcpu-256mb`) with rootfs
   `devbox:1`.
2. Runs `uname -a` and `cat /etc/os-release` via `runCommand` and prints
   the buffered stdout.
3. Destroys the sandbox.

## FC primitives exercised

| primitive         | SDK call                                    |
| ----------------- | ------------------------------------------- |
| Sandbox lifecycle | `Sandbox.create()` (blocks until `running`) |
| Buffered exec     | `sandbox.runCommand()`                      |
| Tear down         | `sandbox.destroy()`                         |

## Versions captured at build time

See `versions.txt`.
