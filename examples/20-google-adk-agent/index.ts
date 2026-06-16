/**
 * Google ADK agent backed by createos-sandbox sandbox tools.
 *
 * A Google Agent Development Kit (ADK) agent runs on the host in Python; its
 * tools execute inside a createos-sandbox VM. This thin TypeScript entry owns the
 * sandbox lifecycle: it creates one sandbox with `createos-sandbox-sdk`, then spawns
 * the Python ADK driver (`adk_agent.py`) as a child process, handing it the
 * sandbox id plus the createos-sandbox connection creds via env. The driver's tools call the
 * createos-sandbox HTTP API directly (runCommand / files) so the agent's reasoning steps land
 * as real sandbox operations. The sandbox is destroyed in a `finally` block —
 * the Python child never tears it down, only this file does.
 *
 * Run:   bun 20-google-adk-agent/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY, plus OPENAI_API_URL / OPENAI_API_KEY /
 *        OPENAI_MODEL (the LLM ADK drives, via a LiteLLM OpenAI-compatible
 *        proxy). Requires python3 on the host PATH; the venv with google-adk
 *        + litellm is auto-created on first run inside this directory.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const here = dirname(fileURLToPath(import.meta.url));

const SHAPE = "s-2vcpu-2gb"; // agent workloads need real RAM
const ROOTFS = "devbox:1";

// Base URL for the control plane, also handed to the Python child.
const CREATEOS_SANDBOX_BASE_URL = process.env.CREATEOS_SANDBOX_BASE_URL;
if (!CREATEOS_SANDBOX_BASE_URL) {
  console.error("CREATEOS_SANDBOX_BASE_URL must be set (see .env.example).");
  process.exit(1);
}
const CREATEOS_SANDBOX_API_KEY = process.env.CREATEOS_SANDBOX_API_KEY;
if (!CREATEOS_SANDBOX_API_KEY) {
  console.error("CREATEOS_SANDBOX_API_KEY must be set (see .env.example).");
  process.exit(1);
}

const OPENAI_API_URL = process.env.OPENAI_API_URL ?? process.env.OPENAI_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
if (!OPENAI_API_URL || !OPENAI_API_KEY || !OPENAI_MODEL) {
  console.error(
    "OPENAI_API_URL, OPENAI_API_KEY and OPENAI_MODEL must be set — ADK reaches the\n" +
      "OpenAI-compatible proxy through LiteLLM (see .env.example).",
  );
  process.exit(1);
}

const VENV_PYTHON = join(here, ".venv", "bin", "python");

/** Wraps spawn in a Promise that resolves to the exit code. */
function spawnAsync(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

try {
  await access(VENV_PYTHON, constants.X_OK);
  // fast path — venv already exists
} catch {
  console.log("[setup] creating Python venv + installing google-adk litellm (first run)...");

  // Verify python3 is available on the host before attempting venv creation.
  const python3Check = await spawnAsync("python3", ["--version"], here).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error("python3 not found on PATH — install Python 3 on the host and retry.");
        process.exit(1);
      }
      throw err;
    },
  );
  if (python3Check !== 0) {
    throw new Error(`python3 --version exited with code ${python3Check}`);
  }

  const venvCode = await spawnAsync("python3", ["-m", "venv", ".venv"], here);
  if (venvCode !== 0) {
    throw new Error(`python3 -m venv .venv failed with exit code ${venvCode}`);
  }

  const pipCode = await spawnAsync(
    join(here, ".venv", "bin", "pip"),
    ["install", "-q", "--disable-pip-version-check", "google-adk", "litellm"],
    here,
  );
  if (pipCode !== 0) {
    throw new Error(`pip install failed with exit code ${pipCode}`);
  }
}

const box = new CreateosSandboxClient({
  apiKey: CREATEOS_SANDBOX_API_KEY,
  baseUrl: CREATEOS_SANDBOX_BASE_URL,
});

// 1. Create the sandbox the agent's tools will act on.
console.log(`[1/3] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await box.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  name: `adk-${Date.now() % 1_000_000}`,
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

try {
  // 2. Run the agent. stdio:"inherit" wires the child's prompts/output straight
  //    to this terminal; the agent loops in Python until it exits.
  console.log("[2/3] launching Python ADK driver (tools backed by this sandbox)...");
  const driver = join(here, "adk_agent.py");
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(VENV_PYTHON, [driver], {
      cwd: here,
      stdio: "inherit",
      env: {
        ...process.env,
        // Hand the child exactly what it needs to reach createos-sandbox + the LLM proxy.
        CREATEOS_SANDBOX_ID: sandbox.id,
        CREATEOS_SANDBOX_BASE_URL,
        CREATEOS_SANDBOX_API_KEY,
        OPENAI_API_URL,
        OPENAI_API_KEY,
        OPENAI_MODEL,
      },
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`ADK driver exited with code ${exitCode}`);
  }
  console.log("\n[3/3] ADK run complete.");
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error(`destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
