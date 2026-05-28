import { Sandbox } from "fc-sandbox-sdk";

const STAMP = new Date().toISOString();
const BASE_PATH = "/root/seed.txt";
const FORK_ONLY_PATH = "/root/fork-only.txt";

async function readFile(sb: Sandbox, path: string) {
  const { result } = await sb.runCommand("sh", ["-c", `cat ${path} 2>&1`]);
  return result.stdout.trim();
}

const base = await Sandbox.create({ shape: "s-1vcpu-256mb", rootfs: "devbox:1" });
console.log(`base created: ${base.id}`);

let fork: Awaited<ReturnType<typeof base.fork>> | undefined;
try {
  await base.files.upload(BASE_PATH, `seed written at ${STAMP}\n`);
  console.log(`wrote ${BASE_PATH}:`, await readFile(base, BASE_PATH));

  console.log("pausing base...");
  await base.pause();
  await base.waitUntilPaused({ timeoutMs: 600_000 });
  console.log("base paused.");

  console.log("forking base (start_paused=true)...");
  fork = await base.fork({ start_paused: true });
  await fork.waitUntilPaused({ timeoutMs: 600_000 });
  console.log(`fork paused: ${fork.id} (forked_from=${fork.data.forked_from})`);

  console.log("resuming fork...");
  await fork.resume();
  await fork.waitUntilRunning({ timeoutMs: 600_000 });
  console.log(`fork running: ${fork.id}`);

  console.log(`fork inherits ${BASE_PATH}:`, await readFile(fork, BASE_PATH));

  await fork.files.upload(FORK_ONLY_PATH, `written only in fork at ${new Date().toISOString()}\n`);
  console.log(`fork wrote ${FORK_ONLY_PATH}:`, await readFile(fork, FORK_ONLY_PATH));

  console.log("resuming base...");
  await base.resume();
  await base.waitUntilRunning({ timeoutMs: 600_000 });

  console.log(`base does not see fork-only file: "${await readFile(base, FORK_ONLY_PATH)}"`);
  console.log(`base still has ${BASE_PATH}:`, await readFile(base, BASE_PATH));
} finally {
  if (fork) await fork.destroy().catch(() => {});
  await base.destroy().catch(() => {});
  console.log("destroyed both sandboxes.");
}
