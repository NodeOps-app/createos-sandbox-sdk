/**
 * Three LLM agent patterns implemented with the Vercel AI SDK:
 *
 *  1. Prompt chaining — pass one step's output as the next step's input.
 *  2. Routing        — classify first, then dispatch to a specialist prompt.
 *  3. Parallelization — fan out three independent sub-prompts concurrently.
 *
 * Runs inside an FC sandbox. Requires env: OPENAI_API_KEY, OPENAI_API_URL, OPENAI_MODEL.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_API_URL,
});
const model = openai(process.env.OPENAI_MODEL);

// ── 1. Prompt chaining ────────────────────────────────────────────────────
// Step A summarises a topic; Step B extracts a single key insight from it.

async function promptChaining() {
  console.log("\n=== PATTERN 1: PROMPT CHAINING ===");

  const { text: summary } = await generateText({
    model,
    prompt: "In two sentences, explain what a microVM is and why it is useful for sandboxing.",
  });
  console.log("Step 1 — summary:", summary.trim());

  const { text: insight } = await generateText({
    model,
    prompt: `Given this summary: "${summary.trim()}" — extract the single most important benefit of microVMs in one short sentence.`,
  });
  console.log("Step 2 — key insight:", insight.trim());
}

// ── 2. Routing ────────────────────────────────────────────────────────────
// A classifier call routes each input to a specialist system prompt.

const specialists = {
  technical:
    "You are a systems-engineering expert. Answer with technical precision in one sentence.",
  business: "You are a cloud cost analyst. Answer in terms of cost and ROI in one sentence.",
  creative: "You are a poet. Respond creatively and imaginatively in one sentence.",
};

async function routing() {
  console.log("\n=== PATTERN 2: ROUTING ===");

  const inputs = [
    "How does copy-on-write memory work in a snapshot?",
    "What is the cost model for running sandboxes at scale?",
    "Write a haiku about ephemeral compute.",
  ];

  for (const input of inputs) {
    const { text: category } = await generateText({
      model,
      prompt: `Classify this question into exactly one word — "technical", "business", or "creative": "${input}"`,
    });
    const label = category
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    const system = specialists[label] ?? specialists.technical;

    const { text: answer } = await generateText({ model, system, prompt: input });
    console.log(`Input:    ${input}`);
    console.log(`Category: ${label}`);
    console.log(`Answer:   ${answer.trim()}\n`);
  }
}

// ── 3. Parallelization ────────────────────────────────────────────────────
// Three independent prompts run concurrently via Promise.all.

async function parallelization() {
  console.log("\n=== PATTERN 3: PARALLELIZATION ===");

  const tasks = [
    {
      label: "security",
      prompt: "Name one security benefit of running code in a microVM. One sentence.",
    },
    {
      label: "performance",
      prompt: "Name one performance benefit of microVM snapshots. One sentence.",
    },
    {
      label: "reliability",
      prompt: "Name one reliability benefit of ephemeral sandboxes. One sentence.",
    },
  ];

  const results = await Promise.all(tasks.map(({ prompt }) => generateText({ model, prompt })));

  for (const [i, { text }] of results.entries()) {
    console.log(`[${tasks[i].label}]: ${text.trim()}`);
  }
}

await promptChaining();
await routing();
await parallelization();

console.log("\nAll patterns complete.");
