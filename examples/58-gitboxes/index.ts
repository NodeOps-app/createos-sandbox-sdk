/**
 * Gitboxes: git for environments.
 *
 * Every branch is its own sandbox. The repo holds the whole world: app code, database migrations, seed data
 * and the test gate. Branching the world = `main.branch()`, a fresh sandbox
 * that gets the repo and rebuilds the database from it. Merging = `merge()`
 * gated by the same tests, so a change that breaks the world never reaches
 * main. Each agent's `diff()` shows exactly what it changed, including files
 * it has not committed yet. A last branch proves that main rebuilds and
 * passes from scratch.
 *
 *   main ──branch──► agent/tax       (own sandbox) ── gate pass ──► merge
 *        ──branch──► agent/tax-fast  (own sandbox) ── gate FAIL ──► discard
 *        ──branch──► agent/email     (own sandbox) ── gate pass ──► merge
 *        ──branch──► verify          (own sandbox) ── rebuild DB + gate
 *
 * createos-sandbox primitives: createSandbox, files.upload, git.register,
 * Workspace.run, cwd, status, diff, commit, branch, merge, discard, destroy
 *
 * Run:   bun 58-gitboxes/index.ts
 * Needs: CREATEOS_SANDBOX_API_KEY. CREATEOS_SANDBOX_BASE_URL optional.
 */

import { CreateosSandboxClient, type Workspace } from "createos-sandbox-sdk";

if (!process.env.CREATEOS_SANDBOX_API_KEY) throw new Error("set CREATEOS_SANDBOX_API_KEY");
const baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL;
const client = new CreateosSandboxClient(baseUrl ? { baseUrl } : {});

const REPO = "/work";

// ── the "world": a tiny billing service + its database ──────────────────────
// Swap sqlite for Postgres (or anything) without changing the workflow: the
// world is rebuilt from what is committed, so every branch gets the same state.

const BASE_FILES: Record<string, string> = {
  ".gitignore": "__pycache__/\n",
  "billing.py": `def invoice_total(db, invoice_id):
    rows = db.execute("SELECT qty, unit_cents FROM lines WHERE invoice_id = ?", (invoice_id,))
    return sum(q * c for q, c in rows)
`,
  "migrations/001_init.sql": `CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer TEXT NOT NULL);
CREATE TABLE lines (invoice_id INTEGER REFERENCES invoices(id), qty INTEGER, unit_cents INTEGER);
`,
  "seed.sql": `INSERT INTO invoices (id, customer) VALUES (1, 'acme');
INSERT INTO lines (invoice_id, qty, unit_cents) VALUES (1, 3, 333), (1, 1, 1999);
`,
  // The gate: rebuild the database from migrations + seed, then check behaviour.
  "test.py": `import glob, sqlite3, billing
db = sqlite3.connect(":memory:")
for f in sorted(glob.glob("migrations/*.sql")) + ["seed.sql"]:
    db.executescript(open(f).read())
import checks
checks.run(db, billing)
print("PASS")
`,
  "checks.py": `def run(db, billing):
    assert billing.invoice_total(db, 1) == 2998, billing.invoice_total(db, 1)
`,
};

// Three agents, three ideas. In a real system an LLM writes these edits.
const AGENTS: { branch: string; goal: string; files: Record<string, string> }[] = [
  {
    branch: "agent/tax",
    goal: "add 18% tax, rate stored per customer",
    files: {
      "migrations/002_tax.sql": `ALTER TABLE invoices ADD COLUMN tax_bp INTEGER NOT NULL DEFAULT 1800;\n`,
      "billing.py": `def invoice_total(db, invoice_id):
    rows = db.execute("SELECT qty, unit_cents FROM lines WHERE invoice_id = ?", (invoice_id,))
    net = sum(q * c for q, c in rows)
    (tax_bp,) = db.execute("SELECT tax_bp FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    return net + (net * tax_bp + 5000) // 10000
`,
      "checks.py": `def run(db, billing):
    assert billing.invoice_total(db, 1) == 3538, billing.invoice_total(db, 1)
`,
    },
  },
  {
    branch: "agent/tax-fast",
    goal: "add 18% tax with float math (rounding bug)",
    files: {
      "billing.py": `def invoice_total(db, invoice_id):
    rows = db.execute("SELECT qty, unit_cents FROM lines WHERE invoice_id = ?", (invoice_id,))
    return int(sum(q * c for q, c in rows) * 1.18)
`,
      "checks.py": `def run(db, billing):
    assert billing.invoice_total(db, 1) == 3538, billing.invoice_total(db, 1)
`,
    },
  },
  {
    branch: "agent/email",
    goal: "store a billing email per customer",
    files: {
      "migrations/003_email.sql": `ALTER TABLE invoices ADD COLUMN email TEXT;\n`,
      "test_email.py": `import glob, sqlite3
db = sqlite3.connect(":memory:")
for f in sorted(glob.glob("migrations/*.sql")) + ["seed.sql"]:
    db.executescript(open(f).read())
db.execute("UPDATE invoices SET email = 'billing@acme.test' WHERE id = 1")
assert db.execute("SELECT email FROM invoices WHERE id = 1").fetchone() == ("billing@acme.test",)
print("PASS")
`,
    },
  },
];

