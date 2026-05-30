# 17 — Analyze data with AI

Upload a CSV into an FC sandbox, let Claude write the pandas/matplotlib
analysis from the file's real schema, run it inside the VM, then read the
rendered chart PNG back out to the host.

This example is built around the `files` API **binary round-trip**: a text
CSV is uploaded into the sandbox and a binary PNG is downloaded back out.
That is what sets it apart from example 02's stdout-only code interpreter —
here a real artifact crosses the sandbox boundary in both directions, and the
host verifies it by checking the PNG magic bytes.

## What it does

1. Creates one `devbox:1` sandbox.
2. `files.upload`s the bundled `sample.csv` (monthly sales by region) into the
   sandbox as raw bytes.
3. Reads the CSV header + first rows and sends them to Claude, which writes a
   self-contained `analyze.py` (pandas aggregation + matplotlib chart). The
   generated code is printed to the console.
4. Installs `pandas` + `matplotlib` inside the sandbox via a detached process
   with a polled completion marker.
5. `runCommand`s the generated script. It groups the data, renders a chart,
   and writes it to `/root/output/chart.png` (matplotlib `Agg` backend).
6. `files.download`s the PNG, validates its header, and saves it to
   `./output/chart.png`. The generated script is also saved to
   `./output/analyze.py`.

The sandbox is always destroyed in a `finally` block.

## Run

```sh
bun install            # from the examples/ root
bun index.ts
```

`.env` is a symlink to the shared `examples/.env`. Set `FC_API_KEY`,
`ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` there (and optionally
`ANTHROPIC_MODEL`). `FC_BASE_URL` defaults to the production control plane.
See `.env.example` for the full list.

## Files

- `index.ts` — the whole example (host side).
- `sample.csv` — the bundled dataset (no network dependency).
- `output/` — generated `chart.png` + `analyze.py` (gitignored).
