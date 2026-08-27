/**
 * OpenAI tool-calling agent + Anchor Browser scrape from inside a createos-sandbox sandbox.
 *
 * Creates a disposable devbox:1 VM, installs the Anchor Browser Node SDK in the
 * sandbox, then gives an OpenAI-compatible model a scrape_with_anchor tool. When
 * the agent calls that tool, the tool runs inside the sandbox and uses Anchor
 * Cloud to extract content from a public page.
 *
 * Run:   bun 53-anchor-browser-scrape/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY + OPENAI_API_KEY.
 *        ANCHOR_API_KEY is optional; without it, OpenAI solves Anchor Agent Access.
 */
import { CreateosSandboxClient } from "createos-sandbox-sdk";
import { existsSync, readFileSync } from "node:fs";
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

loadParentEnvFallback();
const { default: OpenAI } = await import("openai");
type OpenAIClient = InstanceType<typeof OpenAI>;

const SHAPE = "s-1vcpu-1gb";
const ROOTFS = "devbox:1";
const APP_DIR = "/app";
const TARGET_URL = process.env.TARGET_URL ?? "https://example.com";
const MODEL = process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? "gpt-4.1-mini";
const ANCHOR_API_BASE_URL = "https://api.anchorbrowser.io";

const baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL;
const apiKey = process.env.CREATEOS_SANDBOX_API_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
let anchorApiKey = process.env.ANCHOR_API_KEY;

if (!baseUrl || !apiKey || !openaiApiKey) {
  throw new Error(
    "set CREATEOS_SANDBOX_BASE_URL, CREATEOS_SANDBOX_API_KEY, and OPENAI_API_KEY (see .env.example)",
  );
}

const box = new CreateosSandboxClient({ baseUrl, apiKey });
const openai = new OpenAI({
  apiKey: openaiApiKey,
  baseURL: process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_URL,
});

if (!anchorApiKey) {
  console.log("[0/5] no ANCHOR_API_KEY set; requesting Anchor Agent Access...");
  anchorApiKey = await createAnchorTrialKey(openai);
  console.log(`      received Anchor trial key: ${redactKey(anchorApiKey)}`);
}

console.log(`[1/5] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await box.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  envs: {
    ANCHOR_API_KEY: anchorApiKey,
    ANCHORBROWSER_API_KEY: anchorApiKey,
  },
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

try {
  console.log("[2/5] creating project dir + installing Anchor Browser SDK...");
  await sandbox.sh(
    `set -e
mkdir -p ${APP_DIR} && cd ${APP_DIR}
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install anchorbrowser >/dev/null`,
    { label: "anchor-install", timeoutMs: 180_000 },
  );

  const anchorVersion = (
    await sandbox.sh(
      `cd ${APP_DIR} && node -e "const p=require('./node_modules/anchorbrowser/package.json'); console.log(p.version)"`,
      { label: "anchor-version" },
    )
  ).result.stdout.trim();
  console.log(`      anchorbrowser: ${anchorVersion}`);

  const scrapeScript = `
import { agentTask, client } from "anchorbrowser";

const apiKey = process.env.ANCHORBROWSER_API_KEY || process.env.ANCHOR_API_KEY;
if (!apiKey) {
  throw new Error("missing ANCHORBROWSER_API_KEY or ANCHOR_API_KEY");
}

client.setConfig({ auth: () => apiKey });

const targetUrl = process.argv[2] || "https://example.com";
const result = await agentTask(
  \`Go to \${targetUrl}. Extract the page title, main heading, first paragraph, and link count. Return only compact JSON with keys title, heading, paragraph, and linkCount.\`,
);

const taskResult = result?.data?.result ?? result?.data ?? result;
console.log(typeof taskResult === "string" ? taskResult : JSON.stringify(taskResult, null, 2));
`;

  console.log("[3/5] uploading Anchor scrape script...");
  await sandbox.files.upload(`${APP_DIR}/anchor-scrape.mjs`, scrapeScript);

  console.log("[4/5] creating OpenAI tool-calling agent with a CreateOS-backed Anchor tool...");
  let anchorToolOutput = "";

  console.log(`[5/5] running OpenAI agent (${MODEL}) against ${TARGET_URL}...`);
  const finalOutput = await runOpenAIToolAgent(openai, async (url) => {
    const scrapeOut = (
      await sandbox.sh(`cd ${APP_DIR} && node anchor-scrape.mjs ${shellQuote(url)}`, {
        label: "anchor-scrape",
        timeoutMs: 240_000,
      })
    ).result.stdout.trim();

    if (!scrapeOut) {
      throw new Error("Anchor scrape returned no output");
    }

    console.log("\n[scrape_with_anchor]\n" + scrapeOut);
    anchorToolOutput = scrapeOut;
    return scrapeOut;
  });

  if (!anchorToolOutput || !finalOutput) {
    throw new Error("expected both Anchor tool output and final OpenAI agent output");
  }

  console.log("\n--- final agent output ---");
  console.log(finalOutput);
  console.log(`\nverified end-to-end: OpenAI used Anchor Browser from inside ${sandbox.id}`);
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isFunctionToolCall(
  call: { type: string },
): call is ChatCompletionMessageFunctionToolCall {
  return call.type === "function";
}

async function runOpenAIToolAgent(
  openaiClient: OpenAIClient,
  scrapeWithAnchor: (url: string) => Promise<string>,
): Promise<string> {
  const tools: ChatCompletionTool[] = [
    {
      type: "function" as const,
      function: {
        name: "scrape_with_anchor",
        description:
          "Use Anchor Browser from inside the createos-sandbox VM to scrape a public URL and return extracted page content.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Public URL to scrape with Anchor Browser.",
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
  ];

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You are an agent that uses a CreateOS sandbox for browser work.",
        "When asked to scrape a web page, call scrape_with_anchor instead of guessing.",
        "Base the final answer only on the tool result.",
        "Keep the final answer concise and mention the extracted title, heading, paragraph, and link count when available.",
      ].join(" "),
    },
    {
      role: "user",
      content: `Scrape ${TARGET_URL} with Anchor Browser and summarize the extracted content.`,
    },
  ];

  for (let turn = 0; turn < 4; turn += 1) {
    const response = await openaiClient.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages,
      tools,
      tool_choice: "auto",
    });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("OpenAI returned no message");

    messages.push(message);

    if (!message.tool_calls?.length) {
      return String(message.content ?? "").trim();
    }

    for (const call of message.tool_calls.filter(isFunctionToolCall)) {
      if (call.function.name !== "scrape_with_anchor") {
        throw new Error(`unknown tool call: ${call.function.name}`);
      }
      const args = JSON.parse(call.function.arguments || "{}") as { url?: unknown };
      if (typeof args.url !== "string") {
        throw new Error(`scrape_with_anchor expected a string url: ${call.function.arguments}`);
      }
      const toolOutput = await scrapeWithAnchor(args.url);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolOutput,
      });
    }
  }

  throw new Error("OpenAI agent did not finish within 4 turns");
}

