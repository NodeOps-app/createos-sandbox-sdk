/**
 * Claude changelog generator — clone a public git repo inside a sandbox,
 * install the Anthropic SDK, call the Claude Messages API to turn `git log`
 * into a CHANGELOG.md, download it, and print to stdout.
 *
 * Run:   bun 44-claude-changelog-generator/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY plus ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN +
 *        ANTHROPIC_MODEL (the proxy triple from ../.env). The sandbox receives
 *        these as ANTHROPIC_* env vars so the Anthropic SDK inside the VM reaches
 *        the same proxy.
 */
import { CreateosSandboxClient } from "createos-sandbox-sdk";

// Bridge host env -> sandbox env.  Fail fast if createos-sandbox creds are missing.
const baseUrl = process.env.FCSPAWN_URL ?? process.env.CREATEOS_SANDBOX_BASE_URL;
if (!baseUrl) throw new Error("FCSPAWN_URL (or CREATEOS_SANDBOX_BASE_URL) is required");
const apiKey = process.env.CREATEOS_SANDBOX_API_KEY;
if (!apiKey) throw new Error("CREATEOS_SANDBOX_API_KEY is required");

const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
// Prefer the sonnet-tier model: the pro/opus-tier on this proxy uses extended
// thinking mode which emits no text content.  Fall back to ANTHROPIC_MODEL,
// then the upstream default.
const anthropicModel =
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

if (!anthropicAuthToken) throw new Error("ANTHROPIC_AUTH_TOKEN is required");
if (!anthropicBaseUrl) throw new Error("ANTHROPIC_BASE_URL is required");

// Repo to analyse — small public project with a clear commit history, fast shallow clone.
const TARGET_REPO = "https://github.com/antonmedv/fx.git";
const REPO_DIR = "/repo";

const SHAPE = "s-4vcpu-4gb";
const ROOTFS = "devbox:1";

// Env vars injected at sandbox-create time so every runCommand inherits them.
const sandboxEnvs: Record<string, string> = {
  ANTHROPIC_BASE_URL: anthropicBaseUrl,
  ANTHROPIC_AUTH_TOKEN: anthropicAuthToken,
  ANTHROPIC_MODEL: anthropicModel,
  // Anthropic SDK reads ANTHROPIC_API_KEY; proxy token goes to both names.
  ANTHROPIC_API_KEY: anthropicAuthToken,
  ...(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    ? { ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL }
    : {}),
};

const box = new CreateosSandboxClient({ baseUrl, apiKey });

console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await box.createSandbox({ shape: SHAPE, rootfs: ROOTFS, envs: sandboxEnvs });
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

try {
  // Clone the target repo (shallow — only the commit history we need).
  // GIT_TERMINAL_PROMPT=0 prevents git from hanging on credential prompts
  // in a non-interactive sandbox environment.
  console.log(`[2/6] cloning ${TARGET_REPO}...`);
  await sandbox.sh(
    `GIT_TERMINAL_PROMPT=0 git clone --depth=50 --quiet ${TARGET_REPO} ${REPO_DIR}`,
    { label: "git-clone", timeoutMs: 120_000 },
  );

  // Capture the last 40 commits as the prompt input.
  const gitLogResult = await sandbox.sh(`git -C ${REPO_DIR} log --oneline --no-merges -40`, {
    label: "git-log",
  });
  const commitLog = gitLogResult.result.stdout.trim();
  console.log(`      ${commitLog.split("\n").length} commits captured`);

  // Install @anthropic-ai/sdk into a local project directory so node's ESM
  // resolver can find it.  Global installs (-g) are not traversed by default.
  console.log("[3/6] installing @anthropic-ai/sdk inside sandbox...");
  await sandbox.sh(
    "mkdir -p /tmp/gen && cd /tmp/gen && npm init -y > /dev/null && npm install @anthropic-ai/sdk 2>&1 | tail -3",
    { label: "npm-install", timeoutMs: 300_000 },
  );

  // Write the generator script and upload it into the project directory.
  console.log("[4/6] writing generator script...");
  const generatorScript = buildGeneratorScript(commitLog, anthropicModel);
  await sandbox.files.upload("/tmp/gen/gen-changelog.mjs", generatorScript);

  // Run the generator.  sandbox.sh throws on non-zero exit.
  console.log("[5/6] running Claude changelog generator...");
  const genResult = await sandbox.sh("cd /tmp/gen && node gen-changelog.mjs", {
    label: "gen-changelog",
    timeoutMs: 180_000,
  });
  console.log(`      ${genResult.result.stdout.trim()}`);

  // Download the generated CHANGELOG.md.
  console.log("[6/6] downloading CHANGELOG.md...");
  const changelogBytes = await sandbox.files.download("/tmp/gen/CHANGELOG.md");
  const changelog = Buffer.from(changelogBytes).toString("utf8");

  console.log("\n── CHANGELOG.md ─────────────────────────────────────────────────");
  process.stdout.write(changelog);
  console.log("─────────────────────────────────────────────────────────────────\n");
  console.log("done.");
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log(`destroyed: ${sandbox.id}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns an ES-module script that reads ANTHROPIC_* from env, calls the
 * Claude Messages API, and writes CHANGELOG.md to /tmp/gen/CHANGELOG.md.
 */
function buildGeneratorScript(commitLog: string, model: string): string {
  // Escape backticks and backslashes so the template literal survives embedding.
  const safeLog = commitLog.replace(/\\/g, "\\\\").replace(/`/g, "\\`");

  return `
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const { writeFileSync } = await import("fs");

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN,
});

const commitLog = \`${safeLog}\`;

const systemPrompt =
  "You are a technical writer. Given a list of git commits, produce a clean " +
  "CHANGELOG.md in Keep a Changelog format (https://keepachangelog.com). " +
  "Group entries under Added, Changed, Fixed, or Removed. Use today's date " +
  "for the version header. Output only the Markdown — no code fences, no prose.";

const userPrompt =
  "Generate a CHANGELOG.md from these git commits:\\n\\n" + commitLog;

// Extended-thinking model tiers occasionally return end_turn with only a
// thinking block and no text content; retry a few times before giving up.
async function generate() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await client.messages.create({
      model: ${JSON.stringify(model)},
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\\n")
      .trim();
    if (text) return text;
    console.error(
      "attempt " + attempt + "/3: empty content (stop_reason=" + response.stop_reason + "), retrying...",
    );
  }
  throw new Error("Claude returned empty content after 3 attempts");
}

const text = await generate();

writeFileSync("/tmp/gen/CHANGELOG.md", text + "\\n");
console.log("CHANGELOG.md written (" + text.split("\\n").length + " lines)");
`;
}
