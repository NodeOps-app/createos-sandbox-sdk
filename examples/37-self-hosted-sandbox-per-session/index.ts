/**
 * Self-hosted Managed Agent — a FRESH createos-sandbox microVM per session.
 *
 * Same self-hosted-execution idea as example 36, but with the opposite
 * lifecycle: instead of one always-on worker claiming every session, the host
 * here polls the environment queue and spawns a brand-new sandbox for each
 * claimed session, runs `ant beta:worker run` (which attaches to exactly that
 * one work item and exits at idle), then destroys the VM. The host poller is
 * control-plane only and holds the environment key; the agent's tool calls run
 * inside the per-session sandbox. Use this model for clean per-task isolation
 * and no idle VM cost; use 36 when you want a warm worker and lower per-session
 * startup latency.
 *
 * Run:   bun 37-self-hosted-sandbox-per-session/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (the repo symlinks .env -> ../.env), plus a
 *        gitignored .env.ant holding ANTHROPIC_API_KEY (org key, Managed Agents
 *        beta), ANTHROPIC_ENVIRONMENT_ID, and ANTHROPIC_ENVIRONMENT_KEY for a
 *        self_hosted environment (see .env.example).
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "createos-sandbox-sdk";

// Keep in sync with examples/3{6,7}/index.ts — paired teaching example.
// The credential loader, create-retry wrapper, constants, and PROMPT below are
// byte-identical between the two; only the dispatch logic differs.

// ── Managed Agents credentials ────────────────────────────────────────────
// Managed Agents talks to the real Anthropic API. The shared examples `.env`
// (symlinked from ../.env) points ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN at
// an internal gateway — wrong endpoint and auth scheme for Managed Agents.
// Scrub those, then load the org key + environment credentials from `.env.ant`.
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function loadAnt(): { apiKey: string; environmentId: string; environmentKey: string } {
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    delete process.env[k];
  }
  const env: Record<string, string> = {};
  for (const line of readFileSync(new URL("./.env.ant", import.meta.url), "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    env[
      s
        .slice(0, eq)
        .replace(/^export\s+/, "")
        .trim()
    ] = s
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  const environmentId = env.ANTHROPIC_ENVIRONMENT_ID ?? "";
  const environmentKey = env.ANTHROPIC_ENVIRONMENT_KEY ?? "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing in .env.ant (organization key)");
  if (!environmentId || !environmentKey) {
    throw new Error(
      "ANTHROPIC_ENVIRONMENT_ID / ANTHROPIC_ENVIRONMENT_KEY missing in .env.ant.\n" +
        "Generate one in the Console: Workspace > Environments > your self-hosted env > Generate environment key.",
    );
  }
  return { apiKey, environmentId, environmentKey };
}

const ANT_VERSION = "1.10.0";
const AGENT_MODEL = "claude-haiku-4-5";
const SHAPE = "s-4vcpu-4gb";
const WORKDIR = "/workspace";

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

// The agent only has its sandbox tools — no python preinstalled in devbox, so
// the task is pure shell. GOTCHA: the Managed Agents worker rejects an empty
// tool-result text with a 400 when it posts the result back. `tee` defends
// against that — it both writes the file (proof the tool ran inside the createos-sandbox
// microVM, since `uname` reports the guest kernel) AND echoes to stdout, so the
// tool result is guaranteed non-empty. Any bash tool call here must print
// something; a silent command would 400 the session.
const PROMPT =
  "Use your bash tool to run exactly this command: `uname -a | tee /workspace/report.txt`. " +
  "Then reply with the exact output it printed.";

const { apiKey, environmentId, environmentKey } = loadAnt();
const anthropic = new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL });

// One claimed session → one fresh createos-sandbox microVM. The host poller is control-plane
// only (it holds the environment key and claims work); the agent's tool calls
// run inside the per-session sandbox via `ant beta:worker run`, which attaches
// to exactly the claimed work item and exits when the session goes idle.
async function handleSession(sessionId: string, workId: string): Promise<void> {
  console.log(`\n  ▸ claimed session ${sessionId} (work ${workId}) — spawning a microVM…`);
  const sandbox = await createSandbox({
    shape: SHAPE,
    rootfs: "devbox:1",
    name: `shs-sess-${Date.now() % 100000}`,
    // Per-session credentials: the environment key plus the specific item to
    // attach to. Only the environment key — never the org key — enters the VM.
    envs: {
      ANTHROPIC_BASE_URL,
      ANTHROPIC_ENVIRONMENT_ID: environmentId,
      ANTHROPIC_ENVIRONMENT_KEY: environmentKey,
      ANTHROPIC_SESSION_ID: sessionId,
      ANTHROPIC_WORK_ID: workId,
    },
  });
  console.log(`    sandbox ${sandbox.id} @ ${sandbox.ip}`);
  try {
    await sandbox.sh(
      `set -e
mkdir -p ${WORKDIR}
arch=$(uname -m); case "$arch" in x86_64) a=amd64;; aarch64) a=arm64;; *) a=$arch;; esac
curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v${ANT_VERSION}/ant_${ANT_VERSION}_linux_$a.tar.gz" | tar -xz -C /usr/local/bin ant`,
      { timeoutMs: 180_000 },
    );
    console.log(
      "    running ant beta:worker run (attaches to the claimed session, executes tool calls in-VM)…",
    );
    // The worker attaches to exactly this session (via ANTHROPIC_SESSION_ID /
    // ANTHROPIC_WORK_ID) and blocks until idle. Run it in the background and
    // wait for the agent's file to appear, rather than holding one long exec
    // connection open for the whole session.
    await sandbox.sh(
      `nohup setsid ant beta:worker run --workdir ${WORKDIR} --max-idle 5s --log-format text ` +
        `> /tmp/worker.log 2>&1 < /dev/null & echo "worker pid $!"`,
    );
    let report = "";
    for (let i = 0; i < 45; i++) {
      try {
        report = new TextDecoder().decode(await sandbox.files.download(`${WORKDIR}/report.txt`));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!report) {
      throw new Error(
        `report.txt never appeared. worker log:\n${(await sandbox.sh("tail -8 /tmp/worker.log")).result.stdout}`,
      );
    }
    console.log("    ── /workspace/report.txt (written inside this per-session VM) ──");
    for (const line of report.trimEnd().split("\n")) console.log(`      ${line}`);
  } finally {
    await sandbox.destroy().catch((err) => {
      console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    console.log(`    sandbox ${sandbox.id} destroyed`);
  }
}

console.log("[1/3] creating agent + 2 sessions on the self-hosted environment…");
const agent = await anthropic.beta.agents.create({
  name: `createos-sandbox-per-session-${Date.now() % 100000}`,
  model: AGENT_MODEL,
  system: `You are a terse assistant running inside a createos-sandbox microVM. Your working directory is ${WORKDIR}.`,
  tools: [{ type: "agent_toolset_20260401" }],
});
console.log(`      agent ${agent.id}`);

// Each session starts a run (and so enqueues a work item) once it gets a user
// message. Two sessions ⇒ two work items ⇒ two independent microVMs.
for (let i = 0; i < 2; i++) {
  const session = await anthropic.beta.sessions.create({
    agent: agent.id,
    environment_id: environmentId,
  });
  await anthropic.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: PROMPT }] }],
  });
  console.log(`      session ${session.id} queued`);
}

console.log(
  "\n[2/3] polling the environment queue; one fresh createos-sandbox microVM per claimed session…",
);
let handled = 0;
for await (const work of anthropic.beta.environments.work.poller({
  environmentId,
  environmentKey,
  blockMs: 999,
  drain: true, // stop once the queue is empty instead of long-polling forever
  autoStop: false, // the worker inside the VM owns the stop call
})) {
  if (work.data.type !== "session") continue;
  await handleSession(work.data.id, work.id);
  handled++;
}

console.log(`\n[3/3] done — ${handled} session(s) executed, each in its own microVM.`);
