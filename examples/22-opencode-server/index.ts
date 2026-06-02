/**
 * OpenCode Server in a Sandbox.
 *
 * Installs opencode-ai inside an FC microVM, runs `opencode serve` bound
 * to 0.0.0.0, exposes the HTTP API through the sandbox ingress URL, and
 * verifies the server is live by hitting GET /global/health.
 *
 * Run:   bun 22-opencode-server/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (ingress must be granted
 *        for previewUrl() to resolve), plus ANTHROPIC_AUTH_TOKEN /
 *        ANTHROPIC_BASE_URL / ANTHROPIC_MODEL — written into opencode's
 *        provider config so the in-VM server can reach an LLM.
 */

import { FcClient, FcTimeoutError, pollUntil } from "fc-sandbox-sdk";

const SHAPE = "s-2vcpu-2gb"; // opencode + npm install need real RAM
const ROOTFS = "devbox:1"; // ships Node 24 + npm
const PORT = 4096; // opencode serve default port
const APP_DIR = "/root/workspace"; // working directory for opencode

const baseUrl = process.env.FC_BASE_URL;
const apiKey = process.env.FC_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set FC_BASE_URL and FC_API_KEY (see .env.example)");
}

// The available env has ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL.
// opencode.json wires these into the anthropic provider so opencode can
// reach the LLM proxy. ANTHROPIC_AUTH_TOKEN is injected as the apiKey;
// the baseURL override routes through the corporate gateway.
const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN ?? "";
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const anthropicModel = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

const fc = new FcClient({ baseUrl, apiKey });

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

// 1. Create the sandbox with ingress enabled so the HTTP API gets a public URL.
console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS}, ingress on)...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  ingress_enabled: true,
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

// Build the ingress base URL. The template yields https://<ulid>-<port>.<region>.<domain>;
// request http:// — TLS cert is not yet provisioned, http:// is forward-compatible.
const previewUrl = sandbox.previewUrl(PORT, { scheme: "http" });
console.log(`      preview URL (port ${PORT}): ${previewUrl}`);

try {
  // 2. Write opencode's provider config into the working dir.
  console.log("[2/6] creating workspace and writing opencode config...");
  await sandbox.sh(`mkdir -p ${APP_DIR}`, { label: "mkdir" });
  await sandbox.files.upload(`${APP_DIR}/opencode.json`, opencodeConfig);

  // 3. Install the opencode CLI inside the VM.
  console.log("[3/6] installing opencode-ai (npm install -g)...");
  // devbox:1 ships Node 24 + npm; npm i -g is the most reliable install path.
  await sandbox.sh("npm install -g opencode-ai --no-audit --no-fund 2>&1", {
    label: "npm-install",
    timeoutMs: 600_000,
  });
  const version = (
    await sandbox.sh("opencode --version 2>&1 || true", { label: "opencode-version" })
  ).result.stdout.trim();
  console.log(`      opencode ${version}`);

  // devbox:1 has no systemd — daemonise with nohup/setsid and redirect stdio
  // so the buffered runCommand returns promptly. --hostname 0.0.0.0 makes the
  // server reachable through ingress (127.0.0.1 would only be reachable via
  // the agent tunnel). The `;` before nohup ensures the chain doesn't block
  // on the forked process's stdout pipe.
  // 4. Start the server as a daemon (see the nohup/hostname notes above).
  console.log(`[4/6] starting opencode serve on port ${PORT} (daemonised)...`);
  await sandbox.sh(
    `cd ${APP_DIR} && rm -f opencode.log; ` +
      `nohup setsid opencode serve --hostname 0.0.0.0 --port ${PORT} ` +
      `>opencode.log 2>&1 </dev/null & sleep 1; echo launched`,
    { label: "serve" },
  );

  // 5. Wait for the in-VM port before reaching it over ingress.
  console.log(`[5/6] waiting for opencode serve to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 60_000 });
  console.log("      port is accepting connections");

  // 6. Verify the server over the public ingress URL.
  // Poll the health endpoint through the ingress URL until the server responds
  // with valid JSON containing { healthy: true }. Ingress routing propagation
  // and opencode startup can take a moment, so poll with a deadline.
  console.log("[6/6] polling GET /global/health through ingress until healthy...");
  let lastBody = "";
  let lastStatus = 0;
  try {
    const health = await pollUntil<{ healthy?: boolean; version?: string } | undefined>({
      poll: async () => {
        try {
          const res = await fetch(`${previewUrl}/global/health`, {
            signal: AbortSignal.timeout(10_000),
          });
          lastStatus = res.status;
          lastBody = await res.text();
          if (res.ok) {
            return JSON.parse(lastBody) as { healthy?: boolean; version?: string };
          }
        } catch {
          // ingress propagation or server still starting — keep polling
        }
        return undefined;
      },
      done: (json) => json?.healthy === true,
      timeoutMs: 120_000,
    });
    console.log(`\n── /global/health (HTTP ${lastStatus}) ─────────────────────────`);
    console.log(`  healthy: ${health?.healthy}`);
    console.log(`  version: ${health?.version ?? "(not reported)"}`);
    console.log(`  body:    ${lastBody.trim()}`);
  } catch (err) {
    if (!(err instanceof FcTimeoutError)) throw err;
    const log = await sandbox
      .sh(`tail -60 ${APP_DIR}/opencode.log`, { label: "opencode-log" })
      .then((r) => r.result.stdout)
      .catch(() => "(log unavailable)");
    throw new Error(
      `opencode health endpoint never returned { healthy: true } ` +
        `(last HTTP ${lastStatus}). Body: ${lastBody.slice(0, 300)}\n` +
        `Server log:\n${log}`,
      { cause: err },
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
