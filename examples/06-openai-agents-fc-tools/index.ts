import type { Model, ModelRequest, ModelResponse } from "@openai/agents";
import { Sandbox } from "fc-sandbox-sdk";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

loadParentEnvFallback();
process.env.OPENAI_AGENTS_DISABLE_TRACING ??= "true";

const { Agent, OpenAIProvider, Runner, Usage, tool } = await import("@openai/agents");

const WORKDIR = "/root/openai-agents-fc";
const SCRIPT_PATH = `${WORKDIR}/agent_task.py`;
const MODEL = process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? "gpt-4.1-mini";

class ScriptedWorkspaceModel implements Model {
  #step = 0;

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    this.#step += 1;

    if (this.#step === 1) {
      return functionCall("call_list_workspace", "list_workspace", {});
    }

    if (this.#step === 2) {
      return functionCall("call_run_python", "run_python", {
        code: [
          "import json",
          "from pathlib import Path",
          "numbers = [int(line) for line in Path('numbers.txt').read_text().splitlines() if line.strip()]",
          "def is_prime(n):",
          "    if n < 2:",
          "        return False",
          "    d = 2",
          "    while d * d <= n:",
          "        if n % d == 0:",
          "            return False",
          "        d += 1",
          "    return True",
          "def is_fibonacci(n):",
          "    a, b = 0, 1",
          "    while b < n:",
          "        a, b = b, a + b",
          "    return n in (0, b)",
          "answer = {",
          "    'prime_fibonacci_numbers': [n for n in numbers if is_prime(n) and is_fibonacci(n)],",
          "}",
          "answer['count'] = len(answer['prime_fibonacci_numbers'])",
          "Path('answer.json').write_text(json.dumps(answer, indent=2) + '\\n')",
          "print(json.dumps(answer))",
        ].join("\n"),
      });
    }

    if (this.#step === 3) {
      return functionCall("call_read_answer", "read_workspace_file", {
        relativePath: "answer.json",
      });
    }

    return message(
      "answer.json confirms 7 prime Fibonacci numbers: 2, 3, 5, 13, 89, 233, and 1597.",
    );
  }

  getStreamedResponse(_request: ModelRequest): AsyncIterable<never> {
    const error = new Error("Streaming is not implemented for the deterministic local model.");

    return {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          async next(): Promise<IteratorResult<never>> {
            throw error;
          },
        };
      },
    };
  }
}

const model: Model = process.env.OPENAI_API_KEY
  ? await new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_URL,
      useResponses: !(
        process.env.OPENAI_USE_CHAT_COMPLETIONS === "true" ||
        process.env.OPENAI_BASE_URL ||
        process.env.OPENAI_API_URL
      ),
    }).getModel(MODEL)
  : new ScriptedWorkspaceModel();

const sandbox = await Sandbox.create({
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
});

console.log(`sandbox created: ${sandbox.id}`);

