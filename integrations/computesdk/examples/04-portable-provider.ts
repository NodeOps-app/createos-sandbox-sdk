/**
 * 04 — Portable provider (drop-in).
 *
 * The point of ComputeSDK: application code talks to `compute.sandbox`, never
 * to a vendor SDK. `runJob` below knows nothing about createos-sandbox — swap the
 * provider in `setConfig` for e2b/daytona/vercel and the same function runs
 * unchanged. createos-sandbox is wired in here only at the composition root.
 *
 *   CREATEOS_SANDBOX_API_KEY=usr_... CREATEOS_SANDBOX_BASE_URL=https://createos-sandbox.example.com \
 *     npx tsx 04-portable-provider.ts
 */
import { compute } from "computesdk";
import { createosSandbox } from "@computesdk/createos-sandbox";

/** Provider-agnostic: works against whatever provider compute is configured with. */
async function runJob(source: string): Promise<string> {
  const sandbox = await compute.sandbox.create({ memoryMb: 1024 });
  try {
    await sandbox.filesystem.writeFile("/tmp/job.sh", source);
    const r = await sandbox.runCommand("sh /tmp/job.sh");
    if (r.exitCode !== 0) throw new Error(`job failed (${r.exitCode}): ${r.stderr}`);
    return r.stdout.trim();
  } finally {
    await sandbox.destroy();
  }
}

async function main() {
  // The only createos-sandbox-aware line in the whole program.
  compute.setConfig({ provider: createosSandbox({ rootfs: "devbox:1" }) });

  const out = await runJob('echo "result: $((6 * 7))"');
  console.log(out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
