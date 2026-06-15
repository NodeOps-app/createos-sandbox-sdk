# 21 — Astro in a Sandbox

Scaffold a minimal Astro site inside a createos-sandbox microVM, install its dependencies,
run `astro dev`, and reach the dev server through the sandbox's public ingress
URL — then fetch that URL from the host and confirm Astro rendered the page.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a sandbox with `ingress_enabled: true` (`s-2vcpu-2gb`, `devbox:1`).
2. Uploads a hand-written Astro project (`package.json`, `astro.config.mjs`,
   `src/pages/index.astro`) into the VM.
3. Runs `npm install` inside the sandbox and captures the resolved Astro version.
4. Daemonises `astro dev --host 0.0.0.0` via `nohup setsid` (no systemd in
   `devbox:1`), binding `0.0.0.0` so ingress can reach it.
5. Waits for the dev server to bind its port with `waitForPortReady`.
6. Polls the public ingress URL until Astro returns the rendered HTML, then
   asserts the page's marker is present.
7. Destroys the sandbox in a `finally` block.

The Astro config sets `vite.server.allowedHosts: true` — Vite's dev server
otherwise rejects the non-local ingress Host header.

## createos-sandbox primitives exercised

| Primitive                          | SDK call                                      |
| ---------------------------------- | --------------------------------------------- |
| Create sandbox with public ingress | `box.createSandbox({ ingress_enabled: true })` |
| Upload project files into the VM   | `sandbox.files.upload(path, contents)`        |
| Run commands (install, daemonise)  | `sandbox.runCommand("bash", ["-lc", ...])`    |
| Build the public preview URL       | `sandbox.previewUrl(port)`                    |
| Block until the dev server listens | `sandbox.waitForPortReady(port)`              |
| Tear the sandbox down              | `sandbox.destroy()`                           |

## Versions captured at build time

See `versions.txt`.
