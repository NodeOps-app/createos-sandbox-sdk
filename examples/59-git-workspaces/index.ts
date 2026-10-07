/**
 * Git workspaces.
 *
 * Register a folder in a sandbox as a git repo, then let three "agents" each try
 * an idea on their own branch. Every branch is a separate sandbox, so agents
 * never share files, ports or processes. Only branches that pass the tests are
 * merged back, and a failing merge never reaches main.
 *
 *   main ──branch──► agent/fast-sum   (own sandbox) ── tests pass ──► merge
 *        ──branch──► agent/broken     (own sandbox) ── tests fail ──► discard
 *        ──branch──► agent/docs       (own sandbox) ── tests pass ──► merge
 *
 * createos-sandbox primitives: createSandbox, git.register, Workspace.cwd/run,
 * status, diff, commit, branch, merge, discard, destroy
 *
 * Run:   bun 59-git-workspaces/index.ts
 * Needs: CREATEOS_SANDBOX_API_KEY. CREATEOS_SANDBOX_BASE_URL optional.
 */

import { CreateosSandboxClient } from "createos-sandbox-sdk";

if (!process.env.CREATEOS_SANDBOX_API_KEY) throw new Error("set CREATEOS_SANDBOX_API_KEY");
const baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL;
const client = new CreateosSandboxClient(baseUrl ? { baseUrl } : {});

const REPO = "/workspace/stats";
const TESTS = "python3 -m unittest -q";

const sandbox = await client.createSandbox({ shape: "s-1vcpu-1gb", rootfs: "devbox:1" });
try {
  // 1. A small project: code in src/, tests in tests/.
  await sandbox.sh(`mkdir -p ${REPO}/src ${REPO}/tests && cd ${REPO} &&
    printf '__pycache__/\\n' > .gitignore &&
    printf 'def total(xs):\\n    t = 0\\n    for x in xs:\\n        t += x\\n    return t\\n' > src/stats.py &&
    printf 'import sys, unittest\\nsys.path.insert(0, "../src")\\nfrom stats import total\\n\\nclass T(unittest.TestCase):\\n    def test_total(self):\\n        self.assertEqual(total([1, 2, 3]), 6)\\n' > tests/test_stats.py`);
  const main = await sandbox.git.register(REPO, { init: true });
  await main.commit("stats project");
  const tests = main.cwd("tests");
  console.log(
    `main     ${sandbox.id}  tests: ${(await tests.run(TESTS)).result.exit_code === 0 ? "pass" : "fail"}`,
  );

  // 2. Three ideas, each on its own branch in its own sandbox, in parallel.
  const ideas = [
    {
      branch: "agent/fast-sum",
      edit: "printf 'def total(xs):\\n    return sum(xs)\\n' > src/stats.py",
    },
    { branch: "agent/broken", edit: "sed -i 's/t += x/t -= x/' src/stats.py" },
    { branch: "agent/docs", edit: "printf '# stats\\nAdds numbers.\\n' > README.md" },
  ];
  const tried = await Promise.all(
    ideas.map(async ({ branch, edit }) => {
      const ws = await main.branch(branch);
      await ws.run(edit);
      const diff = await ws.diff();
      const passed = (await ws.cwd("tests").run(TESTS)).result.exit_code === 0;
      console.log(
        `${branch.padEnd(15)} ${ws.sandbox.id}  changed: ${diff.files.map((f) => f.path).join(", ")}  tests: ${passed ? "pass" : "FAIL"}`,
      );
      if (passed) await ws.commit(branch);
      return { ws, passed };
    }),
  );

  // 3. Merge the winners. The gate runs the tests again on the merged result.
  for (const { ws, passed } of tried) {
    if (passed) {
      const r = await main.merge(ws, { gate: `cd tests && ${TESTS}` });
      console.log(
        `merge ${(await ws.status()).branch} → ${r.merged ? "merged" : `rejected (${r.reason})`}`,
      );
    }
    await ws.discard();
  }

  const log = await main.run("git log --oneline --graph");
  console.log(`\n${log.result.stdout}`);
  console.log(
    `main tests after merge: ${(await tests.run(TESTS)).result.exit_code === 0 ? "pass" : "fail"}`,
  );
} finally {
  await sandbox.destroy();
}
