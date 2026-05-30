// 14 — Jupyter Singleton. One long-lived IPython kernel inside a
// sandbox, driven cell-by-cell over a Unix-domain socket. The kernel
// keeps Python state (imports, variables, defined functions) across
// calls, so this behaves like a Jupyter notebook with one persistent
// session. Then we pause the parent and fork two branches that inherit
// the kernel mid-session — each branch resumes from the same checkpoint
// and diverges independently. Sandboxes are sequenced (parent → fork A →
// destroy A → fork B → destroy B → parent) so we never exceed two
// concurrent sandboxes.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FcClient, FcTimeoutError, type Sandbox } from "fc-sandbox-sdk";

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

const fc = new FcClient();

// One-shot retry helper for the cap-exhausted / transient 5xx case the
// brief calls out. We back off 30s and retry exactly once; further
// failures propagate so the run fails loudly instead of hanging.
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

async function sh(sb: Sandbox, label: string, script: string, timeoutMs = 180_000) {
  const { result } = await sb.runCommand("bash", ["-lc", script], { timeoutMs });
  if (result.exit_code !== 0) {
    console.log(`[${sb.id} ${label}] exit=${result.exit_code}`);
    if (result.stdout) console.log("  stdout:", result.stdout.slice(-1200));
    if (result.stderr) console.log("  stderr:", result.stderr.slice(-1200));
    throw new Error(`${label} failed on ${sb.id} (exit ${result.exit_code})`);
  }
  return result.stdout;
}

async function installAndBoot(sb: Sandbox) {
  // Daemon is stdlib-only (ast + code), so devbox:1's python3 is
  // enough — no apt-get, no pip, no extra packages.
  await sb.files.upload("/tmp/kernel_daemon.py", daemonSrc);
  await sb.files.upload("/tmp/cell_client.py", clientSrc);
  await sh(
    sb,
    "boot-daemon",
    "set -e; rm -f /tmp/kernel.ready /tmp/kernel.sock; " +
      "nohup setsid python3 /tmp/kernel_daemon.py </dev/null >/tmp/kernel.log 2>&1 & " +
      // Spin until the daemon writes its ready marker.
      "for i in $(seq 1 50); do " +
      "  if [ -S /tmp/kernel.sock ] && [ -f /tmp/kernel.ready ]; then exit 0; fi; " +
      "  sleep 0.2; " +
      "done; " +
      "echo 'kernel never became ready'; tail -100 /tmp/kernel.log; exit 1",
  );
}

async function cell(sb: Sandbox, code: string): Promise<CellReply> {
  // Pipe the cell source through the client shim, which talks to the
  // long-lived daemon on /tmp/kernel.sock. The daemon's reply is JSON.
  const b64 = Buffer.from(code, "utf8").toString("base64");
  const out = await sh(
    sb,
    "cell",
    `set -e; echo '${b64}' | base64 -d | python3 /tmp/cell_client.py`,
  );
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
  // state — currently blocked on fc#42 in some environments — so the
  // example finishes cleanly even if branching is unavailable.
  console.log(`\n[fork:${label}] forking from paused parent ${parent.id}…`);
  const child = await withCapRetry(`fork:${label}`, () => parent.fork({ start_paused: true }));
  try {
    try {
      await child.waitUntilPaused({ timeoutMs: FORK_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof FcTimeoutError) {
        await child.refresh().catch(() => undefined);
        console.log(
          `[fork:${label}] fork stuck in '${child.status}' after ${FORK_TIMEOUT_MS}ms — ` +
            "see https://github.com/NodeOps-app/fc/issues/42",
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

const suffix = (Date.now() % 1_000_000).toString();
const parent = await withCapRetry("createSandbox", () =>
  fc.createSandbox({ shape: SHAPE, rootfs: ROOTFS, name: `jup-${suffix}` }),
);
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
