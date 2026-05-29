// 22 — OpenCode Server in a Sandbox.
// Installs opencode-ai inside an FC microVM, runs `opencode serve` bound
// to 0.0.0.0, exposes the HTTP API through the sandbox ingress URL, and
// verifies the server is live by hitting GET /global/health.

import type { Sandbox } from "fc-sandbox-sdk";
import { FcClient } from "fc-sandbox-sdk";

const SHAPE = "s-2vcpu-2gb"; // opencode + npm install need real RAM
const ROOTFS = "devbox:1"; // ships Node 24 + npm
const PORT = 4096; // opencode serve default port
const APP_DIR = "/root/workspace"; // working directory for opencode

// Bridge FCSPAWN_URL -> baseUrl (env uses FCSPAWN_URL, SDK uses baseUrl)
const baseUrl = process.env.FCSPAWN_URL;
const apiKey = process.env.FC_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set FCSPAWN_URL and FC_API_KEY (see .env.example)");
}

// The available env has ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL.
// opencode.json wires these into the anthropic provider so opencode can
// reach the LLM proxy. ANTHROPIC_AUTH_TOKEN is injected as the apiKey;
// the baseURL override routes through the corporate gateway.
const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN ?? "";
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const anthropicModel = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

const fc = new FcClient({ baseUrl, apiKey });

async function sh(sb: Sandbox, label: string, script: string, timeoutMs = 120_000) {
  const { result, exec_ms } = await sb.runCommand("bash", ["-lc", script], { timeoutMs });
  if (result.exit_code !== 0) {
    console.log(`[${label}] exit=${result.exit_code} (${exec_ms} ms)`);
    if (result.stdout) console.log("  stdout:", result.stdout.slice(-2000));
    if (result.stderr) console.log("  stderr:", result.stderr.slice(-2000));
    throw new Error(`${label} failed (exit ${result.exit_code})`);
  }
  return result.stdout;
}

// opencode.json configures the Anthropic provider with API key + base URL.
// The {env:...} interpolation is resolved by opencode at startup from the
// sandbox's inherited env. We also write it to APP_DIR so opencode picks
// it up as the project config when the working directory is APP_DIR.
const opencodeConfig = JSON.stringify(
  {
    $schema: "https://opencode.ai/config.json",
    model: `anthropic/${anthropicModel}`,
    provider: {
      anthropic: {
        options: {
          apiKey: anthropicAuthToken,
          baseURL: `${anthropicBaseUrl.replace(/\/$/, "")}/v1`,
        },
      },
    },
  },
  null,
  2,
);

console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS}, ingress on)...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  ingress_enabled: true,
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

// Build the ingress base URL. The template yields https://<ulid>-<port>.<region>.<domain>;
// downgrade to http:// — TLS cert is not yet provisioned, http:// is forward-compatible.
const previewUrl = sandbox.previewUrl(PORT).replace(/^https:/, "http:");
console.log(`      preview URL (port ${PORT}): ${previewUrl}`);

try {
  console.log("[2/6] creating workspace and writing opencode config...");
  await sh(sandbox, "mkdir", `mkdir -p ${APP_DIR}`);
  await sandbox.files.upload(`${APP_DIR}/opencode.json`, opencodeConfig);

  console.log("[3/6] installing opencode-ai (npm install -g)...");
  // devbox:1 ships Node 24 + npm; npm i -g is the most reliable install path.
  await sh(sandbox, "npm-install", "npm install -g opencode-ai --no-audit --no-fund 2>&1", 600_000);
  const version = (await sh(sandbox, "opencode-version", "opencode --version 2>&1 || true")).trim();
  console.log(`      opencode ${version}`);

  // devbox:1 has no systemd — daemonise with nohup/setsid and redirect stdio
  // so the buffered runCommand returns promptly. --hostname 0.0.0.0 makes the
  // server reachable through ingress (127.0.0.1 would only be reachable via
  // the agent tunnel). The `;` before nohup ensures the chain doesn't block
  // on the forked process's stdout pipe.
  console.log(`[4/6] starting opencode serve on port ${PORT} (daemonised)...`);
  await sh(
    sandbox,
    "serve",
    `cd ${APP_DIR} && rm -f opencode.log; ` +
      `nohup setsid opencode serve --hostname 0.0.0.0 --port ${PORT} ` +
      `>opencode.log 2>&1 </dev/null & sleep 1; echo launched`,
  );

  console.log(`[5/6] waiting for opencode serve to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 60_000 });
  console.log("      port is accepting connections");

  // Poll the health endpoint through the ingress URL until the server responds
  // with valid JSON containing { healthy: true }. Ingress routing propagation
  // and opencode startup can take a moment, so poll with a deadline.
  console.log("[6/6] polling GET /global/health through ingress until healthy...");
  const deadline = Date.now() + 120_000;
  let healthy = false;
  let lastBody = "";
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${previewUrl}/global/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      lastStatus = res.status;
      lastBody = await res.text();
      if (res.ok) {
        const json = JSON.parse(lastBody) as { healthy?: boolean; version?: string };
        if (json.healthy === true) {
          healthy = true;
          console.log(`\n── /global/health (HTTP ${lastStatus}) ─────────────────────────`);
          console.log(`  healthy: ${json.healthy}`);
          console.log(`  version: ${json.version ?? "(not reported)"}`);
          console.log(`  body:    ${lastBody.trim()}`);
          break;
        }
      }
    } catch {
      // ingress propagation or server still starting — keep polling
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  if (!healthy) {
    const log = await sh(sandbox, "opencode-log", `tail -60 ${APP_DIR}/opencode.log`).catch(
      () => "(log unavailable)",
    );
    throw new Error(
      `opencode health endpoint never returned { healthy: true } ` +
        `(last HTTP ${lastStatus}). Body: ${lastBody.slice(0, 300)}\n` +
        `Server log:\n${log}`,
    );
  }

  // Also verify the providers endpoint to confirm the Anthropic config landed.
  const provRes = await fetch(`${previewUrl}/provider`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (provRes.ok) {
    const provJson = (await provRes.json()) as {
      connected?: string[];
      all?: unknown[];
      default?: unknown;
    };
    console.log(`\n── /provider (HTTP ${provRes.status}) ──────────────────────────────`);
    console.log(`  connected providers: ${JSON.stringify(provJson.connected ?? [])}`);
  }

  console.log(`\nverified end-to-end: opencode ${version} server healthy at ${previewUrl}`);
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
