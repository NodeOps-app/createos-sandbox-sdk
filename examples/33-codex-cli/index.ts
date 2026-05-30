// 33 — Codex CLI in Sandbox
//
// Installs the OpenAI Codex CLI (Rust edition, @openai/codex) inside an FC
// sandbox, configures a custom OpenAI-compatible provider via config.toml,
// then runs a small coding task non-interactively with `codex exec`. The
// generated file is downloaded and printed to stdout.

import { FcClient } from "fc-sandbox-sdk";

const FC_BASE_URL = process.env.FC_BASE_URL;
const FC_API_KEY = process.env.FC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = process.env.OPENAI_API_URL; // gateway base url
const OPENAI_MODEL = process.env.OPENAI_MODEL;

if (!FC_BASE_URL) throw new Error("FC_BASE_URL is not set");
if (!FC_API_KEY) throw new Error("FC_API_KEY is not set");
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
if (!OPENAI_API_URL) throw new Error("OPENAI_API_URL is not set");
if (!OPENAI_MODEL) throw new Error("OPENAI_MODEL is not set");

const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";

// Task for Codex: write a simple Python module to a file the host can verify.
// Kept free of shell-special characters so it survives bash arg expansion.
const CODEX_TASK =
  "Write a Python 3 script called fizzbuzz.py implementing the fizzbuzz function. " +
  "The function should take an integer n and return a list of strings following the classic rules. " +
  "The script must also print the result of calling fizzbuzz with 15 when run directly. " +
  "After writing fizzbuzz.py run it with python3 fizzbuzz.py to confirm it produces output.";

const fc = new FcClient({ baseUrl: FC_BASE_URL, apiKey: FC_API_KEY });

const tail = (s: string) => s.slice(-1200);

async function sh(
  sandbox: Awaited<ReturnType<typeof fc.createSandbox>>,
  label: string,
  script: string,
  timeoutMs = 120_000,
) {
  const { result } = await sandbox.runCommand("bash", ["-lc", script], { timeoutMs });
  if (result.exit_code !== 0) {
    console.error(`[${label}] exit=${result.exit_code}`);
    if (result.stdout) console.error("  stdout:", tail(result.stdout));
    if (result.stderr) console.error("  stderr:", tail(result.stderr));
    throw new Error(`${label} failed (exit ${result.exit_code})`);
  }
  return result.stdout;
}

console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  envs: {
    // Codex CLI reads OPENAI_API_KEY for auth
    OPENAI_API_KEY,
    DEBIAN_FRONTEND: "noninteractive",
  },
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

try {
  console.log("[2/6] installing Node.js 22 + Codex CLI...");
  await sh(
    sandbox,
    "node-install",
    [
      "apt-get update -qq",
      "apt-get install -y -qq curl ca-certificates",
      // NodeSource LTS (22.x)
      "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1",
      "apt-get install -y -qq nodejs",
      "node --version",
    ].join(" && "),
    300_000,
  );

  // Install Codex CLI globally — the Rust binary ships as an npm package
  await sh(sandbox, "codex-install", "npm install -g @openai/codex 2>&1 | tail -5", 300_000);
  const codexVer = await sh(sandbox, "codex-version", "codex --version");
  console.log(`      codex: ${codexVer.trim()}`);

  console.log("[3/6] writing ~/.codex/config.toml (custom provider)...");
  // Configure Codex to use the OpenAI-compatible gateway.
  // model_provider = "gateway" links the active model to the custom provider.
  // supports_websockets = false: gateway does not expose a WS endpoint for streaming.
  // approval_policy = "never": suppresses all interactive approval prompts.
  // sandbox_mode = "danger-full-access": allows the agent to write files (inside FC VM is safe).
  const configToml = `
model = "${OPENAI_MODEL}"
model_provider = "gateway"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.gateway]
name = "NodeOps Gateway"
base_url = "${OPENAI_API_URL}"
env_key = "OPENAI_API_KEY"
supports_websockets = false
`.trim();

  await sandbox.files.upload("/root/.codex/config.toml", configToml);
  console.log("      config written");

  console.log("[4/6] running codex exec (non-interactive)...");
  // Create a dedicated workspace directory so Codex has a clear write target.
  await sh(sandbox, "mkdir-work", "mkdir -p /root/work");
  // Write the task to a file and pipe via stdin to avoid shell quoting issues.
  await sandbox.files.upload("/root/work/task.txt", CODEX_TASK);

  // codex exec: non-interactive task runner.
  // --ephemeral: no session rollout files persisted to disk.
  // --skip-git-repo-check: /root/work is not a git repo; skip that guard.
  // cd into the workspace so relative paths in the task resolve there.
  const codexOut = await sh(
    sandbox,
    "codex-exec",
    "cd /root/work && codex exec --ephemeral --skip-git-repo-check < /root/work/task.txt",
    300_000,
  );
  console.log("\n── codex output ─────────────────────────────────────────────────");
  console.log(codexOut.trim());

  console.log("\n[5/6] downloading generated file...");
  const fileBytes = await sandbox.files.download("/root/work/fizzbuzz.py");
  const fileContent = Buffer.from(fileBytes).toString("utf8");

  console.log("\n── /root/work/fizzbuzz.py ───────────────────────────────────────");
  console.log(fileContent.trim());

  console.log("\n[6/6] running generated code as proof...");
  const pyOut = await sh(sandbox, "python-run", "python3 /root/work/fizzbuzz.py");
  console.log("\n── python3 /root/work/fizzbuzz.py ───────────────────────────────");
  console.log(pyOut.trim());

  console.log("\nverified end-to-end: codex generated and ran Python code inside FC sandbox");
} finally {
  await sandbox.destroy().catch(() => {});
  console.log(`\ndestroyed: ${sandbox.id}`);
}
