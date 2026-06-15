# 38 — S3-disk video→audio transcode (ffmpeg)

An event-style media pipeline on createos-sandbox. A new video in an S3 bucket triggers a
sandbox that mounts the **same bucket as a disk** (s3fs, read-write), runs
ffmpeg to extract audio, writes the result back to the bucket, detaches the
disk, and then destroys or pauses the sandbox. Shows off the createos-sandbox **S3-disk**
primitive end-to-end: register, mount-at-boot, live detach, mount-state
polling.

## Run

```sh
cp .env.example .env  # fill in createos-sandbox + S3 values
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_API_KEY` is the standard createos-sandbox
input (`CREATEOS_SANDBOX_BASE_URL` defaults to the prod control plane). The `S3_*` vars
point at any S3-compatible bucket — **it must be reachable from both your
machine and the createos-sandbox agent** (AWS S3, Cloudflare R2, MinIO, …). Set
`S3_USE_PATH_STYLE=1` for MinIO-style endpoints.

## What it does

1. Generates nothing — ships a tiny `sample.mp4` and **self-seeds** it to
   `s3://<bucket>/input/seed-<rand>.mp4` so the watcher always has work.
2. Registers the bucket as a createos-sandbox disk: `box.disks.create({ kind: "s3", … })`.
   The control plane HEADs the bucket and rejects bad creds up front.
3. **Bounded poll** (`MAX_CYCLES`, `POLL_INTERVAL_S`): lists `input/` via
   `Bun.S3Client`, skipping any video that already has an `output/<base>.mp3`
   (idempotency + loopback guard, since the output lands in the same bucket).
4. For each new video, serially:
   - Boots `devbox:1` on `s-2vcpu-2gb` with the disk mounted at `/mnt/bucket`.
   - Polls `sandbox.listDisks()` until `mount_status === "mounted"` before
     touching the path (avoids an empty-mount race).
   - `apt-get install -y ffmpeg`, then
     `ffmpeg -i /mnt/bucket/input/<key> -vn -acodec libmp3lame …
     /mnt/bucket/output/<base>.mp3` — written straight onto the s3fs mount.
   - `sandbox.detachDisk(...)`, then confirms the `.mp3` is durably in S3
     via `Bun.S3Client` (object exists + non-zero size).
   - Destroys or pauses the sandbox per `CLEANUP_MODE`.
5. Deletes the disk registration on exit (bucket contents untouched).

The audio object appears at `s3://<bucket>/output/<name>.mp3`.

## createos-sandbox primitives exercised

| primitive | SDK call |
| --- | --- |
| Register an S3 bucket as a disk | `box.disks.create({ kind: "s3", config, credentials })` |
| Look up / delete a disk | `box.disks.get()` / `box.disks.delete()` |
| Mount a disk at boot | `box.createSandbox({ disks: [{ disk_id, mount_path }] })` |
| Poll per-attachment mount state | `sandbox.listDisks()` → `mount_status` |
| Live-detach a disk | `sandbox.detachDisk({ diskId, mountPath })` |
| Run buffered commands | `sandbox.runCommand()` |
| Terminate or suspend | `sandbox.destroy()` / `sandbox.pause()` |

## Notes

- **Trigger model**: real S3 event notifications (SQS/Lambda) are out of
  scope for a self-contained script — this polls the bucket on an interval.
  Swap the poll loop for your event source in production.
- **devbox** has no ffmpeg; it's `apt-get`-installed at runtime, which adds a
  one-time cold start to each sandbox.
- s3fs buffers writes locally and flushes on close/unmount, so sequential
  audio output writes straight to the mount fine.

## Versions captured at build time

See `versions.txt`.
