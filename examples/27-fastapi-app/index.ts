// 27 — FastAPI App in an FC sandbox.
// Installs FastAPI + uvicorn inside an FC microVM, uploads a small ASGI app,
// daemonises uvicorn on 0.0.0.0:8000, exposes it through the public ingress
// URL, and verifies JSON responses from two routes.

import { readFile } from "node:fs/promises";
import type { Sandbox } from "fc-sandbox-sdk";
import { FcClient } from "fc-sandbox-sdk";

const SHAPE = "s-1vcpu-1gb";
const ROOTFS = "devbox:1";
const PORT = 8000;
const APP_DIR = "/root/app";

// exactOptionalPropertyTypes: narrow env vars to strings before passing them
// to FcClient options so no possibly-undefined value lands in an optional field.
const baseUrl = process.env.FCSPAWN_URL;
const apiKey = process.env.FC_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set FCSPAWN_URL and FC_API_KEY (see .env.example)");
}

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

const appSrc = await readFile(new URL("./app.py", import.meta.url), "utf8");

console.log(`[1/6] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS}, ingress on)...`);
const sandbox = await fc.createSandbox({
  shape: SHAPE,
  rootfs: ROOTFS,
  ingress_enabled: true,
  envs: { DEBIAN_FRONTEND: "noninteractive" },
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

// Build the ingress URL before entering try so we can log it even if setup fails.
// The template yields https://<ulid>-<port>.<region>.<domain>.
// Downgrade to http:// — the wildcard TLS cert is not yet provisioned;
// http:// is forward-compatible once TLS lands.
const previewUrl = sandbox.previewUrl(PORT).replace(/^https:/, "http:");
console.log(`      preview URL: ${previewUrl}`);

try {
  console.log("[2/6] installing python3-venv (apt-get)...");
  await sh(
    sandbox,
    "apt",
    "apt-get update -qq && apt-get install -y --no-install-recommends python3-venv",
    300_000,
  );

  console.log("[3/6] creating venv + installing fastapi + uvicorn...");
  await sh(
    sandbox,
    "pip",
    "python3 -m venv /opt/venv && /opt/venv/bin/pip install --quiet fastapi uvicorn",
    300_000,
  );

  const pythonVer = (await sh(sandbox, "python-ver", "/opt/venv/bin/python --version")).trim();
  const fastapiVer = (
    await sh(sandbox, "fastapi-ver", "/opt/venv/bin/pip show fastapi | awk '/^Version/{print $2}'")
  ).trim();
  const uvicornVer = (
    await sh(sandbox, "uvicorn-ver", "/opt/venv/bin/pip show uvicorn | awk '/^Version/{print $2}'")
  ).trim();
  console.log(`      ${pythonVer}, fastapi ${fastapiVer}, uvicorn ${uvicornVer}`);

  console.log("[4/6] uploading app.py...");
  await sh(sandbox, "mkdir", `mkdir -p ${APP_DIR}`);
  await sandbox.files.upload(`${APP_DIR}/main.py`, appSrc);

  // devbox:1 has no systemd — daemonise with nohup/setsid and redirect stdio
  // so the buffered runCommand returns instead of hanging on the held pipe.
  // Bind 0.0.0.0 so the ingress proxy can reach the server (127.0.0.1 only
  // reaches through the agent tunnel).
  console.log(`[5/6] starting uvicorn on port ${PORT} (daemonised)...`);
  await sh(
    sandbox,
    "boot",
    `cd ${APP_DIR} && rm -f uvicorn.log; ` +
      `nohup setsid /opt/venv/bin/uvicorn main:app --host 0.0.0.0 --port ${PORT} ` +
      `>uvicorn.log 2>&1 </dev/null & sleep 1; echo launched`,
  );

  console.log(`[6/6] waiting for uvicorn to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 30_000 });
  console.log("      port is accepting connections");

  // Poll the ingress URL until uvicorn serves real responses.
  // Ingress routing may take a moment to propagate after waitForPortReady.
  const deadline = Date.now() + 60_000;
  let rootBody = "";
  let rootStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${previewUrl}/`, { signal: AbortSignal.timeout(10_000) });
      rootStatus = res.status;
      rootBody = await res.text();
      if (res.ok && rootBody.includes("status")) break;
    } catch {
      // ingress propagation still in flight — keep polling
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  if (!rootBody.includes("status")) {
    const log = await sh(sandbox, "log", `tail -40 ${APP_DIR}/uvicorn.log`);
    throw new Error(
      `GET / never returned a JSON body (last HTTP ${rootStatus}).\n` +
        `Body: ${rootBody.slice(0, 300)}\nuvicorn log:\n${log}`,
    );
  }

  // Verify the parametric route: GET /items/42?q=hello
  const itemUrl = `${previewUrl}/items/42?q=hello`;
  const itemRes = await fetch(itemUrl, { signal: AbortSignal.timeout(10_000) });
  const itemBody = await itemRes.text();
  let itemJson: { item_id?: number; q?: string } = {};
  try {
    itemJson = JSON.parse(itemBody);
  } catch {
    throw new Error(`GET /items/42 did not return JSON: ${itemBody.slice(0, 300)}`);
  }
  if (itemJson.item_id !== 42 || itemJson.q !== "hello") {
    throw new Error(`Unexpected /items/42 response: ${itemBody.slice(0, 300)}`);
  }

  // Capture root JSON too
  let rootJson: { status?: string; message?: string } = {};
  try {
    rootJson = JSON.parse(rootBody);
  } catch {
    // non-fatal — the status check above already passed
  }

  console.log(`\n── GET /  (HTTP ${rootStatus}) ─────────────────────────────────────`);
  console.log("  ", JSON.stringify(rootJson));
  console.log(`── GET /items/42?q=hello  (HTTP ${itemRes.status}) ──────────────────────`);
  console.log("  ", JSON.stringify(itemJson));

  console.log(
    `\nverified end-to-end: FastAPI ${fastapiVer} + uvicorn ${uvicornVer} reachable at ${previewUrl}`,
  );

  // Capture versions for versions.txt at runtime
  const region = new URL(previewUrl).hostname.split(".").slice(1, -2).join(".");
  console.log(`\n── versions (for versions.txt) ─────────────────────────────────`);
  console.log(`fc control plane: ${baseUrl} (region ${region || "eu"})`);
  console.log(`${pythonVer.toLowerCase()}`);
  console.log(`fastapi: ${fastapiVer}`);
  console.log(`uvicorn: ${uvicornVer}`);
} finally {
  console.log("\ncleanup...");
  await sandbox.destroy().catch((err) => {
    console.error("destroy failed:", err instanceof Error ? err.message : String(err));
  });
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
