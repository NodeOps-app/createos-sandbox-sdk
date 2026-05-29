# 31 — Git Clone + LSP (TypeScript)

Clones a public TypeScript repository into an FC sandbox, installs
`typescript-language-server`, and drives it over its stdio JSON-RPC protocol
from inside the sandbox — capturing real LSP responses for `initialize`,
`textDocument/documentSymbol`, `textDocument/definition`, and
`textDocument/completion`.

## Run

```sh
cp .env.example .env
# fill in FCSPAWN_URL and FC_API_KEY
bun index.ts
```

bun auto-loads `.env` from the working directory. `FC_API_KEY` and
`FCSPAWN_URL` (or `FC_BASE_URL`) are the required variables.

## What it does

1. Creates a `s-2vcpu-2gb` / `devbox:1` sandbox (tsserver is memory-hungry).
2. Installs `git` and clones `microsoft/vscode-json-languageservice` at `--depth=1`.
3. Installs `typescript` and `typescript-language-server` globally via `npm`.
4. Uploads a small Node.js driver script (`lsp-driver.mjs`) into the sandbox.
5. Runs the driver inside the sandbox; it opens an LSP session over stdio:
   - Sends `initialize` and `initialized`.
   - Sends `textDocument/didOpen` with the full file text.
   - Requests `textDocument/documentSymbol` — lists all symbols in the file.
   - Requests `textDocument/definition` at the position of the first symbol returned
     by `documentSymbol` (`getLanguageService` at line 60).
   - Requests `textDocument/completion` at the same line.
   - Sends `shutdown` + `exit` cleanly.
6. The driver prints a JSON summary to stdout; `index.ts` parses and displays it.
7. Destroys the sandbox in the `finally` block.

The LSP handshake runs entirely inside the sandbox, avoiding the latency and
framing complexity of piping stdio across the control-plane network.

## FC primitives exercised

| Primitive | SDK call |
| --- | --- |
| Sandbox create | `Sandbox.create({ shape, rootfs })` |
| Buffered command | `sandbox.runCommand("bash", ["-lc", …], { timeoutMs })` |
| File upload (driver → sandbox) | `sandbox.files.upload(path, bytes)` |
| Sandbox destroy | `sandbox.destroy()` |

## Versions captured at build time

See `versions.txt`.
