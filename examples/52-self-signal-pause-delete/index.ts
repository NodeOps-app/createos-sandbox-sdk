/**
 * Self-signal — a workload running *inside* a sandbox pauses or deletes its own
 * sandbox with `selfPause()` / `selfDelete()`. No client, no config, no
 * credentials: both calls hit an agent bound to loopback (`127.0.0.1:1029`),
 * reachable only from inside the sandbox. Use it when the workload itself knows
 * it is done — a finished batch job pauses to stop billing, a one-shot task
 * deletes itself — instead of a host polling from outside.
 *
 * This host script deploys a tiny worker into a sandbox, launches it detached,
 * and watches the sandbox act on its own signal. selfPause / selfDelete stop
 * the sandbox mid-process, so the worker is launched in the background — a
 * foreground command would never return once the sandbox freezes.
 *
 * Run:   bun 52-self-signal-pause-delete/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example). No external services.
 *        The in-sandbox worker installs the published SDK, so this needs
 *        @nodeops-createos/sandbox >= 0.7.0 on npm (the release that adds
 *        selfPause / selfDelete).
 */
import { Sandbox } from "createos-sandbox-sdk";

const SHAPE = "s-1vcpu-1gb";
const SDK_PKG = "@nodeops-createos/sandbox";

// A worker that finishes its job, then pauses its own sandbox. selfPause
// snapshots disk + memory and frees the host; resume it later from the
// control plane or CLI.
const PAUSE_WORKER = `
import { selfPause } from "${SDK_PKG}";
console.log("worker: crunching batch...");
await new Promise((r) => setTimeout(r, 500));
console.log("worker: batch done — pausing self");
await selfPause("batch complete");
`;

// A one-shot worker that deletes its own sandbox on completion. Irreversible —
// the sandbox and its state are gone, so no host-side teardown is needed.
const DELETE_WORKER = `
import { selfDelete } from "${SDK_PKG}";
console.log("worker: one-shot task done — deleting self");
await selfDelete("one-shot complete");
`;

// Upload the worker, install the SDK inside, then launch it detached (setsid +
// background) so this runCommand returns before the worker stops the sandbox.
async function deployAndLaunch(box: Sandbox, worker: string): Promise<void> {
  await box.files.upload("/root/worker.ts", worker);
  const install = await box.runCommand("sh", [
    "-lc",
    `cd /root && bun add ${SDK_PKG} >install.log 2>&1 && setsid bun worker.ts >worker.log 2>&1 </dev/null &`,
  ]);
  if (install.result.exit_code !== 0) {
    throw new Error(
      `worker launch failed (exit ${install.result.exit_code}): ${install.result.stderr}`,
    );
  }
}

// ── selfPause: the workload pauses its own sandbox ──────────────────────────
const pauseBox = await Sandbox.create({ shape: SHAPE, rootfs: "devbox:1" });
console.log(`[pause] created ${pauseBox.id} (${pauseBox.status})`);
try {
  await deployAndLaunch(pauseBox, PAUSE_WORKER);
  console.log("[pause] worker launched — waiting for it to pause itself...");
  await pauseBox.waitUntilPaused({ timeoutMs: 60_000 });
  console.log(`[pause] sandbox paused itself (status=${pauseBox.status})`);

  // Resume and read what the worker logged before it paused the sandbox.
  await pauseBox.resume();
  const log = new TextDecoder().decode(await pauseBox.files.download("/root/worker.log"));
  console.log(`[pause] worker output:\n${log.trim()}`);
} finally {
  await pauseBox.destroy().catch((err) => {
    console.error(`[pause] cleanup: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("[pause] destroyed");
}

// ── selfDelete: the workload deletes its own sandbox ────────────────────────
const deleteBox = await Sandbox.create({ shape: SHAPE, rootfs: "devbox:1" });
console.log(`[delete] created ${deleteBox.id} (${deleteBox.status})`);
await deployAndLaunch(deleteBox, DELETE_WORKER);
console.log("[delete] worker launched — waiting for the sandbox to delete itself...");

// Poll the handle: refresh() throws CreateosSandboxNotFoundError once the sandbox is gone.
let deleted = false;
for (let i = 0; i < 60 && !deleted; i++) {
  try {
    await deleteBox.refresh();
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    deleted = true;
  }
}
if (deleted) {
  console.log("[delete] sandbox deleted itself — no cleanup needed");
} else {
  console.log("[delete] still present after 60s — destroying from the host");
  await deleteBox.destroy().catch(() => {});
}
