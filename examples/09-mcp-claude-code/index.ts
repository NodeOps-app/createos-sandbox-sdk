/**
 * Run the Claude Code CLI *inside* a sandbox and drive it headlessly. Installs
 * `@anthropic-ai/claude-code`, pipes a coding task into `claude -p`, and prints
 * what the agent produced. The agent's keys and model are passed through the
 * sandbox's `envs`, so the CLI talks to Anthropic from within the microVM.
 *
 * The task is collected with a single `runCommand`, not `streamCommand`:
 * `streamCommand` exits -1 for long-running CLIs on this backend, so we block
 * on the full result instead (see the note at the call site).
 *
 * Run:   bun 09-mcp-claude-code/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY, plus ANTHROPIC_API_KEY (or the proxy pair
 *        ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL). See .env.example.
 */
import { Sandbox } from "fc-sandbox-sdk";
import { existsSync, readFileSync } from "node:fs";

loadParentEnvFallback();

// Task for Claude Code to perform inside the sandbox.
const TASK =
  "Write a Python script that generates the first 10 Fibonacci numbers " +
  "and identifies which ones are prime. Print each result clearly. " +
  "Save the script to /tmp/fibonacci.py, run it, and show the output.";

const SHAPE = "s-1vcpu-1gb";
const ROOTFS = "devbox:1";

// Claude Code CLI reads ANTHROPIC_API_KEY. Support both the real key and
// the proxy pattern (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL).
const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required");

const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
const anthropicModel = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

// Env vars injected into every command in the sandbox.
// ANTHROPIC_* is needed by the Claude Code CLI inside the sandbox.
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC avoids telemetry/update checks.
const sandboxEnvs: Record<string, string> = {
  ANTHROPIC_API_KEY: anthropicApiKey,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
if (anthropicBaseUrl) sandboxEnvs.ANTHROPIC_BASE_URL = anthropicBaseUrl;

console.log(`[1/4] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await Sandbox.create({ shape: SHAPE, rootfs: ROOTFS, envs: sandboxEnvs });
console.log(`      sandbox: ${sandbox.id}`);

try {
  // Install @anthropic-ai/claude-code to /usr/local so the binary is
  // accessible to all users (required because claude is run as non-root).
  console.log("[2/4] installing @anthropic-ai/claude-code...");
  const install = await sandbox.runCommand(
    "sh",
    ["-lc", "npm install -g @anthropic-ai/claude-code --prefix /usr/local 2>&1"],
    { timeoutMs: 300_000 },
  );
  if (install.result.exit_code !== 0) {
    throw new Error(`npm install failed:\n${install.result.stderr}`);
  }
  const ver = await sandbox.runCommand("/usr/local/bin/claude", ["--version"]);
  console.log(`      ${ver.result.stdout.trim()}`);

  // Claude Code blocks --dangerously-skip-permissions when the process runs
  // as root. Create a non-root user and su to it for the coding task.
  console.log("[3/4] creating non-root user...");
  await sandbox.runCommand("sh", ["-c", "useradd -m -s /bin/bash sandboxuser 2>/dev/null || true"]);

  console.log("[4/4] running coding task inside sandbox...");
  console.log(`      prompt: "${TASK.slice(0, 80)}..."\n`);

  // streamCommand exits -1 for long-running CLIs on this backend; use runCommand instead.
  const { result } = await sandbox.runCommand(
    "su",
    [
      "-s",
      "/bin/bash",
      "-c",
      [
        "export HOME=/home/sandboxuser",
        "export PATH=/usr/local/bin:$PATH",
        `echo ${JSON.stringify(TASK)} | claude -p --dangerously-skip-permissions --model ${JSON.stringify(anthropicModel)} 2>&1`,
      ].join(" && "),
      "sandboxuser",
    ],
    { timeoutMs: 300_000 },
  );

  if (result.exit_code !== 0) {
    throw new Error(`claude exited ${result.exit_code}:\n${result.stderr}`);
  }
  process.stdout.write(result.stdout);
  console.log("\n[done]");
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("sandbox destroyed");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadParentEnvFallback(): void {
  const parentEnv = "../.env";
  if (!existsSync(parentEnv)) return;
  for (const line of readFileSync(parentEnv, "utf8").split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(["'])(.*)\1$/, "$2");
  }
}
