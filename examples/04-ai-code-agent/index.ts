/**
 * AI code agent — Claude writes code, the sandbox runs it. The Anthropic SDK
 * drives a tool-use loop: Claude emits Python via a `run_code` tool, this process
 * executes it in the microVM with runCommand, feeds the output back, and repeats
 * until Claude stops asking for tools. The canonical "LLM with a code sandbox" pattern.
 *
 * Run:   bun 04-ai-code-agent/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY, plus ANTHROPIC_API_KEY for the Claude calls
 *        (external service: the Anthropic API). ANTHROPIC_MODEL is optional.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "createos-sandbox-sdk";

const TASK =
  "Write Python code to find all prime Fibonacci numbers among the first 20 " +
  "Fibonacci numbers. Print each prime Fibonacci number with its index in the sequence.";

// The single tool we expose to Claude. The schema is what Claude sees; the
// actual execution (upload + run in the sandbox) is wired up in the loop below.
const TOOLS: Anthropic.Tool[] = [
  {
    name: "run_code",
    description: "Execute Python 3 code in a sandboxed VM and return its stdout and stderr.",
    input_schema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "Python 3 source code to run" },
      },
      required: ["code"],
    },
  },
];

// Reads ANTHROPIC_API_KEY from the environment.
const anthropic = new Anthropic();

const sandbox = await Sandbox.create({
  shape: "s-2vcpu-2gb", // agent workloads need real RAM
  rootfs: "devbox:1",
});
console.log("sandbox:", sandbox.id);

try {
  // The running transcript. Each turn appends Claude's reply and our tool results.
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: TASK }];

  // Agent loop: call Claude, run any code it asked for, repeat. Breaks when
  // Claude returns without requesting a tool (stop_reason !== "tool_use").
  while (true) {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: TOOLS,
      messages,
    });

    console.log(`\n[claude stop_reason: ${response.stop_reason}]`);
    for (const block of response.content) {
      if (block.type === "text") process.stdout.write(block.text + "\n");
    }

    if (response.stop_reason !== "tool_use") break;

    // Execute every run_code request in this turn. One result per tool_use block,
    // keyed by tool_use_id so Claude can match each result to its request.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use" || block.name !== "run_code") continue;
      const { code } = block.input as { code: string };
      console.log("\n[run_code]\n" + code);

      // This is the tool's actual behavior: drop Claude's code into the VM and run it.
      await sandbox.files.upload("/tmp/agent_script.py", code);
      const { result } = await sandbox.runCommand("python3", ["/tmp/agent_script.py"]);
      // Fold stderr and a nonzero exit into the text so Claude can see and fix failures.
      const output =
        result.stdout +
        (result.stderr ? "\n--- stderr ---\n" + result.stderr : "") +
        (result.exit_code !== 0 ? `\n(exit ${result.exit_code})` : "");

      console.log("[output]\n" + output);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        // The API rejects empty content — substitute a placeholder for silent runs.
        content: output || "(no output)",
      });
    }

    // Append both sides of the exchange, then loop so Claude can react to the output.
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("destroyed");
}
