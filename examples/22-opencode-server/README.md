# 22 — OpenCode Server (Sandbox)

Run [OpenCode](https://opencode.ai)'s headless HTTP server inside an FC microVM,
expose it through the sandbox's public ingress URL, and verify the API is live
by hitting `GET /global/health`.

## Run

```sh
cp .env.example .env
# fill in FCSPAWN_URL, FC_API_KEY, and ANTHROPIC_* vars
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a sandbox with `ingress_enabled: true` (`s-2vcpu-2gb`, `devbox:1`).
2. Writes an `opencode.json` config that wires the Anthropic provider with the
   supplied API key and base URL.
3. Runs `npm install -g opencode-ai` inside the sandbox and captures the
   resolved version.
4. Daemonises `opencode serve --hostname 0.0.0.0 --port 4096` via
   `nohup setsid` (no systemd in `devbox:1`), binding `0.0.0.0` so ingress
   can reach it.
5. Waits for the server to bind its port with `waitForPortReady`.
6. Polls `GET /global/health` through the public ingress URL until the server
   returns `{ healthy: true }`, then prints the full health response.
7. Fetches `GET /provider` to confirm the Anthropic provider config landed.
8. Destroys the sandbox in a `finally` block.

## FC primitives exercised

| Primitive | SDK call |
| --- | --- |
| Create sandbox with public ingress | `fc.createSandbox({ ingress_enabled: true })` |
| Upload config file into the VM | `sandbox.files.upload(path, contents)` |
| Run commands (install, daemonise) | `sandbox.runCommand("bash", ["-lc", ...])` |
| Build the public preview URL | `sandbox.previewUrl(port)` |
| Block until the server listens | `sandbox.waitForPortReady(port)` |
| Tear the sandbox down | `sandbox.destroy()` |

## Versions captured at build time

See `versions.txt`.
