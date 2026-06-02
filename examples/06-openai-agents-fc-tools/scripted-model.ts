/**
 * Offline/keyless stand-in for an LLM, factored out of index.ts so the real
 * lesson (FC as an OpenAI Agents workspace) stays readable in one scroll.
 *
 * Imported dynamically by index.ts so the SDK still loads only after the
 * tracing flag is set there — see the loadParentEnvFallback note in index.ts.
 */
import { Usage } from "@openai/agents";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";

// Deterministic offline stand-in for an LLM: implements the Model interface and
// returns a fixed tool-call script, so the example runs (and the FC tool path is
// exercised) without an OpenAI key. Each getResponse call advances one step.
export class ScriptedWorkspaceModel implements Model {
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
    throw new Error("Streaming is not implemented for the deterministic local model.");
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
