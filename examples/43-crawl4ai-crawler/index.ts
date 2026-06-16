/**
 * Crawl4AI web crawler inside a createos-sandbox sandbox.
 *
 * Installs Crawl4AI and Playwright/Chromium (with all OS-level deps) in a
 * VM, runs an async crawl against a public URL, saves the Markdown output
 * to a file inside the sandbox, then downloads it back to the host. Shows the
 * "heavy browser toolchain in a disposable VM" pattern: the install cost stays
 * inside the sandbox and is torn down when done.
 *
 * Run:   bun 43-crawl4ai-crawler/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example). The crawl runs entirely
 *        inside the VM, so no ingress is involved.
 */
import { writeFile } from "node:fs/promises";
import { CreateosSandboxClient } from "createos-sandbox-sdk";

// Crawl4AI + Chromium need headroom: 4 GB keeps the install + browser
// process comfortable and avoids OOM during `playwright install --with-deps`.
const SHAPE = "s-4vcpu-4gb";
const ROOTFS = "devbox:1";
const TARGET_URL = process.env.CRAWL_URL ?? "https://example.com";
const OUTPUT_PATH = "/tmp/crawl_output.md";
const APP_DIR = "/app";

const baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL;
const apiKey = process.env.CREATEOS_SANDBOX_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set CREATEOS_SANDBOX_BASE_URL and CREATEOS_SANDBOX_API_KEY (see .env.example)");
}

const box = new CreateosSandboxClient({ baseUrl, apiKey });

console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await box.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  envs: { DEBIAN_FRONTEND: "noninteractive" },
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

try {
  // 2. Install Python tooling and Crawl4AI.
  //    crawl4ai[async] pulls in playwright as a Python dep; we also install
  //    the standalone playwright npm package so that `playwright install` is
  //    available from the CLI path for the Chromium browser + OS deps step.
  console.log("[2/6] installing Crawl4AI and dependencies (pip + npm)...");
  await sandbox.sh(
    `set -e
mkdir -p ${APP_DIR}
apt-get update -qq
apt-get install -y --no-install-recommends python3 python3-pip python3-venv npm
python3 -m venv /opt/crawl4ai-venv
/opt/crawl4ai-venv/bin/pip install --quiet "crawl4ai[async]"`,
    { label: "pip-install", timeoutMs: 600_000 },
  );

  const crawl4aiVer = (
    await sandbox.sh("/opt/crawl4ai-venv/bin/pip show crawl4ai | grep ^Version", {
      label: "crawl4ai-ver",
    })
  ).result.stdout.trim();
  console.log(`      crawl4ai: ${crawl4aiVer}`);

  // 3. Install Chromium browser + all OS-level deps via Playwright's own
  //    --with-deps flag. This runs apt inside the VM to pull fonts, NSS, etc.
  //    The venv's playwright CLI is used so the browser lands next to the
  //    Python package (not the npm copy), which is what crawl4ai imports.
  console.log("[3/6] installing Chromium via playwright --with-deps (apt + browser binary)...");
  await sandbox.sh(
    `/opt/crawl4ai-venv/bin/playwright install --with-deps chromium 2>&1 | tail -30`,
    { label: "playwright-install", timeoutMs: 600_000 },
  );

  const chromiumVer = (
    await sandbox.sh(
      "chromium --version 2>/dev/null || chromium-browser --version 2>/dev/null || echo unknown",
      { label: "chromium-ver" },
    )
  ).result.stdout.trim();
  console.log(`      ${chromiumVer}`);

  // 4. Build and upload the crawler script. chromium.launch needs
  //    --no-sandbox when running as root inside the VM.
  const crawlerScript = `import asyncio
import sys
from crawl4ai import AsyncWebCrawler, BrowserConfig

TARGET = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"

async def main():
    browser_cfg = BrowserConfig(
        browser_type="chromium",
        headless=True,
        # --no-sandbox required when running as root inside the VM
        extra_args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        result = await crawler.arun(url=TARGET)
    if not result.success:
        print(f"crawl failed: {result.error_message}", file=sys.stderr)
        sys.exit(1)
    print(result.markdown)

asyncio.run(main())
`;

  console.log("[4/6] uploading crawler script...");
  await sandbox.files.upload(`${APP_DIR}/crawl.py`, crawlerScript);

  // 5. Run the crawl. The script prints Markdown to stdout; we redirect to
  //    OUTPUT_PATH so we can download it cleanly without mixing logs.
  console.log(`[5/6] crawling ${TARGET_URL}...`);
  const crawlOut = await sandbox.sh(
    `/opt/crawl4ai-venv/bin/python3 ${APP_DIR}/crawl.py '${TARGET_URL}' > ${OUTPUT_PATH} 2>/tmp/crawl_stderr.txt; cat ${OUTPUT_PATH}`,
    { label: "crawl", timeoutMs: 180_000 },
  );

  if (crawlOut.result.exit_code !== 0) {
    const stderr = (await sandbox.sh("cat /tmp/crawl_stderr.txt", { label: "crawl-stderr" })).result
      .stdout;
    throw new Error(`crawl failed (exit ${crawlOut.result.exit_code}):\n${stderr}`);
  }

  const markdownOutput = crawlOut.result.stdout;
  if (!markdownOutput.trim()) {
    const stderr = (await sandbox.sh("cat /tmp/crawl_stderr.txt", { label: "crawl-stderr" })).result
      .stdout;
    throw new Error(`crawl produced no output. stderr:\n${stderr}`);
  }

  console.log("\n── crawled Markdown (first 800 chars) ───────────────────────────");
  console.log(markdownOutput.slice(0, 800));
  if (markdownOutput.length > 800) {
    console.log(`... (${markdownOutput.length} chars total)`);
  }

  // 6. Download the output file from the sandbox via the files API.
  console.log(`\n[6/6] downloading ${OUTPUT_PATH} from sandbox...`);
  const buf = await sandbox.files.download(OUTPUT_PATH);
  const localPath = "crawl_output.md";
  await writeFile(localPath, new Uint8Array(buf));
  console.log(`      saved to ${localPath} (${buf.byteLength} bytes)`);

  const lineCount = markdownOutput.split("\n").length;
  console.log(
    `\nverified end-to-end: ${crawl4aiVer} crawled "${TARGET_URL}" — ${lineCount} lines of Markdown`,
  );
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
