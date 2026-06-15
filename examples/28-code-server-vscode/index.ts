/**
 * code-server (VS Code in the browser) inside a createos-sandbox sandbox, reached over ingress.
 *
 * Installs code-server in a microVM, binds it on 0.0.0.0:8080 with auth
 * disabled, exposes that port through the sandbox's public ingress URL, and
 * proves the workbench is live by polling GET /healthz from the host. The
 * takeaway: any TCP server bound to 0.0.0.0 inside the VM becomes a public
 * URL via `sandbox.previewUrl(port)` — no SSH tunnel, no port mapping.
 *
 * Run:   bun 28-code-server-vscode/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example). Ingress is provisioned
 *        per-sandbox by the control plane — no gateway/tunnel host required.
 */
import {
  CreateosSandboxClient,
  CreateosSandboxTimeoutError,
  pollUntil,
} from "createos-sandbox-sdk";

const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";
const PORT = 8080;

// exactOptionalPropertyTypes: narrow env vars before passing to CreateosSandboxClient.
const baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL;
const apiKey = process.env.CREATEOS_SANDBOX_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set CREATEOS_SANDBOX_BASE_URL and CREATEOS_SANDBOX_API_KEY (see .env.example)");
}

const box = new CreateosSandboxClient({ baseUrl, apiKey });

// 1. Create the sandbox with ingress_enabled — this is what allocates the
//    public URL; without it previewUrl() would point at nothing routable.
console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS}, ingress on)...`);
const sandbox = await box.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  ingress_enabled: true,
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

// Build the public ingress URL. Template yields https://<ulid>-<port>.<region>.<domain>.
// Request http:// — TLS wildcard cert is not yet provisioned; http:// is forward-compatible.
const previewUrl = sandbox.previewUrl(PORT, { scheme: "http" });
console.log(`      preview URL: ${previewUrl}`);

try {
  // 2. Ensure curl is available (devbox:1 is Debian-based).
  console.log("[2/6] ensuring curl is available...");
  await sandbox.sh("curl --version >/dev/null || apt-get install -y curl", {
    label: "curl-check",
    timeoutMs: 60_000,
  });

  // 3. Install code-server. Standalone install bundles the Node runtime —
  //    predictable, no PATH conflicts. ~120-200 MB download; 300 s budget is
  //    sufficient on the createos-sandbox egress link.
  console.log("[3/6] installing code-server (standalone, ~100-200 MB)...");
  await sandbox.sh("curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone", {
    label: "install",
    timeoutMs: 300_000,
  });

  // Extract the semver from `code-server --version` output (first line is the bare version).
  const codeServerVer =
    (await sandbox.sh("code-server --version 2>&1", { label: "version" })).result.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^\d+\.\d+/.test(l)) ?? "unknown";
  console.log(`      code-server ${codeServerVer}`);

  // 4. Daemonise with nohup/setsid — devbox:1 has no systemd.
  // `;` before nohup so the chain does not hold the /exec stdout pipe open.
  // --auth none: no password prompt for a short-lived demo sandbox.
  // --bind-addr 0.0.0.0:PORT: required for ingress (127.0.0.1 is not reachable from outside the VM).
  console.log(`[4/6] daemonising code-server on port ${PORT}...`);
  await sandbox.sh(
    `rm -f /tmp/code-server.log ; ` +
      `nohup setsid code-server --bind-addr 0.0.0.0:${PORT} --auth none ` +
      `>/tmp/code-server.log 2>&1 </dev/null & sleep 1; echo launched`,
    { label: "boot" },
  );

  // 5. Wait for the bind to land. waitForPortReady probes from inside the VM,
  //    so it confirms the listener is up before we depend on ingress routing.
  console.log(`[5/6] waiting for code-server to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 60_000 });
  console.log("      port is accepting connections");

  // 6. Poll GET /healthz through the ingress URL until code-server responds.
  //    /healthz is an auth-exempt route that returns {"status":"success","data":{"up":true}}.
  //    The port can be bound (step 5) before ingress routing has propagated,
  //    so we retry the public URL here rather than asserting on the first hit.
  console.log(`[6/6] polling ${previewUrl}/healthz for a live response...`);
  let healthBody = "";
  let healthStatus = 0;
  let healthJson: { status?: string; data?: { up?: boolean } } = {};
  try {
    await pollUntil({
      poll: async () => {
        try {
          const res = await fetch(`${previewUrl}/healthz`, { signal: AbortSignal.timeout(10_000) });
          healthStatus = res.status;
          healthBody = await res.text();
          if (res.ok) {
            try {
              healthJson = JSON.parse(healthBody);
            } catch {
              // not JSON yet — keep polling
            }
          }
        } catch {
          // ingress propagation still in flight — keep polling
        }
        return healthJson.data?.up === true;
      },
      done: (healthy) => healthy,
      timeoutMs: 90_000,
    });
  } catch (err) {
    if (!(err instanceof CreateosSandboxTimeoutError)) throw err;
    // Fetch the log for diagnostics before throwing.
    const log = await sandbox
      .sh("tail -40 /tmp/code-server.log", { label: "log" })
      .then((r) => r.result.stdout)
      .catch(() => "(unavailable)");
    throw new Error(
      `GET /healthz never returned a live response (last HTTP ${healthStatus}).\n` +
        `Body: ${healthBody.slice(0, 300)}\ncode-server log:\n${log}`,
      { cause: err },
    );
  }

  console.log(`\n── GET /healthz  (HTTP ${healthStatus}) ────────────────────────────────`);
  console.log("  ", JSON.stringify(healthJson));

  console.log(`\ncode-server is live at: ${previewUrl}`);
  console.log(`(open this URL in a browser to use VS Code in the sandbox)`);

  // Extract region from preview URL hostname for versions.txt output.
  const hostname = new URL(previewUrl).hostname;
  const region = hostname.split("-").slice(-1)[0]?.split(".").slice(1, -2).join(".") ?? "eu";
  console.log(`\n── versions (for versions.txt) ─────────────────────────────────`);
  console.log(`createos-sandbox control plane: ${baseUrl} (region ${region})`);
  console.log(`code-server: ${codeServerVer}`);
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
