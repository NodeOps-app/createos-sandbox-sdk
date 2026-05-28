import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "fc-sandbox-sdk";

const TASK =
  "Write Python code to find all prime Fibonacci numbers among the first 20 " +
  "Fibonacci numbers. Print each prime Fibonacci number with its index in the sequence.";

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

const anthropic = new Anthropic();

const sandbox = await Sandbox.create({
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
});
console.log("sandbox:", sandbox.id);

try {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: TASK }];

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

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use" || block.name !== "run_code") continue;
      const { code } = block.input as { code: string };
      console.log("\n[run_code]\n" + code);

      await sandbox.files.upload("/tmp/agent_script.py", code);
      const { result } = await sandbox.runCommand("python3", ["/tmp/agent_script.py"]);
      const output =
        result.stdout +
        (result.stderr ? "\n--- stderr ---\n" + result.stderr : "") +
        (result.exit_code !== 0 ? `\n(exit ${result.exit_code})` : "");

      console.log("[output]\n" + output);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output || "(no output)",
      });
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }
} finally {
  await sandbox.destroy();
  console.log("destroyed");
}
