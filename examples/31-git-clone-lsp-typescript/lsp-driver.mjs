// lsp-driver.mjs — runs INSIDE the sandbox via `node lsp-driver.mjs`
// Drives typescript-language-server over stdio JSON-RPC, captures real
// responses for initialize, documentSymbol, definition, and completion,
// then prints a JSON summary to stdout before hard-exiting.
//
// Framing: Content-Length: <bytes>\r\n\r\n<json>

import { spawn } from "node:child_process";

const REPO_DIR = "/workspace/repo";
// vscode-json-languageservice main entry — always present in this repo.
const TARGET_FILE = `${REPO_DIR}/src/jsonLanguageService.ts`;
const LSP_SERVER = "typescript-language-server";

// ── helpers ──────────────────────────────────────────────────────────────────

function encode(msg) {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

// Parse the Content-Length framing from a raw stream.
// Returns an async generator yielding parsed message objects.
async function* parseFrames(readable) {
  let buf = "";
  for await (const chunk of readable) {
    buf += chunk.toString("utf8");
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buf.slice(0, headerEnd);
      const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lenMatch) {
        // Skip malformed header
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(lenMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (buf.length < bodyStart + len) break; // need more data
      const body = buf.slice(bodyStart, bodyStart + len);
      buf = buf.slice(bodyStart + len);
      try {
        yield JSON.parse(body);
      } catch {
        // ignore parse errors on malformed frames
      }
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const results = {};
let nextId = 1;

const pendingRequests = new Map(); // id → { resolve, reject }

const proc = spawn(LSP_SERVER, ["--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PATH: process.env.PATH },
});

proc.stderr.on("data", () => {}); // suppress tsserver logs

// Frame reader loop — runs concurrently.
// Resolves pending requests by id; ignores notifications.
(async () => {
  for await (const msg of parseFrames(proc.stdout)) {
    if (msg.id !== undefined && pendingRequests.has(msg.id)) {
      const { resolve } = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      resolve(msg);
    }
    // notifications (no id) and unknown ids are silently dropped
  }
})();

function request(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    proc.stdin.write(encode(msg));
  });
}

function notify(method, params) {
  proc.stdin.write(encode({ jsonrpc: "2.0", method, params }));
}

// Timeout helper — rejects after ms if the promise hasn't settled.
function withTimeout(ms, promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

try {
  // 1. Read the target file text
  const { readFileSync } = await import("node:fs");
  let fileText;
  try {
    fileText = readFileSync(TARGET_FILE, "utf8");
  } catch {
    // Fallback: try any .ts file in src/
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const srcDir = `${REPO_DIR}/src`;
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    if (files.length === 0) throw new Error("No .ts files found in src/");
    const fallbackPath = join(srcDir, files[0]);
    fileText = readFileSync(fallbackPath, "utf8");
    results.usedFallbackFile = files[0];
  }

  const fileUri = `file://${TARGET_FILE}`;

  // 2. initialize
  const initResp = await withTimeout(
    30_000,
    request("initialize", {
      processId: process.pid,
      rootUri: `file://${REPO_DIR}`,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: false },
          definition: {},
          completion: { completionItem: { snippetSupport: false } },
        },
        workspace: { workspaceFolders: false },
      },
      initializationOptions: {
        preferences: {
          includeInlayHintsForImportedTypes: false,
          includeInlayPropertyDeclarationTypes: false,
        },
      },
    }),
    "initialize",
  );
  results.initialize = {
    serverName: initResp.result?.serverInfo?.name ?? "typescript-language-server",
    serverVersion: initResp.result?.serverInfo?.version ?? "unknown",
    capabilities: Object.keys(initResp.result?.capabilities ?? {}).slice(0, 8),
  };

  // 3. initialized notification (required before any document queries)
  notify("initialized", {});

  // 4. textDocument/didOpen — provide full file text
  notify("textDocument/didOpen", {
    textDocument: {
      uri: fileUri,
      languageId: "typescript",
      version: 1,
      text: fileText,
    },
  });

  // Give tsserver a moment to index the file
  await new Promise((r) => setTimeout(r, 2000));

  // 5. documentSymbol — list all symbols in the file
  const symResp = await withTimeout(
    15_000,
    request("textDocument/documentSymbol", { textDocument: { uri: fileUri } }),
    "documentSymbol",
  );
  // DocumentSymbol has .range; SymbolInformation has .location.range — handle both.
  const symbols = (symResp.result ?? []).map((s) => ({
    name: s.name,
    kind: s.kind,
    // hierarchical DocumentSymbol uses .range; flat SymbolInformation uses .location.range
    range: s.range?.start ?? s.location?.range?.start,
  }));
  results.documentSymbol = { count: symbols.length, symbols: symbols.slice(0, 8) };

  // 6. definition — query the first symbol returned by documentSymbol.
  // Using a known symbol position avoids placing the cursor in a comment or
  // empty line where definition returns nothing.
  const firstSym = symbols[0];
  const defLine = firstSym?.range?.line ?? 0;
  // Put the character inside the symbol name (midpoint).
  const defLineText = fileText.split("\n")[defLine] ?? "";
  const symName = firstSym?.name ?? "";
  const symNameIdx = defLineText.indexOf(symName);
  const defChar = symNameIdx !== -1 ? symNameIdx + Math.floor(symName.length / 2) : 5;
  const defResp = await withTimeout(
    15_000,
    request("textDocument/definition", {
      textDocument: { uri: fileUri },
      position: { line: defLine, character: defChar },
    }),
    "definition",
  );
  const defResult = defResp.result;
  results.definition = {
    query: { line: defLine, character: defChar, token: symName || "(unknown)" },
    locations: Array.isArray(defResult)
      ? defResult.slice(0, 3).map((d) => ({
          uri: d.uri?.replace(`file://${REPO_DIR}/`, "./"),
          line: d.range?.start?.line,
        }))
      : defResult
        ? [
            {
              uri: defResult.uri?.replace(`file://${REPO_DIR}/`, "./"),
              line: defResult.range?.start?.line,
            },
          ]
        : [],
  };

  // 7. completion — trigger at the end of the first symbol's line to get
  // relevant completions in that scope.
  const compLine = defLine;
  const compChar = defLineText.length > 0 ? defLineText.length - 1 : 0;
  const compResp = await withTimeout(
    15_000,
    request("textDocument/completion", {
      textDocument: { uri: fileUri },
      position: { line: compLine, character: compChar },
      context: { triggerKind: 1 },
    }),
    "completion",
  );
  const compItems = compResp.result?.items ?? compResp.result ?? [];
  const itemArray = Array.isArray(compItems) ? compItems : [];
  results.completion = {
    totalItems: itemArray.length,
    sample: itemArray.slice(0, 5).map((i) => i.label),
  };

  // 8. shutdown + exit cleanly
  await withTimeout(5_000, request("shutdown", null), "shutdown");
  notify("exit", null);
} catch (err) {
  results.error = err.message;
} finally {
  // Hard-kill after 2 s to ensure runCommand returns
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {}
    // Print on a single line prefixed with a sentinel so index.ts can extract it.
    process.stdout.write("LSP_RESULTS:" + JSON.stringify(results) + "\n");
    process.exit(0);
  }, 2000);
  proc.stdin.end();
}
