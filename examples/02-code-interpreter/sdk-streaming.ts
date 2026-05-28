// Code-interpreter streaming variant — BLOCKED ON fc#40.
// Will return "agent error: sandbox not found" until the streaming bug is fixed.
// Re-run this once the issue is closed.
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
  console.log("--- streaming output ---");
  for await (const ev of sandbox.streamCommand("python3", ["/tmp/script.py"])) {
    if (ev.stdout) process.stdout.write(ev.stdout);
    if (ev.stderr) process.stderr.write(ev.stderr);
    if (ev.error) console.error("agent error:", ev.error);
    if (ev.exit_code !== undefined) console.log(`(exited ${ev.exit_code})`);
  }
} finally {
  await sandbox.destroy();
  console.log("destroyed");
}