try {
  await sandbox.runCommand("mkdir", ["-p", WORKDIR]);
  await sandbox.files.upload(
    `${WORKDIR}/README.md`,
    [
      "# FC workspace for an OpenAI Agents SDK run",
      "",
      "Use the data in numbers.txt. Write any generated artifacts back into this directory.",
      "Do not rely on mental arithmetic; execute code in the sandbox.",
      "",
    ].join("\n"),
  );
  await sandbox.files.upload(
    `${WORKDIR}/numbers.txt`,
    [
      "2",
      "3",
      "5",
      "8",
      "13",
      "21",
      "34",
      "55",
      "89",
      "144",
      "233",
      "377",
      "610",
      "987",
      "1597",
      "2584",
      "4181",
    ].join("\n") + "\n",
  );
  console.log(`seeded workspace: ${WORKDIR}`);

  const listWorkspace = tool({
    name: "list_workspace",
    description: "List files in the FC sandbox workspace and preview their first lines.",
    parameters: z.object({}),
    execute: async () => {
      const { result } = await sandbox.runCommand("sh", [
        "-lc",
        `find ${WORKDIR} -maxdepth 2 -type f -print -exec sh -c 'echo "--- $1"; sed -n "1,40p" "$1"' _ {} \\;`,
      ]);
      const output = commandOutput(result);
      console.log("\n[list_workspace]\n" + output);
      return output;
    },
  });

  const runPython = tool({
    name: "run_python",
    description:
      "Upload Python code into the FC sandbox workspace, run it, and return stdout, stderr, and exit code.",
    parameters: z.object({
      code: z.string().describe("Python source code to run inside the FC sandbox."),
    }),
    execute: async ({ code }) => {
      const wrapped = [
        "from pathlib import Path",
        "import os",
        `WORKDIR = ${JSON.stringify(WORKDIR)}`,
        "Path(WORKDIR).mkdir(parents=True, exist_ok=True)",
        "os.chdir(WORKDIR)",
        code,
        "",
      ].join("\n");

      await sandbox.files.upload(SCRIPT_PATH, wrapped);
      const { result, exec_ms } = await sandbox.runCommand("python3", [SCRIPT_PATH], {
        timeoutMs: 120_000,
      });
      const output = JSON.stringify({ ...result, exec_ms }, null, 2);
      console.log("\n[run_python]\n" + output);
      return output;
    },
  });

  const readWorkspaceFile = tool({
    name: "read_workspace_file",
    description: "Read a UTF-8 text file from the FC sandbox workspace.",
    parameters: z.object({
      relativePath: z.string().describe("Path relative to the workspace, for example answer.json."),
    }),
    execute: async ({ relativePath }) => {
      if (relativePath.startsWith("/") || relativePath.includes("..")) {
        throw new Error("relativePath must stay inside the workspace");
      }
      const { result } = await sandbox.runCommand("cat", [`${WORKDIR}/${relativePath}`]);
      const output = commandOutput(result);
      console.log(`\n[read_workspace_file ${relativePath}]\n` + output);
      return output;
    },
  });

  const agent = new Agent({
    name: "FC Sandbox Workspace Agent",
    model,
    instructions: [
      "You are an OpenAI Agents SDK agent using an FC microVM as your workspace.",
      "Always inspect the workspace before computing.",
      "Use run_python for computation instead of doing arithmetic in your response.",
      "Write your computed result to answer.json, then read it back before finalizing.",
      "Base the final answer only on answer.json and the command output.",
      "Keep the final answer concise and include the exact numbers found.",
      "If any input value is not Fibonacci, do not say that every input value is Fibonacci.",
    ].join(" "),
    tools: [listWorkspace, runPython, readWorkspaceFile],
  });

  const prompt = [
    "Inspect the FC workspace.",
    "Find every value in numbers.txt that is both a Fibonacci number and a prime number.",
    "Write answer.json with keys prime_fibonacci_numbers and count.",
    "Read answer.json back and summarize the result.",
  ].join(" ");

  console.log(
    process.env.OPENAI_API_KEY
      ? `running OpenAI Agents SDK model: ${MODEL}`
      : "running OpenAI Agents SDK with a deterministic local model",
  );
  const runner = new Runner({ tracingDisabled: true });
  const result = await runner.run(agent, prompt, { maxTurns: 8 });

  console.log("\n--- final agent output ---");
  console.log(result.finalOutput);
} finally {
  await sandbox.destroy().catch(() => {});
  console.log(`destroyed sandbox: ${sandbox.id}`);
}

function loadParentEnvFallback(): void {
  const parentEnv = "../.env";
  if (!existsSync(parentEnv)) return;

  for (const line of readFileSync(parentEnv, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(["'])(.*)\1$/, "$2");
  }
}

function functionCall(callId: string, name: string, args: Record<string, unknown>): ModelResponse {
  return {
    usage: new Usage({ requests: 1 }),
    output: [
      {
        type: "function_call",
        callId,
        name,
        arguments: JSON.stringify(args),
        status: "completed",
      },
    ],
  };
}

function message(text: string): ModelResponse {
  return {
    usage: new Usage({ requests: 1 }),
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

type CommandResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  error?: string;
};

function commandOutput(result: CommandResult): string {
  return JSON.stringify(
    {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exit_code: result.exit_code,
      error: result.error,
    },
    null,
    2,
  );
}