// The gate every branch and every merge must pass.
const GATE = `for t in test*.py; do python3 $t || exit 1; done`;

// ── helpers ─────────────────────────────────────────────────────────────────

const started = performance.now();
const ms = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;
const log = (who: string, msg: string) =>
  console.log(`[${ms().padStart(6)}] ${who.padEnd(14)} ${msg}`);

const writeFiles = (ws: Workspace, files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([p, body]) => ws.sandbox.files.upload(`${ws.root}/${p}`, body)),
  );

// Runs the gate and returns { ok, out } instead of throwing, so a failing
// gate is a result, not a crash.
const gate = async (ws: Workspace) => {
  const { result } = await ws.run(GATE);
  return { ok: result.exit_code === 0, out: (result.stdout + result.stderr).trim() };
};

const sandbox = await client.createSandbox({ shape: "s-1vcpu-1gb", rootfs: "devbox:1" });
// Branch sandboxes still alive, so the finally can clean up after a crash.
const branches = new Set<Workspace>();
const discard = async (ws: Workspace) => {
  branches.delete(ws);
  await ws.discard();
};
try {
  // ── 1. commit the base world ──────────────────────────────────────────────

  const main = await sandbox.git.register(REPO, { init: true });
  await writeFiles(main, BASE_FILES);
  const base = await gate(main);
  if (!base.ok) throw new Error(`base world failed its own gate:\n${base.out}`);
  const first = await main.commit("base world");
  log("main", `committed base world ${first!.slice(0, 7)} (gate passed)`);

  // ── 2. branch: one fresh sandbox per agent, all in parallel ──────────────

  const results = await Promise.all(
    AGENTS.map(async (agent) => {
      const ws = await main.branch(agent.branch);
      branches.add(ws);
      await writeFiles(ws, agent.files);
      // Uncommitted work is visible: diff() covers changed and new files.
      const changed = (await ws.diff()).files.map((f) => f.path).join(", ");
      const check = await gate(ws);
      log(agent.branch, `${agent.goal} → gate ${check.ok ? "PASS" : "FAIL"}`);
      log(agent.branch, `  changed: ${changed}`);
      if (!check.ok) {
        log(agent.branch, `  ${check.out.split("\n").pop()}`);
        await discard(ws); // nothing is committed, nothing leaks into main
        return { branch: agent.branch, ws, passed: false };
      }
      await ws.commit(agent.goal);
      return { branch: agent.branch, ws, passed: true };
    }),
  );

  // ── 3. merge every passing branch; the gate runs on the merged result ────

  for (const { branch, ws, passed } of results) {
    if (!passed) continue;
    const r = await main.merge(ws, { gate: GATE, message: `merge ${branch}` });
    log("main", `merge ${branch} → ${r.merged ? "gate PASS" : `REJECTED (${r.reason})`}`);
    await discard(ws);
  }
  const head = (await main.status()).head!;
  log("main", `main is now ${head.slice(0, 7)}`);

  // ── 4. verify: a brand-new sandbox gets main and rebuilds the world ──────

  const verify = await main.branch("verify");
  branches.add(verify);
  const check = await gate(verify);
  // cwd() returns a handle whose commands run in a subfolder of the repo.
  const migrations = await verify.cwd("migrations").run("ls");
  const clean = (await verify.status()).clean;
  log(
    "verify",
    `fresh sandbox at ${head.slice(0, 7)}, rebuilt DB, gate ${check.ok ? "PASS" : "FAIL"}, clean: ${clean}`,
  );
  log("verify", `  migrations: ${migrations.result.stdout.trim().split("\n").join(", ")}`);
  console.log(`\n${(await main.run("git log --oneline --graph")).result.stdout}`);
  if (!check.ok) process.exitCode = 1;
} finally {
  await Promise.allSettled([sandbox.destroy(), ...[...branches].map((b) => b.discard())]);
  log("cleanup", "destroyed the main sandbox and every remaining branch");
}
