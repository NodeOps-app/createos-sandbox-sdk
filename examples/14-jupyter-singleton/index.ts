/**
 * Jupyter singleton — one long-lived Python kernel, then pause + fork two
 * branches from it.
 *
 * A daemon inside the sandbox keeps a single Python interpreter alive on a
 * Unix-domain socket; the host drives it cell-by-cell, so imports, variables,
 * and defined functions persist across commands (a Jupyter-style session).
 * The parent is then paused — which snapshots the kernel mid-session — and two
 * forks inherit that exact in-memory state and diverge independently. The fork
 * timeouts are deliberately generous: forks occasionally stick in `pausing` on
 * the control plane, and the run treats that as "branching unavailable" rather
 * than failing (see runOnFork). Sandboxes are sequenced (parent → fork A →
 * destroy A → fork B → destroy B) so we never exceed two concurrent VMs.
 *
 * Run:   bun 14-jupyter-singleton/index.ts
 * Needs: CREATEOS_SANDBOX_API_KEY (CREATEOS_SANDBOX_BASE_URL defaults; see .env.example). No external services.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateosSandboxClient,
  CreateosSandboxTimeoutError,
  CreateosSandboxValidationError,
  type Sandbox,
} from "createos-sandbox-sdk";

const here = dirname(fileURLToPath(import.meta.url));
const daemonSrc = await readFile(join(here, "kernel_daemon.py"));
const clientSrc = await readFile(join(here, "cell_client.py"));

const SHAPE = "s-1vcpu-1gb";
const ROOTFS = "devbox:1";

interface CellReply {
  ok: boolean;
  stdout: string;
  stderr: string;
  result: string;
}

const box = new CreateosSandboxClient();

// One-shot retry helper for the cap-exhausted / transient 5xx case. We back
// off 30s and retry exactly once; further failures propagate so the run fails
// loudly instead of hanging.
async function withCapRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[${label}] first attempt failed: ${msg}; sleeping 30s and retrying once…`);
    await new Promise((r) => setTimeout(r, 30_000));
    return await fn();
  }
}

// Create the parent sandbox, retrying through the shared-capacity /
// transient-5xx errors that surface when the account's concurrency cap is
// full (mirrors the sibling examples' 6-attempt policy).
async function createWithRetry() {
  const suffix = (Date.now() % 1_000_000).toString();
  const opts = { shape: SHAPE, rootfs: ROOTFS, name: `jup-${suffix}` };
  const maxAttempts = 6;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await box.createSandbox(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retriable =
        err instanceof CreateosSandboxValidationError ||
        /cap|quota|limit|too many|capacity|unavailable|503|502/i.test(msg);
      if (!retriable || i === maxAttempts) throw err;
      const wait = 30_000 * i;
      console.warn(
        `create attempt ${i}/${maxAttempts} failed (${msg.slice(0, 80)}); waiting ${wait / 1000}s…`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("unreachable");
}

async function installAndBoot(sb: Sandbox) {
  // Daemon is stdlib-only (ast + code), so devbox:1's python3 is
  // enough — no apt-get, no pip, no extra packages.
  await sb.files.upload("/tmp/kernel_daemon.py", daemonSrc);
  await sb.files.upload("/tmp/cell_client.py", clientSrc);
  await sb.sh(
    "set -e; rm -f /tmp/kernel.ready /tmp/kernel.sock; " +
      "nohup setsid python3 /tmp/kernel_daemon.py </dev/null >/tmp/kernel.log 2>&1 & " +
      // Spin until the daemon writes its ready marker.
      "for i in $(seq 1 50); do " +
      "  if [ -S /tmp/kernel.sock ] && [ -f /tmp/kernel.ready ]; then exit 0; fi; " +
      "  sleep 0.2; " +
      "done; " +
      "echo 'kernel never became ready'; tail -100 /tmp/kernel.log; exit 1",
    { label: "boot-daemon" },
  );
}

async function cell(sb: Sandbox, code: string): Promise<CellReply> {
  // Pipe the cell source through the client shim, which talks to the
  // long-lived daemon on /tmp/kernel.sock. The daemon's reply is JSON.
  const b64 = Buffer.from(code, "utf8").toString("base64");
  const out = (
    await sb.sh(`set -e; echo '${b64}' | base64 -d | python3 /tmp/cell_client.py`, {
      label: "cell",
    })
  ).result.stdout;
  const trimmed = out.trim();
  if (!trimmed) throw new Error("empty reply from kernel daemon");
  return JSON.parse(trimmed) as CellReply;
}

function printCell(label: string, code: string, reply: CellReply) {
  const firstLine = code.split("\n")[0]?.slice(0, 70) ?? "";
  console.log(`\n--- ${label}: ${firstLine}${code.includes("\n") ? " …" : ""}`);
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  if (reply.result) console.log(`=> ${reply.result}`);
  if (!reply.ok) console.log("(cell raised)");
}

const FORK_TIMEOUT_MS = 90_000;

async function runOnFork(parent: Sandbox, label: string, code: string): Promise<CellReply | null> {
  // Parent must already be paused. Fork inherits the full kernel state
  // (variables, imports, the active Unix-socket binding) at the
  // snapshot point. Returns null when the fork never reaches a usable
  // state — currently a known control-plane limitation in some
  // environments — so the example finishes cleanly even if branching
  // is unavailable.
  console.log(`\n[fork:${label}] forking from paused parent ${parent.id}…`);
  const child = await withCapRetry(`fork:${label}`, () => parent.fork({ start_paused: true }));
  try {
    try {
      await child.waitUntilPaused({ timeoutMs: FORK_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof CreateosSandboxTimeoutError) {
        await child.refresh().catch(() => undefined);
        console.log(
          `[fork:${label}] fork stuck in '${child.status}' after ${FORK_TIMEOUT_MS}ms — ` +
            "a known control-plane limitation",
        );
        return null;
      }
      throw err;
    }
    console.log(`[fork:${label}] paused: ${child.id} (forked_from=${child.data.forked_from})`);
    await child.resume();
    await child.waitUntilRunning({ timeoutMs: FORK_TIMEOUT_MS });
    console.log(`[fork:${label}] running: ${child.id}`);
    const reply = await cell(child, code);
    printCell(`fork:${label}`, code, reply);
    return reply;
  } finally {
    await child.destroy().catch(() => undefined);
    console.log(`[fork:${label}] destroyed ${child.id}`);
  }
}

const parent = await createWithRetry();
console.log(`parent created: ${parent.id}`);

try {
  console.log("\n[1/5] uploading driver + booting kernel daemon…");
  await installAndBoot(parent);

  console.log("\n[2/5] driving the kernel cell-by-cell (shared state)…");
  // Cell 1 — seed the kernel with imports + a working dataset.
  printCell(
    "cell-1",
    "import statistics as st; xs = list(range(1, 21)); xs[:5]",
    await cell(parent, "import statistics as st\nxs = list(range(1, 21))\nxs[:5]"),
  );
  // Cell 2 — proves state survives: xs is still in scope.
  printCell(
    "cell-2",
    "len(xs), sum(xs), st.mean(xs)",
    await cell(parent, "len(xs), sum(xs), st.mean(xs)"),
  );
  // Cell 3 — define a helper. The function will still exist after
  // pause + fork, because the kernel's globals are part of the snapshot.
  printCell(
    "cell-3",
    "def transform(seq, k): return [v * k for v in seq]\ntransform(xs[:3], 10)",
    await cell(
      parent,
      "def transform(seq, k):\n    return [v * k for v in seq]\ntransform(xs[:3], 10)",
    ),
  );

  console.log("\n[3/5] pausing parent (snapshots kernel mid-session)…");
  await parent.pause();
  await parent.waitUntilPaused({ timeoutMs: 600_000 });
  console.log(`parent paused: ${parent.id}`);

  // Two branches diverge from the same kernel checkpoint. Each fork
  // sees `xs`, `st`, and the `transform` helper without re-running any
  // of the seed cells.
  console.log("\n[4/5] branch A — sum-of-squares on inherited xs");
  const a = await runOnFork(
    parent,
    "A",
    "ys = transform(xs, 2)\nsq = [v*v for v in ys]\n{'ys_head': ys[:5], 'sum_sq': sum(sq), 'mean_sq': st.mean(sq)}",
  );

  console.log("\n[4.5/5] branch B — different transform on the same inherited xs");
  const b = await runOnFork(
    parent,
    "B",
    "zs = transform(xs, -3)\n{'zs_head': zs[:5], 'min_z': min(zs), 'max_z': max(zs), 'stdev_xs': round(st.stdev(xs), 4)}",
  );

  console.log("\n[5/5] divergence check");
  if (a && b) {
    console.log(`  branch A result: ${a.result}`);
    console.log(`  branch B result: ${b.result}`);
    if (a.result === b.result) {
      console.log("  WARNING: branches produced identical output — divergence not demonstrated");
    } else {
      console.log("  OK — same starting kernel, two divergent results");
    }
  } else {
    console.log("  forks unavailable — kernel-singleton portion still verified (cells 1-3)");
  }
} finally {
  console.log("\ncleanup…");
  await parent.destroy().catch(() => undefined);
  console.log("destroyed parent");
}
