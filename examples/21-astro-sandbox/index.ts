/**
 * Astro in a Sandbox.
 *
 * Scaffolds a minimal Astro site inside an FC microVM, installs its
 * dependencies, runs `astro dev` as a daemon, exposes the dev server through
 * the public ingress URL, and verifies the rendered HTML over that URL.
 *
 * Run:   bun 21-astro-sandbox/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY. The control plane must
 *        grant ingress for previewUrl() to resolve.
 */

import { readFile } from "node:fs/promises";
import { FcClient, FcTimeoutError, pollUntil } from "fc-sandbox-sdk";

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

// The Astro project lives in ./site (committed alongside this example); we read
// its three source files here and re-upload them into the sandbox below.
const sitePkg = await readFile(new URL("./site/package.json", import.meta.url), "utf8");
const siteConfig = await readFile(new URL("./site/astro.config.mjs", import.meta.url), "utf8");
const sitePage = await readFile(new URL("./site/src/pages/index.astro", import.meta.url), "utf8");

// 1. Create the sandbox with ingress enabled — required for a public preview URL.
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
// TLS cert is not provisioned yet, so request http:// (port 80,
// forward-compatible once TLS lands).
const previewUrl = sandbox.previewUrl(PORT, { scheme: "http" });
console.log(`      preview URL: ${previewUrl}`);

try {
  // 2. Upload the project files into the sandbox filesystem.
  console.log("[2/6] uploading the Astro project...");
  await sandbox.sh(`mkdir -p ${APP_DIR}/src/pages`, { label: "mkdir" });
  await sandbox.files.upload(`${APP_DIR}/package.json`, sitePkg);
  await sandbox.files.upload(`${APP_DIR}/astro.config.mjs`, siteConfig);
  await sandbox.files.upload(`${APP_DIR}/src/pages/index.astro`, sitePage);

  // 3. Install deps inside the VM.
  console.log("[3/6] installing dependencies (npm install)...");
  await sandbox.sh(`cd ${APP_DIR} && npm install --no-audit --no-fund`, {
    label: "npm-install",
    timeoutMs: 300_000,
  });
  const astroVersion = (
    await sandbox.sh(`cd ${APP_DIR} && node -p "require('astro/package.json').version"`, {
      label: "astro-version",
    })
  ).result.stdout.trim();
  console.log(`      astro ${astroVersion}`);

  // devbox:1 has no systemd — daemonise with nohup/setsid and redirect stdio
  // so the buffered runCommand returns instead of hanging on the inherited
  // stdout pipe. --host 0.0.0.0 makes the dev server reachable via ingress
  // (127.0.0.1 would only reach through the agent tunnel).
  // 4. Start the dev server as a daemon (see the nohup/host notes above).
  console.log(`[4/6] starting astro dev on port ${PORT} (daemonised)...`);
  await sandbox.sh(
    // `&` must background only the nohup command, not the whole `&&` chain,
    // or the subshell holds the /exec stdout pipe open and runCommand hangs.
    `cd ${APP_DIR} && rm -f astro.log; ` +
      `nohup setsid npx astro dev --host 0.0.0.0 --port ${PORT} ` +
      `>astro.log 2>&1 </dev/null & sleep 1; echo launched`,
    { label: "boot" },
  );

  // 5. Wait for the in-VM port to accept connections before reaching it.
  console.log(`[5/6] waiting for astro dev to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 120_000 });
  console.log("      port is accepting connections");

  // 6. Verify the render over the public ingress URL.
  // Cold first-compile happens on the first request through the dev server,
  // and ingress routing may take a moment to propagate — poll the preview URL
  // until a real render comes back rather than fetching once.
  console.log("[6/6] fetching the preview URL until Astro renders...");
  let body = "";
  let status = 0;
  try {
    await pollUntil({
      poll: async () => {
        try {
          const res = await fetch(previewUrl, { signal: AbortSignal.timeout(15_000) });
          status = res.status;
          body = await res.text();
          // Vite blocks non-local hosts with a "Blocked request" body; astro.config
          // sets allowedHosts: true, so a healthy render contains our marker.
          return res.ok && body.includes(MARKER);
        } catch {
          // ingress propagation / cold compile still in flight — keep polling
          return false;
        }
      },
      done: (ready) => ready,
      timeoutMs: 120_000,
    });
  } catch (err) {
    if (!(err instanceof FcTimeoutError)) throw err;
    const log = (await sandbox.sh(`tail -40 ${APP_DIR}/astro.log`, { label: "astro-log" })).result
      .stdout;
    throw new Error(
      `preview URL never rendered (last HTTP ${status}). Body head:\n` +
        `${body.slice(0, 300)}\nastro dev log:\n${log}`,
      { cause: err },
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
