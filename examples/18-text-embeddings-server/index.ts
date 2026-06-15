/**
 * Text-embeddings server inside an FC sandbox, reached over ingress.
 *
 * Runs a small CPU sentence-transformers model as a long-lived HTTP service
 * inside one sandbox, exposes it on the public ingress URL, and embeds a batch
 * of texts by POSTing to it from the host with plain fetch. Showcases
 * "model-as-an-HTTP-service inside a sandbox, exposed via ingress" — the
 * serving counterpart to example 13's in-sandbox RAG. The two-stage readiness
 * check is the FC-specific bit: waitForPortReady proves the port is listening
 * from inside the VM, then a /health poll over the public ingress URL proves
 * the route has propagated and the model finished loading.
 *
 * Run:   bun 18-text-embeddings-server/index.ts
 * Needs: CREATEOS_SANDBOX_API_KEY (CREATEOS_SANDBOX_BASE_URL defaults; see .env.example). Requires FC
 *        ingress — the sandbox is created with ingress_enabled. No other services.
 */

import { readFile } from "node:fs/promises";
import { CreateosSandboxClient, CreateosSandboxValidationError } from "createos-sandbox-sdk";

const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";
const PORT = 8080;
const MODEL_ID = "BAAI/bge-small-en-v1.5"; // small CPU model; ~384-dim vectors
const EXPECTED_DIM = 384;

const SAMPLE_TEXTS = [
  "Firecracker boots microVMs in well under a second.",
  "Sentence embeddings map text into a dense vector space.",
  "The quick brown fox jumps over the lazy dog.",
  "Vector similarity powers semantic search and RAG.",
];

const serverSrc = await readFile(new URL("./server.py", import.meta.url));

const fc = new CreateosSandboxClient();

