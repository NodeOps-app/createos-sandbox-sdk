/**
 * Headless Chrome with the remote-debugging (CDP) port exposed over ingress.
 *
 * Installs Google Chrome stable in an FC sandbox, launches it headless with the
 * Chrome DevTools Protocol port on 9222, then publishes it via the sandbox's
 * public ingress URL through an nginx reverse proxy on port 8080.
 *
 * The FC-specific twist is the nginx hop: Chrome's /json/* HTTP endpoints have
 * DNS-rebinding protection and reject any request whose Host header is a DNS
 * name. The ingress Host *is* the sandbox's public domain, so a direct proxy
 * would be refused. nginx fronts Chrome and rewrites Host to 127.0.0.1:9222
 * before proxying, which satisfies Chrome's check. The same trick applies to
 * any service that pins/validates Host but must be reached over ingress.
 *
 * Proof: GET /json/version through the public URL returns JSON with a `Browser`
 * field (e.g. "Chrome/148…"), confirming remote debugging is live.
 *
 * Run:   bun 30-headless-chromium-devtools/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). Ingress is provisioned
 *        per-sandbox by the control plane — no gateway/tunnel host required.
 */
import type { Sandbox } from "fc-sandbox-sdk";
import { FcClient } from "fc-sandbox-sdk";

const SHAPE = "s-1vcpu-2gb";
const ROOTFS = "devbox:1";
const CDP_PORT = 9222;
const PROXY_PORT = 8080;

// exactOptionalPropertyTypes: narrow to string before passing to FcClient.
const baseUrl = process.env.FC_BASE_URL;
const apiKey = process.env.FC_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set FC_BASE_URL and FC_API_KEY (see .env.example)");
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

