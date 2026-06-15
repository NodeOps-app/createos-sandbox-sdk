/**
 * Mastra agent in a sandbox — installs the Mastra TypeScript agent framework
 * inside a createos-sandbox microVM, uploads a small agent script, and runs it with bun.
 * OPENAI_API_KEY / OPENAI_API_URL / OPENAI_MODEL are injected into the sandbox
 * environment so the agent's AI SDK provider reaches the OpenAI-compatible
 * gateway without secrets being written to disk.
 *
 * Run:   bun index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY, plus OPENAI_API_KEY, OPENAI_API_URL, and
 *        OPENAI_MODEL (see .env.example). The sandbox installs Mastra from npm,
 *        so outbound network access from the VM is required.
 */
import { CreateosSandboxClient } from "createos-sandbox-sdk";

// Bridge FCSPAWN_URL -> CREATEOS_SANDBOX_BASE_URL for operators who set the alternate name.
const baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL ?? process.env.FCSPAWN_URL;
const apiKey = process.env.CREATEOS_SANDBOX_API_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
// OPENAI_API_URL is the gateway base URL (e.g. https://…/v1).
// Map it to OPENAI_BASE_URL which the @ai-sdk/openai provider reads natively.
const openaiBaseUrl = process.env.OPENAI_API_URL ?? process.env.OPENAI_BASE_URL;
const openaiModel = process.env.OPENAI_MODEL;

if (!baseUrl)
  throw new Error("CREATEOS_SANDBOX_BASE_URL (or FCSPAWN_URL) is not set — see .env.example");
if (!apiKey) throw new Error("CREATEOS_SANDBOX_API_KEY is not set — see .env.example");
if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not set — see .env.example");
if (!openaiBaseUrl) throw new Error("OPENAI_API_URL is not set — see .env.example");
if (!openaiModel) throw new Error("OPENAI_MODEL is not set — see .env.example");

const SHAPE = "s-4vcpu-4gb"; // Mastra install + bun need >=1 GB RAM headroom
const ROOTFS = "devbox:1";
const WORK_DIR = "/root/mastra-agent";

// Agent script uploaded to the sandbox and executed with `bun run`.
// Imports @mastra/core/agent and @ai-sdk/openai — both installed inside the
// sandbox in step 3 — and uses the env vars injected at sandbox-create time.
// process.exit(0) is called explicitly to bypass Mastra's OpenTelemetry flush,
// which otherwise hangs indefinitely waiting for a collector that isn't running.
const AGENT_SCRIPT = `
import { Agent } from "@mastra/core/agent";
import { createOpenAI } from "@ai-sdk/openai";

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;
const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

if (!apiKey) throw new Error("OPENAI_API_KEY is not set inside the sandbox");

const openai = createOpenAI({ apiKey, baseURL });

const agent = new Agent({
  name: "Assistant",
  instructions: "You are a helpful assistant. Answer concisely in one or two sentences.",
  model: openai(model),
});

const result = await agent.generate(
  "What is the capital city of France, and roughly how many people live there?"
);
const text = typeof result.text === "string" ? result.text : String(result.text);
console.log(\`Agent response: \${text}\`);
// Exit explicitly — Mastra registers OpenTelemetry spans and without a
// collector the SDK flush blocks indefinitely. process.exit(0) skips the flush.
process.exit(0);
`.trimStart();

const box = new CreateosSandboxClient({ baseUrl, apiKey });

console.log(`[1/5] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await box.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  envs: {
    OPENAI_API_KEY: openaiApiKey,
    // The @ai-sdk/openai createOpenAI factory reads OPENAI_BASE_URL.
    OPENAI_BASE_URL: openaiBaseUrl,
    OPENAI_MODEL: openaiModel,
    // Disable OpenTelemetry SDK so Mastra's span flush doesn't block on exit.
    OTEL_SDK_DISABLED: "true",
  },
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

try {
  // Install bun inside the sandbox.  devbox:1 ships with Node/npm but not bun;
  // the agent script runs under bun for native TS support and faster cold starts.
  console.log("[2/5] installing bun inside the sandbox...");
  await sandbox.sh(
    [
      "apt-get update -qq",
      "apt-get install -y -qq curl ca-certificates unzip",
      "curl -fsSL https://bun.sh/install | bash",
    ].join(" && "),
    { label: "bun-install", timeoutMs: 300_000 },
  );
  const { result: bunVer } = await sandbox.sh("/root/.bun/bin/bun --version", {
    label: "bun-version",
  });
  console.log(`      bun: ${bunVer.stdout.trim()}`);

  // Scaffold a minimal bun project, then install Mastra + its OpenAI AI-SDK
  // provider.  @mastra/core is the framework kernel; @ai-sdk/openai wraps
  // OpenAI-compatible endpoints; 'ai' is the Vercel AI SDK peer dep.
  console.log("[3/5] installing Mastra + AI SDK provider inside the sandbox...");
  await sandbox.sh(
    [
      `mkdir -p ${WORK_DIR} && cd ${WORK_DIR}`,
      "/root/.bun/bin/bun init -y",
      "/root/.bun/bin/bun add @mastra/core @ai-sdk/openai ai",
    ].join(" && "),
    { label: "mastra-install", timeoutMs: 600_000 },
  );

  // Upload the agent script and a tsconfig with bundler module resolution so
  // bun resolves the package.json `exports` of @mastra/core correctly.
  console.log("[4/5] uploading agent script and running it...");
  await sandbox.files.upload(`${WORK_DIR}/agent.ts`, AGENT_SCRIPT);
  await sandbox.files.upload(
    `${WORK_DIR}/tsconfig.json`,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          esModuleInterop: true,
          strict: false,
        },
      },
      null,
      2,
    ),
  );

  const { result } = await sandbox.sh(`cd ${WORK_DIR} && /root/.bun/bin/bun run agent.ts`, {
    label: "agent-run",
    timeoutMs: 300_000,
  });

  if (result.exit_code !== 0) {
    process.stderr.write(`agent stderr:\n${result.stderr}\n`);
    throw new Error(`agent exited with code ${result.exit_code}`);
  }

  console.log("\n── Mastra agent output ──────────────────────────────────────────");
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(`\n[stderr]\n${result.stderr}\n`);

  console.log("[5/5] done.");
} finally {
  await sandbox.destroy().catch((err: unknown) => {
    process.stderr.write(
      `cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
