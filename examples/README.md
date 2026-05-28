# examples

FC SDK examples. Each subdirectory holds a self-contained runnable example.

## Examples

| # | dir | FC primitives |
| -- | --- | --- |
| 01 | [hello-world](01-hello-world/) | create → buffered exec → destroy |
| 02 | [code-interpreter](02-code-interpreter/) | file upload + buffered exec (streaming variant blocked by [fc#40](https://github.com/NodeOps-app/fc/issues/40)) |
| 03 | [dev-server-preview-url](03-dev-server-preview-url/) | `ingress_enabled` + public URL (TLS workaround per [fc#41](https://github.com/NodeOps-app/fc/issues/41)) |
| 04 | [ai-code-agent](04-ai-code-agent/) | agentic coding inside a sandbox |
| 05 | [filesystem-snapshots](05-filesystem-snapshots/) | snapshot → restore |
| 06 | [openai-agents-fc-tools](06-openai-agents-fc-tools/) | OpenAI Agents SDK with FC sandbox tools |
| 07 | [docker-custom-template](07-docker-custom-template/) | custom rootfs from a Docker image |
| 08 | [dev-server-git-preview](08-dev-server-git-preview/) | git clone + dev server + live ingress URL |
| 09 | [mcp-claude-code](09-mcp-claude-code/) | Claude Code CLI running inside a sandbox |
| 10 | [mcp-browserbase](10-mcp-browserbase/) | Browserbase MCP server running in a sandbox |
| 11 | [tigerfs-postgres-filesystem](11-tigerfs-postgres-filesystem/) | TigerFS + PostgreSQL filesystem layer |
| 12 | [radicle-multi-agent](12-radicle-multi-agent/) | multi-agent workflow with Radicle |

## Running

Install once from this directory:

```sh
bun install
```

Set credentials:

```sh
cp .env.example .env   # fill in FC_API_KEY and any other required keys
```

Then run any example:

```sh
bun 01-hello-world/index.ts
```

## Known issues

| # | issue | impact |
| -- | --- | --- |
| [fc#40](https://github.com/NodeOps-app/fc/issues/40) | `exec --stream` 404s on a sandbox where buffered exec works | blocks streaming-output examples until fixed |
| [fc#41](https://github.com/NodeOps-app/fc/issues/41) | wildcard `*.eu.bhautik.in` serves ingress-nginx fake cert | every preview-URL example must skip TLS verify |
