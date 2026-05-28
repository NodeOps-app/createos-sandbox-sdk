// Buffered variant. Streaming variant lives in sdk-streaming.ts (blocked on fc#40).
import { Sandbox } from "fc-sandbox-sdk";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = await readFile(join(here, "script.py"));

const sandbox = await Sandbox.create({
  shape: "s-1vcpu-1gb",
  rootfs: "devbox:1",
});
console.log("created:", sandbox.id);

try {
  await sandbox.files.upload("/tmp/script.py", script);
  console.log("--- output ---");
  const { result } = await sandbox.runCommand("python3", ["/tmp/script.py"]);
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.log(`(exited ${result.exit_code})`);
} finally {
  await sandbox.destroy();
  console.log("destroyed");
}
