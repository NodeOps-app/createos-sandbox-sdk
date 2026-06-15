/**
 * Claude agent GitHub wiki Q&A — clone a public GitHub repo into a createos-sandbox
 * sandbox, let a Claude agent explore its file tree, then ask it 2 concrete
 * questions about the codebase and capture the answers to stdout.
 *
 * Demonstrates the "LLM agent + isolated VM" pattern: the host holds
 * conversation state and calls the Claude API, the sandbox provides a clean
 * read-only execution environment for git clone + file reads.  The agent
 * uses a `read_file` tool backed by `sandbox.runCommand` so it can
 * introspect any path inside the clone without network access.
 *
 * Run:   bun 45-claude-github-wiki/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY, plus ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
 *        / ANTHROPIC_MODEL (or standard ANTHROPIC_API_KEY) for the Claude calls.
 *        No external paid repos — clones github.com/bun-community/create-templates,
 *        a small public repo (~300 KB).
 */
import Anthropic from "@anthropic-ai/sdk";
import { CreateosSandboxClient } from "createos-sandbox-sdk";

// Small public repo: bun starter templates, <350 KB total.
const REPO_URL = "https://github.com/bun-community/create-templates.git";
const REPO_DIR = "/repo";
const SHAPE = "s-4vcpu-4gb";
const ROOTFS = "devbox:1";

// Questions to ask the agent about the cloned codebase.
const QUESTIONS = [
  "List every template directory at the repo root and describe in one sentence what each one is for.",
  "Find the main entry-point file inside the `hono` template and summarise what it does.",
];

// Tools exposed to Claude: read a file and list a directory inside the sandbox.
// The agent uses these to navigate and read the cloned repo without any extra
// installs — just git + standard Unix commands already in devbox:1.
const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file inside the cloned repo.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path inside the sandbox, e.g. /repo/README.md",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List the files and directories at a path inside the cloned repo.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Absolute directory path to list, e.g. /repo" },
      },
      required: ["path"],
    },
  },
];

// Anthropic SDK picks up ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (or
// ANTHROPIC_API_KEY) from the environment automatically.
const anthropic = new Anthropic();
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

const box = new CreateosSandboxClient({
  baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL,
});

console.log(`[1/4] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await box.createSandbox({ shape: SHAPE, rootfs: ROOTFS });
console.log(`      sandbox: ${sandbox.id}`);

try {
  // Clone with --depth=1 to keep network traffic under ~2 MB.
  console.log(`[2/4] cloning ${REPO_URL} ...`);
  const clone = await sandbox.runCommand(
    "sh",
    ["-c", `git clone --depth=1 --quiet ${REPO_URL} ${REPO_DIR} && echo "cloned ok"`],
    { timeoutMs: 120_000 },
  );
  if (clone.result.exit_code !== 0) {
    throw new Error(`git clone failed: ${clone.result.stderr}`);
  }
  console.log(`      ${clone.result.stdout.trim()}`);

  // List the top-level tree so Claude has an orientation snapshot.
  const tree = await sandbox.runCommand("sh", [
    "-c",
    `find ${REPO_DIR} -maxdepth 2 -not -path '*/.git/*' | sort | head -60`,
  ]);
  const treeText = tree.result.stdout.trim();

  console.log(`[3/4] running Claude agent (${QUESTIONS.length} questions)...`);
  const answers: string[] = [];

  for (const [qi, question] of QUESTIONS.entries()) {
    console.log(`\n  Q${qi + 1}: ${question}`);

    // Fresh conversation per question; seed with the tree so Claude knows the layout.
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          `You have read-only access to a cloned Git repository at ${REPO_DIR} inside a sandbox.\n` +
          `Top-level file tree (up to depth 2):\n\`\`\`\n${treeText}\n\`\`\`\n\n` +
          `Use the read_file and list_dir tools to explore the repo, then answer:\n${question}`,
      },
    ];

    // Agent loop: run until Claude stops calling tools.
    let answer = "";
    while (true) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 2048,
        tools: TOOLS,
        messages,
      });

      // Collect any text blocks as the candidate answer.
      for (const block of response.content) {
        if (block.type === "text") answer = block.text;
      }

      if (response.stop_reason !== "tool_use") break;

      // Execute every tool call Claude requested and feed results back.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        let output = "";
        try {
          const input = block.input as { path: string };
          if (block.name === "read_file") {
            const r = await sandbox.runCommand("sh", ["-c", `cat "${input.path}" 2>&1`]);
            output = r.result.stdout || r.result.stderr || "(empty)";
          } else if (block.name === "list_dir") {
            const r = await sandbox.runCommand("sh", ["-c", `ls -1 "${input.path}" 2>&1`]);
            output = r.result.stdout || r.result.stderr || "(empty)";
          } else {
            output = `unknown tool: ${block.name}`;
          }
        } catch (err) {
          output = `error: ${err instanceof Error ? err.message : String(err)}`;
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output || "(no output)",
        });
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }

    console.log(`\n  A${qi + 1}:\n${answer}\n`);
    answers.push(answer);
  }

  console.log("[4/4] agent finished");
  console.log("\n=== ANSWERS ===");
  for (const [i, ans] of answers.entries()) {
    console.log(`\n--- Q${i + 1} ---\n${ans}`);
  }
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log(`\ndestroyed: ${sandbox.id}`);
}
