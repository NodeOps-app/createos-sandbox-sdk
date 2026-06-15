/**
 * S3-backed disk + ffmpeg transcode — mount a bucket into a sandbox.
 *
 * Registers an S3-compatible bucket as an FC disk, mounts it at boot on a
 * fresh sandbox (s3fs), runs an ffmpeg audio-extraction against files on the
 * mount, then detaches the disk and verifies the output landed durably in the
 * bucket from this host. Structured as a bounded watcher: it self-seeds a clip,
 * polls the input prefix, and transcodes each new video in its own short-lived
 * VM (serial, to respect the 5-sandbox cap).
 *
 * GOTCHA: detachDisk requires the disk's resolved `disk_<ulid>` id, NOT its
 * name — the detach handler matches the attachment row by raw id and never
 * resolves a name (attach accepts either). See the DISK_ID note below.
 *
 * Run:   bun 38-s3-disk-ffmpeg-transcode/index.ts
 * Needs: CREATEOS_SANDBOX_API_KEY + CREATEOS_SANDBOX_BASE_URL, and an S3-compatible bucket
 *        reachable from BOTH this machine and the FC agent — S3_BUCKET,
 *        S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY (AWS S3 / R2 / MinIO; set
 *        S3_USE_PATH_STYLE=1 for MinIO). See .env.example for tuning vars.
 */
import {
  CreateosSandboxClient,
  CreateosSandboxNotFoundError,
  type Sandbox,
} from "createos-sandbox-sdk";

