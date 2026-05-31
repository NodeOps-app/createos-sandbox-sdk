/**
 * Model FC sandbox operations as nodes in a LangGraph graph, an LLM driving it.
 *
 * A LangGraph state machine runs on the host and walks an FC sandbox through a
 * lifecycle, one fc-sdk operation per node: create_sandbox → generate_code →
 * run_in_sandbox → summarise. An OpenAI model decides the work (writes the
 * Python, summarises the result); the sandbox executes and verifies it. The
 * pattern: the graph's typed state threads sandbox id / code / output between
 * nodes, and conditional edges short-circuit to END on error so a failed step
 * never feeds a downstream one. The Sandbox handle is module-level because its
 * lifetime spans the whole graph, and teardown happens in the outer finally.
 *
 * Run:   bun 32-langgraph-sandbox-orchestrator/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY, plus OPENAI_API_KEY (+ optional OPENAI_MODEL,
 *        OPENAI_BASE_URL/OPENAI_API_URL for an OpenAI-compatible endpoint). See
 *        .env.example. Reads the parent ../.env as a fallback (loadParentEnvFallback).
 */
import { existsSync, readFileSync } from "node:fs";
import OpenAI from "openai";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { FcClient, type Sandbox } from "fc-sandbox-sdk";

loadParentEnvFallback();

const SHAPE = "s-1vcpu-1gb";
const ROOTFS = "devbox:1";
const WORKDIR = "/root/agent-workspace";
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

// Task the agent will solve inside the sandbox
const TASK =
  "Write a Python script that computes the first 20 Fibonacci numbers, " +
  "prints each one on its own line, and also writes them to a file named output.txt.";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_URL ?? undefined,
});

const fc = new FcClient();

// ── Graph state ───────────────────────────────────────────────────────────────

const AgentState = Annotation.Root({
  task: Annotation<string>({ reducer: (_, v) => v }),
  sandboxId: Annotation<string>({ reducer: (_, v) => v }),
  code: Annotation<string>({ reducer: (_, v) => v }),
  runOutput: Annotation<string>({ reducer: (_, v) => v }),
  finalAnswer: Annotation<string>({ reducer: (_, v) => v }),
  error: Annotation<string | undefined>({ reducer: (_, v) => v }),
});

type AgentStateType = typeof AgentState.State;

// ── Sandbox handle shared across nodes (lifecycle is graph-wide) ──────────────

let sandbox: Sandbox | undefined;

// ── 1. Node: create_sandbox ───────────────────────────────────────────────────

async function createSandboxNode(_state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("\n[node: create_sandbox]");
  sandbox = await fc.createSandbox({ shape: SHAPE, rootfs: ROOTFS });
  console.log(`  sandbox id: ${sandbox.id}  ip: ${sandbox.ip}`);

  // Seed the workspace directory
  await sandbox.runCommand("mkdir", ["-p", WORKDIR]);
  console.log(`  workspace: ${WORKDIR}`);

  return { sandboxId: sandbox.id };
}

// ── 2. Node: generate_code ────────────────────────────────────────────────────

async function generateCodeNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("\n[node: generate_code]");

  // Use a generous token limit so the model has enough budget to emit
  // the full generated program without truncation.
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a Python coding assistant. " +
          "Reply with ONLY valid Python source code — no markdown fences, no explanation. " +
          `The script will run in a Linux sandbox and must write output to ${WORKDIR}/output.txt.`,
      },
      { role: "user", content: state.task },
    ],
    max_tokens: 2048,
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  if (!raw.trim()) {
    const reason = completion.choices[0]?.finish_reason ?? "unknown";
    return { error: `Code generation returned empty content (finish_reason=${reason})` };
  }

  // Strip any accidental markdown fences the model may add
  const code = raw
    .replace(/^```[a-z]*\n?/im, "")
    .replace(/```$/m, "")
    .trim();

  console.log(`  generated ${code.split("\n").length} lines of Python`);
  return { code };
}