// 1. Create with ingress_enabled so previewUrl(8080) resolves to a public URL.
//    DEBIAN_FRONTEND=noninteractive stops apt blocking on debconf prompts.
console.log(`[1/8] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS}, ingress on)...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  ingress_enabled: true,
  envs: { DEBIAN_FRONTEND: "noninteractive" },
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

// Ingress URL template: http://<ulid>-<port>.<region>.<domain>
// Use http:// — https cert is not provisioned; http is forward-compatible.
const previewUrl = sandbox.previewUrl(PROXY_PORT).replace(/^https:/, "http:");
console.log(`      preview URL: ${previewUrl}`);

try {
  // 2. Install Chrome's shared-library deps + nginx. Ubuntu 24.04 (Noble)
  //    ships chromium as a snap-only wrapper — unusable in a microVM — so we
  //    pull Google Chrome stable from the official .deb in step 3 instead.
  console.log("[2/8] installing Chrome deps + nginx (apt-get)...");
  await sh(
    sandbox,
    "apt",
    "apt-get update -qq && " +
      "apt-get install -y --no-install-recommends wget curl nginx " +
      "fonts-liberation libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 " +
      "libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 " +
      "libglib2.0-0t64 libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 " +
      "libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 " +
      "libxkbcommon0 libxrandr2 xdg-utils",
    300_000,
  );

  // 3. Download + install Chrome stable from the official .deb.
  console.log("[3/8] downloading + installing Google Chrome stable...");
  await sh(
    sandbox,
    "chrome-install",
    // dpkg may exit 1 on optional dependency warnings but Chrome binary is installed
    "wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" +
      " && (dpkg -i /tmp/google-chrome.deb || true)" +
      " && google-chrome-stable --version",
    300_000,
  );

  const chromeVer = (
    await sh(sandbox, "chrome-version", "google-chrome-stable --version 2>/dev/null | head -1")
  ).trim();
  console.log(`      ${chromeVer}`);

  // 4. Write the nginx config. Chrome's /json/* endpoints reject DNS-name Host
  //    headers (DNS-rebinding protection). nginx listens on 0.0.0.0:8080
  //    (reachable by ingress) and rewrites Host to the IP literal before
  //    proxying to Chrome's 127.0.0.1:9222 — that is what makes CDP reachable.
  console.log("[4/8] writing nginx reverse proxy config...");
  const nginxConf = [
    "server {",
    `    listen 0.0.0.0:${PROXY_PORT};`,
    "    location / {",
    `        proxy_pass         http://127.0.0.1:${CDP_PORT};`,
    // Rewrite Host to IP literal — Chrome accepts this; rejects DNS names
    `        proxy_set_header   Host 127.0.0.1:${CDP_PORT};`,
    "        proxy_set_header   X-Real-IP $remote_addr;",
    // Forward WebSocket upgrades for CDP WS connections
    "        proxy_http_version 1.1;",
    "        proxy_set_header   Upgrade $http_upgrade;",
    '        proxy_set_header   Connection "upgrade";',
    "    }",
    "}",
  ].join("\n");

  await sandbox.files.upload("/etc/nginx/sites-available/cdp-proxy", nginxConf);
  await sh(
    sandbox,
    "nginx-enable",
    [
      "rm -f /etc/nginx/sites-enabled/default",
      "ln -sf /etc/nginx/sites-available/cdp-proxy /etc/nginx/sites-enabled/cdp-proxy",
      "nginx -t",
    ].join(" && "),
  );

  // 5. Launch Chrome headless. Flags required in a microVM running as root:
  //   --no-sandbox          — Chrome refuses to start as root without this
  //   --disable-dev-shm-usage — prevents OOM on the small /dev/shm
  //   --disable-gpu         — no GPU in the microVM
  //   --remote-allow-origins=* — allow WebSocket CDP connections from any Origin
  // Daemonize with (; nohup setsid) — && would keep the pipe open and block runCommand.
  console.log(`[5/8] launching Google Chrome headless on CDP port ${CDP_PORT}...`);
  await sh(
    sandbox,
    "chrome-start",
    `rm -f /tmp/chrome.log; ` +
      `nohup setsid google-chrome-stable ` +
      `--headless=new ` +
      `--no-sandbox ` +
      `--disable-dev-shm-usage ` +
      `--disable-gpu ` +
      `--user-data-dir=/tmp/chrome-data ` +
      `--remote-debugging-port=${CDP_PORT} ` +
      `--remote-allow-origins='*' ` +
      `>/tmp/chrome.log 2>&1 </dev/null & ` +
      `sleep 3; echo launched`,
  );

  // 6. Start nginx after Chrome is up (so it has a backend to proxy to).
  console.log("[6/8] starting nginx proxy...");
  await sh(
    sandbox,
    "nginx-start",
    `nohup setsid nginx -g 'daemon off;' >/tmp/nginx.log 2>&1 </dev/null & sleep 1; echo launched`,
  );

  // 7. Confirm nginx is listening (probed from inside the VM) before we start
  //    hitting the public URL.
  console.log(`[7/8] waiting for nginx proxy to bind port ${PROXY_PORT}...`);
  await sandbox.waitForPortReady(PROXY_PORT, { timeoutMs: 30_000 });
  console.log("      port is accepting connections");

  // 8. Poll the ingress URL's /json/version until Chrome's CDP endpoint replies.
  //    Ingress routing may take a moment to propagate after waitForPortReady,
  //    so this retries rather than asserting on the first request.
  console.log("[8/8] polling /json/version through the ingress URL...");
  const versionUrl = `${previewUrl}/json/version`;
  const deadline = Date.now() + 60_000;
  let versionBody = "";
  let lastStatus = 0;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(versionUrl, { signal: AbortSignal.timeout(10_000) });
      lastStatus = res.status;
      versionBody = await res.text();
      if (res.ok && versionBody.includes("Browser")) break;
    } catch {
      // ingress propagation still in flight — keep polling
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  if (!versionBody.includes("Browser")) {
    const chromeLog = await sh(sandbox, "log-chrome", "tail -40 /tmp/chrome.log").catch(
      () => "(unavailable)",
    );
    const nginxLog = await sh(sandbox, "log-nginx", "tail -20 /tmp/nginx.log").catch(
      () => "(unavailable)",
    );
    throw new Error(
      `GET /json/version never returned a Browser field (last HTTP ${lastStatus}).\n` +
        `Body: ${versionBody.slice(0, 400)}\n` +
        `chrome log:\n${chromeLog}\n` +
        `nginx log:\n${nginxLog}`,
    );
  }

  let versionJson: {
    Browser?: string;
    "Protocol-Version"?: string;
    webSocketDebuggerUrl?: string;
  } = {};
  try {
    versionJson = JSON.parse(versionBody);
  } catch {
    throw new Error(`/json/version did not return valid JSON: ${versionBody.slice(0, 400)}`);
  }

  console.log(`\n── GET /json/version  (HTTP ${lastStatus}) ──────────────────────────────`);
  console.log("  Browser:             ", versionJson.Browser);
  console.log("  Protocol-Version:    ", versionJson["Protocol-Version"]);
  console.log("  webSocketDebuggerUrl:", versionJson.webSocketDebuggerUrl);

  // Also fetch /json/list to show open debugging targets
  const listRes = await fetch(`${previewUrl}/json/list`, { signal: AbortSignal.timeout(10_000) });
  let listJson: unknown[] = [];
  try {
    listJson = await listRes.json();
  } catch {
    // non-fatal
  }
  console.log(`\n── GET /json/list  (HTTP ${listRes.status}, ${listJson.length} target(s)) ──`);
  if (listJson.length > 0) {
    const first = listJson[0] as Record<string, unknown>;
    console.log("  type:", first["type"]);
    console.log("  url:", first["url"]);
  }

  console.log(
    `\nverified end-to-end: ${versionJson.Browser} reachable at ${previewUrl}/json/version`,
  );
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
