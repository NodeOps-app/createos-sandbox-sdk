# 35 — AIO Sandbox (all-in-one)

Combines every core FC SDK primitive — sandbox creation, file upload,
streaming command output, a daemonised HTTP server, ingress, port-readiness
polling, file download, and cleanup — into a single end-to-end script driven
by an LLM agent.

## Run

```sh
cp .env.example .env
# fill in FC_BASE_URL, FC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL
source .env
bun index.ts
```

Run from the `examples/` directory or from inside `35-aio-sandbox/`. The
`examples/` workspace must have its dependencies installed once:

```sh
cd examples/
bun install
```

## What it does

1. Prompts an LLM (via `@anthropic-ai/sdk`) to generate a self-contained HTML
   page that reports running inside an FC sandbox.
2. Creates an FC sandbox (`s-2vcpu-2gb`, `devbox:1`) with `ingress_enabled:
true` to obtain a public preview URL.
3. Uploads the AI-generated HTML into the sandbox at `/srv/index.html` via
   `sandbox.files.upload`.
4. Streams `python3 --version` output through `sandbox.streamCommand` — an
   async iterator — to verify the runtime environment.
5. Daemonises `python3 -m http.server 8000 --directory /srv --bind 0.0.0.0`
   via `nohup setsid` (no systemd in FC VMs; `;` before `nohup` prevents the
   runCommand pipe from blocking).
6. Calls `sandbox.waitForPortReady(8000)` then fetches the page over the
   public ingress URL to confirm end-to-end reachability.
7. Downloads `/srv/index.html` back via `sandbox.files.download` and verifies
   the content round-trips cleanly.
8. Destroys the sandbox in the `finally` block.

## FC primitives exercised

| Primitive                            | SDK call                                      |
| ------------------------------------ | --------------------------------------------- |
| Sandbox creation with public ingress | `fc.createSandbox({ ingress_enabled: true })` |
| Public preview URL                   | `sandbox.previewUrl(port)`                    |
| File upload into sandbox             | `sandbox.files.upload(path, content)`         |
| Streaming command output             | `sandbox.streamCommand(cmd, args)`            |
| Fire-and-forget command              | `sandbox.runCommand(cmd, args)`               |
| Port-readiness poll                  | `sandbox.waitForPortReady(port)`              |
| File download from sandbox           | `sandbox.files.download(path)`                |
| Sandbox teardown                     | `sandbox.destroy()`                           |

## Versions captured at build time

See `versions.txt`.
