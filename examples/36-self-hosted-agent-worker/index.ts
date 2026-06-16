/**
 * Self-hosted agent worker — back a Claude Managed Agent with ONE persistent
 * createos-sandbox VM.
 *
 * Boots a single long-lived sandbox, installs the `ant` CLI, and runs
 * `ant beta:worker poll` inside it as an always-on daemon. That worker claims
 * every session assigned to the self-hosted environment and executes the
 * agent's tool calls locally, so agent code, files, and egress never leave the
 * createos-sandbox boundary. The script then drives one agent session and proves the work
 * ran in-VM by reading the file the tool wrote. Contrast with example 37, which
 * spawns a FRESH VM per session instead of reusing one persistent worker.
 *
 * Run:   bun 36-self-hosted-agent-worker/index.ts
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
// VM, since `uname` reports the guest kernel) AND echoes to stdout, so the
// tool result is guaranteed non-empty. Any bash tool call here must print
// something; a silent command would 400 the session.
const PROMPT =
  "Use your bash tool to run exactly this command: `uname -a | tee /workspace/report.txt`. " +
  "Then reply with the exact output it printed.";

const { apiKey, environmentId, environmentKey } = loadAnt();
const anthropic = new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL });

// One long-lived createos-sandbox VM is the self-hosted execution boundary. The worker
// inside it claims every session assigned to the environment and runs the
// agent's tool calls locally — agent code, files and egress never leave createos-sandbox.
console.log("[1/6] creating createos-sandbox sandbox (the self-hosted execution boundary)…");
const sandbox = await createSandbox({
  shape: SHAPE,
  rootfs: "devbox:1",
  name: `shs-worker-${Date.now() % 100000}`,
  // The worker authenticates with the *environment* key only — never the org
  // key. `ant` reads these from the environment automatically.
  envs: {
    ANTHROPIC_BASE_URL,
    ANTHROPIC_ENVIRONMENT_ID: environmentId,
    ANTHROPIC_ENVIRONMENT_KEY: environmentKey,
  },
});
console.log(`      sandbox ${sandbox.id} @ ${sandbox.ip}`);

try {
  console.log(`[2/6] installing ant CLI v${ANT_VERSION} inside the sandbox…`);
  const { result: ver } = await sandbox.sh(
    `set -e
mkdir -p ${WORKDIR}
arch=$(uname -m); case "$arch" in x86_64) a=amd64;; aarch64) a=arm64;; *) a=$arch;; esac
curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v${ANT_VERSION}/ant_${ANT_VERSION}_linux_$a.tar.gz" | tar -xz -C /usr/local/bin ant
ant --version`,
    { timeoutMs: 180_000 },
  );
  console.log(`      ${ver.stdout.trim()}`);

  console.log("[3/6] starting always-on worker (ant beta:worker poll) in background…");
  // devbox has no systemd: daemonize with nohup setsid and detach stdio.
  await sandbox.sh(
    `nohup setsid ant beta:worker poll --workdir ${WORKDIR} --log-format text ` +
      `> /tmp/worker.log 2>&1 < /dev/null & sleep 3; echo "worker pid $!"`,
  );
  const { result: log } = await sandbox.sh("cat /tmp/worker.log 2>/dev/null || true");
  if (log.stdout.trim())
    console.log(`      worker log: ${log.stdout.trim().split("\n").slice(-3).join(" | ")}`);

  console.log("[4/6] creating agent + session bound to the self-hosted environment…");
  const agent = await anthropic.beta.agents.create({
    name: `createos-sandbox-worker-${Date.now() % 100000}`,
    model: AGENT_MODEL,
    system: `You are a terse assistant running inside a createos-sandbox VM. Your working directory is ${WORKDIR}.`,
    tools: [{ type: "agent_toolset_20260401" }],
  });
  const session = await anthropic.beta.sessions.create({
    agent: agent.id,
    environment_id: environmentId,
  });
  console.log(`      agent ${agent.id} | session ${session.id}`);

  console.log("[5/6] streaming the session — tool calls execute inside createos-sandbox:\n");
  const stream = await anthropic.beta.sessions.events.stream(session.id, undefined, {
    signal: AbortSignal.timeout(300_000),
  });
  await anthropic.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: PROMPT }] }],
  });

  for await (const event of stream) {
    if (event.type === "agent.message") {
      for (const block of event.content)
        if (block.type === "text") process.stdout.write(block.text);
    } else if (event.type === "agent.tool_use") {
      process.stdout.write(`\n      → [tool: ${event.name}]\n`);
    } else if (event.type === "session.error") {
      console.error("\n      session error:", JSON.stringify(event));
      break;
    } else if (event.type === "session.status_idle") {
      process.stdout.write("\n");
      break;
    }
  }

  console.log(
    "\n[6/6] proof the work ran inside createos-sandbox — reading /workspace from the VM:",
  );
  // The worker writes the file just after the session goes idle, so the read
  // can briefly race ahead of it — retry until it lands.
  let report = "";
  for (let i = 0; i < 8; i++) {
    try {
      report = new TextDecoder().decode(await sandbox.files.download(`${WORKDIR}/report.txt`));
      break;
    } catch (err) {
      if (i === 7) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.log("      ── /workspace/report.txt ──");
  for (const line of report.trimEnd().split("\n")) console.log(`      ${line}`);
} finally {
  console.log("\ncleanup: destroying sandbox…");
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
