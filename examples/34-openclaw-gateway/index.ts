/**
 * OpenClaw gateway over ingress — run a third-party HTTP service in a sandbox.
 *
 * Installs the OpenClaw AI-assistant gateway (Node.js) inside an FC sandbox,
 * exposes it on the public preview URL via HTTP ingress, then verifies it is
 * live by probing its OpenAI-compatible /v1/models endpoint — first from
 * inside the VM, then from this host through ingress. The pattern (install →
 * daemonize → waitForPortReady → fetch previewUrl) generalizes to any long-
 * running server you want reachable from outside the sandbox.
 *
 * Run:   bun 34-openclaw-gateway/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). OPENCLAW_GATEWAY_TOKEN
 *        is optional — a built-in demo token is used when unset.
 */
import { FcClient } from "fc-sandbox-sdk";

const GATEWAY_PORT = 18789;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "fc-openclaw-demo-token";

const baseUrl = process.env.FC_BASE_URL;
const fc = new FcClient(baseUrl ? { baseUrl } : {});

async function sh(
  sandbox: Awaited<ReturnType<(typeof fc)["createSandbox"]>>,
  label: string,
  script: string,
  timeoutMs = 120_000,
): Promise<string> {
  const { result } = await sandbox.runCommand("bash", ["-lc", script], { timeoutMs });
  if (result.exit_code !== 0) {
    console.error(`[${label}] exit=${result.exit_code}`);
    if (result.stdout) console.error("  stdout:", result.stdout.slice(-2000));
    if (result.stderr) console.error("  stderr:", result.stderr.slice(-2000));
    throw new Error(`Command "${label}" failed (exit ${result.exit_code})`);
  }
  return result.stdout;
}

// Stream a long-running command and print live output.
async function stream(
  sandbox: Awaited<ReturnType<(typeof fc)["createSandbox"]>>,
  label: string,
  script: string,
  timeoutMs = 300_000,
): Promise<void> {
  const events = sandbox.streamCommand("bash", ["-lc", script], { timeoutMs });
  for await (const ev of events) {
    if (ev.type === "stdout" && ev.data.trim()) process.stdout.write(`[${label}] ${ev.data}`);
    if (ev.type === "stderr" && ev.data.trim()) process.stderr.write(`[${label}] ${ev.data}`);
    if (ev.type === "exit" && ev.exitCode !== 0) {
      throw new Error(`Command "${label}" failed (exit ${ev.exitCode})`);
    }
  }
}

console.log("[1/6] creating sandbox with HTTP ingress…");
const sandbox = await fc.createSandbox({
  shape: "s-1vcpu-2gb",
  rootfs: "devbox:1",
  ingress_enabled: true,
  // Inject the gateway token so the process picks it up automatically.
  envs: { OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN },
});

