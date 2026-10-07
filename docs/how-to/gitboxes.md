# How-to: Gitboxes — branch a project into isolated sandboxes

## Problem

An agent wants to try several changes to a project at once, run the tests
for each, and keep only the ones that pass, without the attempts touching
each other or the original.

## Solution

Register the project folder as a gitbox with `sandbox.git`. A
`Workspace` is a git repo inside a sandbox plus a working folder in it.
`branch()` puts every branch in its own sandbox, and `merge()` brings
committed work back, guarded by a test command. Why branches clone by
default, and the measured numbers: [../explanation/gitboxes.md](../explanation/gitboxes.md).

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ shape: "s-1vcpu-1gb", rootfs: "devbox:1" });

// A folder that is already a repo, or { init: true } to create one.
const main = await sandbox.git.register("/workspace/my-project");
// Or start from a remote: await sandbox.git.clone(url, "/workspace/my-project", { depth: 1 })

const fix = await main.branch("fix-rounding"); // a new sandbox
await fix.run("sed -i 's/round(x)/round(x, 2)/' src/money.py");
const tests = await fix.cwd("tests").run("pytest -q"); // runs in <repo>/tests
if (tests.result.exit_code === 0) {
  await fix.commit("round to cents");
  const r = await main.merge(fix, { gate: "pytest -q" });
  if (!r.merged) console.log(r.reason); // "conflict" or "gate"
}
await fix.discard(); // destroys the branch's sandbox
```

## Working folder

`cwd(sub)` returns a new workspace whose `run()` starts in `sub`, relative
to the current folder. It never changes the original handle, so parallel
calls are safe. A path that leaves the repo (`../x`, `/etc`) throws.

Registering a path inside a repo resolves to the repo root and keeps the
rest as the working folder:

```ts
const unit = await sandbox.git.register("/workspace/my-project/tests/unit");
unit.root; // "/workspace/my-project"
unit.path; // "tests/unit"
```

`run()` returns the exit code, stdout and stderr instead of throwing, so a
failing test is a result you can act on.

## Look at the work

| Method | What it returns |
| --- | --- |
| `status()` | Branch, HEAD, ahead/behind and every changed, renamed, conflicted or untracked file |
| `diff({ base, binary })` | Patch text plus per-file line counts since `base` (default `HEAD`), including uncommitted and untracked files. Binary contents only with `binary: true` |
| `commit(message)` | New commit sha, or `null` when nothing changed |
| `checkpoint()` | A sha that saves the whole working tree without committing |
| `rollback(sha)` | Restores a checkpoint or commit exactly, deleting files created since |

## Branch modes

| `via` | What the branch gets | Source sandbox | Typical time |
| --- | --- | --- | --- |
| `"clone"` (default) | Full git history, plus uncommitted and untracked files | Keeps running | About 2 s |
| `"fork"` | Everything: memory, running processes, installed packages, ignored files such as `.env` and `node_modules` | Paused while the fork is taken | About 8 to 16 s |

Use `"fork"` when the setup is expensive to repeat (a seeded database, a
large `npm install`). Pass `create` to change the new sandbox in clone
mode, for example `{ shape: "s-2vcpu-2gb" }`. Env var values are never
returned by the API, so set `create.envs` again if the branch needs them.

## Merging

`merge(other, { gate })` copies the other workspace's commits in and
makes a merge commit. It leaves this workspace unchanged when:

- the branches conflict: `{ merged: false, reason: "conflict", conflicts: [...] }`
- the gate command exits non-zero: `{ merged: false, reason: "gate", gate }`

A branch whose commits this workspace already has returns
`{ merged: true, upToDate: true }`. Only committed work is merged; call
`commit()` first. This workspace must have no uncommitted changes to
tracked files, otherwise `merge()` throws: a failed gate could not put them
back exactly. Merges into one workspace run one at a time.

## Warm pool: faster branches of a big repo

A clone-mode branch copies the whole `.git` folder, so a big repo branches
at copy speed (a 1.2 GB `.git` takes 30 s or more). A warm pool keeps
sandboxes that already hold a copy of the repo. A branch from the pool
moves only what changed since the pool was filled.

```ts
const pool = main.pool({ size: 2 }); // fills 2 sandboxes in the background
await pool.whenReady();

const fix = await main.branch("fix", { pool }); // takes one, refills in the background
// ... more branches ...

await pool.close(); // destroys the idle pool sandboxes
```

- Pool sandboxes **keep running and cost money** until `close()`. Pick the
  size for the number of branches you expect at once.
- A dead pool sandbox is skipped and replaced. An empty pool falls back to a
  normal branch, so `branch()` never waits for a fill.
- A failed background fill is kept in `pool.lastError` and retried on the
  next branch.
- The branch is identical to a normal one: same files, history and staging
  area. Files that were in the pool copy but are gone from the source are
  removed.

## How the data moves

Branch and merge data goes straight from one sandbox to the other. Nothing
passes through your process.

| Size | Path |
| --- | --- |
| Below 128 MB | The target downloads the file through the API with a short-lived access token scoped to the source sandbox, disabled right after |
| 128 MB and above | A private network that holds only the two sandboxes. The file is served on the source's network address only, and the network is deleted after the copy |

When the first path fails, the SDK tries the other one. If the source
already has its own access token, the SDK never touches it and uses the
private network. When neither path works, the call throws. Pass
`relay: true` to `branch()`, `merge()` or `pool()` to allow a slow relay
through your process instead.

A branch archive is compressed with zstd when both sandboxes have it
(`devbox:1` does), using one thread on 1–2 vCPU and one per vCPU above
that. Otherwise it falls back to gzip.
