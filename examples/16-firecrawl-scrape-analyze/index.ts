/**
 * Firecrawl scrape → Claude analysis → chart, end-to-end through an FC sandbox.
 *
 * Scrapes a rental-listings page with Firecrawl (host side, plain `fetch`),
 * asks Claude to write a pandas/matplotlib analysis script against a fixed JSON
 * schema, uploads the scraped records + the generated script into one FC
 * sandbox, installs pandas + matplotlib, runs the analysis to produce a price
 * chart PNG, and downloads the chart + summary back to ./output/. The Firecrawl
 * key is optional: when it is absent (or the scrape fails) the example falls
 * back to the bundled sample-listings.json so the FC / Claude / chart path
 * still runs. The chosen data source is reported in the output and the summary.
 *
 * Run:   bun 16-firecrawl-scrape-analyze/index.ts
 * Needs: CREATEOS_SANDBOX_API_KEY + ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL (Claude writes the
 *        code). FIRECRAWL_API_KEY optional — falls back to a bundled fixture.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { CreateosSandboxClient, CreateosSandboxValidationError } from "createos-sandbox-sdk";

const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";
const OUTPUT_DIR = new URL("./output/", import.meta.url).pathname;
const FIXTURE = new URL("./sample-listings.json", import.meta.url).pathname;

// A real listings page to scrape when a Firecrawl key is present. Any page
// that renders rental cards works; the markdown is fed to Claude alongside
// the schema and Claude extracts structured records into the fixture shape.
const SCRAPE_URL = process.env.SCRAPE_URL ?? "https://www.airbnb.com/s/Lisbon--Portugal/homes";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const FIRECRAWL_API_URL = process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev";

// The contract every Listing must satisfy. Both the scrape-extraction prompt
// and the analysis prompt reference this shape so the data is consistent
// whether it comes from Firecrawl or the fixture.
interface Listing {
  title: string;
  neighborhood: string;
  room_type: string;
  price_per_night: number;
  rating: number;
  reviews: number;
  beds: number;
}

const anthropic = new Anthropic();
const fc = new CreateosSandboxClient();

// ── 1. Acquire listings ────────────────────────────────────────────────
//
// Firecrawl returns page markdown; Claude turns that markdown into an array
// of Listing records. On any failure we fall back to the bundled fixture.

async function firecrawlScrape(url: string): Promise<string> {
  const res = await fetch(`${FIRECRAWL_API_URL}/v2/scrape`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  if (!res.ok) {
    throw new Error(`firecrawl ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { success?: boolean; data?: { markdown?: string } };
  const markdown = body.data?.markdown;
  if (!markdown) throw new Error("firecrawl returned no markdown");
  return markdown;
}

function stripFences(text: string): string {
  // Models wrap replies in ```json / ```python fences, sometimes with extra
  // prose or stray fence lines around them. Grab the body of the FIRST fenced
  // block (greedy to the LAST closing fence so trailing guards are dropped);
  // if there is no fence, drop any leftover lines that are only backticks.
  const fenced = text.match(/```(?:json|python)?\s*\n([\s\S]*)\n```/);
  const body = fenced?.[1] ?? text;
  return body
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .trim();
}

// Reasoning-style models spend output budget on an internal thinking block
// before they emit any text. A budget too small for "think + answer" returns
// zero text blocks, so give the call generous headroom (a few hundred records
// of JSON plus the thinking pass fit well under this).
const MAX_TOKENS = 16_000;

function firstText(reply: Anthropic.Message, what: string): string {
  const block = reply.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    const shape = reply.content.map((b) => b.type).join("+") || "empty";
    throw new Error(
      `model returned no text for ${what} (stop=${reply.stop_reason}, blocks=[${shape}])`,
    );
  }
  return block.text;
}

async function extractListings(markdown: string): Promise<Listing[]> {
  const reply = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content:
          "Below is the markdown of a short-stay rental listings page. Extract every " +
          "listing you can find into a JSON array. Each element MUST have exactly these " +
          "keys: title (string), neighborhood (string), room_type (string), " +
          "price_per_night (number, the nightly price in the page currency, no symbol), " +
          "rating (number 0-5), reviews (integer), beds (integer). If a field is missing " +
          "for a listing, make a reasonable estimate from context. Reply with the JSON " +
          "array ONLY — no markdown fences, no prose.\n\n--- PAGE MARKDOWN ---\n" +
          markdown.slice(0, 60_000),
      },
    ],
  });
  const parsed = JSON.parse(stripFences(firstText(reply, "extraction"))) as Listing[];
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("no listings extracted");
  return parsed;
}

async function acquireListings(): Promise<{ source: string; listings: Listing[] }> {
  if (FIRECRAWL_API_KEY) {
    try {
      console.log(`      scraping ${SCRAPE_URL} via Firecrawl…`);
      const markdown = await firecrawlScrape(SCRAPE_URL);
      console.log(`      scraped ${markdown.length} chars of markdown; extracting records…`);
      const listings = await extractListings(markdown);
      return { source: `firecrawl:${SCRAPE_URL}`, listings };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`      Firecrawl path failed (${msg}); falling back to fixture.`);
    }
  } else {
    console.log("      FIRECRAWL_API_KEY not set — using bundled sample-listings.json.");
  }
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as { listings: Listing[] };
  return { source: "fixture:sample-listings.json", listings: fixture.listings };
}

// ── 2. Claude writes the analysis script ───────────────────────────────

const ANALYSIS_PROMPT =
  "Write a Python 3 script for a rental-listings price analysis. Hard requirements:\n" +
  "- Read JSON from the exact path /root/listings.json. Its shape is " +
  '{"listings": [{"title","neighborhood","room_type","price_per_night","rating","reviews","beds"}]}.\n' +
  "- Load it into a pandas DataFrame.\n" +
  '- Use matplotlib with the Agg backend: call matplotlib.use("Agg") BEFORE importing pyplot.\n' +
  "- Produce ONE figure: a bar chart of the MEAN price_per_night per neighborhood, " +
  "sorted descending, with value labels on the bars, a title, and axis labels.\n" +
  "- Save the figure to the exact path /root/price_chart.png at dpi=120 with " +
  "bbox_inches='tight'. You MUST call plt.savefig with that exact path.\n" +
  "- Also print a one-line-per-neighborhood summary (neighborhood, count, mean price " +
  "rounded to 2dp) and a final line 'OVERALL median price: <value>'.\n" +
  "- Use only pandas and matplotlib (plus stdlib json). No seaborn, no network, no input().\n" +
  "Reply with the Python source ONLY — no markdown fences, no prose.";

async function generateAnalysis(): Promise<string> {
  const reply = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: ANALYSIS_PROMPT }],
  });
  const code = stripFences(firstText(reply, "analysis"));
  if (code.includes("```")) throw new Error("generated script still contains markdown fences");
  if (!code.includes("savefig")) throw new Error("generated script never calls savefig");
  return code;
}

// ── sandbox helpers (mirror sibling examples) ──────────────────────────

async function createWithRetry() {
  const name = `firecrawl-${Date.now().toString(36).slice(-6)}`;
  const opts = { shape: SHAPE, rootfs: ROOTFS, name, envs: { DEBIAN_FRONTEND: "noninteractive" } };
  const maxAttempts = 6;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await fc.createSandbox(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retriable =
        err instanceof CreateosSandboxValidationError ||
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

// ── main ───────────────────────────────────────────────────────────────

console.log("[1/6] acquiring listings…");
const { source, listings } = await acquireListings();
console.log(`      ${listings.length} listings from ${source}`);

console.log("[2/6] asking Claude to write the analysis script…");
const [analysisCode] = await Promise.all([
  generateAnalysis(),
  mkdir(OUTPUT_DIR, { recursive: true }),
]);
await writeFile(`${OUTPUT_DIR}analysis.py`, analysisCode);
console.log(
  `      generated ${analysisCode.split("\n").length}-line script → ./output/analysis.py`,
);

const sandbox = await createWithRetry();
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}  shape: ${SHAPE}`);

try {
  console.log("[3/6] installing pandas + matplotlib (background)…");
  // pip on devbox:1 is multi-minute; run detached and poll a marker so no
  // single /exec call stays open long enough to trip a gateway timeout.
  await sandbox.sh(
    "apt-get update -qq && " +
      "apt-get install -y --no-install-recommends python3 python3-pip ca-certificates >/dev/null",
    { label: "apt", timeoutMs: 300_000 },
  );
  await sandbox.sh(
    "cat >/root/install.sh <<'SH'\n" +
      "#!/bin/bash\n" +
      "set -e\n" +
      "pip3 install --no-cache-dir --break-system-packages pandas==2.3.3 matplotlib==3.10.7\n" +
      'python3 -c \'import pandas, matplotlib; print("pandas", pandas.__version__, "mpl", matplotlib.__version__)\'\n' +
      "echo OK >/root/install.done\n" +
      "SH\n" +
      "chmod +x /root/install.sh\n" +
      "nohup setsid bash /root/install.sh >/root/install.log 2>&1 </dev/null &\n" +
      "sleep 1; echo launched",
    { label: "pip-launch" },
  );
  const deadline = Date.now() + 600_000;
  let installed = false;
  while (Date.now() < deadline) {
    const probe = (
      await sandbox.sh(
        "if [ -f /root/install.done ]; then echo done; " +
          "elif pgrep -f install.sh >/dev/null; then echo running; " +
          "else echo dead; fi; " +
          "tail -1 /root/install.log 2>/dev/null || true",
        { label: "pip-poll", timeoutMs: 30_000 },
      )
    ).result.stdout;
    const state = probe.split("\n")[0]?.trim();
    const tail = probe.split("\n").slice(1).join(" ").slice(-120);
    if (state === "done") {
      installed = true;
      break;
    }
    if (state === "dead") {
      const log = (await sandbox.sh("tail -60 /root/install.log", { label: "install-log" })).result
        .stdout;
      throw new Error(`pip install died:\n${log}`);
    }
    console.log(`      pip: ${state}  ${tail}`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!installed) {
    const log = (await sandbox.sh("tail -80 /root/install.log", { label: "install-log" })).result
      .stdout;
    throw new Error(`pip install did not finish within 10 min:\n${log}`);
  }
  console.log("      pip install done");

  console.log("[4/6] uploading listings + analysis script…");
  await sandbox.files.upload("/root/listings.json", JSON.stringify({ source, listings }));
  await sandbox.files.upload("/root/analysis.py", analysisCode);

  console.log("[5/6] running the analysis…");
  const analysisOut = (
    await sandbox.sh("cd /root && python3 analysis.py", { label: "analyze", timeoutMs: 180_000 })
  ).result.stdout;
  console.log("\n── analysis summary ──────────────────────────────────────────");
  console.log(
    analysisOut
      .trim()
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );

  console.log("\n[6/6] downloading chart + summary to ./output/…");
  const png = await sandbox.files.download("/root/price_chart.png");
  await writeFile(`${OUTPUT_DIR}price_chart.png`, new Uint8Array(png));
  await writeFile(`${OUTPUT_DIR}summary.txt`, `source: ${source}\n\n${analysisOut.trim()}\n`);
  console.log(`      saved price_chart.png (${png.byteLength} bytes)`);
  console.log("      saved analysis.py, summary.txt");

  if (png.byteLength < 1000) throw new Error(`chart PNG suspiciously small (${png.byteLength} B)`);
  console.log("\nverified end-to-end.");
} finally {
  console.log("\ncleanup…");
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
