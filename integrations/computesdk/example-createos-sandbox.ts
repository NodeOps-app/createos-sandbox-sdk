/**
 * CreateOS provider example. Run with:
 *   CREATEOS_SANDBOX_API_KEY=usr_... CREATEOS_SANDBOX_BASE_URL=https://createos-sandbox.example.com \
 *     npx tsx example-createos-sandbox.ts
 */
import { compute } from "computesdk";
import { createosSandbox } from "@computesdk/createos-sandbox";

async function main() {
  compute.setConfig({ provider: createosSandbox({}) }); // reads CREATEOS_SANDBOX_API_KEY / CREATEOS_SANDBOX_BASE_URL

  const sandbox = await compute.sandbox.create({ memoryMb: 1024, image: "devbox:1" });
  console.log("created", sandbox.sandboxId);

  const result = await sandbox.runCommand("uname -a");
  console.log("uname:", result.stdout.trim(), "exit:", result.exitCode);

  await sandbox.filesystem.writeFile("/tmp/hello.txt", "hi from computesdk");
  console.log("readback:", await sandbox.filesystem.readFile("/tmp/hello.txt"));
  console.log("ls /tmp:", await sandbox.filesystem.readdir("/tmp"));

  // Native escape hatch — pause/resume/fork/disks live on the createos-sandbox-sdk handle.
  const native = sandbox.getInstance();
  await native.pause();
  await native.resume();

  await sandbox.destroy();
  console.log("destroyed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
