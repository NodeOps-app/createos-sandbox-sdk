/**
 * FastAPI App in an FC sandbox.
 *
 * Installs FastAPI + uvicorn inside an FC microVM, uploads a small ASGI app,
 * daemonises uvicorn on 0.0.0.0:8000, exposes it through the public ingress
 * URL, and verifies JSON responses from two routes.
 *
 * Run:   bun 27-fastapi-app/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY. The control plane must
 *        grant ingress for previewUrl() to resolve.
 */

import { readFile } from "node:fs/promises";
import {
  CreateosSandboxClient,
  CreateosSandboxTimeoutError,
  pollUntil,
} from "createos-sandbox-sdk";

const SHAPE = "s-1vcpu-1gb";
const ROOTFS = "devbox:1";
const PORT = 8000;
const APP_DIR = "/root/app";

// exactOptionalPropertyTypes: narrow env vars to strings before passing them
// to CreateosSandboxClient options so no possibly-undefined value lands in an optional field.
const baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL;
const apiKey = process.env.CREATEOS_SANDBOX_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error("set CREATEOS_SANDBOX_BASE_URL and CREATEOS_SANDBOX_API_KEY (see .env.example)");
}

const fc = new CreateosSandboxClient({ baseUrl, apiKey });

// The ASGI app lives in ./app.py (committed beside this example); we read it
// here and upload it into the sandbox below.
const appSrc = await readFile(new URL("./app.py", import.meta.url), "utf8");

// 1. Create the sandbox with ingress enabled so uvicorn gets a public URL.
//    DEBIAN_FRONTEND=noninteractive keeps the apt-get install below from prompting.
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
// Request http:// — the wildcard TLS cert is not yet provisioned;
// http:// is forward-compatible once TLS lands.
const previewUrl = sandbox.previewUrl(PORT, { scheme: "http" });
console.log(`      preview URL: ${previewUrl}`);

try {
  // 2. Install python3-venv (devbox:1 ships Python but not the venv module).
  console.log("[2/6] installing python3-venv (apt-get)...");
  await sandbox.sh(
    "apt-get update -qq && apt-get install -y --no-install-recommends python3-venv",
    { label: "apt", timeoutMs: 300_000 },
  );

  // 3. Create a venv and install the app's deps into it.
  console.log("[3/6] creating venv + installing fastapi + uvicorn...");
  await sandbox.sh(
    "python3 -m venv /opt/venv && /opt/venv/bin/pip install --quiet fastapi uvicorn",
    { label: "pip", timeoutMs: 300_000 },
  );

  const pythonVer = (
    await sandbox.sh("/opt/venv/bin/python --version", { label: "python-ver" })
  ).result.stdout.trim();
  const fastapiVer = (
    await sandbox.sh("/opt/venv/bin/pip show fastapi | awk '/^Version/{print $2}'", {
      label: "fastapi-ver",
    })
  ).result.stdout.trim();
  const uvicornVer = (
    await sandbox.sh("/opt/venv/bin/pip show uvicorn | awk '/^Version/{print $2}'", {
      label: "uvicorn-ver",
    })
  ).result.stdout.trim();
  console.log(`      ${pythonVer}, fastapi ${fastapiVer}, uvicorn ${uvicornVer}`);

  // 4. Upload the app as main.py so uvicorn's `main:app` import target resolves.
  console.log("[4/6] uploading app.py...");
  await sandbox.sh(`mkdir -p ${APP_DIR}`, { label: "mkdir" });
  await sandbox.files.upload(`${APP_DIR}/main.py`, appSrc);

  // 5. Start uvicorn as a daemon.
  // devbox:1 has no systemd — daemonise with nohup/setsid and redirect stdio
  // so the buffered runCommand returns instead of hanging on the held pipe.
  // Bind 0.0.0.0 so the ingress proxy can reach the server (127.0.0.1 only
  // reaches through the agent tunnel).
  console.log(`[5/6] starting uvicorn on port ${PORT} (daemonised)...`);
  await sandbox.sh(
    `cd ${APP_DIR} && rm -f uvicorn.log; ` +
      `nohup setsid /opt/venv/bin/uvicorn main:app --host 0.0.0.0 --port ${PORT} ` +
      `>uvicorn.log 2>&1 </dev/null & sleep 1; echo launched`,
    { label: "boot" },
  );

  // 6. Wait for the port, then verify both routes over the public ingress URL.
  console.log(`[6/6] waiting for uvicorn to bind port ${PORT}...`);
  await sandbox.waitForPortReady(PORT, { timeoutMs: 30_000 });
  console.log("      port is accepting connections");

  // Poll the ingress URL until uvicorn serves real responses.
  // Ingress routing may take a moment to propagate after waitForPortReady.
  let rootBody = "";
  let rootStatus = 0;
  try {
    await pollUntil({
      poll: async () => {
        try {
          const res = await fetch(`${previewUrl}/`, { signal: AbortSignal.timeout(10_000) });
          rootStatus = res.status;
          rootBody = await res.text();
          return res.ok && rootBody.includes("status");
        } catch {
          // ingress propagation still in flight — keep polling
          return false;
        }
      },
      done: (ready) => ready,
      timeoutMs: 60_000,
    });
  } catch (err) {
    if (!(err instanceof CreateosSandboxTimeoutError)) throw err;
    const log = (await sandbox.sh(`tail -40 ${APP_DIR}/uvicorn.log`, { label: "log" })).result
      .stdout;
    throw new Error(
      `GET / never returned a JSON body (last HTTP ${rootStatus}).\n` +
        `Body: ${rootBody.slice(0, 300)}\nuvicorn log:\n${log}`,
      { cause: err },
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
