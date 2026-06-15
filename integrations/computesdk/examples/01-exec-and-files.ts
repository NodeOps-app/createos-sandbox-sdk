/**
 * 01 — Commands + filesystem (the ComputeSDK basics).
 *
 * Create a sandbox, run a command, read/write/list files, clean up.
 *
 *   CREATEOS_SANDBOX_API_KEY=usr_... CREATEOS_SANDBOX_BASE_URL=https://createos-sandbox.example.com \
 *     npx tsx 01-exec-and-files.ts
 */
import { compute } from "computesdk";
import { createosSandbox } from "@computesdk/createos-sandbox";

async function main() {
  // Reads CREATEOS_SANDBOX_API_KEY / CREATEOS_SANDBOX_BASE_URL from the env.
  compute.setConfig({ provider: createosSandbox({}) });

  const sandbox = await compute.sandbox.create({ memoryMb: 1024, image: "devbox:1" });
  console.log("created", sandbox.sandboxId);

  try {
    // Per-command cwd/env are synthesised client-side (the control plane sets
    // env at sandbox creation, not per exec).
    const r = await sandbox.runCommand('echo "$GREETING from $(pwd)"', {
      cwd: "/tmp",
      env: { GREETING: "hi" },
    });
    console.log("stdout:", r.stdout.trim(), "exit:", r.exitCode);

    await sandbox.filesystem.writeFile("/tmp/hello.txt", "hi from computesdk");
    console.log("readback:", await sandbox.filesystem.readFile("/tmp/hello.txt"));
    console.log("exists:", await sandbox.filesystem.exists("/tmp/hello.txt"));
    const entries = await sandbox.filesystem.readdir("/tmp");
    console.log(
      "ls /tmp:",
      entries.map((e) => e.name),
    );

    await sandbox.filesystem.remove("/tmp/hello.txt");
    console.log("after remove, exists:", await sandbox.filesystem.exists("/tmp/hello.txt"));
  } finally {
    await sandbox.destroy();
    console.log("destroyed");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
