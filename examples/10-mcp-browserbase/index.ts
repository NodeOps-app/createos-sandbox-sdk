/**
 * Host a remote MCP server in a sandbox and let Claude drive it. The sandbox
 * runs the Browserbase MCP server (HTTP transport, bound 0.0.0.0) behind a
 * public ingress URL; Claude reaches it via the Anthropic beta MCP-client
 * feature, pointing `mcp_servers[].url` at the sandbox's `previewUrl(port)`.
 * The sandbox is the MCP *host* — the browser automation itself runs on
 * Browserbase's cloud, called out from inside the microVM.
 *
 * Run:   bun 10-mcp-browserbase/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY, ANTHROPIC_API_KEY, and a Browserbase
 *        account (BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID). See
 *        .env.example. Excluded from CI — it needs a paid Browserbase account.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "fc-sandbox-sdk";
import { existsSync, readFileSync } from "node:fs";

loadParentEnvFallback();

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
const MCP_PORT = 8080;
// Task for the agent
const TASK = "Take a screenshot of https://example.com and tell me what you see on the page.";

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error("Missing required env vars: BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID");
  process.exit(1);
}

const anthropic = new Anthropic();

console.log("Creating FC sandbox with ingress enabled...");
const sandbox = await Sandbox.create({
  shape: "s-1vcpu-512mb",
  rootfs: "devbox:1",
  ingress_enabled: true,
  envs: {
    BROWSERBASE_API_KEY,
    BROWSERBASE_PROJECT_ID,
  },
});
console.log(`Sandbox created: ${sandbox.id}`);

try {
  // Install @browserbasehq/mcp
  console.log("Installing @browserbasehq/mcp...");
  const install = await sandbox.runCommand(
    "bash",
    ["-lc", "npm install -g @browserbasehq/mcp 2>&1 | tail -3"],
    { timeoutMs: 120_000 },
  );
  if (install.result.exit_code !== 0) {
    throw new Error(`npm install failed:\n${install.result.stderr}`);
  }
  console.log("Installed:", install.result.stdout.trim());

  // Start MCP server in background (HTTP transport, bind 0.0.0.0)
  console.log(`Starting Browserbase MCP server on port ${MCP_PORT}...`);
  await sandbox.runCommand("bash", [
    "-lc",
    `nohup setsid npx mcp-server-browserbase \
      --port ${MCP_PORT} \
      --host 0.0.0.0 \
      >/var/log/bb-mcp.log 2>&1 &`,
  ]);

  // Wait for the MCP server to bind the port. Once TCP accepts, the HTTP
  // /mcp endpoint typically responds within a second.
  console.log("Waiting for MCP server to be ready...");
  try {
    await sandbox.waitForPortReady(MCP_PORT, { timeoutMs: 60_000 });
  } catch (err) {
    const log = await sandbox.runCommand("bash", [
      "-lc",
      "cat /var/log/bb-mcp.log 2>/dev/null | tail -20",
    ]);
    console.error("MCP server did not become ready. Log:\n", log.result.stdout);
    throw err;
  }
  console.log("MCP server ready.");

  // Build ingress URL — the SDK substitutes <port> from the control plane template
  const mcpUrl = sandbox.previewUrl(MCP_PORT);
  console.log(`MCP ingress URL: ${mcpUrl}`);

  // Call Claude with the MCP server pointing at the FC sandbox ingress
  console.log(`\nRunning agent task: "${TASK}"`);
  const response = await anthropic.beta.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    max_tokens: 4096,
    betas: ["mcp-client-2025-11-20"],
    mcp_servers: [
      {
        type: "url",
        url: `${mcpUrl}/mcp`,
        name: "browserbase",
      },
    ],
    messages: [{ role: "user", content: TASK }],
  });

  console.log("\n--- Agent response ---");
  for (const block of response.content) {
    if (block.type === "text") {
      process.stdout.write(block.text + "\n");
    }
  }
  console.log(`\nStop reason: ${response.stop_reason}`);
} finally {
  await sandbox.destroy();
  console.log(`\nDestroyed sandbox: ${sandbox.id}`);
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
