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
    switch (ev.type) {
      case "stdout":
        process.stdout.write(ev.data);
        break;
      case "stderr":
        process.stderr.write(ev.data);
        break;
      case "error":
        console.error("agent error:", ev.message);
        break;
      case "exit":
        console.log(`(exited ${ev.exitCode})`);
        break;
      case "heartbeat":
        break;
    }
  }
} finally {
  await sandbox.destroy();
  console.log("destroyed");
}
