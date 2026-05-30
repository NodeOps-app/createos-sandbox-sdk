// 21 — Astro in a Sandbox.
// Scaffolds a minimal Astro site inside an FC microVM, installs its
// dependencies, runs `astro dev` as a daemon, exposes the dev server through
// the public ingress URL, and verifies the rendered HTML over that URL.

import { readFile } from "node:fs/promises";
import type { Sandbox } from "fc-sandbox-sdk";
import { FcClient } from "fc-sandbox-sdk";

const SHAPE = "s-2vcpu-2gb"; // astro/vite install + dev compile want real RAM
const ROOTFS = "devbox:1"; // ships Node 24 + npm — above Astro's engine floor
const PORT = 4321; // astro dev's default port
const APP_DIR = "/root/site";
const MARKER = "astro-on-fc-ok"; // emitted by src/pages/index.astro

// exactOptionalPropertyTypes: narrow env vars to strings before constructing
// the client, so no possibly-undefined value reaches an optional field.
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

const sitePkg = await readFile(new URL("./site/package.json", import.meta.url), "utf8");
const siteConfig = await readFile(new URL("./site/astro.config.mjs", import.meta.url), "utf8");
const sitePage = await readFile(new URL("./site/src/pages/index.astro", import.meta.url), "utf8");

console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS}, ingress on)...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  ingress_enabled: true,
  envs: { NODE_ENV: "development" },
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

// Build the ingress base URL up front so a missing ingress config fails fast.
// The template yields https://<ulid>-<port>.<region>.<domain>; the wildcard
// TLS cert is not provisioned yet, so downgrade to http:// (port 80,
// forward-compatible once TLS lands).
const previewUrl = sandbox.previewUrl(PORT).replace(/^https:/, "http:");
console.log(`      preview URL: ${previewUrl}`);

try {
  console.log("[2/6] uploading the Astro project...");
  await sh(sandbox, "mkdir", `mkdir -p ${APP_DIR}/src/pages`);
  await sandbox.files.upload(`${APP_DIR}/package.json`, sitePkg);
  await sandbox.files.upload(`${APP_DIR}/astro.config.mjs`, siteConfig);
  await sandbox.files.upload(`${APP_DIR}/src/pages/index.astro`, sitePage);

  console.log("[3/6] installing dependencies (npm install)...");
  await sh(sandbox, "npm-install", `cd ${APP_DIR} && npm install --no-audit --no-fund`, 300_000);
  const astroVersion = (
    await sh(
      sandbox,
      "astro-version",
      `cd ${APP_DIR} && node -p "require('astro/package.json').version"`,
    )
  ).trim();
  console.log(`      astro ${astroVersion}`);

  // devbox:1 has no systemd — daemonise with nohup/setsid and redirect stdio
  // so the buffered runCommand returns instead of hanging on the inherited
  // stdout pipe. --host 0.0.0.0 makes the dev server reachable via ingress
  // (127.0.0.1 would only reach through the agent tunnel).
  console.log(`[4/6] starting astro dev on port ${PORT} (daemonised)...`);
  await sh(
    sandbox,
    "boot",
    // `&` must background only the nohup command, not the whole `&&` chain,
    // or the subshell holds the /exec stdout pipe open and runCommand hangs.
    `cd ${APP_DIR} && rm -f astro.log; ` +
      `nohup setsid npx astro dev --host 0.0.0.0 --port ${PORT} ` +
      `>astro.log 2>&1 </dev/null & sleep 1; echo launched`,
  );

  console.log(`[5/6] waiting for astro dev to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 120_000 });
  console.log("      port is accepting connections");

  // Cold first-compile happens on the first request through the dev server,
  // and ingress routing may take a moment to propagate — poll the preview URL
  // until a real render comes back rather than fetching once.
  console.log("[6/6] fetching the preview URL until Astro renders...");
  const deadline = Date.now() + 120_000;
  let body = "";
  let status = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(previewUrl, { signal: AbortSignal.timeout(15_000) });
      status = res.status;
      body = await res.text();
      // Vite blocks non-local hosts with a "Blocked request" body; astro.config
      // sets allowedHosts: true, so a healthy render contains our marker.
      if (res.ok && body.includes(MARKER)) break;
    } catch {
      // ingress propagation / cold compile still in flight — keep polling
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  if (!body.includes(MARKER)) {
    const log = await sh(sandbox, "astro-log", `tail -40 ${APP_DIR}/astro.log`);
    throw new Error(
      `preview URL never rendered (last HTTP ${status}). Body head:\n` +
        `${body.slice(0, 300)}\nastro dev log:\n${log}`,
    );
  }

  console.log(`\n── preview response (HTTP ${status}) ────────────────────────────`);
  const titleMatch = body.match(/<title>([^<]*)<\/title>/i);
  const h1Match = body.match(/<h1[^>]*>([^<]*)<\/h1>/i);
  console.log(`  title: ${titleMatch?.[1] ?? "(none)"}`);
  console.log(`  h1:    ${h1Match?.[1] ?? "(none)"}`);
  console.log(`  marker present: ${body.includes(MARKER)}`);
  console.log(`  body bytes: ${body.length}`);

  console.log(`\nverified end-to-end: astro ${astroVersion} dev server reachable at ${previewUrl}`);
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
