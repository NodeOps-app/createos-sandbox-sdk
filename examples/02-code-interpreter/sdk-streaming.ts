/**
 * Code interpreter, streaming variant — same upload-and-run as index.ts, but
 * consuming output live via streamCommand instead of buffering. This is how you
 * surface long-running output incrementally.
 *
 * BLOCKED: streaming exec currently 404s on the control plane, so this prints
 * `agent error: sandbox not found` until the streaming bug is fixed. index.ts
 * (the buffered path) is the working default; re-run this once the issue closes.
 *
 * Run:   bun 02-code-interpreter/sdk-streaming.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). No external services.
 */
import { Sandbox } from "fc-sandbox-sdk";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 1. Read the local script (next to this file) and create the sandbox.
const here = dirname(fileURLToPath(import.meta.url));
const script = await readFile(join(here, "script.py"));

const sandbox = await Sandbox.create({
  shape: "s-1vcpu-1gb",
  rootfs: "devbox:1",
});
console.log("created:", sandbox.id);

try {
  // 2. Upload, then stream. streamCommand yields a typed event per chunk as the
  //    process runs, rather than one buffered result at the end.
  await sandbox.files.upload("/tmp/script.py", script);
  console.log("--- streaming output ---");
  for await (const ev of sandbox.streamCommand("python3", ["/tmp/script.py"])) {
    // 3. Demux the event stream by type. stdout/stderr carry output chunks;
    //    exit carries the final code; heartbeat is a keep-alive (ignore it).
    switch (ev.type) {
      case "stdout":
        process.stdout.write(ev.data);
        break;
      case "stderr":
        process.stderr.write(ev.data);
        break;
      case "error":
        // The control-plane-side failure surfaces here (see the BLOCKED note above).
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
  // 4. Always destroy.
  await sandbox.destroy();
  console.log("destroyed");
}
