/**
 * 03 — Streaming command output.
 *
 * `runCommand` buffers stdout until the process exits. For long-running or
 * chatty commands, the native handle's `streamCommand` yields stdout/stderr
 * frames as they arrive. Streaming is a native createos-sandbox-sdk feature, so
 * this example uses the provider directly and reaches it via `getInstance()`.
 *
 *   CREATEOS_SANDBOX_API_KEY=usr_... CREATEOS_SANDBOX_BASE_URL=https://createos-sandbox.example.com \
 *     npx tsx 03-stream-command.ts
 */
import { createosSandbox } from "@computesdk/createos-sandbox";

async function main() {
  const provider = createosSandbox({});

  const sandbox = await provider.sandbox.create({ memoryMb: 1024, image: "devbox:1" });
  const native = sandbox.getInstance();
  console.log("created", native.id);

  try {
    // Emit a line a second for five seconds, watching frames land live.
    for await (const event of native.streamCommand("sh", [
      "-c",
      "for i in 1 2 3 4 5; do echo line $i; sleep 1; done",
    ])) {
      switch (event.type) {
        case "stdout":
          process.stdout.write(event.data);
          break;
        case "stderr":
          process.stderr.write(event.data);
          break;
        case "exit":
          console.log("exit:", event.exitCode);
          break;
        case "error":
          console.error("stream error:", event.message);
          break;
        // "heartbeat" frames keep the connection alive; ignore them.
      }
    }
  } finally {
    await sandbox.destroy();
    console.log("destroyed");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
