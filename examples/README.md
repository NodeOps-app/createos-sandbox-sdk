# Examples

Self-contained, runnable examples for `fc-sandbox-sdk`. Each subdirectory is
one example you run with `bun`.

## Running

Install dependencies once from this directory:

```sh
bun install
```

Every example needs a reachable `fc-spawn` control plane (`FC_BASE_URL`) and
an API key (`FC_API_KEY`); some need extra provider keys. Each example ships a
`.env.example` listing what it needs. Create a `.env` that `bun` will load
(it reads `.env` from the directory you run the command in), then run it:

```sh
cp 01-hello-world/.env.example .env   # fill in the values
bun 01-hello-world/index.ts
```

## Catalog

<!-- BEGIN GENERATED: examples (do not edit; run `bun run docs:gen`) -->
| # | Example | What it shows | Key SDK primitives | Setup |
| --- | --- | --- | --- | --- |
| 01 | [01-hello-world](01-hello-world/) | Smoke test: create a sandbox, run one buffered command, destroy it. | createSandbox, runCommand, destroy | — |
| 02 | [02-code-interpreter](02-code-interpreter/) | Upload a Python script, run it, capture stdout/stderr. Includes a streaming variant. | createSandbox, files.upload, runCommand, streamCommand, destroy | — |
| 03 | [03-dev-server-preview-url](03-dev-server-preview-url/) | Bind an HTTP server and reach it via a per-sandbox ingress preview URL. | createSandbox, runCommand, waitForPortReady, previewUrl, destroy | — |
| 04 | [04-ai-code-agent](04-ai-code-agent/) | Use a sandbox as the code-execution environment for a Claude agent. | createSandbox, files.upload, runCommand, destroy | — |
| 05 | [05-filesystem-snapshots](05-filesystem-snapshots/) | Snapshot/branch a sandbox: pause, fork, resume the clone. | files.upload, runCommand, pause, fork, resume, waitUntilPaused, destroy | — |
| 06 | [06-openai-agents-fc-tools](06-openai-agents-fc-tools/) | Expose sandbox operations as tools to the OpenAI Agents SDK. | createSandbox, files.upload, runCommand, destroy | — |
| 07 | [07-docker-custom-template](07-docker-custom-template/) | Build a custom rootfs template from a Dockerfile, then run containers inside the microVM. | templates.create, templates.get, templates.delete, createSandbox, runCommand, destroy | — |
| 08 | [08-dev-server-git-preview](08-dev-server-git-preview/) | Clone a repo, start a dev server, expose it via a live ingress URL. | createSandbox, runCommand, waitForPortReady, previewUrl, destroy | — |
| 09 | [09-mcp-claude-code](09-mcp-claude-code/) | Run the Claude Code CLI inside a sandbox. | createSandbox, runCommand, streamCommand, destroy | — |
| 10 | [10-mcp-browserbase](10-mcp-browserbase/) | Run the Browserbase MCP server in a sandbox, driven by Claude. | createSandbox, runCommand, waitForPortReady, previewUrl, destroy | extra |
| 11 | [11-tigerfs-postgres-filesystem](11-tigerfs-postgres-filesystem/) | Run PostgreSQL on a TigerFS filesystem layer in one microVM. | createSandbox, files.upload, runCommand, destroy | — |
| 12 | [12-radicle-multi-agent](12-radicle-multi-agent/) | Three networked sandboxes running a Radicle p2p git mesh with role-specialized agents. | createSandbox, runCommand, files.download, networks.create, networks.get, networks.delete, destroy | — |
| 13 | [13-llamaindex-rag](13-llamaindex-rag/) | Build a LlamaIndex vector index; persist it across pause/resume. | createSandbox, files.upload, files.download, runCommand, pause, resume, destroy | — |
| 14 | [14-jupyter-singleton](14-jupyter-singleton/) | Keep a persistent Python kernel over a socket; pause and fork two branches. | createSandbox, files.upload, runCommand, pause, fork, resume, destroy | — |
| 15 | [15-acp-hello-world](15-acp-hello-world/) | Run an Agent Client Protocol agent in a sandbox over JSON-RPC. | createSandbox, files.upload, runCommand, destroy | — |
| 16 | [16-firecrawl-scrape-analyze](16-firecrawl-scrape-analyze/) | Scrape pages with Firecrawl, have Claude write analysis code, run it, pull the chart. | createSandbox, files.upload, files.download, runCommand, destroy | — |
| 17 | [17-analyze-data-with-ai](17-analyze-data-with-ai/) | Upload a CSV, have Claude write the analysis from its schema, read back the chart. | createSandbox, files.upload, files.download, runCommand, destroy | — |
| 18 | [18-text-embeddings-server](18-text-embeddings-server/) | Serve a CPU embeddings model as a long-lived service over ingress. | createSandbox, files.upload, runCommand, waitForPortReady, previewUrl, destroy | — |
| 19 | [19-batch-inference-fanout](19-batch-inference-fanout/) | Shard a classification job across many sandboxes in parallel. | createSandbox, files.upload, runCommand, listSandboxes, destroy | — |
| 20 | [20-google-adk-agent](20-google-adk-agent/) | Drive a Google ADK agent whose tools run inside a microVM. | createSandbox, runCommand, destroy | — |
| 21 | [21-astro-sandbox](21-astro-sandbox/) | Scaffold an Astro site, run `astro dev`, reach it via ingress. | createSandbox, files.upload, runCommand, waitForPortReady, previewUrl, destroy | — |
| 22 | [22-opencode-server](22-opencode-server/) | Run the OpenCode headless HTTP server over ingress. | createSandbox, files.upload, runCommand, waitForPortReady, previewUrl, destroy | — |
| 25 | [25-prometheus-pushgateway](25-prometheus-pushgateway/) | Run a Prometheus Pushgateway, push a metric, scrape it via ingress. | createSandbox, runCommand, waitForPortReady, previewUrl, destroy | — |
| 26 | [26-s3-bucket-mount](26-s3-bucket-mount/) | Query a public S3 bucket via DuckDB httpfs inside a sandbox. | createSandbox, files.upload, files.download, runCommand, destroy | — |
| 27 | [27-fastapi-app](27-fastapi-app/) | Serve a FastAPI app over ingress and verify its routes. | createSandbox, files.upload, runCommand, waitForPortReady, previewUrl, destroy | — |
| 28 | [28-code-server-vscode](28-code-server-vscode/) | Run code-server (VS Code in the browser) over ingress. | createSandbox, runCommand, waitForPortReady, previewUrl, destroy | — |
| 29 | [29-playwright-headless-browser](29-playwright-headless-browser/) | Run Playwright + headless Chromium to scrape and extract the DOM. | createSandbox, files.upload, runCommand, destroy | — |
| 30 | [30-headless-chromium-devtools](30-headless-chromium-devtools/) | Run headless Chrome with the CDP port exposed via ingress. | createSandbox, files.upload, runCommand, waitForPortReady, previewUrl, destroy | — |
| 31 | [31-git-clone-lsp-typescript](31-git-clone-lsp-typescript/) | Clone a TS repo and drive typescript-language-server over stdio. | createSandbox, files.upload, runCommand, destroy | — |
| 32 | [32-langgraph-sandbox-orchestrator](32-langgraph-sandbox-orchestrator/) | Model sandbox operations as LangGraph nodes with an OpenAI LLM. | createSandbox, files.upload, runCommand, destroy | — |
| 33 | [33-codex-cli](33-codex-cli/) | Run the OpenAI Codex CLI in a sandbox to execute a task. | createSandbox, files.upload, files.download, runCommand, destroy | — |
| 34 | [34-openclaw-gateway](34-openclaw-gateway/) | Run the OpenClaw gateway over ingress and verify /v1/models. | createSandbox, runCommand, streamCommand, waitForPortReady, previewUrl, destroy | — |
| 35 | [35-aio-sandbox](35-aio-sandbox/) | All-in-one tour exercising every core primitive in one run. | createSandbox, files.upload, files.download, runCommand, streamCommand, waitForPortReady, previewUrl, destroy | — |
| 36 | [36-self-hosted-agent-worker](36-self-hosted-agent-worker/) | Back a Claude Managed Agent with one persistent microVM for tool execution. | createSandbox, runCommand, files.download, destroy | extra |
| 37 | [37-self-hosted-sandbox-per-session](37-self-hosted-sandbox-per-session/) | Back a Claude Managed Agent with a fresh microVM per session. | createSandbox, runCommand, files.download, destroy | extra |
| 38 | [38-s3-disk-ffmpeg-transcode](38-s3-disk-ffmpeg-transcode/) | Register an S3-backed disk, mount at boot, transcode with ffmpeg, detach, destroy. | disks.create, disks.get, disks.list, disks.delete, createSandbox, getSandbox, detachDisk, pause, runCommand, destroy | extra |
| 39 | [39-bandwidth-recharge](39-bandwidth-recharge/) | Read a sandbox's bandwidth quota and grow it after create with rechargeBandwidth (create no longer accepts bandwidth_quota_bytes). | createSandbox, getBandwidth, rechargeBandwidth, destroy | — |
| 40 | [40-idle-auto-pause](40-idle-auto-pause/) | Set an idle auto-pause timeout at create with auto_pause_after_seconds and change it live with setAutoPause(seconds | null) so an idle sandbox stops billing. | createSandbox, setAutoPause, destroy | — |
| 45 | [45-claude-github-wiki](45-claude-github-wiki/) | Clone a public GitHub repo into a sandbox and run a Claude tool-use agent that reads the file tree to answer questions about the codebase. | createSandbox, runCommand, destroy | — |

Setup `extra` = needs an external service or extra secrets; excluded from CI.

**Notes**

- **02 code-interpreter** — Streaming exec currently 404s on the control plane; the buffered path is the default.
- **03 dev-server-preview-url** — Use http:// previews unless your ingress wildcard has a real TLS cert.
- **10 mcp-browserbase** — **needs extra setup** — Needs a Browserbase account.
- **14 jupyter-singleton** — Fork can occasionally stick in 'pausing' on the control plane.
- **36 self-hosted-agent-worker** — **needs extra setup** — Needs Anthropic managed-agents access.
- **37 self-hosted-sandbox-per-session** — **needs extra setup** — Needs Anthropic managed-agents access.
- **38 s3-disk-ffmpeg-transcode** — **needs extra setup** — Needs an S3-compatible bucket reachable from the FC agent.

<!-- END GENERATED: examples -->

This catalog is generated from [`manifest.json`](manifest.json), the
machine-readable index of every example. Add or edit an example there, then
run `bun run docs:gen` from the repository root.
