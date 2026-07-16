# 52 — Self-signal: pause or delete from inside

A workload running **inside** a sandbox can pause or delete its own sandbox by
calling `selfPause()` / `selfDelete()` from the SDK — no client, no config, no
credentials. Both calls hit an agent bound to loopback (`127.0.0.1:1029`), so
they only work from inside a sandbox and fail with a connection error anywhere
else. Reach for this when the workload itself knows it is done: a finished batch
job pauses to stop billing, a one-shot task deletes itself — no host polling
from outside.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_BASE_URL` defaults to the
production control plane and only needs to be set to override.

> The in-sandbox worker installs the published SDK with `bun add`, so this
> example needs **@nodeops-createos/sandbox ≥ 0.7.0** on npm — the release that
> adds `selfPause` / `selfDelete`.

## What it does

1. **selfPause.** Creates a sandbox, uploads a small worker that does its job
   then calls `selfPause("batch complete")`, and launches it detached. The host
   waits with `waitUntilPaused()` and sees the sandbox pause itself, then
   `resume()`s and downloads the worker's log to show what it printed.
2. **selfDelete.** Creates a second sandbox with a one-shot worker that calls
   `selfDelete("one-shot complete")`. The host polls `refresh()` until it throws
   `CreateosSandboxNotFoundError` — the sandbox deleted itself, so no host-side
   teardown is needed.

`selfPause` / `selfDelete` stop the sandbox mid-process, so the worker is
launched in the background (`setsid … &`): a foreground command would never
return once the sandbox freezes or is destroyed.

## createos-sandbox primitives exercised

| primitive             | SDK call                          |
| --------------------- | --------------------------------- |
| Sandbox lifecycle     | `Sandbox.create()`                |
| Upload a file         | `sandbox.files.upload()`          |
| Run a command         | `sandbox.runCommand()`            |
| Pause from inside     | `selfPause()` (in the worker)     |
| Delete from inside    | `selfDelete()` (in the worker)    |
| Wait for pause        | `sandbox.waitUntilPaused()`       |
| Resume                | `sandbox.resume()`                |
| Download a file       | `sandbox.files.download()`        |
| Tear down             | `sandbox.destroy()`               |
