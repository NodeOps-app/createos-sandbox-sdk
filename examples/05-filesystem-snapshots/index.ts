/**
 * Filesystem snapshots — pause → fork → resume.
 *
 * Demonstrates FC's copy-on-write snapshot model: a paused sandbox can be
 * forked into an independent clone that inherits the parent's entire
 * filesystem as of the pause point. Writes made after the fork stay local to
 * each side — the fork and its parent diverge from the snapshot onward.
 *
 * Run:   bun 05-filesystem-snapshots/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example). No external services.
 */
import { Sandbox } from "createos-sandbox-sdk";

const STAMP = new Date().toISOString();
const BASE_PATH = "/root/seed.txt";
const FORK_ONLY_PATH = "/root/fork-only.txt";

// Read a file from inside the sandbox. `2>&1` folds a "no such file" error
// into stdout so we can print it (used below to show the base can't see the
// fork-only file) instead of throwing.
async function readFile(sb: Sandbox, path: string) {
  const { result } = await sb.runCommand("sh", ["-c", `cat ${path} 2>&1`]);
  return result.stdout.trim();
}

// Sandbox.create is the client-less factory — it builds the CreateosSandboxClient from
// CREATEOS_SANDBOX_BASE_URL / CREATEOS_SANDBOX_API_KEY and blocks until the VM is `running`.
// tiny shape on purpose — this smoke test only reads/writes small files
const base = await Sandbox.create({ shape: "s-1vcpu-256mb", rootfs: "devbox:1" });
console.log(`base created: ${base.id}`);

let fork: Sandbox | undefined;
try {
  // 1. Seed a file on the base — this is the state we expect the fork to inherit.
  await base.files.upload(BASE_PATH, `seed written at ${STAMP}\n`);
  console.log(`wrote ${BASE_PATH}:`, await readFile(base, BASE_PATH));

  // 2. Pause to snapshot. pause() is async server-side; waitUntilPaused polls
  //    until the checkpoint is committed. The 10-minute budget is deliberate —
  //    snapshotting a live VM routinely outlasts the default 60s request deadline.
  console.log("pausing base...");
  await base.pause();
  await base.waitUntilPaused({ timeoutMs: 600_000 });
  console.log("base paused.");

  // 3. Fork the paused snapshot. start_paused leaves the clone paused on arrival
  //    (cheaper than booting it immediately) — we resume it ourselves in step 4.
  console.log("forking base (start_paused=true)...");
  fork = await base.fork({ start_paused: true });
  await fork.waitUntilPaused({ timeoutMs: 600_000 });
  console.log(`fork paused: ${fork.id} (forked_from=${fork.data.forked_from})`);

  // 4. Resume the fork into a running VM so we can run commands in it.
  console.log("resuming fork...");
  await fork.resume();
  await fork.waitUntilRunning({ timeoutMs: 600_000 });
  console.log(`fork running: ${fork.id}`);

  // 5. The fork inherits everything written before the pause.
  console.log(`fork inherits ${BASE_PATH}:`, await readFile(fork, BASE_PATH));

  // 6. Write a file that exists ONLY in the fork — this is the divergence point.
  await fork.files.upload(FORK_ONLY_PATH, `written only in fork at ${new Date().toISOString()}\n`);
  console.log(`fork wrote ${FORK_ONLY_PATH}:`, await readFile(fork, FORK_ONLY_PATH));

  // 7. Resume the base and prove the filesystems are independent: the base never
  //    sees the fork-only file, but still has its own seed.
  console.log("resuming base...");
  await base.resume();
  await base.waitUntilRunning({ timeoutMs: 600_000 });

  console.log(`base does not see fork-only file: "${await readFile(base, FORK_ONLY_PATH)}"`);
  console.log(`base still has ${BASE_PATH}:`, await readFile(base, BASE_PATH));
} finally {
  // Always tear down both VMs. .catch(() => {}) so a failed destroy on one side
  // doesn't mask the other — or the real error from the try block.
  if (fork) await fork.destroy().catch(() => {});
  await base.destroy().catch(() => {});
  console.log("destroyed both sandboxes.");
}
