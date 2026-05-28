# 02 — Code Interpreter

Upload a Python script into a sandbox, run it, and capture stdout/stderr.

> ⚠️ **Streaming exec is currently broken on prod** — see
> [fc#40](https://github.com/NodeOps-app/fc/issues/40). `sdk-streaming.ts`
> exists so the broken path can be re-tested once the fix lands; the
> default `index.ts` uses buffered exec.

## Run

```sh
cp .env.example .env  # fill in FC_API_KEY
bun index.ts                # buffered (default)
bun sdk-streaming.ts        # broken on prod — fc#40
```

bun auto-loads `.env` from the example dir. `FC_BASE_URL` defaults to the
production control plane and only needs to be set to override.

## What it does

1. Creates a sandbox on shape `s-1vcpu-1gb` with rootfs `devbox:1`.
2. Uploads `script.py` to `/tmp/script.py` via `sandbox.files.upload`.
3. Runs `python3 /tmp/script.py` via `runCommand` and prints
   stdout/stderr + exit code.
4. Destroys the sandbox.

## FC primitives exercised

| primitive | SDK call |
| --- | --- |
| File upload | `sandbox.files.upload()` |
| Buffered exec | `sandbox.runCommand()` |
| Streaming exec (blocked) | `sandbox.streamCommand()` — fc#40 |
| Tear down | `sandbox.destroy()` |

## Versions captured at build time

See `versions.txt`.
