# 11 — TigerFS over Postgres in a createos-sandbox sandbox

Runs Postgres inside a single createos-sandbox VM, mounts that database as a
filesystem with [TigerFS](https://tigerfs.io/docs), then reads and writes
markdown notes from a plain Python script — proving that an off-the-shelf
"filesystem-is-the-API" tool works end-to-end inside `createos-sandbox` sandboxes.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_BASE_URL` and `CREATEOS_SANDBOX_API_KEY`
are the standard inputs `createos-sandbox-sdk` consumes. No other secrets are
required — Postgres is provisioned inside the sandbox with a local-only
demo user.

## What it does

1. Boots `devbox:1` on `s-2vcpu-2gb`. The guest kernel has
   `CONFIG_FUSE_FS=y` and devbox already ships `fuse3`, so TigerFS can use
   FUSE inside the VM without any host capability bumps.
2. `apt-get install postgresql python3 curl`, then starts the default
   Debian cluster with `pg_ctlcluster <ver> main start` (no systemd in
   devbox).
3. Provisions a `demo` superuser and `demodb` database.
4. Installs TigerFS with the upstream one-liner
   (`curl -fsSL https://install.tigerfs.io | sh`).
5. Runs `tigerfs migrate` on the empty database to lay down the schema.
6. Mounts `postgres://demo:demo@127.0.0.1/demodb` at `/mnt/db` —
   backgrounded via `nohup setsid` because `tigerfs mount` stays in the
   foreground holding the FUSE loop.
7. Creates a `notes` markdown app with `echo "markdown,history" >
/mnt/db/.build/notes`, then writes `hello.md` through the mount.
8. Uploads `hello.py` and runs it. The Python script reads `hello.md`,
   writes a second note, and lists the directory — all through ordinary
   `pathlib` calls.
9. `psql` dumps the rows that back the filesystem so you can see the
   round trip: file written via the mount, row in `tigerfs.notes`.

## createos-sandbox primitives exercised

| primitive                                   | SDK call                                   |
| ------------------------------------------- | ------------------------------------------ |
| Boot stock devbox rootfs                    | `box.createSandbox({ rootfs: "devbox:1" })` |
| Inject Postgres password into every command | `envs: { PGPASSWORD: … }`                  |
| Run buffered commands                       | `sandbox.runCommand()`                     |
| Upload local script to the guest            | `sandbox.files.upload()`                   |
| Tear the sandbox down                       | `sandbox.destroy()`                        |

## Versions captured at build time

See `versions.txt`.
