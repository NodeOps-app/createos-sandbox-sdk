// 17 — Analyze data with AI. Upload a CSV into an FC sandbox, let Claude
// write the pandas/matplotlib analysis from the file's real schema, run it
// inside the VM, then read the rendered chart PNG back out to the host.
//
// The point is the files API binary round-trip: a text CSV goes in, a binary
// PNG comes back. That is the difference from example 02's stdout-only code
// interpreter — here a real artifact crosses the sandbox boundary in both
// directions, and the host verifies it by checking the PNG magic bytes.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { FcClient, FcValidationError, type Sandbox } from "fc-sandbox-sdk";

const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";

const HERE = new URL("./", import.meta.url).pathname;
const OUTPUT_DIR = `${HERE}output/`;

const CSV_PATH = "/root/sample.csv";
const SCRIPT_PATH = "/root/analyze.py";
const CHART_PATH = "/root/output/chart.png";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
if (!ANTHROPIC_BASE_URL || !ANTHROPIC_AUTH_TOKEN) {
  console.error("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN must be set (see .env.example).");
  process.exit(1);
}

const anthropic = new Anthropic({
  baseURL: ANTHROPIC_BASE_URL,
  authToken: ANTHROPIC_AUTH_TOKEN,
});

const fc = new FcClient();