// Force http:// — ingress TLS cert is not yet provisioned; http is forward-compatible.
const previewUrl = sandbox.previewUrl(GATEWAY_PORT).replace(/^https:\/\//, "http://");
console.log(`  sandbox: ${sandbox.id}`);
console.log(`  preview: ${previewUrl}`);

try {
  // ── step 2: ensure Node 24 ──────────────────────────────────────────────
  console.log("\n[2/6] checking Node.js version…");
  const nodeVer = await sh(sandbox, "node-ver", "node --version 2>/dev/null || echo 'missing'");
  const nodeMajor = parseInt(nodeVer.trim().replace(/^v/, ""), 10);
  console.log(`  found: ${nodeVer.trim()} (major=${nodeMajor})`);

  if (isNaN(nodeMajor) || nodeMajor < 22) {
    console.log("  Node < 22 — installing Node 24 via n…");
    await stream(
      sandbox,
      "node-install",
      [
        "set -e",
        "apt-get update -qq",
        "apt-get install -y -qq curl ca-certificates >/dev/null 2>&1",
        "curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n -o /usr/local/bin/n",
        "chmod +x /usr/local/bin/n",
        "n 24 2>&1",
      ].join("\n"),
      600_000,
    );
    const newVer = await sh(sandbox, "node-ver2", "node --version");
    console.log(`  upgraded to: ${newVer.trim()}`);
  }

  // ── step 3: install openclaw globally ──────────────────────────────────
  console.log("\n[3/6] installing openclaw globally (streaming)…");
  await stream(
    sandbox,
    "npm-install",
    // Increase npm memory limit for large installs; suppress audit noise.
    "NODE_OPTIONS='--max-old-space-size=512' npm install -g openclaw@latest --no-audit --no-fund 2>&1",
    600_000,
  );

  const ocVer = await sh(sandbox, "oc-ver", "openclaw --version 2>&1 || echo unknown");
  console.log(`  openclaw version: ${ocVer.trim()}`);

  // ── step 4: write minimal openclaw config ──────────────────────────────
  // --allow-unconfigured boots the gateway without a model configured.
  // Config sets auth token and binds to LAN so ingress can reach port 18789.
  console.log("\n[4/6] writing openclaw config and starting gateway…");
  await sh(
    sandbox,
    "write-config",
    [
      "mkdir -p ~/.openclaw",
      // Minimal JSON5 config: gateway token + LAN bind + no model required.
      `cat > ~/.openclaw/openclaw.json << 'EOF'`,
      `{`,
      `  gateway: {`,
      `    port: ${GATEWAY_PORT},`,
      `    bind: "lan",`,
      `    auth: { token: "${GATEWAY_TOKEN}" }`,
      `  }`,
      `}`,
      `EOF`,
    ].join("\n"),
  );

  // Daemonize with nohup setsid — no systemd in FC devbox:1.
  // Semicolon before nohup is mandatory: && would cause runCommand to hold
  // the stdout pipe and never return.
  await sh(
    sandbox,
    "gateway-start",
    `nohup setsid openclaw gateway --port ${GATEWAY_PORT} --bind lan --allow-unconfigured --verbose </dev/null >/tmp/openclaw.log 2>&1 & echo "started PID $!"`,
  );

  // ── step 5: wait for port + verify from inside ─────────────────────────
  console.log("\n[5/6] waiting for gateway to bind port…");
  await sandbox.waitForPortReady(GATEWAY_PORT, { timeoutMs: 90_000, host: "127.0.0.1" });
  console.log("  port 18789 accepting connections");

  // Inner probe: hit both unauthenticated root and auth-guarded /v1/models.
  const innerProbe = await sh(
    sandbox,
    "inner-probe",
    [
      `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${GATEWAY_PORT}/ || true`,
      `echo ""`,
      `curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer ${GATEWAY_TOKEN}' http://127.0.0.1:${GATEWAY_PORT}/v1/models || true`,
    ].join("\n"),
  );
  console.log(`  inner probe (root / /v1/models): ${innerProbe.trim()}`);

  // Tail the gateway log so we can see startup state.
  const gwLog = await sh(sandbox, "gw-log", "tail -n 30 /tmp/openclaw.log 2>/dev/null || true");
  if (gwLog.trim()) console.log("  gateway log tail:\n" + gwLog.trim());

  // ── step 6: probe public preview URL from host ─────────────────────────
  console.log(`\n[6/6] probing preview URL: ${previewUrl}`);
  const deadline = Date.now() + 60_000;
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${previewUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
        signal: AbortSignal.timeout(8_000),
      });
      lastStatus = res.status;
      lastBody = await res.text();
      if (lastStatus < 500) break;
    } catch {
      // connection refused / DNS not yet propagated — retry
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  console.log(`  HTTP ${lastStatus}`);
  console.log(`  body preview: ${lastBody.slice(0, 300)}`);
  console.log(`\nlive gateway: ${previewUrl}`);
} finally {
  console.log("\ncleanup…");
  await sandbox.destroy();
  console.log(`destroyed: ${sandbox.id}`);
}
