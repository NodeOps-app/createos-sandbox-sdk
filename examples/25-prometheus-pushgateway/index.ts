// 25 — Prometheus Pushgateway inside an FC sandbox.
//
// Downloads the Prometheus Pushgateway binary, daemonises it on 0.0.0.0:9091
// so the FC HTTP ingress can reach it, pushes a custom metric via the
// Pushgateway's /metrics/job/<job> endpoint, then scrapes /metrics through
// the public ingress URL to verify the metric round-trips.

import { FcClient } from "fc-sandbox-sdk";

const SHAPE = "s-1vcpu-1gb";
const ROOTFS = "devbox:1";
const PORT = 9091;
const PUSHGATEWAY_VERSION = "1.11.1";

// Pushgateway listens on port 9091 by default.
// Bind 0.0.0.0 so the FC ingress proxy can forward external traffic.

const baseUrl = process.env.FCSPAWN_URL;
const apiKey = process.env.FC_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set FCSPAWN_URL and FC_API_KEY in .env (see .env.example)");
}

// The control plane currently uses a self-signed TLS certificate.
// Bun's fetch accepts `tls: { rejectUnauthorized: false }` as an undocumented
// option; wrapping globalThis.fetch here keeps the bypass scoped to SDK calls.
const fetchInsecure: typeof globalThis.fetch = (input, init?) =>
  // @ts-ignore — bun-specific tls option not in the standard fetch types
  globalThis.fetch(input, { ...init, tls: { rejectUnauthorized: false } });

const fc = new FcClient({ baseUrl, apiKey, fetch: fetchInsecure });

async function sh(
  sb: Awaited<ReturnType<typeof fc.createSandbox>>,
  label: string,
  script: string,
  timeoutMs = 120_000,
) {
  const { result, exec_ms } = await sb.runCommand("bash", ["-lc", script], { timeoutMs });
  if (result.exit_code !== 0) {
    console.log(`[${label}] exit=${result.exit_code} (${exec_ms} ms)`);
    if (result.stdout) console.log("  stdout:", result.stdout.slice(-2000));
    if (result.stderr) console.log("  stderr:", result.stderr.slice(-2000));
    throw new Error(`${label} failed (exit ${result.exit_code})`);
  }
  return result.stdout;
}

console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS}, ingress on)...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  ingress_enabled: true,
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

// Build ingress URL up-front; fails fast if ingress was not granted.
// previewUrl returns https:// but TLS wildcard cert may not be provisioned —
// use http:// which is forward-compatible once TLS lands.
const metricsUrl = sandbox.previewUrl(PORT).replace(/^https:/, "http:");
const pushUrl = `${metricsUrl}/metrics/job/fc_example_job`;
console.log(`      metrics URL : ${metricsUrl}/metrics`);
console.log(`      push URL    : ${pushUrl}`);

try {
  console.log(`[2/6] downloading prometheus/pushgateway v${PUSHGATEWAY_VERSION}...`);
  await sh(
    sandbox,
    "download",
    [
      "set -e",
      `curl -fsSL https://github.com/prometheus/pushgateway/releases/download/v${PUSHGATEWAY_VERSION}/pushgateway-${PUSHGATEWAY_VERSION}.linux-amd64.tar.gz -o /tmp/pgw.tar.gz`,
      "tar -xzf /tmp/pgw.tar.gz -C /tmp",
      `cp /tmp/pushgateway-${PUSHGATEWAY_VERSION}.linux-amd64/pushgateway /usr/local/bin/pushgateway`,
      "chmod +x /usr/local/bin/pushgateway",
      "pushgateway --version",
    ].join(" && "),
    120_000,
  );
  console.log("      binary installed");

  // Daemonise with nohup setsid — no systemd in devbox:1.
  // `;` before nohup (not `&&`) so the chain does not hold the /exec stdout
  // pipe open and hang runCommand.
  console.log(`[3/6] starting pushgateway on 0.0.0.0:${PORT} (daemonised)...`);
  await sh(
    sandbox,
    "boot",
    `nohup setsid pushgateway --web.listen-address=0.0.0.0:${PORT} >/var/log/pushgateway.log 2>&1 </dev/null &`,
  );

  console.log(`[4/6] waiting for pushgateway to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 30_000 });
  console.log("      port accepting connections");

  // Push a custom metric using the text-based Prometheus exposition format.
  // A single line is enough to prove the round-trip.
  const metricName = "fc_example_requests_total";
  const metricValue = "42";
  const payload = `# TYPE ${metricName} counter\n${metricName}{env="sandbox"} ${metricValue}\n`;

  console.log(`[5/6] pushing metric "${metricName}" = ${metricValue}...`);
  await sh(
    sandbox,
    "push",
    `printf '${payload.replace(/'/g, "'\\''")}' | curl -fsS --data-binary @- http://127.0.0.1:${PORT}/metrics/job/fc_example_job`,
  );
  console.log("      pushed successfully");

  // Scrape the public ingress endpoint.  Poll until the metric appears —
  // ingress propagation may take a moment.
  console.log("[6/6] scraping /metrics via ingress URL...");
  const scrapeEndpoint = `${metricsUrl}/metrics`;
  const deadline = Date.now() + 60_000;
  let scrapeBody = "";
  let lastStatus = 0;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(scrapeEndpoint, { signal: AbortSignal.timeout(10_000) });
      lastStatus = res.status;
      if (res.ok) {
        scrapeBody = await res.text();
        if (scrapeBody.includes(metricName)) break;
      }
    } catch {
      // ingress propagating — keep polling
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  if (!scrapeBody.includes(metricName)) {
    const log = await sh(sandbox, "pgw-log", "tail -20 /var/log/pushgateway.log");
    throw new Error(
      `Metric "${metricName}" not found in /metrics (last HTTP ${lastStatus}).\n` +
        `Pushgateway log:\n${log}`,
    );
  }

  // Extract the metric line(s) for display.
  const metricLines = scrapeBody
    .split("\n")
    .filter((l) => l.startsWith(metricName))
    .join("\n");

  console.log("\n── /metrics (scrape via ingress) ─────────────────────────────────");
  console.log(metricLines);
  console.log("──────────────────────────────────────────────────────────────────");
  console.log(`\nverified end-to-end: pushgateway v${PUSHGATEWAY_VERSION}`);
  console.log(`metric "${metricName}" pushed and scraped via ${scrapeEndpoint}`);
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
