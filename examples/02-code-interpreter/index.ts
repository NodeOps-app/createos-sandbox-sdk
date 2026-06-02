/**
 * Code interpreter — upload a local Python script into the sandbox and run it,
 * capturing the full result. This is the buffered path and the default for the
 * example. A streaming variant lives in sdk-streaming.ts, but streaming exec
 * currently 404s on the control plane, so the buffered path is what works today.
 *
 * Run:   bun 02-code-interpreter/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). No external services.
 */
import { Sandbox } from "fc-sandbox-sdk";
import { readFile } from "node:fs/promises";

// 1. Read the script off the local disk, next to this file (not from cwd).
const script = await readFile(new URL("./script.py", import.meta.url));

// 2. Create the sandbox. 1 GB shape — Python's interpreter wants more than the
//    256 MB used by the trivial examples.
const sandbox = await Sandbox.create({
  shape: "s-1vcpu-1gb",
  rootfs: "devbox:1",
});
console.log("created:", sandbox.id);

try {
  // 3. Upload the script into the VM, then run it buffered (blocks until exit).
  await sandbox.files.upload("/tmp/script.py", script);
  console.log("--- output ---");
  const { result } = await sandbox.runCommand("python3", ["/tmp/script.py"]);
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.log(`(exited ${result.exit_code})`);
} finally {
  // 4. Always destroy.
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("destroyed");
}
