/**
 * Sandbox as an agent tool, one sandbox per call — a cloud-hosted Claude Managed
 * Agent whose `run_command` tool spawns a fresh, disposable createos-sandbox for
 * every single call and destroys it immediately after.
 *
 * Same architecture as example 50 (Anthropic hosts the agent loop; this
 * orchestrator owns the sandbox and the control-plane key), one difference: the
 * sandbox lifecycle. Nothing is reused, so nothing persists — every tool call
 * gets a clean machine that has never seen the agent's earlier commands. That is
 * the right shape for untrusted or one-shot work: no cross-call contamination,
 * no long-lived box to clean up, blast radius of one command.
 *
 * The task is the one from example 50 — write a file in one call, read it back
 * in the next — precisely so the contrast lands: here the read **fails**, and the
 * two calls report different hostnames.
 *
 * Trade-off: you pay a cold start per call. When per-call isolation is not worth
 * that, use example 50's per-session sandbox instead.
 *
 * Run:   bun 51-cloud-agent-sandbox-per-call/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (the repo symlinks .env -> ../.env),
 *        plus a gitignored .env.ant holding ANTHROPIC_API_KEY (org key with the
 *        Managed Agents beta). No environment key — that is a self-hosted-only
 *        credential (see .env.example).
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "createos-sandbox-sdk";

// Keep in sync with examples/5{0,1}/index.ts — paired teaching example. The
// credential loader, agent definition, constants and PROMPT below are identical
// between the two; only the sandbox lifecycle differs.

// ── Managed Agents credentials ────────────────────────────────────────────
// Managed Agents talks to the real Anthropic API. The shared examples `.env`
// (symlinked from ../.env) points ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN at
// an internal gateway — wrong endpoint and auth scheme for Managed Agents.
// Scrub those, then load the org key from `.env.ant`. A cloud environment needs
// no environment key: nothing of ours polls Anthropic's work queue.
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function loadAntKey(): string {
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
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing in .env.ant (organization key)");
  return apiKey;
}

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

// The whole tool: boot a sandbox, run the one command, tear it down. The sandbox
// exists only for the duration of this call, so a failure here costs one machine
// and nothing else.
//
// `Sandbox.sh` throws on a non-zero exit, which is wrong for a tool — and this
// example depends on that difference: the second call's `cat` *must* fail, and
// the agent must see the failure rather than the orchestrator crashing on it.
// `runCommand` returns the exit code instead of throwing. Managed Agents rejects
// an empty tool result, so never return an empty string.
async function runInFreshSandbox(command: string, call: number): Promise<string> {
  const started = Date.now();
  const sandbox = await createSandbox({
    shape: SHAPE,
    rootfs: "devbox:1",
    name: `call-tool-${call}-${Date.now() % 100000}`,
  });
  try {
    const { result } = await sandbox.runCommand(
      "bash",
      ["-lc", `mkdir -p ${WORKDIR}; cd ${WORKDIR}; ${command}`],
      { timeoutMs: 120_000 },
    );
    const combined = `${result.stdout}${result.stderr}`.trim() || "(no output)";
    const output = result.exit_code === 0 ? combined : `exit ${result.exit_code}\n${combined}`;
    console.log(
      `      ← sandbox ${sandbox.id} (fresh, ${((Date.now() - started) / 1000).toFixed(1)}s incl. cold start)` +
        `: ${output.replace(/\n/g, " | ")}`,
    );
    return output;
  } finally {
    await sandbox.destroy().catch(() => {});
    console.log(`      ✗ sandbox ${sandbox.id} destroyed — nothing it wrote survives`);
  }
}

// Identical to example 50's task. There the second call finds the file; here it
// cannot — a different machine ran it.
const PROMPT =
  "Do this in exactly two separate run_command calls — never combine them:\n" +
  `1. Run: hostname > ${WORKDIR}/note.txt; echo "written by $(hostname)"\n` +
  `2. Run: cat ${WORKDIR}/note.txt\n` +
  "Then say in one sentence whether the second call saw the file the first call " +
  "wrote, and whether the two hostnames match.";

const apiKey = loadAntKey();
const anthropic = new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL });

let environmentId: string | undefined;
let sessionId: string | undefined;
let toolCalls = 0;

try {
  // A cloud environment hosts the agent loop on Anthropic's infrastructure. No
  // sandbox exists yet — none will, until the agent actually asks to run
  // something.
  console.log("[1/5] creating the cloud environment (Anthropic hosts the agent loop)…");
  const environment = await anthropic.beta.environments.create({
    name: `createos-tool-percall-${Date.now() % 100000}`,
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  environmentId = environment.id;
  console.log(`      environment ${environment.id}`);

  console.log("[2/5] creating the agent — its only tool is run_command…");
  const agent = await anthropic.beta.agents.create({
    name: `createos-percall-tool-${Date.now() % 100000}`,
    model: AGENT_MODEL,
    system:
      "You are a terse assistant. Your only way to run anything is the run_command tool, " +
      `which runs a shell command on a remote Linux machine. Its working directory is ${WORKDIR}. ` +
      "Report command output verbatim.",
    // No `agent_toolset_20260401`: without it the cloud agent has no bash of its
    // own, so every command it wants to run must go through createos-sandbox.
    tools: [
      {
        type: "custom",
        name: "run_command",
        description:
          "Run a shell command on the remote Linux machine and return its combined output.",
        input_schema: {
          type: "object",
          properties: { command: { type: "string", description: "The shell command to run" } },
          required: ["command"],
        },
      },
    ],
  });
  const session = await anthropic.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
  });
  sessionId = session.id;
  console.log(`      agent ${agent.id} | session ${session.id}`);

  // Open the stream before sending the task: events emitted between session
  // creation and the first read would otherwise be missed. The stream must stay
  // open for the whole run — the agent blocks on our tool results, so dropping it
  // mid-call strands the session.
  console.log("[3/5] streaming the session — each tool call spawns its own sandbox:\n");
  const stream = await anthropic.beta.sessions.events.stream(session.id, undefined, {
    signal: AbortSignal.timeout(600_000),
  });
  await anthropic.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: PROMPT }] }],
  });

  for await (const event of stream) {
    if (event.type === "agent.message") {
      for (const block of event.content)
        if (block.type === "text") process.stdout.write(block.text);
    } else if (event.type === "agent.custom_tool_use") {
      toolCalls++;
      const command = String((event.input as { command?: string }).command ?? "");
      console.log(`\n      → tool call ${toolCalls}: ${command}`);
      const output = await runInFreshSandbox(command, toolCalls);
      await anthropic.beta.sessions.events.send(session.id, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{ type: "text", text: output }],
          },
        ],
      });
    } else if (event.type === "session.error") {
      console.error("\n      session error:", JSON.stringify(event));
      break;
    } else if (event.type === "session.status_idle") {
      // `requires_action` means the agent is idle *waiting on our tool result* —
      // the run is not over. Only a real stop reason ends it.
      if (event.stop_reason?.type === "requires_action") continue;
      process.stdout.write("\n");
      break;
    } else if (event.type === "session.status_terminated") {
      break;
    }
  }

  console.log(
    `\n[4/5] ${toolCalls} tool calls, ${toolCalls} sandboxes — each destroyed before the next began.`,
  );
  console.log(
    "      no sandbox outlived its call, so the file written in call 1 was gone by call 2.",
  );
  console.log(
    "      example 50 runs this same task on one per-session sandbox, where it survives.",
  );
} finally {
  console.log(
    "\n[5/5] cleanup: deleting the session and environment (no sandbox left to destroy)…",
  );
  if (sessionId) {
    await anthropic.beta.sessions
      .delete(sessionId)
      .catch((err) => console.log(`      session: ${(err as Error).message}`));
  }
  if (environmentId) {
    await anthropic.beta.environments
      .archive(environmentId)
      .catch((err) => console.log(`      environment: ${(err as Error).message}`));
  }
  console.log("      done");
}
