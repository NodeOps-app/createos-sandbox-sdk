/**
 * Playwright + headless Chromium inside an FC sandbox to scrape a page.
 *
 * Installs Playwright and Chromium (with all OS-level deps) in a microVM,
 * uploads a scrape script, runs it headless against example.com, and parses
 * the extracted DOM (title, heading, paragraph, link count) back on the host.
 * Shows the "heavy browser toolchain in a disposable VM" pattern: the install
 * cost stays inside the sandbox and is torn down with it.
 *
 * Run:   bun 29-playwright-headless-browser/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). The scrape runs entirely
 *        inside the VM, so no ingress/gateway is involved (FCSPAWN_GATEWAY in
 *        .env.example is unused here).
 */
import type { Sandbox } from "fc-sandbox-sdk";
import { FcClient } from "fc-sandbox-sdk";

// Chromium needs >=1GB RAM; 2GB gives comfortable headroom for the
// browser process + system deps that --with-deps pulls.
const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";
const APP_DIR = "/app";

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

// 1. Create the sandbox. DEBIAN_FRONTEND=noninteractive keeps apt from
//    blocking on tzdata/debconf prompts when --with-deps pulls packages.
console.log(`[1/5] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  envs: { DEBIAN_FRONTEND: "noninteractive" },
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

try {
  // 2. Install Playwright into a local npm project (devbox:1 ships node/npm),
  //    so Playwright resolves from ${APP_DIR} rather than a global install.
  console.log("[2/5] creating project dir + installing Playwright...");
  await sh(
    sandbox,
    "init",
    `set -e
mkdir -p ${APP_DIR} && cd ${APP_DIR}
npm init -y >/dev/null`,
    60_000,
  );

  // playwright install --with-deps handles both the npm package and all
  // OS-level deps (fonts, libglib, libnss, etc.) via apt.
  // Generous timeout: pulls ~130 MB browser + many apt packages.
  await sh(
    sandbox,
    "playwright-install",
    `set -e
cd ${APP_DIR}
npm install playwright >/dev/null 2>&1
npx playwright install --with-deps chromium 2>&1 | tail -20`,
    600_000,
  );

  const pwVer = (
    await sh(
      sandbox,
      "playwright-ver",
      `cd ${APP_DIR} && node -e "const p=require('./node_modules/playwright/package.json'); console.log(p.version)"`,
    )
  ).trim();
  console.log(`      playwright: ${pwVer}`);

  // 3. Build the scrape script that Playwright will run inside the VM.
  const scrapeScript = `
const { chromium } = require('playwright');

(async () => {
  // --no-sandbox is required when running as root inside the microVM.
  // --disable-dev-shm-usage prevents crashes in low /dev/shm environments.
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  console.log('navigating to https://example.com ...');
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

  const title = await page.title();
  const heading = await page.locator('h1').first().innerText();
  const paragraph = await page.locator('p').first().innerText();

  // Demonstrate JavaScript evaluation inside the page context
  const linkCount = await page.evaluate(() => document.querySelectorAll('a').length);

  await browser.close();

  console.log(JSON.stringify({ title, heading, paragraph, linkCount }, null, 2));
})();
`;

  console.log("[3/5] uploading scrape script...");
  await sandbox.files.upload(`${APP_DIR}/scrape.js`, scrapeScript);

  // 4. Run the scrape. The script prints a JSON blob on stdout; we parse it
  //    back on the host below to verify the DOM was actually extracted.
  console.log("[4/5] running Playwright scrape of example.com...");
  const scrapeOut = await sh(sandbox, "scrape", `cd ${APP_DIR} && node scrape.js`, 120_000);
  console.log("── scrape output ────────────────────────────────────────────────");
  console.log(scrapeOut.trim());

  // Parse and validate the JSON output
  let scraped: { title?: string; heading?: string; paragraph?: string; linkCount?: number } = {};
  const jsonMatch = scrapeOut.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      scraped = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error(`scrape output is not valid JSON: ${scrapeOut.slice(0, 300)}`);
    }
  } else {
    throw new Error(`no JSON found in scrape output: ${scrapeOut.slice(0, 300)}`);
  }

  if (!scraped.title || !scraped.heading) {
    throw new Error(`missing title or heading in scraped data: ${JSON.stringify(scraped)}`);
  }

  console.log("\n── extracted content ────────────────────────────────────────────");
  console.log(`  title    : ${scraped.title}`);
  console.log(`  heading  : ${scraped.heading}`);
  console.log(`  paragraph: ${scraped.paragraph}`);
  console.log(`  links    : ${scraped.linkCount}`);

  // 5. Report the Chromium build Playwright installed (for the run summary).
  console.log("[5/5] checking Chromium version...");
  const chromiumVer = (
    await sh(
      sandbox,
      "chromium-ver",
      "chromium --version 2>/dev/null || chromium-browser --version 2>/dev/null || echo unknown",
    )
  ).trim();
  console.log(`      ${chromiumVer}`);

  console.log(
    `\nverified end-to-end: Playwright ${pwVer} scraped "${scraped.title}" from example.com`,
  );
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
