/**
 * Google ADK agent backed by FC sandbox tools.
 *
 * A Google Agent Development Kit (ADK) agent runs on the host in Python; its
 * tools execute inside an FC microVM. This thin TypeScript entry owns the
 * sandbox lifecycle: it creates one sandbox with `fc-sandbox-sdk`, then spawns
 * the Python ADK driver (`adk_agent.py`) as a child process, handing it the
 * sandbox id plus the FC connection creds via env. The driver's tools call the
 * FC HTTP API directly (runCommand / files) so the agent's reasoning steps land
 * as real sandbox operations. The sandbox is destroyed in a `finally` block —
 * the Python child never tears it down, only this file does.
 *
 * Run:   bun 20-google-adk-agent/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY, plus OPENAI_API_URL / OPENAI_API_KEY /
 *        OPENAI_MODEL (the LLM ADK drives, via a LiteLLM OpenAI-compatible
 *        proxy). A local Python venv with google-adk + litellm (see below).
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FcClient } from "fc-sandbox-sdk";

const here = dirname(fileURLToPath(import.meta.url));

const SHAPE = "s-1vcpu-256mb";
const ROOTFS = "devbox:1";

// Base URL for the control plane, also handed to the Python child.
const FC_BASE_URL = process.env.FC_BASE_URL;
if (!FC_BASE_URL) {
  console.error("FC_BASE_URL must be set (see .env.example).");
  process.exit(1);
}
const FC_API_KEY = process.env.FC_API_KEY;
if (!FC_API_KEY) {
  console.error("FC_API_KEY must be set (see .env.example).");
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
try {
  await access(VENV_PYTHON, constants.X_OK);
} catch {
  console.error(
    `Python venv not found at ${VENV_PYTHON}.\n` +
      "Create it once with:\n" +
      "  python3 -m venv .venv && .venv/bin/pip install google-adk litellm",
  );
  process.exit(1);
}

const fc = new FcClient({ apiKey: FC_API_KEY, baseUrl: FC_BASE_URL });

// 1. Create the sandbox the agent's tools will act on.
console.log(`[1/3] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await fc.createSandbox({
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
        // Hand the child exactly what it needs to reach FC + the LLM proxy.
        FC_SANDBOX_ID: sandbox.id,
        FC_BASE_URL,
        FC_API_KEY,
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
