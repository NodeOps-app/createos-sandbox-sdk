/**
 * LlamaIndex RAG in a single sandbox, surviving a snapshot. Uploads a 4-doc
 * corpus, installs llama-index + sentence-transformers (local CPU embeddings),
 * builds a VectorStoreIndex persisted to disk, then pause/resumes the sandbox
 * — the key point: the on-disk index survives the snapshot, so the query phase
 * runs against the *same* index after the VM was checkpointed and restored.
 * Asks a question via an OpenAI-compatible chat model; the answer and the
 * top-k retrieved chunks land on the host.
 *
 * Run:   bun 13-llamaindex-rag/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY and an OpenAI-compatible endpoint
 *        (OPENAI_API_KEY + OPENAI_API_URL, optional OPENAI_MODEL). The sandbox
 *        needs outbound network to install packages and pull the embed model.
 *        See .env.example.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { CreateosSandboxClient, CreateosSandboxValidationError } from "createos-sandbox-sdk";

const SHAPE = "s-4vcpu-4gb";
const ROOTFS = "devbox:1";
const CORPUS_DIR = new URL("./corpus/", import.meta.url).pathname;
const OUTPUT_DIR = new URL("./output/", import.meta.url).pathname;
const QUESTION =
  "What states does a createos-sandbox sandbox move through, and which one is terminal?";

const OPENAI_API_URL = process.env.OPENAI_API_URL ?? process.env.OPENAI_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
if (!OPENAI_API_URL || !OPENAI_API_KEY) {
  console.error("OPENAI_API_URL and OPENAI_API_KEY must be set (see .env.example).");
  process.exit(1);
}

const box = new CreateosSandboxClient();

async function createWithRetry() {
  const name = `llamaidx-${Date.now().toString(36).slice(-6)}`;
  const opts = {
    shape: SHAPE,
    rootfs: ROOTFS,
    name,
    envs: {
      DEBIAN_FRONTEND: "noninteractive",
      OPENAI_API_URL: OPENAI_API_URL!,
      OPENAI_API_KEY: OPENAI_API_KEY!,
      OPENAI_MODEL,
      // Keep HF cache off the rootfs overlay's hot path.
      HF_HOME: "/root/.cache/huggingface",
      TOKENIZERS_PARALLELISM: "false",
    },
  };
  const maxAttempts = 6;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await box.createSandbox(opts);
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

const sandbox = await createWithRetry();
console.log(`sandbox: ${sandbox.id}  ip: ${sandbox.ip}  shape: ${SHAPE}`);

try {
  console.log("[1/7] installing python3-pip + llama-index + sentence-transformers (background)…");
  // pip install is multi-minute; run it detached and poll a completion
  // marker file so we never hold a single /exec call open long enough to
  // trip an upstream gateway timeout (502).
  await sandbox.sh(
    "apt-get update -qq && " +
      "apt-get install -y --no-install-recommends python3 python3-pip ca-certificates >/dev/null",
    { label: "apt", timeoutMs: 300_000 },
  );
  await sandbox.sh(
    "cat >/root/install.sh <<'SH'\n" +
      "#!/bin/bash\n" +
      "set -e\n" +
      "pip3 install --no-cache-dir --break-system-packages " +
      "  --index-url https://download.pytorch.org/whl/cpu torch==2.9.1\n" +
      "pip3 install --no-cache-dir --break-system-packages " +
      "  llama-index-core==0.14.22 " +
      "  llama-index-embeddings-huggingface==0.7.0 " +
      "  llama-index-llms-openai-like==0.7.2 " +
      "  sentence-transformers==5.5.1\n" +
      "python3 -c 'import llama_index.core, sentence_transformers; print(\"llama_index_core\", llama_index.core.__version__)'\n" +
      "echo OK >/root/install.done\n" +
      "SH\n" +
      "chmod +x /root/install.sh\n" +
      "nohup setsid bash /root/install.sh >/root/install.log 2>&1 </dev/null &\n" +
      "sleep 1; echo launched",
    { label: "pip-launch" },
  );
  // Poll the marker. Each poll is a short /exec call.
  const deadline = Date.now() + 900_000;
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
    throw new Error(`pip install did not finish within 15 min:\n${log}`);
  }
  console.log("      pip install done");

  console.log("[2/7] pre-pulling the embedding model into the HF cache…");
  await sandbox.sh(
    'python3 -c "from sentence_transformers import SentenceTransformer; ' +
      "SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')\"",
    { label: "embed-warm", timeoutMs: 300_000 },
  );

  console.log(`[3/7] uploading corpus from ${CORPUS_DIR}…`);
  await sandbox.sh("mkdir -p /root/corpus /root/storage", { label: "mkdir-corpus" });
  const corpusFiles = await readdir(CORPUS_DIR);
  for (const f of corpusFiles) {
    const body = await readFile(`${CORPUS_DIR}${f}`, "utf8");
    await sandbox.files.upload(`/root/corpus/${f}`, body);
  }
  console.log(`      uploaded ${corpusFiles.length} files`);

  const indexerSrc = await readFile(new URL("./indexer.py", import.meta.url), "utf8");
  const querySrc = await readFile(new URL("./query.py", import.meta.url), "utf8");
  await sandbox.files.upload("/root/indexer.py", indexerSrc);
  await sandbox.files.upload("/root/query.py", querySrc);

  console.log("[4/7] building VectorStoreIndex (local MiniLM embeddings)…");
  const idxOut = (
    await sandbox.sh("cd /root && python3 indexer.py", { label: "build-index", timeoutMs: 600_000 })
  ).result.stdout;
  console.log(
    idxOut
      .trim()
      .split("\n")
      .map((l) => `      ${l}`)
      .join("\n"),
  );

  const sizeOut = (
    await sandbox.sh("du -sb /root/storage | awk '{print $1}'; ls /root/storage", {
      label: "index-size",
    })
  ).result.stdout;
  const indexBytes = Number(sizeOut.split("\n")[0]?.trim() ?? 0);
  console.log(`      persisted index: ${indexBytes} bytes`);

  console.log("[5/7] pause/resume — snapshot the prepared sandbox…");
  await sandbox.pause();
  await sandbox.waitUntilPaused({ timeoutMs: 60_000 });
  console.log(`      paused (status=${sandbox.status})`);
  await sandbox.resume();
  await sandbox.waitUntilRunning({ timeoutMs: 60_000 });
  console.log(`      resumed (status=${sandbox.status})`);

  console.log(`[6/7] querying against the persisted index…`);
  console.log(`      question: ${QUESTION}`);
  const qOut = (
    await sandbox.sh(`cd /root && python3 query.py ${JSON.stringify(QUESTION)}`, {
      label: "query",
      timeoutMs: 300_000,
    })
  ).result.stdout;

  await mkdir(OUTPUT_DIR, { recursive: true });
  // query.py prints exactly one JSON object as its final stdout — find the
  // first `{` and parse from there to tolerate any incidental warnings.
  const trimmed = qOut.trim();
  const jsonStart = trimmed.indexOf("{");
  await writeFile(`${OUTPUT_DIR}answer.json`, jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed);
  const parsed = JSON.parse(trimmed.slice(jsonStart));
  console.log("\n── answer ────────────────────────────────────────────────────");
  console.log(parsed.answer);
  console.log("\n── retrieved sources ────────────────────────────────────────");
  for (const s of parsed.sources as Array<{
    score: number | null;
    file: string;
    excerpt: string;
  }>) {
    console.log(`  [${s.score?.toFixed(3) ?? "n/a"}] ${s.file}`);
    console.log(`        ${s.excerpt}`);
  }

  console.log("\n[7/7] downloading index artefacts to ./output/…");
  for (const f of ["docstore.json", "index_store.json", "default__vector_store.json"]) {
    try {
      const bytes = await sandbox.files.download(`/root/storage/${f}`);
      await writeFile(`${OUTPUT_DIR}${f}`, new Uint8Array(bytes));
      console.log(`      saved ${f} (${bytes.byteLength} bytes)`);
    } catch (e) {
      // Newer llama-index versions name files differently; tolerate.
      console.log(`      skip ${f}: ${(e as Error).message}`);
    }
  }

  console.log("\nverified end-to-end.");
} finally {
  console.log("\ncleanup…");
  // Retry destroy through transient 5xx — orphans cost capacity that the
  // sibling examples are competing for.
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
