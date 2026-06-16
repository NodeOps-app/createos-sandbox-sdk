# Examples

Runnable, self-contained programs — one per directory under [`examples/`](../examples/). Each ships an `.env.example` listing the keys it needs; copy it to `.env`, fill it in, and run the entry file with `bun`. See the [examples README](../examples/README.md) for the run instructions.

> This index is generated from `examples/manifest.json`. Edit the manifest, then run `bun run docs:gen` — do not hand-edit this file.

## AI agents & frameworks

| # | Example | What it shows | Setup |
| --- | --- | --- | --- |
| 04 | [04-ai-code-agent](../examples/04-ai-code-agent/) | Use a sandbox as the code-execution environment for a Claude agent. | — |
| 06 | [06-openai-agents-fc-tools](../examples/06-openai-agents-fc-tools/) | Expose sandbox operations as tools to the OpenAI Agents SDK. | — |
| 09 | [09-mcp-claude-code](../examples/09-mcp-claude-code/) | Run the Claude Code CLI inside a sandbox. | — |
| 10 | [10-mcp-browserbase](../examples/10-mcp-browserbase/) | Run the Browserbase MCP server in a sandbox, driven by Claude. | extra setup |
| 12 | [12-radicle-multi-agent](../examples/12-radicle-multi-agent/) | Three networked sandboxes running a Radicle p2p git mesh with role-specialized agents. | — |
| 13 | [13-llamaindex-rag](../examples/13-llamaindex-rag/) | Build a LlamaIndex vector index; persist it across pause/resume. | — |
| 15 | [15-acp-hello-world](../examples/15-acp-hello-world/) | Run an Agent Client Protocol agent in a sandbox over JSON-RPC. | — |
| 16 | [16-firecrawl-scrape-analyze](../examples/16-firecrawl-scrape-analyze/) | Scrape pages with Firecrawl, have Claude write analysis code, run it, pull the chart. | — |
| 17 | [17-analyze-data-with-ai](../examples/17-analyze-data-with-ai/) | Upload a CSV, have Claude write the analysis from its schema, read back the chart. | — |
| 18 | [18-text-embeddings-server](../examples/18-text-embeddings-server/) | Serve a CPU embeddings model as a long-lived service over ingress. | — |
| 19 | [19-batch-inference-fanout](../examples/19-batch-inference-fanout/) | Shard a classification job across many sandboxes in parallel. | — |
| 20 | [20-google-adk-agent](../examples/20-google-adk-agent/) | Drive a Google ADK agent whose tools run inside a VM. | — |
| 32 | [32-langgraph-sandbox-orchestrator](../examples/32-langgraph-sandbox-orchestrator/) | Model sandbox operations as LangGraph nodes with an OpenAI LLM. | — |
| 33 | [33-codex-cli](../examples/33-codex-cli/) | Run the OpenAI Codex CLI in a sandbox to execute a task. | — |
| 34 | [34-openclaw-gateway](../examples/34-openclaw-gateway/) | Run the OpenClaw gateway over ingress and verify /v1/models. | — |
| 35 | [35-aio-sandbox](../examples/35-aio-sandbox/) | All-in-one tour exercising every core primitive in one run. | — |
| 36 | [36-self-hosted-agent-worker](../examples/36-self-hosted-agent-worker/) | Back a Claude Managed Agent with one persistent VM for tool execution. | extra setup |
| 37 | [37-self-hosted-sandbox-per-session](../examples/37-self-hosted-sandbox-per-session/) | Back a Claude Managed Agent with a fresh VM per session. | extra setup |
| 44 | [44-claude-changelog-generator](../examples/44-claude-changelog-generator/) | Clone a public git repo inside a sandbox, run the commit log through the Claude Messages API, and download the generated CHANGELOG.md. | extra setup |
| 45 | [45-claude-github-wiki](../examples/45-claude-github-wiki/) | Clone a public GitHub repo into a sandbox and run a Claude tool-use agent that reads the file tree to answer questions about the codebase. | — |
| 46 | [46-mastra-agent](../examples/46-mastra-agent/) | Install the Mastra TypeScript agent framework inside a createos-sandbox VM, upload an agent script, run it against an OpenAI-compatible provider, and capture the response. | — |
| 47 | [47-effective-agents-patterns](../examples/47-effective-agents-patterns/) | Run three LLM agent patterns (prompt-chaining, routing, parallelization) using the Vercel AI SDK inside a createos-sandbox sandbox, with an OpenAI-compatible model proxy. | — |

## Dev servers & preview URLs

| # | Example | What it shows | Setup |
| --- | --- | --- | --- |
| 03 | [03-dev-server-preview-url](../examples/03-dev-server-preview-url/) | Bind an HTTP server and reach it via a per-sandbox ingress preview URL. | — |
| 08 | [08-dev-server-git-preview](../examples/08-dev-server-git-preview/) | Clone a repo, start a dev server, expose it via a live ingress URL. | — |
| 21 | [21-astro-sandbox](../examples/21-astro-sandbox/) | Scaffold an Astro site, run `astro dev`, reach it via ingress. | — |
| 22 | [22-opencode-server](../examples/22-opencode-server/) | Run the OpenCode headless HTTP server over ingress. | — |
| 25 | [25-prometheus-pushgateway](../examples/25-prometheus-pushgateway/) | Run a Prometheus Pushgateway, push a metric, scrape it via ingress. | — |
| 27 | [27-fastapi-app](../examples/27-fastapi-app/) | Serve a FastAPI app over ingress and verify its routes. | — |
| 28 | [28-code-server-vscode](../examples/28-code-server-vscode/) | Run code-server (VS Code in the browser) over ingress. | — |
| 30 | [30-headless-chromium-devtools](../examples/30-headless-chromium-devtools/) | Run headless Chrome with the CDP port exposed via ingress. | — |

