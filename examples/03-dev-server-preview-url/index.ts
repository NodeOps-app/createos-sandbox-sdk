/**
 * Dev server + preview URL — run an HTTP server inside the sandbox and reach it
 * from the public internet over per-sandbox ingress. The pattern behind serving
 * a live app preview (dev server, web UI) straight out of a microVM.
 *
 * Run:   bun 03-dev-server-preview-url/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). No external services.
 */
import { Sandbox } from "fc-sandbox-sdk";

// 1. Create with ingress on. ingress_enabled provisions a public hostname that
//    proxies to a port inside the VM; without it previewUrl has nothing to route.
const sandbox = await Sandbox.create({
  // tiny shape on purpose — this smoke test only serves a static page
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
  ingress_enabled: true,
});
console.log("created:", sandbox.id);

try {
  // 2. Start the server in the background. The trailing `>/tmp/srv.log 2>&1 &`
  //    detaches it and frees the terminal — without redirecting stdio, the
  //    buffered runCommand would block forever waiting for the process to exit.
  // devbox:1 has no systemd — daemonise with nohup/setsid.
  // Bind 0.0.0.0: ingress forwards to eth0, not loopback.
  await sandbox.runCommand("sh", [
    "-c",
    'mkdir -p /srv && echo "<h1>hello from fc preview URL</h1>" > /srv/index.html && cd /srv && nohup setsid python3 -m http.server 8080 --bind 0.0.0.0 >/tmp/srv.log 2>&1 &',
  ]);

  // 3. Wait for the port to accept connections — the server boots async, so
  //    fetching the URL immediately would race the listener.
  await sandbox.waitForPortReady(8080, { timeoutMs: 10_000 });

  // 4. Resolve the public URL for the port. The URL is HTTPS but the ingress
  //    serves a self-signed cert (issue #46 — not yet fronted by Cloudflare),
  //    so TLS verification is disabled for this smoke-test fetch only.
  const url = sandbox.previewUrl(8080);
  console.log("URL:", url);

  console.log("--- response ---");
  const res = await fetch(url, { tls: { rejectUnauthorized: false } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  process.stdout.write(await res.text());
} finally {
  // 5. Always destroy.
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("destroyed");
}
