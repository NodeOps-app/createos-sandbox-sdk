/**
 * Batch inference fan-out — a parallel-map workload sharded across many FC
 * sandboxes.
 *
 * Sentiment classification over a bundled batch of labeled movie reviews,
 * sharded and processed in PARALLEL across N independent FC sandboxes. Each
 * sandbox installs a CPU-only HuggingFace model, runs its shard, and reports
 * its own inference timing. The host shards the batch, fans the work out
 * concurrently, then aggregates: overall accuracy against the bundled labels,
 * throughput, and the concurrency speedup of fan-out over a serial estimate.
 * The shared concurrency cap is a hard ceiling, so the design keeps
 * SHARD_COUNT <= MAX_CONCURRENCY (one wave); above the cap, shards must run in
 * waves of at most MAX_CONCURRENCY. Cleanup destroys only the sandboxes this
 * run created and leak-checks that none survive.
 *
 * Run:   bun 19-batch-inference-fanout/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (both required; see .env.example). No other
 *        external services — the model is pulled from HuggingFace inside each VM.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FcClient, FcValidationError, type Sandbox } from "fc-sandbox-sdk";

const here = dirname(fileURLToPath(import.meta.url));

const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";
const MODEL = "distilbert-base-uncased-finetuned-sst-2-english";
const SHARD_COUNT = 4; // <= MAX_CONCURRENCY so the whole batch runs in one wave
const MAX_CONCURRENCY = 4; // hard ceiling: shared 5/5 cap, leave one slot of headroom

// Base URL for the control plane.
const FC_BASE_URL = process.env.FC_BASE_URL;
if (!FC_BASE_URL) {
  console.error("FC_BASE_URL must be set (see .env.example).");
  process.exit(1);
}
const FC_API_KEY = process.env.FC_API_KEY;
if (!FC_API_KEY) {
  console.error("FC_API_KEY must be set (see .env.example).");
  process.exit(1);
}

const fc = new FcClient({ apiKey: FC_API_KEY, baseUrl: FC_BASE_URL });

interface Review {
  id: number;
  text: string;
  label: string;
}

interface Prediction {
  id: number;
  label: string;
  score: number;
}

interface ShardResult {
  shard: number;
  model: string;
  model_load_ms: number;
  inference_ms: number;
  count: number;
  predictions: Prediction[];
}

function splitEvenly<T>(items: T[], parts: number): T[][] {
  const shards: T[][] = Array.from({ length: parts }, () => []);
  items.forEach((item, i) => shards[i % parts]!.push(item));
  return shards;
}

// One-shot back-off retry for the shared cap / transient 5xx case. Backs off
// and retries a few times; never destroys sandboxes it did not create.
async function createWithRetry(name: string): Promise<Sandbox> {
  const opts = {
    shape: SHAPE,
    rootfs: ROOTFS,
    name,
    envs: {
      DEBIAN_FRONTEND: "noninteractive",
      HF_HOME: "/root/.cache/huggingface",
      HF_HUB_DISABLE_PROGRESS_BARS: "1",
      TRANSFORMERS_VERBOSITY: "error",
      TOKENIZERS_PARALLELISM: "false",
    },
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
        `  create attempt ${i}/${maxAttempts} failed (${msg.slice(0, 80)}); waiting ${wait / 1000}s…`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("unreachable");
}

// pip install (CPU torch + transformers) is multi-minute; run it detached and
// poll a marker file so we never hold one /exec open long enough to trip an
// upstream gateway timeout.
async function installDeps(sb: Sandbox) {
  await sb.sh(
    "apt-get update -qq && " +
      "apt-get install -y --no-install-recommends python3 python3-pip ca-certificates >/dev/null",
    { label: "apt", timeoutMs: 300_000 },
  );
  await sb.sh(
    "cat >/root/install.sh <<'SH'\n" +
      "#!/bin/bash\n" +
      "set -e\n" +
      // torch lives only on the CPU index; transformers lives on PyPI — two steps.
      "pip3 install --no-cache-dir --break-system-packages " +
      "  --index-url https://download.pytorch.org/whl/cpu torch==2.9.1\n" +
      "pip3 install --no-cache-dir --break-system-packages transformers==5.9.0\n" +
      'python3 -c \'import torch, transformers; print("torch", torch.__version__, "transformers", transformers.__version__)\'\n' +
      "echo OK >/root/install.done\n" +
      "SH\n" +
      "chmod +x /root/install.sh\n" +
      "nohup setsid bash /root/install.sh >/root/install.log 2>&1 </dev/null &\n" +
      "sleep 1; echo launched",
    { label: "pip-launch" },
  );
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const { result: probe } = await sb.sh(
      "if [ -f /root/install.done ]; then echo done; " +
        "elif pgrep -f install.sh >/dev/null; then echo running; " +
        "else echo dead; fi; " +
        "tail -1 /root/install.log 2>/dev/null || true",
      { label: "pip-poll", timeoutMs: 30_000 },
    );
    const state = probe.stdout.split("\n")[0]?.trim();
    if (state === "done") return;
    if (state === "dead") {
      const { result: log } = await sb.sh("tail -60 /root/install.log", { label: "install-log" });
      throw new Error(`pip install died on ${sb.id}:\n${log.stdout}`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  const { result: log } = await sb.sh("tail -80 /root/install.log", { label: "install-log" });
  throw new Error(`pip install did not finish within 15 min on ${sb.id}:\n${log.stdout}`);
}

// Prepare a sandbox: install deps, upload infer.py + this shard's reviews, and
// pre-pull the model into the HF cache so the timed inference pays no download.
async function prepareSandbox(sb: Sandbox, shardIndex: number, shard: Review[], inferSrc: string) {
  console.log(`  [shard ${shardIndex}] ${sb.id}: installing torch + transformers…`);
  await installDeps(sb);
  await sb.files.upload("/root/infer.py", inferSrc);
  await sb.files.upload("/root/shard.json", JSON.stringify(shard));
  console.log(`  [shard ${shardIndex}] ${sb.id}: pre-pulling model ${MODEL}…`);
  await sb.sh(
    'python3 -c "from transformers import pipeline; ' +
      `pipeline('sentiment-analysis', model='${MODEL}', device=-1)('warmup')"`,
    { label: "warm", timeoutMs: 600_000 },
  );
}

// Run one shard and parse the single JSON object infer.py prints. Tolerate any
// incidental leading output by parsing from the first '{'.
async function runShard(sb: Sandbox, shardIndex: number): Promise<ShardResult> {
  const { result } = await sb.sh(`cd /root && python3 infer.py shard.json ${shardIndex}`, {
    label: "infer",
    timeoutMs: 300_000,
  });
  const out = result.stdout;
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`no JSON in infer.py output on ${sb.id}: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(start)) as ShardResult;
}

const reviews: Review[] = JSON.parse(await readFile(join(here, "reviews.json"), "utf8"));
const inferSrc = await readFile(join(here, "infer.py"), "utf8");
const shards = splitEvenly(reviews, SHARD_COUNT);
const labelById = new Map(reviews.map((r) => [r.id, r.label.toUpperCase()]));

console.log(
  `batch: ${reviews.length} reviews → ${SHARD_COUNT} shards ` +
    `(${shards.map((s) => s.length).join("/")}) — model ${MODEL}`,
);

const sandboxes: Sandbox[] = [];
try {
  const suffix = Date.now().toString(36).slice(-6);

  console.log(`\n[1/4] creating ${SHARD_COUNT} sandboxes concurrently (cap ${MAX_CONCURRENCY})…`);
  // SHARD_COUNT <= MAX_CONCURRENCY, so the whole batch creates in one wave.
  // (If SHARD_COUNT ever exceeds the cap, process in waves of MAX_CONCURRENCY.)
  const created = await Promise.all(shards.map((_, i) => createWithRetry(`infer-${suffix}-${i}`)));
  sandboxes.push(...created);
  for (const [i, sb] of sandboxes.entries()) {
    console.log(`      shard ${i}: ${sb.id}  ip: ${sb.ip}`);
  }

  console.log("\n[2/4] preparing sandboxes (install + model warm, in parallel)…");
  const prepStart = Date.now();
  await Promise.all(sandboxes.map((sb, i) => prepareSandbox(sb, i, shards[i]!, inferSrc)));
  const prepWallMs = Date.now() - prepStart;

  console.log("\n[3/4] running inference on all shards concurrently…");
  const wallStart = Date.now();
  const results = await Promise.all(sandboxes.map((sb, i) => runShard(sb, i)));
  const fanoutWallMs = Date.now() - wallStart;

  // Aggregate on the host. Speedup is computed on the inference phase only
  // (infer.py-reported `inference_ms`), so it reflects sharded throughput and
  // not the one-time cold start, which is amortizable and reported separately.
  const allPredictions = results.flatMap((r) => r.predictions);
  let correct = 0;
  for (const p of allPredictions) {
    if (p.label.toUpperCase() === labelById.get(p.id)) correct++;
  }
  const total = allPredictions.length;
  const accuracy = total ? correct / total : 0;

  const inferenceMsByShard = results.map((r) => r.inference_ms);
  const serialEstimateMs = inferenceMsByShard.reduce((a, b) => a + b, 0);
  const parallelActualMs = Math.max(...inferenceMsByShard);
  const speedup = parallelActualMs ? serialEstimateMs / parallelActualMs : 0;
  const throughput = parallelActualMs ? (total / parallelActualMs) * 1000 : 0;
  const maxLoadMs = Math.max(...results.map((r) => r.model_load_ms));

  console.log("\n[4/4] results");
  console.log("  ── per-shard ───────────────────────────────────────────────");
  for (const r of results) {
    const sbId = sandboxes[r.shard]!.id;
    console.log(
      `  shard ${r.shard} (${sbId}): ${r.count} items  ` +
        `load=${r.model_load_ms}ms  inference=${r.inference_ms}ms`,
    );
  }
  console.log("  ── aggregate ───────────────────────────────────────────────");
  console.log(`  model:               ${MODEL}`);
  console.log(`  sandboxes (shards):  ${SHARD_COUNT}`);
  console.log(`  total items:         ${total}`);
  console.log(`  accuracy:            ${(accuracy * 100).toFixed(1)}% (${correct}/${total})`);
  console.log(`  fan-out wall-clock:  ${fanoutWallMs} ms (inference RPC round-trip)`);
  console.log(`  serial estimate:     ${serialEstimateMs} ms (sum of per-shard inference_ms)`);
  console.log(`  parallel actual:     ${parallelActualMs} ms (max per-shard inference_ms)`);
  console.log(`  concurrency speedup: ${speedup.toFixed(2)}x  over ${SHARD_COUNT} sandboxes`);
  console.log(`  throughput:          ${throughput.toFixed(1)} items/sec`);
  console.log(`  model load+warm:     ~${maxLoadMs} ms per sandbox (in-process, after pre-pull)`);
  console.log(
    `  one-time cold start: ${(prepWallMs / 1000).toFixed(0)} s wall-clock (deps install + model pre-pull, ` +
      `parallel across sandboxes; amortizable, excluded from speedup)`,
  );

  console.log("\nverified end-to-end.");
} finally {
  console.log("\ncleanup…");
  // Destroy every sandbox we created; one failure must not leak the rest.
  const created = sandboxes.map((sb) => sb.id);
  const outcomes = await Promise.allSettled(sandboxes.map((sb) => sb.destroy()));
  outcomes.forEach((o, i) => {
    if (o.status === "rejected") {
      const msg = o.reason instanceof Error ? o.reason.message : String(o.reason);
      console.error(`  destroy failed for ${sandboxes[i]!.id}: ${msg.slice(0, 100)}`);
    } else {
      console.log(`  destroyed ${sandboxes[i]!.id}`);
    }
  });

  // Leak check: confirm none of OUR created ids is still running. Destroy is
  // async server-side, so wait for each to reach the terminal state first,
  // then assert against the account's running set — only a `running` box of
  // ours counts as a leak.
  if (created.length) {
    await Promise.allSettled(sandboxes.map((sb) => sb.waitUntilDestroyed({ timeoutMs: 60_000 })));
    try {
      const live = await fc.listSandboxes({ status: "running" });
      const liveIds = new Set(live.map((s) => s.id));
      const leaked = created.filter((id) => liveIds.has(id));
      if (leaked.length) {
        console.error(`  LEAK: ${leaked.length} sandbox(es) still running: ${leaked.join(", ")}`);
      } else {
        console.log(`  leak check: none of our ${created.length} sandboxes are still running`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  leak check skipped (listSandboxes failed): ${msg.slice(0, 80)}`);
    }
  }
}
