/**
 * Prometheus Pushgateway inside an FC sandbox.
 *
 * Downloads the Prometheus Pushgateway binary, daemonises it on 0.0.0.0:9091
 * so the FC HTTP ingress can reach it, pushes a custom metric via the
 * Pushgateway's /metrics/job/<job> endpoint, then scrapes /metrics through
 * the public ingress URL to verify the metric round-trips.
 *
 * Run:   bun 25-prometheus-pushgateway/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY. Ingress must be granted
 *        for previewUrl() to resolve. No external services — the binary is
 *        fetched from GitHub releases at runtime.
 */

import {
  CreateosSandboxClient,
  CreateosSandboxTimeoutError,
  pollUntil,
} from "createos-sandbox-sdk";

const SHAPE = "s-1vcpu-1gb";
const ROOTFS = "devbox:1";
const PORT = 9091;
const PUSHGATEWAY_VERSION = "1.11.1";

// Pushgateway listens on port 9091 by default.
// Bind 0.0.0.0 so the FC ingress proxy can forward external traffic.

const baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL;
const apiKey = process.env.CREATEOS_SANDBOX_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error(
    "set CREATEOS_SANDBOX_BASE_URL and CREATEOS_SANDBOX_API_KEY in .env (see .env.example)",
  );
}

const fc = new CreateosSandboxClient({ baseUrl, apiKey });

// 1. Create the sandbox with ingress enabled so the scrape endpoint is public.
console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS}, ingress on)...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  ingress_enabled: true,
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

// Build ingress URL up-front; fails fast if ingress was not granted.
// previewUrl returns https:// but TLS wildcard cert may not be provisioned —
// request http:// which is forward-compatible once TLS lands.
const metricsUrl = sandbox.previewUrl(PORT, { scheme: "http" });
const pushUrl = `${metricsUrl}/metrics/job/fc_example_job`;
console.log(`      metrics URL : ${metricsUrl}/metrics`);
console.log(`      push URL    : ${pushUrl}`);

try {
  // 2. Fetch + install the Pushgateway binary into the VM.
  console.log(`[2/6] downloading prometheus/pushgateway v${PUSHGATEWAY_VERSION}...`);
  await sandbox.sh(
    [
      "set -e",
      `curl -fsSL https://github.com/prometheus/pushgateway/releases/download/v${PUSHGATEWAY_VERSION}/pushgateway-${PUSHGATEWAY_VERSION}.linux-amd64.tar.gz -o /tmp/pgw.tar.gz`,
      "tar -xzf /tmp/pgw.tar.gz -C /tmp",
      `cp /tmp/pushgateway-${PUSHGATEWAY_VERSION}.linux-amd64/pushgateway /usr/local/bin/pushgateway`,
      "chmod +x /usr/local/bin/pushgateway",
      "pushgateway --version",
    ].join(" && "),
    { label: "download", timeoutMs: 120_000 },
  );
  console.log("      binary installed");

  // 3. Start the Pushgateway as a daemon.
  // Daemonise with nohup setsid — no systemd in devbox:1.
  // `;` before nohup (not `&&`) so the chain does not hold the /exec stdout
  // pipe open and hang runCommand.
  console.log(`[3/6] starting pushgateway on 0.0.0.0:${PORT} (daemonised)...`);
  await sandbox.sh(
    `nohup setsid pushgateway --web.listen-address=0.0.0.0:${PORT} >/var/log/pushgateway.log 2>&1 </dev/null &`,
    { label: "boot" },
  );

  // 4. Wait for the port before pushing/scraping.
  console.log(`[4/6] waiting for pushgateway to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 30_000 });
  console.log("      port accepting connections");

  // 5. Push a metric from inside the VM (curl to 127.0.0.1), then scrape it
  //    back from outside over ingress — proving both paths reach the same process.
  // Push a custom metric using the text-based Prometheus exposition format.
  // A single line is enough to prove the round-trip.
  const metricName = "fc_example_requests_total";
  const metricValue = "42";
  const payload = `# TYPE ${metricName} counter\n${metricName}{env="sandbox"} ${metricValue}\n`;

  console.log(`[5/6] pushing metric "${metricName}" = ${metricValue}...`);
  await sandbox.sh(
    `printf '${payload.replace(/'/g, "'\\''")}' | curl -fsS --data-binary @- http://127.0.0.1:${PORT}/metrics/job/fc_example_job`,
    { label: "push" },
  );
  console.log("      pushed successfully");

  // 6. Verify the round-trip by scraping over the public ingress URL.
  // Scrape the public ingress endpoint.  Poll until the metric appears —
  // ingress propagation may take a moment.
  console.log("[6/6] scraping /metrics via ingress URL...");
  const scrapeEndpoint = `${metricsUrl}/metrics`;
  let scrapeBody = "";
  let lastStatus = 0;

  try {
    await pollUntil({
      poll: async () => {
        try {
          const res = await fetch(scrapeEndpoint, { signal: AbortSignal.timeout(10_000) });
          lastStatus = res.status;
          if (res.ok) {
            scrapeBody = await res.text();
            return scrapeBody.includes(metricName);
          }
        } catch {
          // ingress propagating — keep polling
        }
        return false;
      },
      done: (found) => found,
      timeoutMs: 60_000,
    });
  } catch (err) {
    if (!(err instanceof CreateosSandboxTimeoutError)) throw err;
    const log = (await sandbox.sh("tail -20 /var/log/pushgateway.log", { label: "pgw-log" })).result
      .stdout;
    throw new Error(
      `Metric "${metricName}" not found in /metrics (last HTTP ${lastStatus}).\n` +
        `Pushgateway log:\n${log}`,
      { cause: err },
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
