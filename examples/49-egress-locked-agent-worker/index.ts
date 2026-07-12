/**
 * Egress-locked agent worker — back a Claude Managed Agent with a persistent
 * sandbox whose network egress is locked down.
 *
 * Same self-hosted worker as example 36, plus the security boundary every
 * self-hosted-sandbox guide (Vercel, Cloudflare, E2B) leads with: the agent's
 * tool calls run inside a sandbox that can reach a co-located *private* service
 * but **cannot exfiltrate to the public internet**. Provision with open egress
 * (to install the worker CLI), start an internal-only service on loopback, then
 * `setEgress` to an allowlist of exactly one host — `api.anthropic.com`. From
 * that point the worker can still talk to Anthropic and the agent can still
 * reach your internal service, but any outbound call to an unlisted host is
 * dropped in-kernel on the host and cannot be bypassed from inside.
 *
 * The session then proves both properties at once: the agent curls the private
 * service (succeeds) and curls a public host (blocked), and the host reads back
 * the report plus the enforced allowlist.
 *
 * Run:   bun 49-egress-locked-agent-worker/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (the repo symlinks .env -> ../.env), plus a
 *        gitignored .env.ant holding ANTHROPIC_API_KEY (org key, Managed Agents
 *        beta), ANTHROPIC_ENVIRONMENT_ID, and ANTHROPIC_ENVIRONMENT_KEY for a
 *        self_hosted environment (see .env.example).
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "createos-sandbox-sdk";

// ── Managed Agents credentials ────────────────────────────────────────────
// Managed Agents talks to the real Anthropic API. The shared examples `.env`
// (symlinked from ../.env) points ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN at
// an internal gateway — wrong endpoint and auth scheme for Managed Agents.
// Scrub those, then load the org key + environment credentials from `.env.ant`.
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

// The single host the sandbox is allowed to reach once locked. The worker polls
// sessions and posts tool results here; everything else is dropped.
const ANTHROPIC_HOST = "api.anthropic.com";

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
// The internal-only service the agent's tools are allowed to reach. It listens
// on loopback and is never exposed — a stand-in for your private API or DB.
const PRIVATE_PORT = 8899;

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

// One bash tool call proves both halves of the boundary in one shot: it reaches
// the private loopback service (should return the record) and attempts a public
// host (should be blocked by the egress lock). `tee` mirrors the combined output
// to /workspace/report.txt AND to stdout — the Managed Agents worker 400s on an
// empty tool result, so the command must always print something.
const PROMPT =
  "Use your bash tool to run exactly this one command, then reply with the exact output it printed:\n" +
  "```\n" +
  `{ echo '## private internal service (expect a JSON record):'; curl -s --max-time 5 http://127.0.0.1:${PRIVATE_PORT}/rec.json || echo PRIVATE_FAIL; echo; echo '## public internet exfil attempt (expect blocked):'; if curl -sf -o /dev/null --max-time 5 https://example.com; then echo 'REACHED example.com — egress NOT locked'; else echo "BLOCKED by egress (curl exit $?)"; fi; } | tee ${WORKDIR}/report.txt\n` +
  "```";

const { apiKey, environmentId, environmentKey } = loadAnt();
const anthropic = new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL });

// One long-lived sandbox is the self-hosted execution boundary. The worker
// inside it claims every session assigned to the environment and runs the
// agent's tool calls locally — agent code, files and egress never leave createos-sandbox.
console.log("[1/8] creating createos-sandbox sandbox (open egress, so we can install the worker)…");
const sandbox = await createSandbox({
  shape: SHAPE,
  rootfs: "devbox:1",
  name: `egr-worker-${Date.now() % 100000}`,
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
  console.log(`[2/8] installing ant CLI v${ANT_VERSION} inside the sandbox…`);
  const { result: ver } = await sandbox.sh(
    `set -e
mkdir -p ${WORKDIR}
arch=$(uname -m); case "$arch" in x86_64) a=amd64;; aarch64) a=arm64;; *) a=$arch;; esac
curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v${ANT_VERSION}/ant_${ANT_VERSION}_linux_$a.tar.gz" | tar -xz -C /usr/local/bin ant
ant --version`,
    { timeoutMs: 180_000 },
  );
  console.log(`      ${ver.stdout.trim()}`);

  console.log("[3/8] starting an internal-only service on loopback (your private API/DB)…");
  // busybox ships in devbox and its httpd daemonizes by default (no -f), so the
  // exec returns immediately instead of blocking on a foreground server.
  const { result: svc } = await sandbox.sh(
    `set -e
mkdir -p /srv
printf '%s' '{"service":"internal-inventory","sku":"ACME-42","stock":128,"note":"reachable only from inside your environment"}' > /srv/rec.json
busybox httpd -p ${PRIVATE_PORT} -h /srv
sleep 1
pgrep -f "httpd -p ${PRIVATE_PORT}" >/dev/null && echo "private service up on 127.0.0.1:${PRIVATE_PORT}"`,
  );
  console.log(`      ${svc.stdout.trim()}`);

  console.log(`[4/8] locking egress to a one-host allowlist: ${ANTHROPIC_HOST}…`);
  // Rules apply live, in-kernel, with no restart. From here the sandbox can
  // reach only api.anthropic.com (worker traffic) and loopback (the private
  // service); every other destination is dropped and cannot be reached from
  // inside — DNS still resolves, but the connection never completes.
  const locked = await sandbox.setEgress([ANTHROPIC_HOST]);
  console.log(`      egress allowlist now: ${JSON.stringify(locked.egress)}`);

  console.log("[5/8] starting always-on worker (ant beta:worker poll) in background…");
  // devbox has no systemd: daemonize with nohup setsid and detach stdio.
  await sandbox.sh(
    `nohup setsid ant beta:worker poll --workdir ${WORKDIR} --log-format text ` +
      `> /tmp/worker.log 2>&1 < /dev/null & sleep 3; echo "worker pid $!"`,
  );
  const { result: log } = await sandbox.sh("cat /tmp/worker.log 2>/dev/null || true");
  if (log.stdout.trim())
    console.log(`      worker log: ${log.stdout.trim().split("\n").slice(-3).join(" | ")}`);

  console.log("[6/8] creating agent + session bound to the self-hosted environment…");
  const agent = await anthropic.beta.agents.create({
    name: `createos-sandbox-egress-${Date.now() % 100000}`,
    model: AGENT_MODEL,
    system: `You are a terse assistant running inside a createos-sandbox. Your working directory is ${WORKDIR}.`,
    tools: [{ type: "agent_toolset_20260401" }],
  });
  const session = await anthropic.beta.sessions.create({
    agent: agent.id,
    environment_id: environmentId,
  });
  console.log(`      agent ${agent.id} | session ${session.id}`);

  console.log("[7/8] streaming the session — tool calls execute inside the locked sandbox:\n");
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

  console.log("\n[8/8] proof — reading the report and the enforced allowlist from the sandbox:");
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
  const enforced = await sandbox.getEgress();
  console.log(`      ── enforced egress allowlist ── ${JSON.stringify(enforced.egress)}`);
} finally {
  console.log("\ncleanup: destroying sandbox…");
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
