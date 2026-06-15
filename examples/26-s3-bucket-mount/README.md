# 26 — S3 Bucket Mount

Mount a public S3 bucket as a queryable data source inside a createos-sandbox sandbox using
DuckDB's `httpfs` extension, then run a multi-year climate analysis pipeline
modelled after a dbt transformation workflow.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_API_KEY (and CREATEOS_SANDBOX_BASE_URL if not using the default control plane)
bun index.ts
```

Expected runtime: ~3 minutes (dominated by downloading ~40 MB of Parquet from S3).

## What it does

1. Creates a `s-2vcpu-2gb` createos-sandbox sandbox (`devbox:1`).
2. Installs DuckDB v1.5.3 from the official GitHub release.
3. Uploads three SQL models to the sandbox — a lightweight dbt-style pipeline:
   - `stg_tmax.sql` — stages raw TMAX readings from `s3://noaa-ghcn-pds` across
     5 years of Hive-partitioned Parquet (no AWS credentials required — NOAA data
     is public and DuckDB uses anonymous S3 access via `httpfs`).
   - `agg_annual.sql` — aggregates to annual average maximum temperature per station.
   - `rpt_trend.sql` — ranks the 15 stations with the largest temperature rise
     from 2020 to 2024.
4. Runs the full pipeline inside the sandbox and prints the trend report to stdout.
5. Exports the results to `/tmp/trend.parquet` inside the sandbox and downloads
   it locally as `trend.parquet`.
6. Destroys the sandbox in the `finally` block.

## createos-sandbox primitives exercised

| Primitive         | SDK call                                   |
| ----------------- | ------------------------------------------ |
| Sandbox lifecycle | `box.createSandbox()` / `sandbox.destroy()` |
| Shell commands    | `sandbox.runCommand("bash", ["-lc", ...])` |
| File upload       | `sandbox.files.upload(path, content)`      |
| File download     | `sandbox.files.download(path)`             |

## Versions captured at build time

See `versions.txt`.