## Code execution & data

| # | Example | What it shows | Setup |
| --- | --- | --- | --- |
| 01 | [01-hello-world](../examples/01-hello-world/) | Smoke test: create a sandbox, run one buffered command, destroy it. | — |
| 02 | [02-code-interpreter](../examples/02-code-interpreter/) | Upload a Python script, run it, capture stdout/stderr. Includes a streaming variant. | — |
| 11 | [11-tigerfs-postgres-filesystem](../examples/11-tigerfs-postgres-filesystem/) | Run PostgreSQL on a TigerFS filesystem layer in one VM. | — |
| 26 | [26-s3-bucket-mount](../examples/26-s3-bucket-mount/) | Query a public S3 bucket via DuckDB httpfs inside a sandbox. | — |
| 29 | [29-playwright-headless-browser](../examples/29-playwright-headless-browser/) | Run Playwright + headless Chromium to scrape and extract the DOM. | — |
| 31 | [31-git-clone-lsp-typescript](../examples/31-git-clone-lsp-typescript/) | Clone a TS repo and drive typescript-language-server over stdio. | — |
| 41 | [41-python-pdf-extractor](../examples/41-python-pdf-extractor/) | Upload a fillable PDF into a sandbox, pip-install PyMuPDF, extract every form-field name and value to JSON, and download the result — no external API required. | — |
| 42 | [42-doc-to-markdown](../examples/42-doc-to-markdown/) | Upload a local document (HTML, DOCX, PDF, …) into a createos-sandbox sandbox, convert it to Markdown with Microsoft MarkItDown (pip-installed inside the guest), and download the result. | — |
| 43 | [43-crawl4ai-crawler](../examples/43-crawl4ai-crawler/) | Install Crawl4AI and Playwright/Chromium inside a VM, crawl a public URL to Markdown, download the output to the host. | — |

## Disks, networks & templates

| # | Example | What it shows | Setup |
| --- | --- | --- | --- |
| 07 | [07-docker-custom-template](../examples/07-docker-custom-template/) | Build a custom rootfs template from a Dockerfile, then run containers inside the VM. | — |
| 38 | [38-s3-disk-ffmpeg-transcode](../examples/38-s3-disk-ffmpeg-transcode/) | Register an S3-backed disk, mount at boot, transcode with ffmpeg, detach, destroy. | extra setup |

## Lifecycle, snapshots & cost

| # | Example | What it shows | Setup |
| --- | --- | --- | --- |
| 05 | [05-filesystem-snapshots](../examples/05-filesystem-snapshots/) | Snapshot/branch a sandbox: pause, fork, resume the clone. | — |
| 14 | [14-jupyter-singleton](../examples/14-jupyter-singleton/) | Keep a persistent Python kernel over a socket; pause and fork two branches. | — |
| 39 | [39-bandwidth-recharge](../examples/39-bandwidth-recharge/) | Read a sandbox's bandwidth quota and grow it after create with rechargeBandwidth (create no longer accepts bandwidth_quota_bytes). | — |
| 40 | [40-idle-auto-pause](../examples/40-idle-auto-pause/) | Set an idle auto-pause timeout at create with auto_pause_after_seconds and change it live with setAutoPause(seconds | null) so an idle sandbox stops billing. | — |

## Notes

- **02 code-interpreter** — Streaming exec currently 404s on the control plane; the buffered path is the default.
- **03 dev-server-preview-url** — Use http:// previews unless your ingress wildcard has a real TLS cert.
- **10 mcp-browserbase** — **needs extra setup** — Needs a Browserbase account.
- **14 jupyter-singleton** — Fork can occasionally stick in 'pausing' on the control plane.
- **36 self-hosted-agent-worker** — **needs extra setup** — Needs Anthropic managed-agents access.
- **37 self-hosted-sandbox-per-session** — **needs extra setup** — Needs Anthropic managed-agents access.
- **38 s3-disk-ffmpeg-transcode** — **needs extra setup** — Needs an S3-compatible bucket reachable from the createos-sandbox agent.
- **43 crawl4ai-crawler** — Heavy install step (~600 s); needs s-4vcpu-4gb for Chromium headroom.
- **44 claude-changelog-generator** — **needs extra setup** — Needs ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (or ANTHROPIC_API_KEY) for the Claude Messages API inside the sandbox.
- **46 mastra-agent** — Requires an OpenAI-compatible provider (OPENAI_API_URL + OPENAI_API_KEY + OPENAI_MODEL). OTEL_SDK_DISABLED=true is injected into the sandbox to prevent Mastra's OpenTelemetry flush from blocking exit.
- **47 effective-agents-patterns** — ai and @ai-sdk/openai are installed inside the sandbox, not on the host. ci=false because it needs an external LLM proxy.

## See also

- [Quickstart](./quickstart.md) — the 30-second tour
- [Tutorial](./tutorial.md) — build an AI app generator end to end
- [How-to guides](./how-to/) — task-oriented recipes
- [API reference](./reference/) — every class, method, and type
