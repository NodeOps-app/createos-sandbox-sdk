# 43 — Crawl4AI Web Crawler

Run [Crawl4AI](https://github.com/unclecode/crawl4ai) with a headless Chromium
browser inside a createos-sandbox VM to crawl a public URL and produce clean Markdown,
then download the output to the host.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY
# optionally set CRAWL_URL (defaults to https://example.com)
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a sandbox (`s-4vcpu-4gb`, `devbox:1`) — 4 GB RAM gives Chromium
   and the Crawl4AI runtime comfortable headroom during install and crawl.
2. Installs `python3`, `pip`, `npm`, and Crawl4AI (via pip into a venv at
   `/opt/crawl4ai-venv`).
3. Runs `playwright install --with-deps chromium` from the venv to download the
   Chromium binary and all OS-level dependencies (fonts, NSS, libglib, etc.)
   via apt in one step.
4. Uploads `crawl.py` — a small async script that opens a headless Chromium
   browser with `--no-sandbox` (required as root inside the VM) and
   `--disable-dev-shm-usage`, then calls `crawler.arun(url)` to produce Markdown.
5. Runs the crawler against `CRAWL_URL` and captures the Markdown output to
   `/tmp/crawl_output.md` inside the sandbox.
6. Downloads the output file via `sandbox.files.download` and saves it as
   `crawl_output.md` in the current directory.
7. Destroys the sandbox in a `finally` block.

## createos-sandbox primitives exercised

| Primitive                          | SDK call                                    |
| ---------------------------------- | ------------------------------------------- |
| Create sandbox with env injection  | `box.createSandbox({ shape, rootfs, envs })` |
| Run buffered shell commands        | `sandbox.sh(script, { timeoutMs })`         |
| Upload script into the VM          | `sandbox.files.upload(path, contents)`      |
| Download file from the VM          | `sandbox.files.download(path)`              |
| Tear the sandbox down              | `sandbox.destroy()`                         |

## Versions captured at build time

See `versions.txt`.
