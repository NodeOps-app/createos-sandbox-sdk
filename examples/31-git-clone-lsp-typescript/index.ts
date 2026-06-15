/**
 * Clone a TypeScript repo into a createos-sandbox sandbox and drive a language server over it.
 *
 * Shallow-clones microsoft/vscode-json-languageservice into a microVM, installs
 * typescript-language-server, then uploads and runs `lsp-driver.mjs` (see that
 * file) which speaks the LSP JSON-RPC stdio protocol to the server from *inside*
 * the VM and captures real responses for initialize, documentSymbol, definition,
 * and completion. This file orchestrates the sandbox; the driver is the LSP
 * client. They communicate by a one-line `LSP_RESULTS:<json>` sentinel on stdout
 * — the simplest way to return structured data out of a `runCommand` call.
 *
 * Run:   bun 31-git-clone-lsp-typescript/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example). No external services
 *        beyond the public GitHub repo the clone pulls.
 */
import { readFile } from "node:fs/promises";
import { Sandbox } from "createos-sandbox-sdk";

const baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL;
const apiKey = process.env.CREATEOS_SANDBOX_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set CREATEOS_SANDBOX_BASE_URL and CREATEOS_SANDBOX_API_KEY (see .env.example)");
}

// Small public TS library used as the LSP target corpus.
// vscode-json-languageservice: Microsoft's JSON language service (~1.6 MB, main branch).
const CLONE_URL = "https://github.com/microsoft/vscode-json-languageservice.git";
const CLONE_REF = "main"; // shallow clone
const REPO_DIR = "/workspace/repo";

const SHAPE = "s-2vcpu-2gb"; // tsserver is memory-hungry; 1 GB can OOM
const ROOTFS = "devbox:1";

// ── 1. create ──────────────────────────────────────────────────────────────
// Sandbox.create is the client-less factory: the create request is arg 1 and
// client options (baseUrl/apiKey) go in arg 2.
console.log("[1/6] creating sandbox...");
const sandbox = await Sandbox.create({ shape: SHAPE, rootfs: ROOTFS }, { baseUrl, apiKey });
console.log(`      sandbox: ${sandbox.id}`);

try {
  // ── 2. clone ─────────────────────────────────────────────────────────────
  console.log("[2/6] git clone (depth=1)...");
  const cloneResult = await sandbox.runCommand(
    "bash",
    [
      "-lc",
      [
        "set -e",
        "apt-get update -qq && apt-get install -y --no-install-recommends git ca-certificates -qq",
        `mkdir -p ${REPO_DIR}`,
        // Disable any credential helper; GIT_TERMINAL_PROMPT=0 makes git
        // fail fast on missing auth rather than hanging waiting for a tty.
        `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true git -c credential.helper= clone --depth=1 --branch ${CLONE_REF} ${CLONE_URL} ${REPO_DIR}`,
        `ls ${REPO_DIR}/src/*.ts | head -3`,
      ].join(" && "),
    ],
    { timeoutMs: 180_000 },
  );
  if (cloneResult.result.exit_code !== 0) {
    throw new Error(`git clone failed:\n${cloneResult.result.stderr}`);
  }
  const clonedFiles = cloneResult.result.stdout.trim().split("\n").filter(Boolean);
  console.log(`      cloned — src files: ${clonedFiles.join(", ")}`);

  // ── 3. install Node + LSP server ─────────────────────────────────────────
  console.log("[3/6] installing Node.js + typescript-language-server...");
  const installResult = await sandbox.runCommand(
    "bash",
    [
      "-lc",
      [
        "set -e",
        // devbox:1 may not have current nodejs; install via NodeSource or use system node
        "node --version 2>/dev/null || (apt-get install -y --no-install-recommends nodejs npm -qq)",
        // typescript-language-server requires typescript as a peer
        "npm install -g --quiet typescript typescript-language-server 2>&1 | tail -5",
        "typescript-language-server --version",
      ].join(" && "),
    ],
    { timeoutMs: 300_000 },
  );
  if (installResult.result.exit_code !== 0) {
    throw new Error(`LSP install failed:\n${installResult.result.stderr}`);
  }
  const lspVersion = installResult.result.stdout.trim().split("\n").pop() ?? "unknown";
  console.log(`      typescript-language-server: ${lspVersion}`);

  // ── 4. upload the LSP driver ──────────────────────────────────────────────
  console.log("[4/6] uploading LSP driver into sandbox...");
  const driverPath = new URL("./lsp-driver.mjs", import.meta.url).pathname;
  const driverBytes = await readFile(driverPath);
  await sandbox.files.upload("/workspace/lsp-driver.mjs", driverBytes);
  console.log("      uploaded lsp-driver.mjs");

  // ── 5. run the LSP driver ─────────────────────────────────────────────────
  console.log(
    "[5/6] running LSP driver (initialize + documentSymbol + definition + completion)...",
  );
  const driverResult = await sandbox.runCommand(
    "bash",
    ["-lc", ["set -e", `mkdir -p ${REPO_DIR}`, "node /workspace/lsp-driver.mjs"].join(" && ")],
    { timeoutMs: 120_000 },
  );
  if (driverResult.result.exit_code !== 0) {
    throw new Error(
      `LSP driver failed (exit=${driverResult.result.exit_code}):\n${driverResult.result.stderr}`,
    );
  }

  const rawOutput = driverResult.result.stdout.trim();
  // The driver writes "LSP_RESULTS:<json>" as the last stdout line.
  const sentinelLine = rawOutput.split("\n").findLast((l) => l.startsWith("LSP_RESULTS:"));
  if (!sentinelLine) {
    throw new Error(`LSP driver missing sentinel line.\nOutput:\n${rawOutput.slice(-500)}`);
  }
  const jsonStr = sentinelLine.slice("LSP_RESULTS:".length);

  let lspResults: Record<string, unknown> = {};
  try {
    lspResults = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    throw new Error(`LSP driver output is not valid JSON:\n${jsonStr.slice(-500)}`);
  }

  // ── 6. print results ──────────────────────────────────────────────────────
  console.log("\n[6/6] LSP results:");
  const init = lspResults.initialize as
    | { serverName?: string; serverVersion?: string; capabilities?: string[] }
    | undefined;
  if (init) {
    console.log(`  initialize:      ${init.serverName ?? "?"} ${init.serverVersion ?? "?"}`);
    console.log(`  capabilities:    ${(init.capabilities ?? []).join(", ")}`);
  }
  const sym = lspResults.documentSymbol as
    | { count?: number; symbols?: Array<{ name: string; kind: number }> }
    | undefined;
  if (sym) {
    console.log(
      `  documentSymbol:  ${sym.count} symbols — ${(sym.symbols ?? []).map((s) => s.name).join(", ")}`,
    );
  }
  const def = lspResults.definition as
    | { query?: { token?: string }; locations?: Array<{ uri: string; line: number }> }
    | undefined;
  if (def) {
    console.log(
      `  definition:      token="${def.query?.token}" → ${(def.locations ?? []).length} location(s)`,
    );
  }
  const comp = lspResults.completion as { totalItems?: number; sample?: string[] } | undefined;
  if (comp) {
    console.log(
      `  completion:      ${comp.totalItems} items — sample: [${(comp.sample ?? []).join(", ")}]`,
    );
  }

  if (lspResults.error) {
    console.warn(`  driver error:    ${lspResults.error}`);
  }

  console.log("\nFull LSP output:");
  console.log(JSON.stringify(lspResults, null, 2));
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log(`\ndestroyed: ${sandbox.id}`);
}
