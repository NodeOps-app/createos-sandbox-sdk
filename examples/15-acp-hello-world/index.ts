// 15 — ACP (Agent Client Protocol) hello world.
//
// Spawns an ACP-compatible agent inside an FC sandbox and drives a single
// prompt turn over JSON-RPC 2.0. The agent is a ~100-line Python echo
// implementation of the three baseline ACP methods (initialize, session/new,
// session/prompt). A Python driver, also injected into the sandbox, spawns
// the agent as a subprocess, walks the protocol, prints every wire frame to
// stderr, and emits a structured summary on stdout. The host (this file)
// invokes the driver with `runCommand` and prints both streams.

import { readFile } from "node:fs/promises";
import { Sandbox } from "fc-sandbox-sdk";

const SHAPE = "s-1vcpu-256mb";
const ROOTFS = "devbox:1";
const PROMPT = "hello, ACP — what time is it on the agent side?";

const AGENT_PATH = "/tmp/acp_agent.py";
const DRIVER_PATH = "/tmp/acp_driver.py";

console.log(`[1/4] creating sandbox (shape=${SHAPE}, rootfs=${ROOTFS})...`);
const sandbox = await Sandbox.create({
  shape: SHAPE,
  rootfs: ROOTFS,
  name: `acp-${Date.now() % 1000000}`,
});
console.log(`      sandbox: ${sandbox.id}`);

try {
  console.log("[2/4] uploading ACP agent + driver scripts...");
  const here = new URL("./", import.meta.url).pathname;
  const [agentSrc, driverSrc] = await Promise.all([
    readFile(`${here}acp_agent.py`),
    readFile(`${here}acp_driver.py`),
  ]);
  await Promise.all([
    sandbox.files.upload(AGENT_PATH, new Uint8Array(agentSrc)),
    sandbox.files.upload(DRIVER_PATH, new Uint8Array(driverSrc)),
  ]);

  console.log("[3/4] sanity-checking python3 inside sandbox...");
  const py = await sandbox.runCommand("python3", ["--version"]);
  if (py.result.exit_code !== 0) {
    throw new Error(`python3 missing: ${py.result.stderr}`);
  }
  console.log(`      ${py.result.stdout.trim() || py.result.stderr.trim()}`);

  console.log(`[4/4] driving ACP turn — prompt: ${JSON.stringify(PROMPT)}\n`);
  const { result } = await sandbox.runCommand("python3", [DRIVER_PATH, PROMPT], {
    timeoutMs: 60_000,
  });

  if (result.stderr) {
    console.log("--- JSON-RPC wire frames (driver stderr) ---");
    process.stdout.write(result.stderr);
    console.log("--------------------------------------------\n");
  }

  if (result.exit_code !== 0) {
    throw new Error(`driver exited ${result.exit_code}`);
  }

  console.log("--- ACP turn summary (driver stdout) ---");
  process.stdout.write(result.stdout);
  console.log("----------------------------------------");

  let parsed: { assistant?: string; stopReason?: string } = {};
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // already printed raw above
  }
  if (parsed.assistant) {
    console.log(`\nagent reply: ${JSON.stringify(parsed.assistant)}`);
    console.log(`stop reason: ${parsed.stopReason}`);
  }
} finally {
  await sandbox.destroy();
  console.log(`\nsandbox destroyed: ${sandbox.id}`);
}