async function createWithRetry() {
  const name = `analyze-${Date.now().toString(36).slice(-6)}`;
  const opts = {
    shape: SHAPE,
    rootfs: ROOTFS,
    name,
    envs: { DEBIAN_FRONTEND: "noninteractive", MPLBACKEND: "Agg" },
  };
  const maxAttempts = 6;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await fc.createSandbox(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retriable =
        err instanceof FcValidationError ||
        /cap|quota|limit|too many|capacity|unavailable|503|502/i.test(msg);
      if (!retriable || i === maxAttempts) throw err;
      const wait = 30_000 * i;
      console.warn(
        `create attempt ${i}/${maxAttempts} failed (${msg.slice(0, 80)}); waiting ${wait / 1000}s…`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("unreachable");
}

async function sh(sb: Sandbox, label: string, script: string, timeoutMs = 180_000) {
  const { result, exec_ms } = await sb.runCommand("bash", ["-lc", script], { timeoutMs });
  if (result.exit_code !== 0) {
    console.log(`[${label}] exit=${result.exit_code} (${exec_ms} ms)`);
    if (result.stdout) console.log("  stdout:", result.stdout.slice(-2000));
    if (result.stderr) console.log("  stderr:", result.stderr.slice(-2000));
    throw new Error(`${label} failed (exit ${result.exit_code})`);
  }
  return result.stdout;
}

// Claude often wraps code in ```python fences and adds prose. Pull out the
// first fenced block when present, otherwise trust the whole response.
function extractPython(raw: string): string {
  const fenced = raw.match(/```(?:python)?\s*\n([\s\S]*?)```/);
  return (fenced?.[1] ?? raw).trim();
}

async function generateAnalysis(header: string, sampleRows: string): Promise<string> {
  const prompt =
    "You are given a CSV file inside a Linux sandbox at the absolute path " +
    `${CSV_PATH}. Its header row and first data rows are:\n\n` +
    `${header}\n${sampleRows}\n\n` +
    "Write a single self-contained Python 3 script that:\n" +
    `1. Reads the CSV with pandas from "${CSV_PATH}".\n` +
    "2. Computes a meaningful aggregation suited to these columns (group/sum/mean).\n" +
    '3. Uses matplotlib with the non-interactive "Agg" backend ' +
    '(call matplotlib.use("Agg") before importing pyplot) to render one ' +
    "informative chart with a title and axis labels.\n" +
    `4. Saves the chart as a PNG to exactly "${CHART_PATH}" ` +
    "(create the parent directory with os.makedirs(..., exist_ok=True)).\n" +
    "5. Prints a short plain-text summary of the aggregation to stdout.\n\n" +
    "Constraints: standard library + pandas + matplotlib only, no network " +
    "access, no command-line arguments. Output ONLY the Python code, nothing else.";

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return extractPython(raw);
}

const sandbox = await createWithRetry();
console.log(`sandbox: ${sandbox.id}  ip: ${sandbox.ip}  shape: ${SHAPE}`);

try {
  console.log(`[1/6] uploading ${CSV_PATH} (binary round-trip: CSV in)…`);
  const csvBytes = await readFile(`${HERE}sample.csv`);
  await sandbox.files.upload(CSV_PATH, new Uint8Array(csvBytes));
  const csvText = new TextDecoder().decode(csvBytes);
  const lines = csvText.trim().split("\n");
  const header = lines[0] ?? "";
  const sampleRows = lines.slice(1, 4).join("\n");
  console.log(`      header: ${header}`);
  console.log(`      uploaded ${csvBytes.byteLength} bytes`);

  console.log("[2/6] asking Claude to generate the analysis from the schema…");
  const code = await generateAnalysis(header, sampleRows);
  console.log("\n── generated analysis (analyze.py) ──────────────────────────");
  console.log(code);
  console.log("─────────────────────────────────────────────────────────────\n");
  await sandbox.files.upload(SCRIPT_PATH, code);

  console.log("[3/6] installing python3 + pandas + matplotlib (detached)…");
  // pip install of pandas+matplotlib is multi-minute. Run it detached and
  // poll a marker file so we never hold a single command open long enough to
  // trip an upstream gateway timeout (502), mirroring example 13.
  await sh(
    sandbox,
    "apt",
    "apt-get update -qq && " +
      "apt-get install -y --no-install-recommends python3 python3-pip ca-certificates >/dev/null",
    300_000,
  );
  await sh(
    sandbox,
    "pip-launch",
    "cat >/root/install.sh <<'SH'\n" +
      "#!/bin/bash\n" +
      "set -e\n" +
      "pip3 install --no-cache-dir --break-system-packages pandas==2.3.3 matplotlib==3.10.7\n" +
      "python3 -c \"import pandas, matplotlib; print('pandas', pandas.__version__, 'matplotlib', matplotlib.__version__)\"\n" +
      "echo OK >/root/install.done\n" +
      "SH\n" +
      "chmod +x /root/install.sh\n" +
      "nohup setsid bash /root/install.sh >/root/install.log 2>&1 </dev/null &\n" +
      "sleep 1; echo launched",
  );
  const deadline = Date.now() + 600_000;
  let installed = false;
  while (Date.now() < deadline) {
    const probe = await sh(
      sandbox,
      "pip-poll",
      "if [ -f /root/install.done ]; then echo done; " +
        "elif pgrep -f install.sh >/dev/null; then echo running; " +
        "else echo dead; fi; " +
        "tail -1 /root/install.log 2>/dev/null || true",
      30_000,
    );
    const state = probe.split("\n")[0]?.trim();
    const tail = probe.split("\n").slice(1).join(" ").slice(-120);
    if (state === "done") {
      installed = true;
      break;
    }
    if (state === "dead") {
      const log = await sh(sandbox, "install-log", "tail -60 /root/install.log");
      throw new Error(`pip install died:\n${log}`);
    }
    console.log(`      pip: ${state}  ${tail}`);
    await new Promise((r) => setTimeout(r, 12_000));
  }
  if (!installed) {
    const log = await sh(sandbox, "install-log", "tail -80 /root/install.log");
    throw new Error(`pip install did not finish within 10 min:\n${log}`);
  }
  console.log("      pip install done");

  console.log("[4/6] running the generated analysis inside the sandbox…");
  const runOut = await sh(sandbox, "analyze", "cd /root && python3 analyze.py", 180_000);
  console.log("\n── analysis stdout ──────────────────────────────────────────");
  console.log(runOut.trim());
  console.log("─────────────────────────────────────────────────────────────\n");

  console.log(`[5/6] reading ${CHART_PATH} back out (binary round-trip: PNG out)…`);
  const pngBytes = await sandbox.files.download(CHART_PATH);
  const png = new Uint8Array(pngBytes);
  // Validate the PNG magic so we prove a real binary artifact crossed back,
  // not an error page or an empty file.
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const validPng = PNG_MAGIC.every((b, i) => png[i] === b);
  if (!validPng) {
    throw new Error(`downloaded file is not a PNG (first bytes: ${png.slice(0, 8).join(",")})`);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = `${OUTPUT_DIR}chart.png`;
  await writeFile(outPath, png);
  console.log(`      saved ${outPath} (${png.byteLength} bytes, valid PNG header)`);

  console.log("[6/6] also saving the generated script to ./output/analyze.py…");
  await writeFile(`${OUTPUT_DIR}analyze.py`, code);

  console.log("\nverified end-to-end: CSV uploaded, analysis generated + run, PNG read back.");
} finally {
  console.log("\ncleanup…");
  // Retry destroy through transient 5xx — orphans cost capacity shared with
  // the sibling examples.
  for (let i = 1; i <= 4; i++) {
    try {
      await sandbox.destroy();
      console.log(`destroyed sandbox: ${sandbox.id}`);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === 4) {
        console.error(`destroy failed (gave up after 4 attempts): ${msg}`);
      } else {
        console.warn(`destroy attempt ${i} failed (${msg.slice(0, 80)}); retrying in ${10 * i}s…`);
        await new Promise((r) => setTimeout(r, 10_000 * i));
      }
    }
  }
}
