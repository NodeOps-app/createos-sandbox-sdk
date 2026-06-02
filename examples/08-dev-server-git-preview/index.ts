/**
 * Live dev-server preview — git-clone a repo, run `next dev` in the background,
 * and expose it on a public ingress URL. Shows the ingress flow end to end:
 * `ingress_enabled` at create time, `previewUrl(port)` for the public address,
 * a daemonised dev server (no systemd in a microVM), and `waitForPortReady`
 * to gate on the bind before handing out the link.
 *
 * Run:   bun 08-dev-server-git-preview/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). No external services.
 */
import { Sandbox } from "fc-sandbox-sdk";

// 1 vCPU is enough for next dev cold-compile; ingress required for public URL
const sandbox = await Sandbox.create({
  shape: "s-1vcpu-1gb",
  rootfs: "devbox:1",
  ingress_enabled: true,
});

console.log(`[1/5] sandbox: ${sandbox.id}`);
// Force http:// — ingress TLS cert is not yet provisioned; http is forward-compatible
const previewUrl = sandbox.previewUrl(3000, { scheme: "http" });
console.log(`      preview URL: ${previewUrl}`);

try {
  // Sparse-clone only the hello-world example from next.js canary.
  // --depth=1 --filter=blob:none --sparse keeps download under ~2 MB.
  console.log("[2/5] cloning next.js hello-world example...");
  await sandbox.runCommand("sh", [
    "-c",
    [
      "git clone --depth=1 --filter=blob:none --sparse https://github.com/vercel/next.js.git /app",
      "cd /app && git sparse-checkout set examples/hello-world",
      "cp -r /app/examples/hello-world /nextapp",
    ].join(" && "),
  ]);

  console.log("[3/5] installing dependencies...");
  await sandbox.runCommand("sh", ["-c", "cd /nextapp && npm install --prefer-offline"], {
    timeoutMs: 300_000,
  });

  // next dev binds 0.0.0.0 by default; nohup setsid daemonises without systemd
  console.log("[4/5] starting next dev on port 3000...");
  await sandbox.runCommand("sh", [
    "-c",
    "cd /nextapp && nohup setsid npx next dev -p 3000 > /var/log/nextdev.log 2>&1 &",
  ]);

  // Wait for next dev to bind :3000. Cold-compile still happens on first
  // hit through the preview URL — that's acceptable for a demo.
  console.log("[5/5] waiting for Next.js server to bind port 3000...");
  await sandbox.waitForPortReady(3000, { timeoutMs: 90_000 });
  console.log(`      server listening`);

  console.log(`\nlive preview: ${previewUrl}`);
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log(`destroyed: ${sandbox.id}`);
}
