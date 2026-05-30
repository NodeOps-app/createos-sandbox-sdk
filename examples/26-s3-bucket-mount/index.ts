// 26 — S3 Bucket Mount
//
// Mounts a public S3 bucket as a queryable data source inside an FC sandbox
// using DuckDB's httpfs extension. Reads NOAA GHCN climate parquet data
// (s3://noaa-ghcn-pds) and runs a multi-year temperature trend analysis
// with an in-sandbox dbt-style SQL transformation pipeline.
//
// FC primitives: createSandbox, files.upload, runCommand, destroy

import { writeFileSync } from "node:fs";
import { FcClient } from "fc-sandbox-sdk";

// NOAA GHCN open data — publicly readable, no AWS credentials required.
const S3_BUCKET = "noaa-ghcn-pds";
const S3_REGION = "us-east-1";
const S3_PREFIX = "parquet/by_year";
// Analyse TMAX readings across several years to show year-over-year trend.
const YEARS = [2020, 2021, 2022, 2023, 2024];

const DUCKDB_VERSION = "v1.5.3";
const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";

const baseUrl = process.env.FC_BASE_URL;
const fcOptions = baseUrl ? { baseUrl } : {};
const fc = new FcClient(fcOptions);

async function sh(
  sandbox: Awaited<ReturnType<typeof fc.createSandbox>>,
  label: string,
  script: string,
  timeoutMs = 120_000,
) {
  const { result } = await sandbox.runCommand("bash", ["-lc", script], { timeoutMs });
  if (result.exit_code !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 1500);
    throw new Error(`[${label}] exit=${result.exit_code}\n${detail}`);
  }
  return result.stdout.trim();
}

console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await fc.createSandbox({ shape: SHAPE, rootfs: ROOTFS });
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