async function createWithRetry() {
  const name = `embed-${Date.now().toString(36).slice(-6)}`;
  const opts = {
    shape: SHAPE,
    rootfs: ROOTFS,
    name,
    ingress_enabled: true,
    envs: {
      DEBIAN_FRONTEND: "noninteractive",
      EMBED_MODEL: MODEL_ID,
      EMBED_PORT: String(PORT),
      // Keep the HF cache off the rootfs overlay's hot path.
      HF_HOME: "/root/.cache/huggingface",
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

// Build the ingress base URL from the control-plane template up front, so a
// missing ingress config fails in seconds instead of after the multi-minute
// setup. The template gives https://<ulid>-<port>.<region>.<domain>; the
// wildcard TLS cert is not in place yet, so request the http:// scheme
// (port 80, forward-compatible).
const base = sandbox.previewUrl(PORT, { scheme: "http" });
console.log(`ingress base: ${base}`);

try {
  console.log("[1/5] installing python3-pip + torch (CPU) + sentence-transformers…");
  await sandbox.sh(
    "apt-get update -qq && " +
      "apt-get install -y --no-install-recommends python3 python3-pip ca-certificates >/dev/null",
    { label: "apt", timeoutMs: 300_000 },
  );
  // pip install is multi-minute; run it detached and poll a marker file so
  // no single /exec call stays open long enough to trip a gateway timeout.
  await sandbox.sh(
    "cat >/root/install.sh <<'SH'\n" +
      "#!/bin/bash\n" +
      "set -e\n" +
      "pip3 install --no-cache-dir --break-system-packages " +
      "  --index-url https://download.pytorch.org/whl/cpu torch==2.9.1\n" +
      "pip3 install --no-cache-dir --break-system-packages sentence-transformers==5.5.1\n" +
      "python3 -c 'import sentence_transformers; print(\"st\", sentence_transformers.__version__)'\n" +
      "echo OK >/root/install.done\n" +
      "SH\n" +
      "chmod +x /root/install.sh\n" +
      "nohup setsid bash /root/install.sh >/root/install.log 2>&1 </dev/null &\n" +
      "sleep 1; echo launched",
    { label: "pip-launch" },
  );
  const deadline = Date.now() + 900_000;
  let installed = false;
  while (Date.now() < deadline) {
    const { result: probe } = await sandbox.sh(
      "if [ -f /root/install.done ]; then echo done; " +
        "elif pgrep -f install.sh >/dev/null; then echo running; " +
        "else echo dead; fi; " +
        "tail -1 /root/install.log 2>/dev/null || true",
      { label: "pip-poll", timeoutMs: 30_000 },
    );
    const state = probe.stdout.split("\n")[0]?.trim();
    const tail = probe.stdout.split("\n").slice(1).join(" ").slice(-120);
    if (state === "done") {
      installed = true;
      break;
    }
    if (state === "dead") {
      const { result: log } = await sandbox.sh("tail -60 /root/install.log", {
        label: "install-log",
      });
      throw new Error(`pip install died:\n${log.stdout}`);
    }
    console.log(`      pip: ${state}  ${tail}`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!installed) {
    const { result: log } = await sandbox.sh("tail -80 /root/install.log", {
      label: "install-log",
    });
    throw new Error(`pip install did not finish within 15 min:\n${log.stdout}`);
  }
  console.log("      pip install done");

  console.log("[2/5] uploading + booting the embeddings server (background)…");
  await sandbox.files.upload("/root/server.py", serverSrc);
  // devbox:1 has no systemd — daemonise with nohup/setsid. The server
  // downloads the model on first start, so the boot is not instant; the
  // model download happens while the process is detached.
  // The detached launcher can return a spurious non-zero from the exec
  // reaper ("waitid: no child processes") even when the process started
  // fine; readiness is proven by waitForPortReady below, so treat the
  // launch as best-effort and let the port probe be the source of truth.
  try {
    await sandbox.sh(
      "rm -f /root/server.log; " +
        "nohup setsid python3 /root/server.py >/root/server.log 2>&1 </dev/null & " +
        "sleep 1; echo launched",
      { label: "boot-server" },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no child processes|exited -1/i.test(msg)) throw err;
    console.warn(
      `      boot launcher returned a transient reaper error (${msg.slice(0, 80)}); relying on port probe`,
    );
  }

  console.log(`[3/5] waiting for the model to load + port ${PORT} to listen…`);
  // Model load on CPU can take a while; give the port probe a generous
  // budget. waitForPortReady probes inside the VM until the port accepts.
  await sandbox.waitForPortReady(PORT, { timeoutMs: 300_000 });
  console.log(`      port ${PORT} is accepting connections`);

  // The model may still be finishing its load right as the port opens.
  // Poll /health over ingress until it reports ready.
  console.log("[4/5] health-checking the server over ingress…");
  const healthDeadline = Date.now() + 120_000;
  let healthy = false;
  while (Date.now() < healthDeadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const h = (await res.json()) as { model: string; dim: number };
        console.log(`      health OK — model=${h.model} dim=${h.dim}`);
        healthy = true;
        break;
      }
    } catch {
      // ingress propagation / model still loading — keep polling
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (!healthy) {
    const { result: log } = await sandbox.sh("tail -40 /root/server.log", { label: "server-log" });
    throw new Error(`server never became healthy over ingress:\n${log.stdout}`);
  }

  console.log(`[5/5] embedding ${SAMPLE_TEXTS.length} texts over ingress…`);
  const res = await fetch(`${base}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts: SAMPLE_TEXTS }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`POST /embed -> HTTP ${res.status}: ${await res.text()}`);

  const out = (await res.json()) as {
    model: string;
    dim: number;
    count: number;
    embeddings: number[][];
  };

  console.log("\n── embeddings ───────────────────────────────────────────────");
  console.log(`  model:   ${out.model}`);
  console.log(`  vectors: ${out.embeddings.length}`);
  console.log(`  dim:     ${out.dim}`);
  console.log(
    `  sample:  [${out.embeddings[0]
      ?.slice(0, 5)
      .map((x) => x.toFixed(4))
      .join(", ")}, …]`,
  );

  // Assert the shape we expected from the chosen model.
  if (out.embeddings.length !== SAMPLE_TEXTS.length) {
    throw new Error(`expected ${SAMPLE_TEXTS.length} vectors, got ${out.embeddings.length}`);
  }
  if (out.dim !== EXPECTED_DIM || out.embeddings.some((v) => v.length !== EXPECTED_DIM)) {
    throw new Error(`expected ${EXPECTED_DIM}-dim vectors, got dim=${out.dim}`);
  }

  console.log(
    `\nverified end-to-end: ${out.embeddings.length} ${out.dim}-dim vectors from ${out.model} over ingress.`,
  );
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
