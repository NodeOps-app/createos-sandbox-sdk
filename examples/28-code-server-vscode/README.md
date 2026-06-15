# 28 — code-server (VS Code in Browser)

Run [code-server](https://github.com/coder/code-server) inside a createos-sandbox microVM and expose a
fully-functional VS Code IDE through the sandbox's public ingress URL.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_BASE_URL and CREATEOS_SANDBOX_API_KEY
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a sandbox with `ingress_enabled: true` (`s-2vcpu-2gb`, `devbox:1`).
2. Installs code-server via the official standalone installer (`--method=standalone`) — bundles its own Node runtime, no PATH conflicts.
3. Daemonises `code-server --bind-addr 0.0.0.0:8080 --auth none` via `nohup setsid` (no systemd in `devbox:1`).
4. Waits for port 8080 to accept connections with `waitForPortReady`.
5. Polls `GET /healthz` through the public ingress URL until code-server returns `{"status":"success","data":{"up":true}}`.
6. Prints the live VS Code URL.
7. Destroys the sandbox in a `finally` block.

## createos-sandbox primitives exercised

| Primitive                          | SDK call                                      |
| ---------------------------------- | --------------------------------------------- |
| Create sandbox with public ingress | `box.createSandbox({ ingress_enabled: true })` |
| Run commands inside the VM         | `sandbox.runCommand("bash", ["-lc", ...])`    |
| Build the public preview URL       | `sandbox.previewUrl(port)`                    |
| Block until the server listens     | `sandbox.waitForPortReady(port)`              |
| Tear the sandbox down              | `sandbox.destroy()`                           |

## Versions captured at build time

See `versions.txt`.
