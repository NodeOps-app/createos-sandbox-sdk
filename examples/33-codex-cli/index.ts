/**
 * Run the OpenAI Codex CLI inside a sandbox to execute a coding task.
 *
 * Installs the Codex CLI (Rust edition, @openai/codex) in a createos-sandbox sandbox, points
 * it at an OpenAI-compatible provider via ~/.codex/config.toml, then runs a
 * coding task non-interactively with `codex exec`. The generated file is
 * downloaded and re-run on the VM as proof. The interesting part is making an
 * autonomous coding agent safe to let loose: it gets danger-full-access +
 * approval=never, which is only acceptable *because* the blast radius is a
 * disposable microVM that gets destroyed in the finally block.
 *
 * Run:   bun 33-codex-cli/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY, plus OPENAI_API_KEY, OPENAI_API_URL (the
 *        provider base_url), and OPENAI_MODEL — all required (see .env.example).
 */
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const CREATEOS_SANDBOX_BASE_URL = process.env.CREATEOS_SANDBOX_BASE_URL;
const CREATEOS_SANDBOX_API_KEY = process.env.CREATEOS_SANDBOX_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = process.env.OPENAI_API_URL; // gateway base url
const OPENAI_MODEL = process.env.OPENAI_MODEL;

if (!CREATEOS_SANDBOX_BASE_URL) throw new Error("CREATEOS_SANDBOX_BASE_URL is not set");
if (!CREATEOS_SANDBOX_API_KEY) throw new Error("CREATEOS_SANDBOX_API_KEY is not set");
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

const box = new CreateosSandboxClient({
  baseUrl: CREATEOS_SANDBOX_BASE_URL,
  apiKey: CREATEOS_SANDBOX_API_KEY,
});

// 1. Create the sandbox. envs are injected into the VM's environment so the
//    Codex CLI (which reads OPENAI_API_KEY for auth) sees the key without us
//    having to write it into a file.
console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await box.createSandbox({
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
  // 2. Install Node 22 (NodeSource) then the Codex CLI (the Rust binary ships
  //    as the @openai/codex npm package).
  console.log("[2/6] installing Node.js 22 + Codex CLI...");
  await sandbox.sh(
    [
      "apt-get update -qq",
      "apt-get install -y -qq curl ca-certificates",
      // NodeSource LTS (22.x)
      "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1",
      "apt-get install -y -qq nodejs",
      "node --version",
    ].join(" && "),
    { label: "node-install", timeoutMs: 300_000 },
  );

  // Install Codex CLI globally — the Rust binary ships as an npm package
  await sandbox.sh("npm install -g @openai/codex 2>&1 | tail -5", {
    label: "codex-install",
    timeoutMs: 300_000,
  });
  const { result: ver } = await sandbox.sh("codex --version", { label: "codex-version" });
  console.log(`      codex: ${ver.stdout.trim()}`);

  // 3. Write Codex's config. The settings below are what wire it to the custom
  //    gateway and let it run unattended inside the disposable VM.
  console.log("[3/6] writing ~/.codex/config.toml (custom provider)...");
  // Configure Codex to use the OpenAI-compatible gateway.
  // model_provider = "gateway" links the active model to the custom provider.
  // supports_websockets = false: gateway does not expose a WS endpoint for streaming.
  // approval_policy = "never": suppresses all interactive approval prompts.
  // sandbox_mode = "danger-full-access": allows the agent to write files (inside createos-sandbox VM is safe).
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

  // 4. Run the task. The prompt is uploaded to a file and piped via stdin
  //    rather than passed as an argv string, so its prose can't be mangled by
  //    bash quoting/expansion.
  console.log("[4/6] running codex exec (non-interactive)...");
  // Create a dedicated workspace directory so Codex has a clear write target.
  await sandbox.sh("mkdir -p /root/work", { label: "mkdir-work" });
  // Write the task to a file and pipe via stdin to avoid shell quoting issues.
  await sandbox.files.upload("/root/work/task.txt", CODEX_TASK);

  // codex exec: non-interactive task runner.
  // --ephemeral: no session rollout files persisted to disk.
  // --skip-git-repo-check: /root/work is not a git repo; skip that guard.
  // cd into the workspace so relative paths in the task resolve there.
  const { result: codex } = await sandbox.sh(
    "cd /root/work && codex exec --ephemeral --skip-git-repo-check < /root/work/task.txt",
    { label: "codex-exec", timeoutMs: 300_000 },
  );
  console.log("\n── codex output ─────────────────────────────────────────────────");
  console.log(codex.stdout.trim());

  // 5. Pull the file the agent wrote back to the host to inspect it.
  console.log("\n[5/6] downloading generated file...");
  const fileBytes = await sandbox.files.download("/root/work/fizzbuzz.py");
  const fileContent = Buffer.from(fileBytes).toString("utf8");

  console.log("\n── /root/work/fizzbuzz.py ───────────────────────────────────────");
  console.log(fileContent.trim());

  // 6. Re-run the generated script in the VM as end-to-end proof it works.
  console.log("\n[6/6] running generated code as proof...");
  const { result: py } = await sandbox.sh("python3 /root/work/fizzbuzz.py", {
    label: "python-run",
  });
  console.log("\n── python3 /root/work/fizzbuzz.py ───────────────────────────────");
  console.log(py.stdout.trim());

  console.log(
    "\nverified end-to-end: codex generated and ran Python code inside createos-sandbox sandbox",
  );
} finally {
  await sandbox.destroy().catch(() => {});
  console.log(`\ndestroyed: ${sandbox.id}`);
}
