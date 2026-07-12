/**
 * Sandbox as an agent tool, one sandbox per session — give a cloud-hosted
 * Claude Managed Agent a `run_command` tool backed by createos-sandbox.
 *
 * The inverse of examples 36/37/49. There, the agent's own bash ran *inside* a
 * sandbox (self-hosted environment). Here Anthropic hosts the agent loop, and
 * createos-sandbox is a discrete tool the agent reaches for: the agent emits a
 * `run_command` tool call, this orchestrator runs it in a sandbox it owns, and
 * hands the output back. The control-plane API key never leaves your host.
 *
 * Lifecycle: **one sandbox per session**, created before the session starts and
 * reused for every tool call, so state persists between calls. The task proves
 * it — the agent writes a file in one tool call and reads it back in the next,
 * and the read succeeds. Example 51 runs the same task with a fresh throwaway
 * sandbox per call, where that read fails.
 *
 * The agent is given *only* the custom tool — no built-in agent toolset — so
 * createos-sandbox is its single execution path.
 *
 * Run:   bun 50-cloud-agent-sandbox-tool/index.ts
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

// The tool body. `Sandbox.sh` throws on a non-zero exit, which is wrong for a
// tool: a failing command is a result the agent must see and reason about, not
// an orchestrator crash. Drop to `runCommand` and hand back the exit code with
// the output. Managed Agents also rejects an empty tool result, so never return
// an empty string.
async function runCommand(sandbox: Sandbox, command: string): Promise<string> {
  const { result } = await sandbox.runCommand("bash", ["-lc", command], { timeoutMs: 120_000 });
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.exit_code === 0) return output || "(no output)";
  return `exit ${result.exit_code}\n${output || "(no output)"}`;
}

// Two tool calls, deliberately: write, then read back in a *separate* call. With
// one sandbox per session the second call lands on the same machine, so the read
// succeeds and the hostnames match.
const PROMPT =
  "Do this in exactly two separate run_command calls — never combine them:\n" +
  `1. Run: hostname > ${WORKDIR}/note.txt; echo "written by $(hostname)"\n` +
  `2. Run: cat ${WORKDIR}/note.txt\n` +
  "Then say in one sentence whether the second call saw the file the first call " +
  "wrote, and whether the two hostnames match.";

const apiKey = loadAntKey();
const anthropic = new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL });

// The one sandbox that serves every tool call in this session. Created up front,
// destroyed when the session ends — so anything the agent writes survives across
// its tool calls.
console.log("[1/6] creating the session's createos-sandbox sandbox…");
const sandbox = await createSandbox({
  shape: SHAPE,
  rootfs: "devbox:1",
  name: `sess-tool-${Date.now() % 100000}`,
});
console.log(`      sandbox ${sandbox.id} @ ${sandbox.ip}`);
await sandbox.sh(`mkdir -p ${WORKDIR}`);

let environmentId: string | undefined;
let sessionId: string | undefined;
let toolCalls = 0;

try {
  // A cloud environment hosts the agent loop on Anthropic's infrastructure. We
  // never touch it — it exists because sessions require an environment — and the
  // agent's only way to run anything is the custom tool below.
  console.log("[2/6] creating the cloud environment (Anthropic hosts the agent loop)…");
  const environment = await anthropic.beta.environments.create({
    name: `createos-tool-session-${Date.now() % 100000}`,
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  environmentId = environment.id;
  console.log(`      environment ${environment.id}`);

  console.log("[3/6] creating the agent — its only tool is run_command…");
  const agent = await anthropic.beta.agents.create({
    name: `createos-sandbox-tool-${Date.now() % 100000}`,
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
  console.log("[4/6] streaming the session — tool calls land in the sandbox:\n");
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
    } else if (event.type === "agent.custom_tool_use") {
      toolCalls++;
      const command = String((event.input as { command?: string }).command ?? "");
      console.log(`\n      → tool call ${toolCalls}: ${command}`);
      const output = await runCommand(sandbox, command);
      console.log(`      ← sandbox ${sandbox.id}: ${output.replace(/\n/g, " | ")}`);
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

  console.log(`\n[5/6] ${toolCalls} tool calls, all served by sandbox ${sandbox.id}.`);
  console.log("      the file survived between calls because the sandbox did.");
  console.log("      host-side read of the same file, straight from the sandbox:");
  const note = new TextDecoder().decode(await sandbox.files.download(`${WORKDIR}/note.txt`));
  console.log(`      ── ${WORKDIR}/note.txt ── ${note.trim()}`);
} finally {
  console.log("\n[6/6] cleanup: destroying the sandbox, session and environment…");
  await sandbox.destroy().catch((err) => console.log(`      sandbox: ${(err as Error).message}`));
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
