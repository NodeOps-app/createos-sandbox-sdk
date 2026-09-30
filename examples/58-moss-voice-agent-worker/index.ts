/**
 * Moss voice-agent worker — an insurance claims voice agent whose retrieval
 * runs in-process with Moss (https://moss.dev), inside an egress-locked
 * sandbox, handing its call notes to a second sandbox after the call.
 *
 * Moss loads a search index into the agent's own memory, so each conversational
 * turn retrieves in a few milliseconds with no network hop. That makes the
 * sandbox the retrieval layer's home, and this example shows the three things
 * a production voice deployment needs from it:
 *
 *   1. Prewarm: the worker loads the policy KB once, like a LiveKit/Pipecat
 *      worker's prewarm. The cache lives on the sandbox disk, so a restart
 *      reloads from disk and keeps the same Moss device id.
 *   2. Lock down: `setEgress` to the Moss hosts only. Caller details can't
 *      leave the VM for anywhere else; call notes are embedded locally.
 *   3. Hand off: on submit_report the worker pushes the notes as a Moss index;
 *      a reviewer sandbox (also locked) loads them for QA.
 *
 * Moss bills session-minutes for every process holding an index, so all the
 * sandbox work (boot, install, lock) happens first and each Moss step is a
 * short process that exits. The run prints the total Moss process time.
 *
 * Run:   bun 58-moss-voice-agent-worker/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY, plus
 *        MOSS_PROJECT_ID + MOSS_PROJECT_KEY (https://portal.usemoss.dev).
 */
import { Sandbox } from "createos-sandbox-sdk";

const MOSS_ID = process.env.MOSS_PROJECT_ID;
const MOSS_KEY = process.env.MOSS_PROJECT_KEY;
if (!MOSS_ID || !MOSS_KEY) {
  console.error("MOSS_PROJECT_ID and MOSS_PROJECT_KEY are required (https://portal.usemoss.dev)");
  process.exit(1);
}

const SHAPE = "s-8vcpu-8gb";
const DISK_MIB = 50 * 1024;
const WORKDIR = "/opt/claims";
const MOSS_VERSION = "1.15.0";
// Everything Moss needs: API, model downloads, index downloads, and the
// object store that session pushes upload to. Nothing else is reachable.
const MOSS_HOSTS = [
  "service.usemoss.dev",
  "models.moss.link",
  "indexes.moss.link",
  "*.r2.cloudflarestorage.com",
];
const CLAIM_ID = `c${Date.now().toString(36)}`;

// Sandbox create is a non-idempotent POST, so the SDK does not retry it on the
// occasional transient 502 from the control plane. A short bounded retry here
// keeps the example robust.
async function createSandbox(opts: Parameters<typeof Sandbox.create>[0]): Promise<Sandbox> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await Sandbox.create(opts);
    } catch (err) {
      lastErr = err;
      console.log(
        `      create attempt ${attempt} failed (${(err as Error).message.slice(0, 60)}); retrying…`,
      );
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw lastErr;
}

/** Boots one sandbox with the claims agent and the Moss SDK installed. The
 *  Moss keys go in `envs`: write-only, never visible through the API again. */
async function bootAgent(name: string): Promise<Sandbox> {
  const box = await createSandbox({
    shape: SHAPE,
    rootfs: "devbox:1",
    disk_mib: DISK_MIB,
    name: `${name}-${Date.now() % 100000}`,
    envs: { MOSS_PROJECT_ID: MOSS_ID!, MOSS_PROJECT_KEY: MOSS_KEY! },
  });
  await box.files.upload(
    `${WORKDIR}/package.json`,
    JSON.stringify({ type: "module", dependencies: { "@moss-js/moss": MOSS_VERSION } }),
  );
  await box.files.upload(
    `${WORKDIR}/claims-agent.ts`,
    Bun.file(new URL("./claims-agent.ts", import.meta.url)),
  );
  await box.sh(`cd ${WORKDIR} && bun install --silent`, { timeoutMs: 180_000 });
  return box;
}

/** Runs one claims-agent step, echoes its output and returns its JSON summary. */
async function step<T extends object = object>(
  box: Sandbox,
  args: string,
): Promise<T & { processMs: number }> {
  const { result } = await box.sh(`cd ${WORKDIR} && bun claims-agent.ts ${args}`, {
    timeoutMs: 180_000,
  });
  const lines = result.stdout.trimEnd().split("\n");
  const summary = JSON.parse(lines.pop()!) as T & { processMs: number };
  if (lines.length) console.log(lines.join("\n"));
  return summary;
}

const mossMs: number[] = [];
let worker: Sandbox | undefined;
let reviewer: Sandbox | undefined;

try {
  console.log("[1/7] booting the claims worker and a reviewer sandbox, installing the Moss SDK…");
  [worker, reviewer] = await Promise.all([bootAgent("moss-worker"), bootAgent("moss-reviewer")]);
  console.log(
    `      worker ${worker.id} | reviewer ${reviewer.id} (${SHAPE}, ${DISK_MIB / 1024} GB disk)`,
  );

  console.log("[2/7] ensuring the policy knowledge base exists in Moss Cloud…");
  await step(worker, "setup");

  console.log(`[3/7] locking egress on both sandboxes to Moss only: ${MOSS_HOSTS.join(", ")}`);
  // Rules apply live, in-kernel on the host: nothing inside the VM can undo them.
  await Promise.all([worker.setEgress(MOSS_HOSTS), reviewer.setEgress(MOSS_HOSTS)]);
  const { result: probe } = await worker.sh(
    `curl -s -o /dev/null -m 5 https://service.usemoss.dev && echo "      moss:    reachable" || echo "      moss:    BLOCKED"
curl -s -o /dev/null -m 5 https://example.com && echo "      example.com: REACHABLE — egress NOT locked" || echo "      example.com: blocked (caller data can't leave)"`,
  );
  console.log(probe.stdout.trimEnd());

  console.log(
    `[4/7] claim call ${CLAIM_ID}: prewarm, 6 caller turns with in-process retrieval, submit_report…`,
  );
  const call = await step<{ prewarmMs: number; turns: number[] }>(worker, `call ${CLAIM_ID}`);
  mossMs.push(call.processMs);

  console.log("[5/7] reviewer sandbox loads the pushed call notes for QA…");
  mossMs.push((await step(reviewer, `review ${CLAIM_ID}`)).processMs);

  console.log("[6/7] restarting the worker process: reload from the disk cache…");
  const warm = await step<{ reloadMs: number }>(worker, "warm");
  mossMs.push(warm.processMs);

  const p = call.turns.toSorted((a, b) => a - b);
  console.log("[7/7] summary");
  console.log(
    `      retrieval per turn: median ${p[p.length >> 1]} ms, max ${p.at(-1)} ms (voice turn budget ~800 ms)`,
  );
  console.log(
    `      worker start: cold ${call.prewarmMs} ms → restart from disk cache ${warm.reloadMs} ms`,
  );
  console.log(
    `      Moss session time: ${(mossMs.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s across ${mossMs.length} short processes`,
  );
} finally {
  await Promise.allSettled([worker?.destroy(), reviewer?.destroy()]);
  console.log("      sandboxes destroyed");
}
