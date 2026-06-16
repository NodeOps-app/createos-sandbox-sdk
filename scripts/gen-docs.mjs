#!/usr/bin/env bun
// Regenerates the example catalog (in examples/README.md and llms.txt) and the
// llms-full.txt context bundle from examples/manifest.json — the single source
// of truth for the example index.
//
//   bun run docs:gen     write the generated regions/files
//   bun run docs:check   verify they are in sync (exit 1 on drift); used in CI
//
// examples/README.md and llms.txt each carry a `<!-- BEGIN/END GENERATED -->`
// region that this script owns. llms-full.txt is generated in full.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const manifest = JSON.parse(read("examples/manifest.json"));
const examples = manifest.examples;

const TICK = "`";
const markers = (name) => ({
  begin: `<!-- BEGIN GENERATED: ${name} (do not edit; run ${TICK}bun run docs:gen${TICK}) -->`,
  end: `<!-- END GENERATED: ${name} -->`,
});

function replaceRegion(content, name, body) {
  const { begin, end } = markers(name);
  const bi = content.indexOf(begin);
  const ei = content.indexOf(end);
  if (bi === -1 || ei === -1) {
    throw new Error(`gen-docs: GENERATED markers for "${name}" not found`);
  }
  return `${content.slice(0, bi + begin.length)}\n${body}\n${content.slice(ei)}`;
}

// ---- renderers ------------------------------------------------------------

function renderReadmeCatalog() {
  const header =
    "| # | Example | What it shows | Key SDK primitives | Setup |\n| --- | --- | --- | --- | --- |";
  const rows = examples.map((e) => {
    const setup = e.status === "stable" ? "—" : "extra";
    return `| ${e.id} | [${e.dir}](${e.dir}/) | ${e.summary} | ${e.primitives.join(", ")} | ${setup} |`;
  });
  const noted = examples.filter((e) => e.notes || e.status !== "stable");
  const notes = noted.map((e) => {
    const tag = e.status !== "stable" ? "**needs extra setup** — " : "";
    return `- **${e.id} ${e.slug}** — ${tag}${e.notes ?? "external service or extra secrets required."}`;
  });
  const legend = "\nSetup `extra` = needs an external service or extra secrets; excluded from CI.";
  const notesBlock = notes.length ? `\n**Notes**\n\n${notes.join("\n")}\n` : "";
  return `${header}\n${rows.join("\n")}\n${legend}\n${notesBlock}`;
}

function renderLlmsExamples() {
  return examples.map((e) => `- [${e.dir}](examples/${e.dir}/) — ${e.summary}`).join("\n");
}

// Capability buckets for the docs/examples.md index. Derived from each
// example's primitives/deps (no manifest duplication) so new examples sort
// themselves. First match wins; AI is checked first because many agent
// examples also bind a port or attach a network.
const CATEGORY_ORDER = [
  "AI agents & frameworks",
  "Dev servers & preview URLs",
  "Code execution & data",
  "Disks, networks & templates",
  "Lifecycle, snapshots & cost",
];

function categoryOf(e) {
  const deps = (e.deps ?? []).join(" ");
  const prims = e.primitives ?? [];
  const slug = e.slug ?? "";
  const aiDep =
    /anthropic|openai|agents|langchain|langgraph|mastra|ai-sdk|llamaindex|google-adk|\bai\b/i;
  const aiSlug =
    /agent|claude|codex|gpt|rag|adk|langgraph|mastra|openclaw|acp|mcp|llamaindex|firecrawl|embeddings|inference|analyze/i;
  if (aiDep.test(deps) || aiSlug.test(slug)) return "AI agents & frameworks";
  if (prims.includes("previewUrl") || prims.includes("waitForPortReady")) {
    return "Dev servers & preview URLs";
  }
  if (
    prims.some((p) =>
      /^disks\.|^networks\.|^templates\.|attach(Disk|Network)|detach(Disk|Network)/.test(p),
    )
  ) {
    return "Disks, networks & templates";
  }
  if (prims.some((p) => /pause|fork|resume|setAutoPause|rechargeBandwidth|getBandwidth/.test(p))) {
    return "Lifecycle, snapshots & cost";
  }
  return "Code execution & data";
}

