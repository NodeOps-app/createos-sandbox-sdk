# 16 — Firecrawl scrape + analyze

Scrape a short-stay rental listings page, have Claude write a
pandas/matplotlib analysis script, run that script inside a single FC
sandbox, and pull the resulting price chart PNG back to the host.

The scrape runs on the host with plain `fetch` against the Firecrawl API;
the analysis runs in an isolated microVM. When `FIRECRAWL_API_KEY` is not
set, the example uses the bundled `sample-listings.json` so the FC sandbox /
Claude / chart path still runs end-to-end.

## Run

```sh
cp .env.example .env  # fill in values (the shared ../.env is already symlinked)
bun index.ts
```

bun auto-loads `.env` from this dir. Required: `CREATEOS_SANDBOX_API_KEY` and an Anthropic
endpoint (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`). `FIRECRAWL_API_KEY`
is optional — without it the example falls back to the bundled fixture.

## What it does

1. **Acquire listings.** With `FIRECRAWL_API_KEY` set, `POST`s the
   `SCRAPE_URL` page to Firecrawl's `/v2/scrape` for markdown, then asks
   Claude to extract structured records (title, neighborhood, room type,
   nightly price, rating, reviews, beds). Without a key, loads
   `sample-listings.json`.
2. **Generate analysis.** Asks Claude to write a Python script bound to a
   fixed contract: read `/root/listings.json`, build a pandas DataFrame,
   render a per-neighborhood mean-price bar chart with the Agg backend, and
   save it to `/root/price_chart.png`. The generated script is saved to
   `./output/analysis.py`.
3. **Spawn one `s-2vcpu-2gb` sandbox** on `devbox:1`.
4. **Install pandas + matplotlib** via `pip3` (launched detached, polled to
   completion so no single call trips a gateway timeout).
5. **Upload** the scraped JSON and the generated script, then **run** the
   analysis with `runCommand`.
6. **Download** `price_chart.png` and a text summary to `./output/` and
   destroy the sandbox.

## FC primitives exercised

| primitive                             | SDK call                                                |
| ------------------------------------- | ------------------------------------------------------- |
| Sandbox create with env injection     | `client.createSandbox({ shape, rootfs, envs })`         |
| File upload (JSON + script → sandbox) | `sandbox.files.upload(path, body)`                      |
| Buffered command                      | `sandbox.runCommand("bash", ["-lc", …], { timeoutMs })` |
| File download (chart PNG → host)      | `sandbox.files.download(path)`                          |
| Cleanup                               | `sandbox.destroy()`                                     |

## Notes

- Firecrawl runs on the host with the built-in global `fetch` — no Firecrawl
  SDK. Python deps install inside the sandbox at runtime.
- The analysis prompt pins exact input/output paths and forces the Agg
  matplotlib backend so the model-generated script renders a PNG headlessly.
- One sandbox at a time; `createSandbox` is wrapped in a back-off retry so
  the example plays nice with the shared concurrency cap.

## Versions captured at build time

See `versions.txt`.