// ── config ──────────────────────────────────────────────────────────────
const S3 = {
  bucket: requireEnv("S3_BUCKET"),
  endpoint: requireEnv("S3_ENDPOINT"),
  region: process.env.S3_REGION || "us-east-1",
  accessKey: requireEnv("S3_ACCESS_KEY"),
  secretKey: requireEnv("S3_SECRET_KEY"),
  usePathStyle: /^(1|true|yes)$/i.test(process.env.S3_USE_PATH_STYLE ?? ""),
};
const INPUT_PREFIX = (process.env.INPUT_PREFIX ?? "input/").replace(/\/*$/, "/");
const OUTPUT_PREFIX = (process.env.OUTPUT_PREFIX ?? "output/").replace(/\/*$/, "/");
const POLL_INTERVAL_S = Number(process.env.POLL_INTERVAL_S ?? "5");
const MAX_CYCLES = Number(process.env.MAX_CYCLES ?? "12");
const CLEANUP_MODE = (process.env.CLEANUP_MODE ?? "destroy") as "destroy" | "pause";
if (CLEANUP_MODE !== "destroy" && CLEANUP_MODE !== "pause") {
  throw new Error(`CLEANUP_MODE must be "destroy" or "pause", got "${CLEANUP_MODE}"`);
}

const MOUNT = "/mnt/bucket";
const SHAPE = "s-2vcpu-2gb";
const rand = () => crypto.randomUUID().slice(0, 8);
const DISK_NAME = `ex38-${rand()}`;
const VIDEO_RE = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;

// Local S3 client (Bun built-in) — seeds, lists, and verifies the bucket
// from this machine. The same bucket is mounted *inside* the sandbox as an
// FC disk via s3fs; this client never touches the mount, only the API.
const s3 = new Bun.S3Client({
  accessKeyId: S3.accessKey,
  secretAccessKey: S3.secretKey,
  bucket: S3.bucket,
  endpoint: S3.endpoint,
  region: S3.region,
  virtualHostedStyle: !S3.usePathStyle,
});

const fc = new CreateosSandboxClient();

// ── 1. self-seed a sample clip so the watcher always has work ────────────
const seedKey = `${INPUT_PREFIX}seed-${rand()}.mp4`;
console.log(`[seed] uploading sample.mp4 -> s3://${S3.bucket}/${seedKey}`);
await s3.file(seedKey).write(Bun.file(new URL("./sample.mp4", import.meta.url)));

// ── 2. register the bucket as an FC disk (idempotent by name) ────────────
let createdDisk = false;
console.log(`[disk] registering S3 disk "${DISK_NAME}" (bucket=${S3.bucket})`);
let disk = await fc.disks.get(DISK_NAME).catch((e) => {
  if (e instanceof CreateosSandboxNotFoundError) return null;
  throw e;
});
if (!disk) {
  disk = await fc.disks.create({
    name: DISK_NAME,
    kind: "s3",
    config: {
      bucket: S3.bucket,
      endpoint: S3.endpoint,
      region: S3.region,
      ...(S3.usePathStyle ? { use_path_style: true } : {}),
    },
    credentials: { access_key: S3.accessKey, secret_key: S3.secretKey },
  });
  createdDisk = true;
}
// Use the resolved disk_<ulid> id for attach/detach. The control plane's
// detach handler matches the attachment row by raw id and does not resolve a
// disk name, so the name only works for the catalog API (get/create/delete).
const DISK_ID = disk.id;
console.log(`[disk] ${DISK_ID} (${disk.name})`);

// ── 3. bounded poll loop ─────────────────────────────────────────────────
const seen = new Set<string>();
let processed = 0;
try {
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    const listing = await s3.list({ prefix: INPUT_PREFIX, maxKeys: 1000 });
    const inputs = (listing?.contents ?? [])
      .map((o) => o.key)
      .filter((k): k is string => !!k && VIDEO_RE.test(k) && !seen.has(k));

    // skip inputs whose output already exists (loopback / idempotency guard)
    const pending: string[] = [];
    for (const key of inputs) {
      if (await s3.file(outputKeyFor(key)).exists()) {
        seen.add(key);
        continue;
      }
      pending.push(key);
    }

    if (pending.length === 0) {
      if (processed > 0) {
        console.log(`[poll] cycle ${cycle}: nothing left to process, stopping early`);
        break;
      }
      console.log(
        `[poll] cycle ${cycle}/${MAX_CYCLES}: no new videos, waiting ${POLL_INTERVAL_S}s`,
      );
      await Bun.sleep(POLL_INTERVAL_S * 1000);
      continue;
    }

    console.log(`[poll] cycle ${cycle}/${MAX_CYCLES}: ${pending.length} new video(s)`);
    for (const key of pending) {
      await transcodeOne(key); // serial — respects the 5-sandbox cap
      seen.add(key);
      processed++;
    }
  }

  if (processed === 0) {
    throw new Error("no videos were processed — check the bucket and prefixes");
  }
  console.log(`\nverified end-to-end: ${processed} video(s) transcoded to audio in S3`);
} finally {
  if (createdDisk) {
    console.log(`[cleanup] deleting disk ${DISK_NAME} (bucket contents untouched)`);
    await fc.disks.delete(DISK_NAME).catch((e) => console.warn(`  disk delete failed: ${e}`));
  }
}

// ── per-video pipeline ───────────────────────────────────────────────────
async function transcodeOne(inputKey: string): Promise<void> {
  const outputKey = outputKeyFor(inputKey);
  const inPath = `${MOUNT}/${inputKey}`;
  const outPath = `${MOUNT}/${outputKey}`;
  console.log(`\n── ${inputKey} → ${outputKey} ──────────────────────────────`);

  console.log(`  [vm] creating sandbox (shape=${SHAPE}, disk=${DISK_NAME}@${MOUNT})`);
  const sandbox = await fc.createSandbox({
    name: `ffmpeg-${rand()}`,
    shape: SHAPE,
    rootfs: "devbox:1",
    envs: { DEBIAN_FRONTEND: "noninteractive" },
    disks: [{ disk_id: DISK_ID, mount_path: MOUNT }],
  });
  console.log(`  [vm] ${sandbox.id}  ip: ${sandbox.ip}`);

  let detached = false;
  try {
    // wait for s3fs mount to come up before touching the path (avoids a race
    // where ffmpeg sees an empty dir and reports "file not found")
    await waitForMount(sandbox);

    console.log(`  [apt] installing ffmpeg...`);
    const apt = await sandbox.runCommand(
      "bash",
      ["-lc", "apt-get update -qq && apt-get install -y --no-install-recommends ffmpeg"],
      { timeoutMs: 300_000 },
    );
    if (apt.result.exit_code !== 0) throw new Error(`apt install failed:\n${apt.result.stderr}`);

    console.log(`  [ffmpeg] extracting audio (mp3) directly onto the mount...`);
    const ff = await sandbox.runCommand(
      "bash",
      [
        "-lc",
        `mkdir -p "${MOUNT}/${OUTPUT_PREFIX}" && ` +
          `ffmpeg -nostdin -y -i "${inPath}" -vn -acodec libmp3lame -q:a 4 "${outPath}"`,
      ],
      { timeoutMs: 300_000 },
    );
    if (ff.result.exit_code !== 0) {
      throw new Error(
        `ffmpeg failed (exit ${ff.result.exit_code}):\n${ff.result.stderr.slice(-2000)}`,
      );
    }

    // detach before verifying from the API side — proves the s3fs flush on
    // unmount completed and the object is durably in the bucket.
    console.log(`  [disk] detaching ${DISK_ID} from ${MOUNT}`);
    await sandbox.detachDisk({ diskId: DISK_ID, mountPath: MOUNT });
    detached = true;

    // real e2e proof: the object exists in S3 with a non-zero size
    const f = s3.file(outputKey);
    if (!(await f.exists())) throw new Error(`output ${outputKey} not found in S3 after transcode`);
    const stat = await f.stat();
    if (!stat.size) throw new Error(`output ${outputKey} is empty in S3`);
    console.log(`  [verify] s3://${S3.bucket}/${outputKey} present (${stat.size} bytes)`);

    if (CLEANUP_MODE === "pause") {
      await sandbox.pause();
      console.log(
        `  [vm] paused ${sandbox.id} — resume with fc.getSandbox("${sandbox.id}").resume()`,
      );
    } else {
      await sandbox.destroy();
      console.log(`  [vm] destroyed ${sandbox.id}`);
    }
  } catch (err) {
    // on failure always destroy (don't leak a paused sandbox); detach best-effort
    if (!detached) {
      await sandbox.detachDisk({ diskId: DISK_ID, mountPath: MOUNT }).catch(() => {});
    }
    await sandbox.destroy().catch(() => {});
    throw err;
  }
}

async function waitForMount(sandbox: Sandbox): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const disks = await sandbox.listDisks();
    const d = disks.find((x) => x.mount_path === MOUNT);
    if (d?.mount_status === "mounted") {
      console.log(`  [disk] mounted at ${MOUNT}`);
      return;
    }
    if (d?.mount_status === "error") {
      throw new Error(
        `disk mount entered "error" state — is ${S3.endpoint} reachable from the FC agent?`,
      );
    }
    await Bun.sleep(1000);
  }
  throw new Error(
    `disk did not reach "mounted" within 30s (last: ${JSON.stringify(await sandbox.listDisks())})`,
  );
}

function outputKeyFor(inputKey: string): string {
  const base = inputKey.slice(INPUT_PREFIX.length).replace(/\.[^.]+$/, "");
  return `${OUTPUT_PREFIX}${base}.mp3`;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name} — see .env.example`);
  return v;
}