function renderExamplesDoc() {
  const byCat = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  for (const e of examples) byCat.get(categoryOf(e)).push(e);

  const intro = [
    "# Examples",
    "",
    "Runnable, self-contained programs — one per directory under " +
      "[`examples/`](../examples/). Each ships an `.env.example` listing the " +
      "keys it needs; copy it to `.env`, fill it in, and run the entry file " +
      "with `bun`. See the [examples README](../examples/README.md) for the " +
      "run instructions.",
    "",
    "> This index is generated from `examples/manifest.json`. Edit the " +
      "manifest, then run `bun run docs:gen` — do not hand-edit this file.",
  ].join("\n");

  const blocks = [];
  for (const cat of CATEGORY_ORDER) {
    const items = byCat.get(cat);
    if (!items.length) continue;
    const header = "| # | Example | What it shows | Setup |\n| --- | --- | --- | --- |";
    const rows = items.map((e) => {
      const setup = e.status === "stable" ? "—" : "extra setup";
      return `| ${e.id} | [${e.dir}](../examples/${e.dir}/) | ${e.summary} | ${setup} |`;
    });
    blocks.push(`## ${cat}\n\n${header}\n${rows.join("\n")}`);
  }

  const noted = examples.filter((e) => e.notes || e.status !== "stable");
  const notes = noted.map((e) => {
    const tag = e.status !== "stable" ? "**needs extra setup** — " : "";
    return `- **${e.id} ${e.slug}** — ${tag}${e.notes ?? "external service or extra secrets required."}`;
  });
  const notesBlock = notes.length ? `## Notes\n\n${notes.join("\n")}` : "";

  const footer =
    "## See also\n\n" +
    "- [Quickstart](./quickstart.md) — the 30-second tour\n" +
    "- [Tutorial](./tutorial.md) — build an AI app generator end to end\n" +
    "- [How-to guides](./how-to/) — task-oriented recipes\n" +
    "- [API reference](./reference/) — every class, method, and type";

  return [intro, ...blocks, notesBlock, footer].filter(Boolean).join("\n\n") + "\n";
}

// The full Diátaxis corpus, in reading order. sdk-analysis.md is intentionally
// excluded — it is internal and lives outside the public docs tree.
const LLMS_FULL_DOCS = [
  "docs/index.md",
  "docs/quickstart.md",
  "docs/tutorial.md",
  "docs/explanation/microvm-sandboxes.md",
  "docs/explanation/handle-model.md",
  "docs/explanation/lifecycle.md",
  "docs/explanation/reliability.md",
  "docs/how-to/files.md",
  "docs/how-to/lifecycle.md",
  "docs/how-to/expose-a-service.md",
  "docs/how-to/disks-networks-templates.md",
  "docs/how-to/streaming.md",
  "docs/how-to/error-handling.md",
  "docs/how-to/observability.md",
  "docs/reference/index.md",
  "docs/reference/client.md",
  "docs/reference/sandbox.md",
  "docs/reference/sub-apis.md",
  "docs/reference/errors.md",
  "docs/reference/types.md",
  "docs/reference/helpers.md",
  "docs/examples.md",
];

function renderLlmsFull(llmsTxt, examplesDoc) {
  const sections = [
    "# createos-sandbox-sdk — full context bundle",
    "> Generated by scripts/gen-docs.mjs from README.md, docs/, and llms.txt.\n> Do not edit by hand; run `bun run docs:gen`.",
    read("README.md"),
    ...LLMS_FULL_DOCS.map((p) => (p === "docs/examples.md" ? examplesDoc : read(p))),
    llmsTxt,
  ];
  // Strip per-line trailing whitespace so the bundle is stable under the
  // repo's trailing-whitespace pre-commit hook (source docs may carry it).
  return `${sections.join("\n\n---\n\n")}\n`.replace(/[ \t]+$/gm, "");
}

// ---- plan the writes ------------------------------------------------------

const outputs = {};

outputs["examples/README.md"] = replaceRegion(
  read("examples/README.md"),
  "examples",
  renderReadmeCatalog(),
);

const examplesDoc = renderExamplesDoc();
outputs["docs/examples.md"] = examplesDoc;

const llmsTxt = replaceRegion(read("llms.txt"), "examples", renderLlmsExamples());
outputs["llms.txt"] = llmsTxt;
outputs["llms-full.txt"] = renderLlmsFull(llmsTxt, examplesDoc);

// ---- write or check -------------------------------------------------------

let drift = false;
for (const [rel, content] of Object.entries(outputs)) {
  const path = join(ROOT, rel);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === content) continue;
  if (CHECK) {
    drift = true;
    console.error(`out of sync: ${relative(ROOT, path)} — run \`bun run docs:gen\``);
  } else {
    writeFileSync(path, content);
    console.log(`wrote ${rel}`);
  }
}

if (CHECK) {
  if (drift) process.exit(1);
  console.log("docs in sync with examples/manifest.json");
}
