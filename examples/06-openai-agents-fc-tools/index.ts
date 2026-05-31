/**
 * OpenAI Agents SDK + FC tools — drive a microVM from an OpenAI Agents agent by
 * exposing sandbox operations (list files, run Python, read a result file) as
 * agent tools. The agent inspects its workspace, computes in the sandbox, writes
 * an answer file, and reads it back. Shows the FC-as-agent-workspace pattern.
 *
 * Runs with a real OpenAI model if OPENAI_API_KEY is set; otherwise it falls back
 * to a built-in deterministic model so the FC tool path is exercisable with no key.
 *
 * Run:   bun 06-openai-agents-fc-tools/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY. OPENAI_API_KEY is optional (external service:
 *        OpenAI / any OpenAI-compatible endpoint); without it the local model runs.
 */
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";
import { Sandbox } from "fc-sandbox-sdk";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

// Hydrate env from the shared examples/.env (../.env from this dir) before
// anything reads process.env. See loadParentEnvFallback at the bottom.
loadParentEnvFallback();
process.env.OPENAI_AGENTS_DISABLE_TRACING ??= "true";

// Dynamic import: the env (incl. tracing flag) must be set before the SDK loads.
const { Agent, OpenAIProvider, Runner, Usage, tool } = await import("@openai/agents");

const WORKDIR = "/root/openai-agents-fc";
const SCRIPT_PATH = `${WORKDIR}/agent_task.py`;
const MODEL = process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? "gpt-4.1-mini";

// Deterministic offline stand-in for an LLM: implements the Model interface and
// returns a fixed tool-call script, so the example runs (and the FC tool path is
// exercised) without an OpenAI key. Each getResponse call advances one step.
class ScriptedWorkspaceModel implements Model {
  #step = 0;

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    this.#step += 1;

    // Step 1: ask to list the workspace.
    if (this.#step === 1) {
      return functionCall("call_list_workspace", "list_workspace", {});
    }

    // Step 2: emit the Python that computes the prime-Fibonacci answer.
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

    // Step 3: read the answer file back.
    if (this.#step === 3) {
      return functionCall("call_read_answer", "read_workspace_file", {
        relativePath: "answer.json",
      });
    }

    // Step 4+: no more tool calls — return the final text answer to end the run.
    return message(
      "answer.json confirms 7 prime Fibonacci numbers: 2, 3, 5, 13, 89, 233, and 1597.",
    );
  }

  // The Runner used here is non-streaming; this stub satisfies the interface and
  // throws if anything ever asks the local model to stream.
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

// Pick the model: real OpenAI provider when a key is present, else the offline
// scripted model. With a custom base URL we default to the Chat Completions API
// (useResponses=false) since OpenAI-compatible endpoints rarely implement the
// newer Responses API.
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

// 1. Create the workspace sandbox — this VM is the agent's filesystem.
const sandbox = await Sandbox.create({
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
});

console.log(`sandbox created: ${sandbox.id}`);

try {
  // 2. Seed the workspace: a README describing the task and the input data the
  //    agent will operate on. The agent discovers these via the list tool.
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

  // 3. Define the agent's tools. Each one wraps a sandbox operation: the agent
  //    calls them by name, the execute body runs against the live VM, and the
  //    returned string becomes the tool result the model sees next turn.

  // List + preview workspace files (one shell call: find then sed each file's head).
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

  // Run agent-supplied Python in the workspace.
  const runPython = tool({
    name: "run_python",
    description:
      "Upload Python code into the FC sandbox workspace, run it, and return stdout, stderr, and exit code.",
    parameters: z.object({
      code: z.string().describe("Python source code to run inside the FC sandbox."),
    }),
    execute: async ({ code }) => {
      // Prepend a preamble that chdirs into WORKDIR so the agent's code can use
      // bare relative paths (numbers.txt, answer.json) regardless of cwd.
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
      // Generous timeout — agent code is arbitrary and may be slow.
      const { result, exec_ms } = await sandbox.runCommand("python3", [SCRIPT_PATH], {
        timeoutMs: 120_000,
      });
      const output = JSON.stringify({ ...result, exec_ms }, null, 2);
      console.log("\n[run_python]\n" + output);
      return output;
    },
  });

  // Read one text file back out of the workspace.
  const readWorkspaceFile = tool({
    name: "read_workspace_file",
    description: "Read a UTF-8 text file from the FC sandbox workspace.",
    parameters: z.object({
      relativePath: z.string().describe("Path relative to the workspace, for example answer.json."),
    }),
    execute: async ({ relativePath }) => {
      // Path-traversal guard: reject absolute paths and `..` so a tool call can't
      // read outside WORKDIR. Always validate model-supplied paths.
      if (relativePath.startsWith("/") || relativePath.includes("..")) {
        throw new Error("relativePath must stay inside the workspace");
      }
      const { result } = await sandbox.runCommand("cat", [`${WORKDIR}/${relativePath}`]);
      const output = commandOutput(result);
      console.log(`\n[read_workspace_file ${relativePath}]\n` + output);
      return output;
    },
  });

  // 4. Assemble the agent: the model, the workspace tools, and instructions that
  //    push it to compute in the sandbox (not in its head) and ground its answer
  //    in answer.json — guardrails against an LLM fabricating the result.
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
  // 5. Run the agent loop. The Runner drives model -> tool -> model until the
  //    model returns a final message or maxTurns is hit.
  const runner = new Runner({ tracingDisabled: true });
  const result = await runner.run(agent, prompt, { maxTurns: 8 });

  console.log("\n--- final agent output ---");
  console.log(result.finalOutput);
} finally {
  // 6. Always destroy.
  await sandbox.destroy().catch(() => {});
  console.log(`destroyed sandbox: ${sandbox.id}`);
}

// Minimal .env loader for the shared examples/.env (../.env from this dir), so a
// single env file serves every example. Only fills keys not already in the
// environment, so a real shell export still wins.
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

// Builds an Agents-SDK ModelResponse that requests a tool call — the shape the
// scripted model returns to invoke a tool.
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

// Builds a ModelResponse carrying a final assistant message — ends the run.
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

// Normalize a runCommand result into a compact JSON string for the model to read.
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
