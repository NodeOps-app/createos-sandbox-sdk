# 29 — Playwright Headless Browser

Run a Playwright + Chromium headless browser inside an FC microVM, scrape a
public web page, and extract structured content via the DOM.

## Run

```sh
cp .env.example .env
# fill in FC_BASE_URL + FC_API_KEY
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a sandbox (`s-2vcpu-2gb`, `devbox:1`) — 2 GB RAM gives Chromium
   comfortable headroom alongside the system deps that Playwright pulls.
2. Initialises a local npm project inside the VM (`/app`) and installs
   `playwright` via npm.
3. Runs `npx playwright install --with-deps chromium` to download the
   Chromium binary and all OS-level dependencies (fonts, NSS, libglib, etc.)
   via apt in one step.
4. Uploads `scrape.js` into the VM via `sandbox.files.upload` — a small Node
   script that opens a Chromium browser with `--no-sandbox` (required as root)
   and `--disable-dev-shm-usage`.
5. Navigates to `https://example.com`, extracts the page title, `<h1>`, first
   `<p>`, and link count via `page.evaluate()`, and prints JSON to stdout.
6. Downloads and validates the JSON output on the host.
7. Destroys the sandbox in a `finally` block.

## FC primitives exercised

| Primitive                      | SDK call                                    |
| ------------------------------ | ------------------------------------------- |
| Create sandbox                 | `fc.createSandbox({ shape, rootfs, envs })` |
| Upload script into the VM      | `sandbox.files.upload(path, contents)`      |
| Run commands (install, scrape) | `sandbox.runCommand("bash", ["-lc", ...])`  |
| Tear the sandbox down          | `sandbox.destroy()`                         |

## Versions captured at build time

See `versions.txt`.