// ── 3. Node: run_in_sandbox ───────────────────────────────────────────────────

async function runInSandboxNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("\n[node: run_in_sandbox]");
  if (!sandbox) throw new Error("sandbox not initialised");

  const scriptPath = `${WORKDIR}/solution.py`;

  // Upload the generated script
  await sandbox.files.upload(scriptPath, state.code);
  console.log(`  uploaded: ${scriptPath}`);

  // Run it
  const { result, exec_ms } = await sandbox.runCommand("python3", [scriptPath], {
    timeoutMs: 60_000,
  });
  console.log(`  exit_code: ${result.exit_code}  exec_ms: ${exec_ms}`);

  if (result.stderr.trim()) {
    console.log(`  stderr: ${result.stderr.trim().slice(0, 400)}`);
  }

  if (result.exit_code !== 0) {
    return { error: `python3 exited ${result.exit_code}: ${result.stderr.trim()}` };
  }

  // Read the written output file for verification
  const catResult = await sandbox.runCommand("cat", [`${WORKDIR}/output.txt`]);
  const runOutput = catResult.result.stdout.trim();
  const lines = runOutput.split("\n");
  console.log(`  output.txt (${lines.length} lines):`);
  for (const line of lines.slice(0, 5)) {
    console.log(`    ${line}`);
  }
  if (lines.length > 5) {
    console.log(`    … (${lines.length} lines total)`);
  }

  return { runOutput };
}

// ── 4. Node: summarise ────────────────────────────────────────────────────────

async function summariseNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("\n[node: summarise]");

  if (state.error) {
    console.log(`  error path: ${state.error}`);
    return { finalAnswer: `Task failed: ${state.error}` };
  }

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a concise technical assistant. Summarise the computation result in 2 sentences.",
      },
      {
        role: "user",
        content: `Task: ${state.task}\n\nOutput:\n${state.runOutput}`,
      },
    ],
    max_tokens: 512,
  });

  const finalAnswer = completion.choices[0]?.message?.content?.trim() ?? "";
  console.log(`  final answer: ${finalAnswer}`);
  return { finalAnswer };
}

// ── Routers: skip downstream nodes on error ───────────────────────────────────

function routeAfterGenerate(state: AgentStateType): "run_in_sandbox" | typeof END {
  return state.error ? END : "run_in_sandbox";
}

function routeAfterRun(state: AgentStateType): "summarise" | typeof END {
  return state.error ? END : "summarise";
}

// ── Build graph ───────────────────────────────────────────────────────────────

const workflow = new StateGraph(AgentState)
  .addNode("create_sandbox", createSandboxNode)
  .addNode("generate_code", generateCodeNode)
  .addNode("run_in_sandbox", runInSandboxNode)
  .addNode("summarise", summariseNode)
  .addEdge(START, "create_sandbox")
  .addEdge("create_sandbox", "generate_code")
  .addConditionalEdges("generate_code", routeAfterGenerate, ["run_in_sandbox", END])
  .addConditionalEdges("run_in_sandbox", routeAfterRun, ["summarise", END])
  .addEdge("summarise", END);

const graph = workflow.compile();

// ── Run ───────────────────────────────────────────────────────────────────────

console.log("LangGraph Sandbox Orchestrator");
console.log(`  model: ${MODEL}`);
console.log(`  shape: ${SHAPE}  rootfs: ${ROOTFS}`);
console.log(`  task: ${TASK}\n`);

try {
  const finalState = await graph.invoke({ task: TASK });

  console.log("\n─────────────────────────────────");
  console.log("Graph completed.");
  console.log(`Sandbox: ${finalState.sandboxId}`);
  if (finalState.error) console.log(`Error:  ${finalState.error}`);
  console.log(`Answer: ${finalState.finalAnswer}`);
} finally {
  if (sandbox) {
    await sandbox.destroy();
    console.log(`\ndestroyed sandbox: ${sandbox.id}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
