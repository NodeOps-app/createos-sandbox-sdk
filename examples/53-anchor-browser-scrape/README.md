# 53 - OpenAI Tool Agent + Anchor Browser Scrape

Run an OpenAI-compatible tool-calling agent on the host, give it a
CreateOS-backed browser tool, and have that tool use Anchor Browser from inside
a createos-sandbox VM to scrape a public page with a managed browser.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_BASE_URL, CREATEOS_SANDBOX_API_KEY,
# and OPENAI_API_KEY. ANCHOR_API_KEY is optional.
bun index.ts
```

`bun` auto-loads `.env` from the current directory. The script also fills
missing values from `../.env`, which is convenient when sharing credentials
across examples.

## What it does

1. Uses `ANCHOR_API_KEY` when present. If it is missing, calls Anchor Agent
   Access, asks OpenAI to solve the challenge, and exchanges the answer for a
   limited trial Anchor key.
2. Creates a sandbox (`s-1vcpu-1gb`, `devbox:1`).
3. Injects `ANCHOR_API_KEY` and `ANCHORBROWSER_API_KEY` into the sandbox. The
   second name matches what the raw Anchor SDK reads when no explicit auth
   callback is configured.
4. Initializes a small Node project in `/app` and installs `anchorbrowser`.
5. Uploads `anchor-scrape.mjs`, a script that calls Anchor's `agentTask()` with
   a scraping prompt.
6. Starts an OpenAI-compatible tool-calling agent with a `scrape_with_anchor`
   tool.
7. The OpenAI agent decides to call the tool; the tool runs
   `anchor-scrape.mjs` inside the sandbox.
8. The agent summarizes the Anchor result.
9. Destroys the sandbox in a `finally` block.

## createos-sandbox primitives exercised

| Primitive                         | SDK call                                     |
| --------------------------------- | -------------------------------------------- |
| Create sandbox with env injection | `box.createSandbox({ shape, rootfs, envs })` |
| Run buffered shell commands       | `sandbox.sh(script, { timeoutMs })`          |
| Upload script into the VM         | `sandbox.files.upload(path, contents)`       |
| Tear the sandbox down             | `sandbox.destroy()`                          |

## Notes

This example needs an OpenAI API key. Bring your own `ANCHOR_API_KEY` for normal
usage, or omit it to use Anchor Agent Access for a limited trial key. It is
excluded from CI because it calls external services.