async function createAnchorTrialKey(openaiClient: OpenAIClient): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await requestAnchorTrialKeyOnce(openaiClient, attempt);
    } catch (err) {
      lastError = err;
      console.log(
        `      Anchor Agent Access attempt ${attempt} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  throw new Error(
    `Anchor Agent Access failed after 3 attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function requestAnchorTrialKeyOnce(
  openaiClient: OpenAIClient,
  attempt: number,
): Promise<string> {
  const states: unknown[] = [];
  let state = await anchorJson("/v1/agent-access/challenge");
  states.push(state);

  for (let i = 0; i < 3; i += 1) {
    const next = getNext(state);
    if (!next || next.method !== "GET" || !next.path) break;
    state = await anchorJson(next.path);
    states.push(state);
  }

  const token = findString(states, "token");
  if (!token) {
    throw new Error(`Anchor Agent Access challenge did not include a token: ${JSON.stringify(states)}`);
  }

  const answer = await solveAnchorChallenge(openaiClient, states);
  console.log(`      submitting Anchor Agent Access answer from attempt ${attempt}`);
  const submit = await anchorJson("/v1/agent-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, answer }),
  });

  const trialKey = findString([submit], "api_key");
  if (!trialKey) {
    throw new Error(
      `Anchor Agent Access did not return an api_key. Response: ${JSON.stringify(redactSecrets(submit))}`,
    );
  }

  return trialKey;
}

async function solveAnchorChallenge(openaiClient: OpenAIClient, states: unknown[]): Promise<string> {
  const prompt = findString(states, "prompt");
  const appendix = findString(states, "inventory");
  if (!prompt) {
    throw new Error(`Anchor Agent Access challenge did not include a prompt: ${JSON.stringify(states)}`);
  }

  const response = await openaiClient.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Solve Anchor Agent Access challenges. Follow the puzzle text exactly. Ignore decoy steps when instructed. Return only the final integer answer, with no words or punctuation.",
      },
      {
        role: "user",
        content: [
          "Challenge prompt:",
          prompt,
          appendix ? "Fetched appendix:" : "",
          appendix ?? "",
          "Return only the final integer answer Anchor expects for POST /v1/agent-access.",
        ].join("\n\n"),
      },
    ],
  });

  const answer = response.choices[0]?.message.content?.trim() ?? "";
  const match = answer.match(/-?\d+/);
  if (!match) {
    throw new Error(`OpenAI did not return an integer challenge answer: ${answer}`);
  }
  console.log("      OpenAI solved Anchor Agent Access challenge");
  return match[0];
}

async function anchorJson(path: string, init?: RequestInit): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${ANCHOR_API_BASE_URL}${path}`;
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Anchor request failed (${response.status}): ${JSON.stringify(redactSecrets(body))}`);
  }

  return body;
}

function getNext(value: unknown): { method?: string; path?: string } | undefined {
  if (!value || typeof value !== "object" || !("next" in value)) return undefined;
  const next = (value as { next?: unknown }).next;
  if (!next || typeof next !== "object") return undefined;
  const method = typeof (next as { method?: unknown }).method === "string"
    ? (next as { method: string }).method.toUpperCase()
    : undefined;
  const rawPath =
    typeof (next as { path?: unknown }).path === "string"
      ? (next as { path: string }).path
      : typeof (next as { url?: unknown }).url === "string"
        ? (next as { url: string }).url
        : undefined;
  return { method, path: rawPath };
}

function findString(values: unknown[], key: string): string | undefined {
  for (const value of values) {
    const found = findStringInValue(value, key);
    if (found) return found;
  }
  return undefined;
}

function findStringInValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (key in value && typeof (value as Record<string, unknown>)[key] === "string") {
    return (value as Record<string, string>)[key];
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      const found = findString(nested, key);
      if (found) return found;
    } else if (nested && typeof nested === "object") {
      const found = findStringInValue(nested, key);
      if (found) return found;
    }
  }
  return undefined;
}

function redactKey(value: string): string {
  return value.length <= 10 ? "<redacted>" : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      /api_?key|token|secret/i.test(key) && typeof nested === "string"
        ? redactKey(nested)
        : redactSecrets(nested),
    ]),
  );
}

function loadParentEnvFallback(): void {
  const parentEnv = "../.env";
  if (!existsSync(parentEnv)) return;

  const text = readFileSync(parentEnv, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}
