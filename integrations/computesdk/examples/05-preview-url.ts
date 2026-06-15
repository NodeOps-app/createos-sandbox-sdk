/**
 * 05 — Public preview URL (ingress).
 *
 * Sandboxes created with ingress enabled (the provider default) expose guest
 * ports on a public URL. Start a server inside the VM, then build its public
 * URL with the native handle's `previewUrl(port)` (reached via `getInstance()`).
 *
 *   CREATEOS_SANDBOX_API_KEY=usr_... CREATEOS_SANDBOX_BASE_URL=https://createos-sandbox.example.com \
 *     npx tsx 05-preview-url.ts
 */
import { createosSandbox } from "@computesdk/createos-sandbox";

async function main() {
  const provider = createosSandbox({});

  const sandbox = await provider.sandbox.create({ memoryMb: 1024, image: "devbox:1" });
  const native = sandbox.getInstance();
  console.log("created", native.id);

  try {
    // Serve /root on port 8080 in the background, then hand back its URL.
    await sandbox.runCommand("cd /root && python3 -m http.server 8080", { background: true });

    const url = native.previewUrl(8080);
    console.log("public URL:", url);
    console.log("open it (or curl it) while this sandbox lives to hit the server.");
  } finally {
    await sandbox.destroy();
    console.log("destroyed");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
