// Live tests for git workspaces against a real control plane. They create real
// sandboxes and take a few minutes. Skipped unless CREATEOS_SANDBOX_LIVE=1.
//
//   CREATEOS_SANDBOX_LIVE=1 CREATEOS_SANDBOX_API_KEY=... bun run test:live

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateosSandboxClient,
  CreateosSandboxError,
  CreateosSandboxGitError,
  type Sandbox,
  type Workspace,
} from "../../src/index.ts";

const LIVE = process.env.CREATEOS_SANDBOX_LIVE === "1";
const T = 240_000;
const REPO = "/workspace/app";

const client = LIVE ? new CreateosSandboxClient() : (undefined as unknown as CreateosSandboxClient);
const made: Sandbox[] = [];
let sb: Sandbox;
let main: Workspace;

const sh = async (ws: Workspace, cmd: string) => {
  const r = await ws.run(cmd);
  if (r.result.exit_code !== 0) throw new Error(`${cmd}: ${r.result.stderr}`);
  return r.result.stdout;
};
const paths = async (ws: Workspace) => new Set((await ws.status()).files.map((f) => f.path));
const track = (ws: Workspace) => {
  made.push(ws.sandbox);
  return ws;
};

describe.skipIf(!LIVE)("git workspaces (live)", () => {
  beforeAll(async () => {
    sb = await client.createSandbox({ shape: "s-1vcpu-1gb", rootfs: "devbox:1", disk_mib: 51200 });
    made.push(sb);
    await sb.sh(`mkdir -p ${REPO}/tests ${REPO}/src && cd ${REPO} &&
      printf 'def add(a, b):\\n    return a + b\\n' > src/calc.py &&
      printf 'import sys; sys.path.insert(0, "../src")\\nfrom calc import add\\nassert add(2, 3) == 5\\nprint("ok")\\n' > tests/test_calc.py &&
      printf 'node_modules/\\n.env\\n__pycache__/\\n' > .gitignore &&
      echo SECRET=1 > .env && mkdir -p node_modules/x && echo dep > node_modules/x/i.js`);
    main = await sb.git.register(REPO, { init: true });
    await main.commit("base project");
  }, T);

  afterAll(async () => {
    await Promise.allSettled(made.map((s) => s.destroy()));
  }, T);

  // ── register / cwd / run ───────────────────────────────────────────────

  test(
    "register refuses a plain folder without init",
    async () => {
      await sb.sh("mkdir -p /workspace/plain");
      const err = await sb.git.register("/workspace/plain").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CreateosSandboxGitError);
      expect((err as CreateosSandboxGitError).stderr).toContain("not a git repository");
    },
    T,
  );

  test(
    "register on a subfolder resolves the repo root and keeps the subfolder as cwd",
    async () => {
      const ws = await sb.git.register(`${REPO}/tests`);
      expect(ws.root).toBe(REPO);
      expect(ws.path).toBe("tests");
      expect(await sh(ws, "pwd")).toBe(`${REPO}/tests\n`);
    },
    T,
  );

  test(
    "cwd() chains, runs in the subfolder and rejects escapes",
    async () => {
      const t = main.cwd("tests/");
      expect(t.dir).toBe(`${REPO}/tests`);
      expect(await sh(t, "python3 test_calc.py")).toBe("ok\n");
      expect(main.cwd("src").cwd("../tests").path).toBe("tests");
      expect(() => main.cwd("../etc")).toThrow(CreateosSandboxError);
      expect(() => main.cwd("/etc")).toThrow(CreateosSandboxError);
      expect(main.path).toBe(""); // the original handle is unchanged
    },
    T,
  );

  test(
    "run returns failures as data and keeps shell syntax",
    async () => {
      const r = await main.run("echo out; echo err >&2; exit 7");
      expect(r.result.exit_code).toBe(7);
      expect(r.result.stdout).toBe("out\n");
      expect(r.result.stderr).toBe("err\n");
      expect(await sh(main, "ls src/*.py | wc -l | tr -d ' '")).toBe("1\n");
    },
    T,
  );

  // ── status / diff / commit ─────────────────────────────────────────────

  test(
    "status and diff see edits, new files, spaces and binaries; commit clears them",
    async () => {
      await sh(
        main,
        `echo '# note' >> src/calc.py && echo hi > "notes with space.txt" && head -c 2048 /dev/urandom > blob.bin`,
      );
      const st = await main.status();
      expect(st.branch).toBe("main");
      expect(st.clean).toBe(false);
      const byPath = Object.fromEntries(st.files.map((f) => [f.path, f]));
      expect(byPath["src/calc.py"]?.kind).toBe("changed");
      expect(byPath["notes with space.txt"]?.kind).toBe("untracked");
      expect(byPath[".env"]).toBeUndefined(); // ignored

      const d = await main.diff();
      const files = Object.fromEntries(d.files.map((f) => [f.path, f]));
      expect(files["src/calc.py"]?.added).toBe(1);
      expect(files["notes with space.txt"]?.added).toBe(1);
      expect(files["blob.bin"]?.binary).toBe(true);
      expect(d.patch).toContain("+# note");
      expect((await main.status()).files.length).toBe(st.files.length); // diff left the index alone

      const sha = await main.commit("notes and blob");
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect((await main.status()).clean).toBe(true);
      expect(await main.commit("nothing")).toBeNull();
    },
    T,
  );

  test(
    "status reports renames and deletions",
    async () => {
      await sh(main, "git mv blob.bin data.bin && git rm -q 'notes with space.txt'");
      const st = await main.status();
      expect(st.files.find((f) => f.kind === "renamed")).toMatchObject({
        path: "data.bin",
        from: "blob.bin",
      });
      expect(st.files.find((f) => f.path === "notes with space.txt")?.index).toBe("D");
      await main.commit("rename and delete");
    },
    T,
  );

  // ── checkpoint / rollback ──────────────────────────────────────────────

  test(
    "rollback restores a checkpoint exactly, including uncommitted work",
    async () => {
      await sh(main, "echo draft > draft.txt");
      const cp = await main.checkpoint();
      await sh(main, "rm src/calc.py && echo junk > junk.txt && echo changed > draft.txt");
      await main.commit("a bad commit");
      await main.rollback(cp);
      expect(await sh(main, "cat draft.txt")).toBe("draft\n");
      expect(await sh(main, "test -f src/calc.py && test ! -e junk.txt && echo ok")).toBe("ok\n");
      expect((await main.status()).files.map((f) => f.path)).toEqual(["draft.txt"]);
      await sh(main, "rm draft.txt");
    },
    T,
  );

  // ── branch (clone) ─────────────────────────────────────────────────────

  test(
    "branch clones into a new sandbox with uncommitted work, not ignored files",
    async () => {
      await sh(main, "echo wip > wip.txt");
      const t0 = performance.now();
      const b = track(await main.branch("feature-a"));
      console.log(`branch via clone: ${Math.round(performance.now() - t0)} ms`);
      expect(b.sandbox.id).not.toBe(main.sandbox.id);
      expect(b.root).toBe(REPO);
      expect((await b.status()).branch).toBe("feature-a");
      expect(await sh(b, "cat wip.txt")).toBe("wip\n");
      expect(await sh(b, "test ! -e .env && test ! -e node_modules && echo ok")).toBe("ok\n");
      expect(await sh(b.cwd("tests"), "python3 test_calc.py")).toBe("ok\n");
      // The source is untouched and still has its uncommitted file.
      expect((await main.status()).files.map((f) => f.path)).toEqual(["wip.txt"]);
      // Writes in the branch never reach the source.
      await sh(b, "echo branch-only > only.txt");
      expect((await main.run("test -e only.txt")).result.exit_code).toBe(1);
      await sh(main, "rm wip.txt");
    },
    T,
  );

  test(
    "branch keeps the staging area: staged, unstaged and untracked stay apart",
    async () => {
      await sh(
        main,
        "echo staged > staged.txt && git add staged.txt && echo unstaged >> src/calc.py",
      );
      const state = "git status --porcelain=v1 -uall";
      const want = await sh(main, state);
      const b = track(await main.branch("feature-index"));
      expect(await sh(b, state)).toBe(want);
      await sh(
        main,
        "git rm -q --cached staged.txt && rm staged.txt && git checkout -q -- src/calc.py",
      );
    },
    T,
  );

  test(
    "branches are isolated machines: same port, separate processes",
    async () => {
      const b = track(await main.branch("feature-ports"));
      const serve =
        "nohup python3 -m http.server 8000 >/dev/null 2>&1 & echo $! > /tmp/srv.pid; sleep 1";
      const code = "curl -s -o /dev/null -w '%{http_code}' localhost:8000 || true";
      await sh(main, serve);
      await sh(b, serve); // same port, no clash: separate machines
      expect(await sh(main, code)).toBe("200");
      expect(await sh(b, code)).toBe("200");
      await sh(main, "kill $(cat /tmp/srv.pid) && sleep 0.5");
      expect(await sh(main, code)).toBe("000");
      expect(await sh(b, code)).toBe("200");
    },
    T,
  );

  test(
    "branch carries big binaries, unicode names and deletions byte for byte",
    async () => {
      await sh(
        main,
        "head -c 20000000 /dev/urandom > big.bin && echo hola > 'café ñ.txt' && rm tests/test_calc.py",
      );
      const sums =
        "sha256sum big.bin 'café ñ.txt' | cut -c1-64; test ! -e tests/test_calc.py && echo deleted";
      const want = await sh(main, sums);
      const b = track(await main.branch("feature-bytes"));
      expect(await sh(b, sums)).toBe(want);
      expect(await paths(b)).toEqual(await paths(main));
      await sh(main, "rm big.bin 'café ñ.txt' && git checkout -q -- tests/test_calc.py");
    },
    T,
  );

  // ── merge ──────────────────────────────────────────────────────────────

  test(
    "merge brings a branch's commits back, gated by the tests",
    async () => {
      const b = track(await main.branch("feature-mul"));
      await sh(b, `printf 'def mul(a, b):\\n    return a * b\\n' >> src/calc.py`);
      await b.commit("add mul");
      const r = await main.merge(b, { gate: "cd tests && python3 test_calc.py" });
      expect(r).toMatchObject({ merged: true, upToDate: false });
      expect(await sh(main, "grep -c 'def mul' src/calc.py")).toBe("1\n");
      expect(await sh(main, "git log -1 --format=%p | wc -w | tr -d ' '")).toBe("2\n"); // merge commit
      expect(await main.merge(b)).toMatchObject({ merged: true, upToDate: true });
    },
    T,
  );

  test(
    "merge reports conflicts and leaves main untouched",
    async () => {
      const b = track(await main.branch("feature-conflict"));
      await sh(b, "sed -i 's/a + b/b + a/' src/calc.py");
      await b.commit("swap operands");
      await sh(main, "sed -i 's/a + b/a+b/' src/calc.py");
      await main.commit("compact");
      const before = (await main.status()).head;
      const r = await main.merge(b);
      expect(r).toEqual({ merged: false, reason: "conflict", conflicts: ["src/calc.py"] });
      const after = await main.status();
      expect(after.head).toBe(before);
      expect(after.clean).toBe(true);
    },
    T,
  );

  test(
    "merge rolls back when the gate fails",
    async () => {
      const b = track(await main.branch("feature-broken"));
      await sh(b, "sed -i 's/return a+b/return a - b/; s/return a + b/return a - b/' src/calc.py");
      await b.commit("break add");
      const before = (await main.status()).head;
      const r = await main.merge(b, { gate: "cd tests && python3 test_calc.py" });
      expect(r.merged).toBe(false);
      if (!r.merged && r.reason === "gate")
        expect(r.gate.result.stderr).toContain("AssertionError");
      expect((await main.status()).head).toBe(before);
    },
    T,
  );

  test(
    "a gate that commits and then fails is undone to the exact pre-merge commit",
    async () => {
      const b = track(await main.branch("feature-gate-commit"));
      await sh(b, "echo b > gate-b.txt");
      await b.commit("b work");
      const before = (await main.status()).head;
      const gate =
        "echo g > gate.txt && git add gate.txt && git -c user.name=g -c user.email=g@g commit -qm g && false";
      expect((await main.merge(b, { gate })).merged).toBe(false);
      expect((await main.status()).head).toBe(before);
      expect(await sh(main, "test ! -e gate-b.txt && test ! -e gate.txt && echo ok")).toBe("ok\n");
    },
    T,
  );

  test(
    "merge refuses a target with uncommitted changes and leaves them alone",
    async () => {
      const b = track(await main.branch("feature-dirty"));
      await sh(b, "echo d > dirty-b.txt");
      await b.commit("d");
      await sh(main, "echo '# local edit' >> src/calc.py");
      const err = await main.merge(b, { gate: "false" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CreateosSandboxGitError);
      expect((err as CreateosSandboxGitError).stderr).toContain("uncommitted");
      expect(await sh(main, "tail -1 src/calc.py")).toBe("# local edit\n");
      await sh(main, "git checkout -q -- src/calc.py");
    },
    T,
  );

  test(
    "an unchanged child still brings its parent's commits",
    async () => {
      const parent = track(await main.branch("feature-p2"));
      await sh(parent, "echo p2 > p2.txt");
      await parent.commit("p2 work");
      const child = track(await parent.branch("feature-c2")); // no commits of its own
      expect((await main.merge(child)).merged).toBe(true);
      expect(await sh(main, "cat p2.txt")).toBe("p2\n");
    },
    T,
  );

  test(
    "rollback and diff reject option-like revisions",
    async () => {
      for (const bad of [
        () => main.rollback("--hard"),
        () => main.diff({ base: "--output=/tmp/x" }),
      ]) {
        const err = await bad().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CreateosSandboxGitError);
        expect((err as CreateosSandboxGitError).stderr).toContain("unknown revision");
      }
      expect(await sh(main, "test ! -e /tmp/x && test -f src/calc.py && echo ok")).toBe("ok\n");
    },
    T,
  );

  test(
    "register rejects a linked worktree",
    async () => {
      await sh(main, "git worktree add -q /workspace/wt -b wt-test");
      const err = await sb.git.register("/workspace/wt").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CreateosSandboxGitError);
      expect((err as CreateosSandboxGitError).stderr).toContain("linked worktrees");
      await sh(main, "git worktree remove --force /workspace/wt && git branch -q -D wt-test");
    },
    T,
  );

  test(
    "a branch of a branch merges straight into main",
    async () => {
      const child = track(await main.branch("feature-parent"));
      await sh(child, "echo parent > parent.txt");
      await child.commit("parent work");
      const grandchild = track(await child.branch("feature-child"));
      await sh(grandchild, "echo child > child.txt");
      await grandchild.commit("child work");
      // main has never seen the parent's commit, so the SDK must send full history.
      const r = await main.merge(grandchild);
      expect(r.merged).toBe(true);
      expect(await sh(main, "cat parent.txt child.txt")).toBe("parent\nchild\n");
    },
    T,
  );

  test(
    "three agents in parallel: only passing branches reach main",
    async () => {
      const ideas = [
        { name: "agent-ok-1", edit: "echo 'X = 1' >> src/calc.py" },
        { name: "agent-bad", edit: "sed -i 's/return/return 1 +/' src/calc.py" },
        { name: "agent-ok-2", edit: "echo 'Y = 2' > src/extra.py" },
      ];
      const gate = "cd tests && python3 test_calc.py";
      const branches = await Promise.all(
        ideas.map(async (i) => {
          const b = track(await main.branch(i.name));
          await sh(b, i.edit);
          const ok = (await b.cwd("tests").run("python3 test_calc.py")).result.exit_code === 0;
          if (ok) await b.commit(i.name);
          return { b, ok };
        }),
      );
      expect(branches.map((x) => x.ok)).toEqual([true, false, true]);
      for (const { b, ok } of branches) {
        if (ok) expect((await main.merge(b, { gate })).merged).toBe(true);
        await b.discard();
      }
      expect(await sh(main, "grep -c 'X = 1' src/calc.py; cat src/extra.py")).toBe("1\nY = 2\n");
      expect(await sh(main.cwd("tests"), "python3 test_calc.py")).toBe("ok\n");
    },
    T,
  );

  // ── fork mode / clone / discard ────────────────────────────────────────

  test(
    "branch via fork copies ignored files and running processes; source resumes",
    async () => {
      await sh(
        main,
        "nohup sh -c 'while :; do sleep 1; done' >/dev/null 2>&1 & echo $! > /tmp/loop.pid",
      );
      const t0 = performance.now();
      const b = track(await main.branch("feature-fork", { via: "fork" }));
      console.log(`branch via fork: ${Math.round(performance.now() - t0)} ms`);
      expect(b.sandbox.id).not.toBe(main.sandbox.id);
      expect((await b.status()).branch).toBe("feature-fork");
      expect(await sh(b, "cat .env node_modules/x/i.js")).toBe("SECRET=1\ndep\n");
      expect(await sh(b, "kill -0 $(cat /tmp/loop.pid) && echo alive")).toBe("alive\n");
      expect((await main.sandbox.refresh()).status).toBe("running");
      expect(await sh(main, "echo up")).toBe("up\n");
    },
    T,
  );

  test(
    "clone() fetches a public repo and branches from it",
    async () => {
      const ws = await sb.git.clone("https://github.com/octocat/Hello-World", "/workspace/hello", {
        depth: 1,
      });
      expect((await ws.status()).branch).toBe("master");
      expect(await sh(ws, "cat README")).toContain("Hello World");
      const b = track(await ws.branch("try"));
      expect(await sh(b, "cat README")).toContain("Hello World");
      const pool = ws.pool({ size: 1 });
      await pool.whenReady();
      await sh(ws, "echo hi > hi.txt");
      const w = track(await ws.branch("try-warm", { pool }));
      expect(await sh(w, "cat hi.txt; git rev-parse --is-shallow-repository")).toBe("hi\ntrue\n");
      await pool.close();
    },
    T,
  );

  // ── warm pool / transfer paths ─────────────────────────────────────────

  const fingerprint = (ws: Workspace) =>
    sh(
      ws,
      "git rev-parse HEAD; git status --porcelain=v1 -uall | sha256sum; git ls-files -co --exclude-standard -z | sort -z | xargs -0 sha256sum 2>&1 | sha256sum",
    );

  test(
    "warm pool branch equals a cold branch and drops files deleted since the fill",
    async () => {
      await sh(main, "echo stale > stale-untracked.txt");
      const pool = main.pool({ size: 1 });
      await pool.whenReady();
      expect(pool.ready).toBe(1);
      await sh(main, "rm stale-untracked.txt; echo w > warm.txt; git add warm.txt");
      await main.commit("after fill");
      await sh(
        main,
        "echo edit >> src/calc.py; echo staged > staged.txt; git add staged.txt; echo u > new-untracked.txt",
      );
      const want = await fingerprint(main);
      const t0 = performance.now();
      const warm = track(await main.branch("warm", { pool }));
      console.log(`warm branch: ${Math.round(performance.now() - t0)} ms`);
      const cold = track(await main.branch("cold"));
      expect(await fingerprint(warm)).toBe(want);
      expect(await fingerprint(cold)).toBe(want);
      expect((await warm.status()).branch).toBe("warm");
      expect(await sh(warm, "ls stale-untracked.txt .env 2>/dev/null || echo gone")).toBe("gone\n");
      expect(await sh(warm, "git diff --cached --name-only")).toBe("staged.txt\n");
      await pool.whenReady(); // refilled in the background
      expect(pool.ready).toBe(1);
      // A dead member is skipped: the branch still works.
      const member = pool.take()!;
      await member.sandbox.destroy();
      pool.give(member);
      const after = track(await main.branch("after-dead", { pool }));
      expect(await fingerprint(after)).toBe(want);
      await pool.close();
      expect(pool.ready).toBe(0);
      await sh(
        main,
        "git checkout -q -- src/calc.py; git reset -q; rm -f staged.txt new-untracked.txt",
      );
    },
    T,
  );

  test(
    "a big archive moves over a private network that is removed afterwards",
    async () => {
      const big = await sb.git.register("/workspace/big", { init: true });
      await sh(big, "head -c 150000000 /dev/urandom > blob.bin");
      await big.commit("big");
      const want = await sh(big, "sha256sum blob.bin");
      const t0 = performance.now();
      const b = track(await big.branch("copy"));
      console.log(`150 MB branch: ${Math.round(performance.now() - t0)} ms`);
      expect(await sh(b, "sha256sum blob.bin")).toBe(want);
      // No transfer network still holds either sandbox (other runs may own some).
      const nets = (await client.networks.list()).filter((n) => n.name.startsWith("createos-git-"));
      const held = await Promise.all(
        nets.map(async (n) => (await client.networks.get(n.id)).members ?? []),
      );
      const ours = new Set([big.sandbox.id, b.sandbox.id]);
      expect(held.flat().filter((m) => ours.has(m.sandbox_id))).toEqual([]);
      await sh(b, "echo more > more.txt");
      await b.commit("more");
      expect((await big.merge(b)).merged).toBe(true);
      expect(await sh(big, "cat more.txt")).toBe("more\n");
    },
    T,
  );

  test(
    "a source with its own access token still copies directly and keeps the token",
    async () => {
      await sb.createAccessToken();
      try {
        const b = track(await main.branch("own-token"));
        expect((await b.status()).branch).toBe("own-token");
        expect((await sb.getAccessToken()).enabled).toBe(true);
      } finally {
        await sb.disableAccessToken();
      }
    },
    T,
  );

  test(
    "discard destroys only sandboxes that branch() created",
    async () => {
      const b = track(await main.branch("feature-tmp"));
      await b.discard();
      expect((await b.sandbox.refresh()).status).toMatch(/destroy/);
      await expect(main.discard()).rejects.toThrow(CreateosSandboxError);
    },
    T,
  );
});
