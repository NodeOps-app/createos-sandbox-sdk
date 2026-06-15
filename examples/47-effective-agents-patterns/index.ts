/**
 * Effective agent patterns — prompt-chaining, routing, and parallelization —
 * implemented with the Vercel AI SDK (ai + @ai-sdk/openai) running INSIDE an
 * FC microVM. The host orchestrates the sandbox lifecycle; all LLM calls
 * happen inside the VM so the agent code runs in an isolated, ephemeral
 * environment.
 *
 * Run:   bun 47-effective-agents-patterns/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY + OPENAI_API_KEY + OPENAI_API_URL + OPENAI_MODEL
 */
import { readFileSync } from "node:fs";
import { Sandbox } from "createos-sandbox-sdk";

// Bridge host env vars into the sandbox so the agent code can reach the LLM proxy.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = process.env.OPENAI_API_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL;

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
if (!OPENAI_API_URL) throw new Error("OPENAI_API_URL is required");
if (!OPENAI_MODEL) throw new Error("OPENAI_MODEL is required");

const SHAPE = "s-4vcpu-4gb";
const ROOTFS = "devbox:1";

console.log(`[1/5] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await Sandbox.create({
  shape: SHAPE,
  rootfs: ROOTFS,
  envs: {
    OPENAI_API_KEY,
    OPENAI_API_URL,
    OPENAI_MODEL,
  },
});
console.log(`      sandbox: ${sandbox.id}`);

try {
  // Upload the agent-patterns TypeScript file into the sandbox.
  const agentScript = readFileSync(
    new URL("./agent-patterns.js", import.meta.url).pathname,
    "utf8",
  );
  console.log("[2/5] uploading agent-patterns.js...");
  await sandbox.files.upload("/root/agent-patterns.js", agentScript);

  // Install the Vercel AI SDK and its OpenAI provider inside the sandbox.
  // bun is pre-installed on devbox:1.
  console.log("[3/5] installing ai + @ai-sdk/openai inside the sandbox...");
  await sandbox.sh("cd /root && bun add ai @ai-sdk/openai", {
    label: "bun-install",
    timeoutMs: 180_000,
  });

  // Run each pattern once; capture combined stdout.
  console.log("[4/5] running agent patterns...");
  const { result } = await sandbox.runCommand("bun", ["run", "/root/agent-patterns.js"], {
    timeoutMs: 300_000,
  });

  if (result.exit_code !== 0) {
    if (result.stderr) process.stderr.write("--- stderr ---\n" + result.stderr + "\n");
    throw new Error(`agent-patterns.ts exited ${result.exit_code}`);
  }

  console.log("\n--- agent output ---");
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write("--- stderr ---\n" + result.stderr + "\n");

  console.log("[5/5] done — verified all three patterns");
} finally {
  await sandbox.destroy().catch((err: unknown) => {
    process.stderr.write(
      `cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
  console.log(`destroyed: ${sandbox.id}`);
}
