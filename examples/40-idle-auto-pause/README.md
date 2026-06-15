# 40 — Idle auto-pause

Pause a sandbox automatically after it goes idle, so an unused VM stops
billing without the client watching for idleness. Set the timeout at create
with `auto_pause_after_seconds`, then change it live with `setAutoPause`.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_BASE_URL` defaults to the
production control plane and only needs to be set to override.

## What it does

1. Creates a sandbox (`s-1vcpu-1gb`, rootfs `devbox:1`) with
   `auto_pause_after_seconds: 300` — pause after 5 minutes idle.
2. Raises the timeout to 600 s with `setAutoPause(600)`; the handle refreshes
   so `sandbox.data.auto_pause_after_seconds` reflects the new value.
3. Disables auto-pause with `setAutoPause(null)` (the SDK sends
   `disable_auto_pause` because `omitempty` can't clear a nullable int).
4. Destroys the sandbox.

The valid range is 60–86400 (1 min – 24 h); the server rejects values outside
it with a validation error.

## FC primitives exercised

| primitive         | SDK call                       |
| ----------------- | ------------------------------ |
| Sandbox lifecycle | `Sandbox.create()`             |
| Set idle timeout  | `sandbox.setAutoPause()`       |
| Read current view | `sandbox.data`                 |
| Tear down         | `sandbox.destroy()`            |