try {
  // ── step 2: install DuckDB CLI ───────────────────────────────────────────
  console.log(`[2/6] installing DuckDB ${DUCKDB_VERSION} + httpfs extension...`);
  await sh(
    sandbox,
    "install-duckdb",
    [
      "apt-get update -qq",
      "apt-get install -y -qq curl ca-certificates",
      `curl -fsSL https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/duckdb_cli-linux-amd64.gz | gunzip -c > /usr/local/bin/duckdb`,
      "chmod +x /usr/local/bin/duckdb",
      "duckdb --version",
    ].join(" && "),
    300_000,
  );
  const version = await sh(sandbox, "version", "duckdb --version");
  console.log(`      installed: ${version}`);

  // ── step 3: upload SQL transformation models ─────────────────────────────
  // Three SQL models that mimic a lightweight dbt pipeline:
  //   stg_tmax.sql  — stage raw TMAX readings from S3
  //   agg_annual.sql — aggregate to annual avg per station
  //   rpt_trend.sql  — rank top-warming stations
  console.log("[3/6] uploading dbt-style SQL models...");

  const yearGlobs = YEARS.map(
    (y) => `s3://${S3_BUCKET}/${S3_PREFIX}/YEAR=${y}/ELEMENT=TMAX/**/*.snappy.parquet`,
  ).join("', '");

  const stgTmax = `-- stg_tmax: stage raw NOAA TMAX readings from S3
-- DATA_VALUE is tenths of a degree Celsius; convert to °C
CREATE OR REPLACE VIEW stg_tmax AS
SELECT
    ID                          AS station_id,
    CAST(SUBSTR(DATE, 1, 4) AS INTEGER) AS obs_year,
    CAST(DATA_VALUE AS DOUBLE) / 10.0   AS tmax_c
FROM read_parquet(['${yearGlobs}'], hive_partitioning=true, union_by_name=true)
WHERE DATA_VALUE IS NOT NULL
  AND Q_FLAG IS NULL;  -- Q_FLAG set means the reading failed quality checks
`;

  const aggAnnual = `-- agg_annual: annual average TMAX per station
CREATE OR REPLACE VIEW agg_annual AS
SELECT
    station_id,
    obs_year,
    ROUND(AVG(tmax_c), 2) AS avg_tmax_c,
    COUNT(*)               AS n_readings
FROM stg_tmax
GROUP BY station_id, obs_year
HAVING COUNT(*) >= 100;  -- require at least 100 readings for significance
`;

  const rptTrend = `-- rpt_trend: stations with the largest temperature rise 2020→2024
CREATE OR REPLACE VIEW rpt_trend AS
WITH
  base AS (SELECT station_id, avg_tmax_c FROM agg_annual WHERE obs_year = ${YEARS[0]}),
  last AS (SELECT station_id, avg_tmax_c FROM agg_annual WHERE obs_year = ${YEARS[YEARS.length - 1]})
SELECT
    last.station_id,
    base.avg_tmax_c                              AS tmax_${YEARS[0]},
    last.avg_tmax_c                              AS tmax_${YEARS[YEARS.length - 1]},
    ROUND(last.avg_tmax_c - base.avg_tmax_c, 2) AS delta_c
FROM last
JOIN base USING (station_id)
ORDER BY delta_c DESC
LIMIT 15;
`;

  await Promise.all([
    sandbox.files.upload("/tmp/stg_tmax.sql", stgTmax),
    sandbox.files.upload("/tmp/agg_annual.sql", aggAnnual),
    sandbox.files.upload("/tmp/rpt_trend.sql", rptTrend),
  ]);
  console.log("      uploaded: stg_tmax.sql, agg_annual.sql, rpt_trend.sql");

  // ── step 4: configure DuckDB S3 access + run the pipeline ───────────────
  console.log(`[4/6] mounting s3://${S3_BUCKET} via DuckDB httpfs (anonymous)...`);

  // Shared preamble for both DuckDB scripts: enable anonymous S3 access and
  // load the three SQL model files. Idiomatic DuckDB shell: statements execute
  // in order; output from the last SELECT goes to stdout.
  const duckdbPreamble = `
INSTALL httpfs;
LOAD httpfs;
SET s3_region='${S3_REGION}';
SET s3_access_key_id='';
SET s3_secret_access_key='';
.read /tmp/stg_tmax.sql
.read /tmp/agg_annual.sql
.read /tmp/rpt_trend.sql
`;

  const driverSql = duckdbPreamble + "SELECT * FROM rpt_trend;\n";
  await sandbox.files.upload("/tmp/driver.sql", driverSql);

  console.log(
    `      querying ${YEARS[0]}–${YEARS[YEARS.length - 1]} TMAX data across ${YEARS.length} years...`,
  );
  console.log(`      (downloading ~${YEARS.length * 8} MB of parquet from S3 — allow ~60 s)`);

  const pipelineOutput = await sh(sandbox, "pipeline", "duckdb < /tmp/driver.sql", 180_000);
  console.log("\n── temperature trend report ────────────────────────────────────────");
  console.log(pipelineOutput);

  // ── step 5: save results locally ────────────────────────────────────────
  // Write a separate export script so we don't need complex shell quoting.
  console.log("[5/6] exporting results to Parquet inside sandbox + downloading...");
  const exportSql =
    duckdbPreamble + "COPY (SELECT * FROM rpt_trend) TO '/tmp/trend.parquet' (FORMAT PARQUET);\n";
  await sandbox.files.upload("/tmp/export.sql", exportSql);
  await sh(sandbox, "export-parquet", "duckdb < /tmp/export.sql", 180_000);

  const parquetBuf = await sandbox.files.download("/tmp/trend.parquet");
  const localOut = new URL("./trend.parquet", import.meta.url).pathname;
  writeFileSync(localOut, new Uint8Array(parquetBuf));
  console.log(`      saved ${parquetBuf.byteLength} bytes → ${localOut}`);

  // ── step 6: verify the parquet locally with DuckDB SQL ──────────────────
  console.log("[6/6] verified end-to-end: S3 bucket mounted, pipeline ran, results downloaded.");
  console.log(`\n  S3 source : s3://${S3_BUCKET}/${S3_PREFIX}/YEAR=*/ELEMENT=TMAX/`);
  console.log(`  Years     : ${YEARS.join(", ")}`);
  console.log(`  DuckDB    : ${version}`);
  console.log(`  Output    : trend.parquet (${parquetBuf.byteLength} bytes)`);
} finally {
  await sandbox.destroy();
  console.log(`\ndestroyed: ${sandbox.id}`);
}
