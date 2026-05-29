// 28 — code-server (VS Code in Browser) inside an FC sandbox.
// Installs code-server inside an FC microVM, binds it on 0.0.0.0:8080
// with auth disabled, exposes it through the public ingress URL, and
// verifies the workbench is live by hitting GET /healthz.

import type { Sandbox } from "fc-sandbox-sdk";
import { FcClient } from "fc-sandbox-sdk";

const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";
const PORT = 8080;

// exactOptionalPropertyTypes: narrow env vars before passing to FcClient.
const baseUrl = process.env.FCSPAWN_URL;
const apiKey = process.env.FC_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set FCSPAWN_URL and FC_API_KEY (see .env.example)");
}

const fc = new FcClient({ baseUrl, apiKey });

async function sh(sb: Sandbox, label: string, script: string, timeoutMs = 120_000) {
  const { result, exec_ms } = await sb.runCommand("bash", ["-lc", script], { timeoutMs });
  if (result.exit_code !== 0) {
    console.log(`[${label}] exit=${result.exit_code} (${exec_ms} ms)`);
    if (result.stdout) console.log("  stdout:", result.stdout.slice(-2000));
    if (result.stderr) console.log("  stderr:", result.stderr.slice(-2000));
    throw new Error(`${label} failed (exit ${result.exit_code})`);
  }
  return result.stdout;
}

console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS}, ingress on)...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  ingress_enabled: true,
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

// Build the public ingress URL. Template yields https://<ulid>-<port>.<region>.<domain>.
// Downgrade to http:// — TLS wildcard cert is not yet provisioned; http:// is forward-compatible.
const previewUrl = sandbox.previewUrl(PORT).replace(/^https:/, "http:");
console.log(`      preview URL: ${previewUrl}`);

try {
  // Ensure curl is available (devbox:1 is Debian-based).
  console.log("[2/6] ensuring curl is available...");
  await sh(sandbox, "curl-check", "curl --version >/dev/null || apt-get install -y curl", 60_000);

  // Standalone install bundles the Node runtime — predictable, no PATH conflicts.
  // ~120-200 MB download; 300 s budget is sufficient on the FC egress link.
  console.log("[3/6] installing code-server (standalone, ~100-200 MB)...");
  await sh(
    sandbox,
    "install",
    "curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone",
    300_000,
  );

  // Extract the semver from `code-server --version` output (first line is the bare version).
  const codeServerVer =
    (await sh(sandbox, "version", "code-server --version 2>&1"))
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^\d+\.\d+/.test(l)) ?? "unknown";
  console.log(`      code-server ${codeServerVer}`);

  // Daemonise with nohup/setsid — devbox:1 has no systemd.
  // `;` before nohup so the chain does not hold the /exec stdout pipe open.
  // --auth none: no password prompt for a short-lived demo sandbox.
  // --bind-addr 0.0.0.0:PORT: required for ingress (127.0.0.1 is not reachable from outside the VM).
  console.log(`[4/6] daemonising code-server on port ${PORT}...`);
  await sh(
    sandbox,
    "boot",
    `rm -f /tmp/code-server.log ; ` +
      `nohup setsid code-server --bind-addr 0.0.0.0:${PORT} --auth none ` +
      `>/tmp/code-server.log 2>&1 </dev/null & sleep 1; echo launched`,
  );

  console.log(`[5/6] waiting for code-server to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 60_000 });
  console.log("      port is accepting connections");

  // Poll GET /healthz through the ingress URL until code-server responds.
  // /healthz is an auth-exempt route that returns JSON {"status":"success","data":{"up":true}}.
  console.log(`[6/6] polling ${previewUrl}/healthz for a live response...`);
  const deadline = Date.now() + 90_000;
  let healthBody = "";
  let healthStatus = 0;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${previewUrl}/healthz`, { signal: AbortSignal.timeout(10_000) });
      healthStatus = res.status;
      healthBody = await res.text();
      if (res.ok) {
        let json: { status?: string; data?: { up?: boolean } } = {};
        try {
          json = JSON.parse(healthBody);
        } catch {
          // not JSON yet — keep polling
        }
        if (json.data?.up === true) {
          healthy = true;
          break;
        }
      }
    } catch {
      // ingress propagation still in flight — keep polling
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  if (!healthy) {
    // Fetch the log for diagnostics before throwing.
    const log = await sh(sandbox, "log", "tail -40 /tmp/code-server.log").catch(
      () => "(unavailable)",
    );
    throw new Error(
      `GET /healthz never returned a live response (last HTTP ${healthStatus}).\n` +
        `Body: ${healthBody.slice(0, 300)}\ncode-server log:\n${log}`,
    );
  }

  let healthJson: { status?: string; data?: { up?: boolean } } = {};
  try {
    healthJson = JSON.parse(healthBody);
  } catch {
    // non-fatal — healthy flag already confirmed data.up === true
  }

  console.log(`\n── GET /healthz  (HTTP ${healthStatus}) ────────────────────────────────`);
  console.log("  ", JSON.stringify(healthJson));

  console.log(`\ncode-server is live at: ${previewUrl}`);
  console.log(`(open this URL in a browser to use VS Code in the sandbox)`);

  // Extract region from preview URL hostname for versions.txt output.
  const hostname = new URL(previewUrl).hostname;
  const region = hostname.split("-").slice(-1)[0]?.split(".").slice(1, -2).join(".") ?? "eu";
  console.log(`\n── versions (for versions.txt) ─────────────────────────────────`);
  console.log(`fc control plane: ${baseUrl} (region ${region})`);
  console.log(`code-server: ${codeServerVer}`);
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
