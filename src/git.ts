// Gitboxes (`sandbox.git`): a folder inside a sandbox registered as a git repo, with
// git-style branching where every branch gets its own sandbox.
//
// Design notes:
// - Isolation first. `branch()` never shares a sandbox: it either clones the
//   repo into a fresh sandbox ("clone") or forks the whole sandbox ("fork").
// - No shared mutable storage. Commits move straight from one sandbox to the
//   other (see git-transfer.ts), driven by this process, so there is exactly
//   one writer and nothing to lock.
// - Every git and shell call passes user values as positional arguments to a
//   fixed bash script, never by string interpolation.
// - A `Workspace` is immutable. `cwd()` returns a new handle; no shell state is
//   kept between calls, so concurrent calls on one workspace are safe.

import {
  CreateosSandboxApiError,
  CreateosSandboxError,
  CreateosSandboxNotFoundError,
} from "./errors.js";
import {
  type CleanupFailure,
  COMPRESS,
  CreateosSandboxCleanupError,
  CreateosSandboxGitError,
  DROP,
  type GitAuthor,
  LONG_TIMEOUT_MS,
  PRELUDE,
  type TargetScript,
  SNAPSHOT,
  deliver,
  errorText,
  finish,
  gitScript,
  runGit,
  serialize,
  spawnSandbox,
  throwIfFailed,
} from "./git-transfer.js";
import type { CreateosSandboxHttp } from "./http.js";
import { sleep } from "./poll.js";
import type { Sandbox } from "./sandbox.js";
import type { CreateSandboxRequest, ExecOptions, ExecResponse, SandboxView } from "./types.js";

export {
  type CleanupFailure,
  CreateosSandboxCleanupError,
  CreateosSandboxGitError,
  type GitAuthor,
};

/** Commit author used when the caller does not set one. */
export const DEFAULT_GIT_AUTHOR = { name: "createos-agent", email: "agent@createos.sh" };

/** How `Workspace.branch` copies the work into its new sandbox. */
export type BranchVia = "clone" | "fork";

export interface RegisterOptions {
  /** Run `git init` (and make an empty first commit) when the folder is not a repo yet. */
  init?: boolean;
  /** Author for commits made through this workspace. */
  author?: GitAuthor;
}

export interface CloneOptions {
  /** Branch or tag to check out. */
  branch?: string;
  /** Shallow clone depth. */
  depth?: number;
  author?: GitAuthor;
}

/** Copy options shared by `branch`, `merge` and `pool`. */
export interface CopyOptions {
  /**
   * Allow relaying the bytes through this process when the sandboxes cannot
   * copy directly (private network, then a token-scoped pull). Off by default:
   * the relay is slow and moves repo contents through the caller.
   */
  relay?: boolean;
}

export interface BranchOptions extends CopyOptions {
  /**
   * `"clone"` (default): a fresh sandbox receives the repo as one archive,
   * including uncommitted and untracked files. The source keeps running.
   * Ignored files (`node_modules`, `.env`) are not copied.
   *
   * `"fork"`: pause, fork and resume the source. The branch gets everything:
   * memory, running processes, installed packages and ignored files. The
   * source is paused for the duration.
   */
  via?: BranchVia;
  /** Overrides for the new sandbox in `"clone"` mode. Defaults copy shape, disk size, rootfs and egress. */
  create?: Partial<CreateSandboxRequest>;
  /**
   * Take a ready sandbox from this warm pool (made by `workspace.pool()`), so
   * only the changes since the pool was filled move. Falls back to a normal
   * clone when the pool is empty. Ignored with `via: "fork"`.
   */
  pool?: WarmPool;
}

export interface MergeOptions extends CopyOptions {
  /** Shell command run at the repo root after the merge, for up to 30 minutes. A non-zero exit undoes the merge. */
  gate?: string;
  /** Merge commit message. */
  message?: string;
}

export interface PoolOptions extends CopyOptions {
  /** Number of ready sandboxes to keep. Each one is a running sandbox you pay for. */
  size: number;
  /** Overrides for the pool sandboxes, as in `BranchOptions.create`. */
  create?: Partial<CreateSandboxRequest>;
}

export type MergeResult =
  | { merged: true; sha: string; upToDate: boolean }
  | { merged: false; reason: "conflict"; conflicts: string[] }
  | { merged: false; reason: "gate"; gate: ExecResponse };

/** One changed path from `Workspace.status`. */
export interface GitFileStatus {
  path: string;
  /** Previous path for renames and copies. */
  from?: string;
  kind: "changed" | "renamed" | "unmerged" | "untracked";
  /** Index (staged) state letter from porcelain v2, `.` when unchanged. */
  index: string;
  /** Working-tree state letter from porcelain v2, `.` when unchanged. */
  worktree: string;
}

export interface GitStatus {
  /** Current branch, or `null` when HEAD is detached. */
  branch: string | null;
  /** HEAD commit sha, or `null` before the first commit. */
  head: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  /** True when there are no changed or untracked files. */
  clean: boolean;
  files: GitFileStatus[];
}

export interface DiffOptions {
  /** Commit, branch or tag to compare against. Default `HEAD`. */
  base?: string;
  /**
   * Put binary file contents in `patch` (`git diff --binary`), so it can be
   * applied with `git apply`. Off by default: a few MB of binary turns into
   * a large patch that is slow to download.
   */
  binary?: boolean;
}

/** Everything changed since `base`, including uncommitted and untracked files. */
export interface GitDiff {
  base: string;
  /** Unified diff text. Binary files show as "Binary files ... differ" unless `binary` is set. */
  patch: string;
  files: { path: string; added: number; deleted: number; binary: boolean }[];
}

const NUL = "\u0000";

/** Joins a relative sub-path onto a relative base, refusing anything that leaves the repo. */
export function joinRepoPath(base: string, sub: string): string {
  if (sub.startsWith("/"))
    throw new CreateosSandboxError(`cwd must be relative to the repo: ${sub}`);
  if (sub.includes(NUL)) throw new CreateosSandboxError("cwd must not contain NUL");
  const out: string[] = [];
  for (const part of `${base}/${sub}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) throw new CreateosSandboxError(`cwd escapes the repo: ${sub}`);
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatus(raw: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    head: null,
    ahead: 0,
    behind: 0,
    clean: true,
    files: [],
  };
  const fields = raw.split(NUL);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.startsWith("# branch.oid ")) {
      const oid = f.slice(13);
      status.head = oid === "(initial)" ? null : oid;
    } else if (f.startsWith("# branch.head ")) {
      const head = f.slice(14);
      status.branch = head === "(detached)" ? null : head;
    } else if (f.startsWith("# branch.upstream ")) {
      status.upstream = f.slice(18);
    } else if (f.startsWith("# branch.ab ")) {
      const [a, b] = f.slice(12).split(" ");
      status.ahead = Number(a);
      status.behind = Math.abs(Number(b));
    } else if (f.startsWith("1 ") || f.startsWith("u ")) {
      // "1 XY sub mH mI mW hH hI path" / "u XY sub m1 m2 m3 mW h1 h2 h3 path"
      const parts = f.split(" ");
      const xy = parts[1]!;
      const pathIndex = f.startsWith("1 ") ? 8 : 10;
      status.files.push({
        path: parts.slice(pathIndex).join(" "),
        kind: f.startsWith("u ") ? "unmerged" : "changed",
        index: xy[0]!,
        worktree: xy[1]!,
      });
    } else if (f.startsWith("2 ")) {
      // "2 XY sub mH mI mW hH hI Xscore path", then the original path in the next field.
      const parts = f.split(" ");
      const xy = parts[1]!;
      status.files.push({
        path: parts.slice(9).join(" "),
        from: fields[++i]!,
        kind: "renamed",
        index: xy[0]!,
        worktree: xy[1]!,
      });
    } else if (f.startsWith("? ")) {
      status.files.push({ path: f.slice(2), kind: "untracked", index: "?", worktree: "?" });
    }
  }
  status.clean = status.files.length === 0;
  return status;
}

/** Parses `git diff --numstat -z`. Renames are reported under their new path. */
export function parseNumstat(raw: string): GitDiff["files"] {
  const files: GitDiff["files"] = [];
  const fields = raw.split(NUL);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (!f) continue;
    const t1 = f.indexOf("\t");
    const t2 = f.indexOf("\t", t1 + 1);
    const added = f.slice(0, t1);
    const deleted = f.slice(t1 + 1, t2);
    const path = f.slice(t2 + 1);
    const binary = added === "-";
    // A rename leaves the path empty and puts "old" and "new" in the next two fields.
    const name = path === "" ? ((i += 2), fields[i]!) : path;
    files.push({
      path: name,
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    });
  }
  return files;
}

/** Entry point reached via `sandbox.git`. */
export class SandboxGit {
  readonly #http: CreateosSandboxHttp;
  readonly #sandbox: Sandbox;

  constructor(http: CreateosSandboxHttp, sandbox: Sandbox) {
    this.#http = http;
    this.#sandbox = sandbox;
  }

  /**
   * Registers a folder in the sandbox as a gitbox workspace. A path inside a repo
   * resolves to the repo root, and the rest becomes the workspace's `cwd`.
   *
   * @throws {CreateosSandboxGitError} when the folder is not a repo and `init` is not set.
   *
   * @example
   * const main = await sandbox.git.register("/workspace/my-project");
   * await main.cwd("tests").run("python3 test.py");
   */
  async register(path: string, options: RegisterOptions = {}): Promise<Workspace> {
    if (!path.startsWith("/"))
      throw new CreateosSandboxError(`register needs an absolute path: ${path}`);
    const author = options.author ?? DEFAULT_GIT_AUTHOR;
    const script = `${PRELUDE}
if ! top=$(g rev-parse --show-toplevel 2>/dev/null); then
  [ "$1" = init ] || { echo "not a git repository: $R (pass { init: true })" >&2; exit 3; }
  mkdir -p "$R"; g init -q -b main; top=$(g rev-parse --show-toplevel)
fi
R=$top
if [ "$(g rev-parse --path-format=absolute --git-dir)" != "$(g rev-parse --path-format=absolute --git-common-dir)" ]; then
  echo "linked worktrees are not supported: $R" >&2; exit 5
fi
if ! g rev-parse -q --verify HEAD >/dev/null; then
  [ "$1" = init ] || { echo "repository has no commits: $R" >&2; exit 4; }
  g commit -q --allow-empty -m "init"
fi
printf '%s\\n' "$top"`;
    const out = await gitScript(this.#sandbox, "register", script, path, author, [
      options.init ? "init" : "",
    ]);
    const root = out.replace(/\n$/, "");
    const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : "";
    return new Workspace(
      this.#http,
      this.#sandbox,
      root,
      joinRepoPath("", rel),
      author,
      false,
      null,
    );
  }

  /**
   * Clones a repo into `path` and registers it. Use an https URL with a
   * token for private repos; the URL is stored in the clone's remote config.
   *
   * @example
   * const ws = await sandbox.git.clone("https://github.com/acme/app", "/workspace/app", { depth: 1 });
   */
  async clone(url: string, path: string, options: CloneOptions = {}): Promise<Workspace> {
    if (!path.startsWith("/"))
      throw new CreateosSandboxError(`clone needs an absolute path: ${path}`);
    const flags = [
      ...(options.branch ? ["--branch", options.branch] : []),
      ...(options.depth ? ["--depth", String(options.depth)] : []),
    ];
    const script = `${PRELUDE}url=$1; shift; git -c safe.directory='*' clone -q "$@" -- "$url" "$R"`;
    await gitScript(this.#sandbox, "clone", script, path, DEFAULT_GIT_AUTHOR, [url, ...flags]);
    return this.register(path, options.author ? { author: options.author } : {});
  }
}

/**
 * A git repo inside one sandbox, plus a working folder within it. Created by
 * `sandbox.git.register`, `sandbox.git.clone` or `workspace.branch`.
 */
export class Workspace {
  /** The sandbox that holds this workspace. */
  readonly sandbox: Sandbox;
  /** Absolute path of the repo root inside the sandbox. */
  readonly root: string;
  /** Working folder relative to `root`. Empty string means the root itself. */
  readonly path: string;
  readonly author: GitAuthor;
  /** True when `branch()` created the sandbox, so `discard()` may destroy it. */
  readonly ownsSandbox: boolean;
  /** Commit the branch started from. `null` for a registered or cloned workspace. */
  readonly base: string | null;
  readonly #http: CreateosSandboxHttp;

  constructor(
    http: CreateosSandboxHttp,
    sandbox: Sandbox,
    root: string,
    path: string,
    author: GitAuthor,
    ownsSandbox: boolean,
    base: string | null,
  ) {
    this.#http = http;
    this.sandbox = sandbox;
    this.root = root;
    this.path = path;
    this.author = author;
    this.ownsSandbox = ownsSandbox;
    this.base = base;
  }

  /** Absolute working folder inside the sandbox. */
  get dir(): string {
    return this.path ? `${this.root}/${this.path}` : this.root;
  }

  /**
   * Returns a new workspace whose commands run in `sub`, relative to the
   * current folder. Paths that leave the repo throw.
   *
   * @example
   * await ws.cwd("tests").run("python3 test.py");
   */
  cwd(sub: string): Workspace {
    return new Workspace(
      this.#http,
      this.sandbox,
      this.root,
      joinRepoPath(this.path, sub),
      this.author,
      this.ownsSandbox,
      this.base,
    );
  }

  /**
   * Runs a shell command in the working folder. Returns the result instead of
   * throwing on a non-zero exit, so a failing test is data.
   *
   * @example
   * const r = await ws.run("npm test");
   * if (r.result.exit_code !== 0) console.log(r.result.stderr);
   */
  run(command: string, options: ExecOptions = {}): Promise<ExecResponse> {
    return this.#runAt(this.dir, command, options);
  }

  /** Typed `git status`: branch, ahead/behind and every changed or untracked file. */
  async status(): Promise<GitStatus> {
    return parseStatus(await this.#git("status", `${PRELUDE}g status --porcelain=v2 --branch -z`));
  }

  /**
   * Everything changed since `base` (default `HEAD`), including uncommitted
   * and untracked files. Ignored files are left out.
   */
  async diff(options: DiffOptions = {}): Promise<GitDiff> {
    const base = options.base ?? "HEAD";
    const out = await this.#git(
      "diff",
      `${PRELUDE}${SNAPSHOT}O=$(mktemp -d); trap 'rm -rf "$O"' EXIT; s=$(snap)
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$O/objects"
b=$(g rev-parse -q --verify --end-of-options "$1^{commit}") || { echo "unknown revision: $1" >&2; exit 2; }
g diff --numstat -z "$b" "$s"; g diff \${2:+--binary} "$b" "$s"`,
      [base, options.binary ? "1" : ""],
    );
    // numstat -z ends every record with NUL; the patch text never contains one.
    const cut = out.lastIndexOf(NUL) + 1;
    return { base, files: parseNumstat(out.slice(0, cut)), patch: out.slice(cut) };
  }

  /**
   * Stages everything and commits. Returns the new sha, or `null` when there
   * was nothing to commit.
   */
  async commit(message: string, options: { allowEmpty?: boolean } = {}): Promise<string | null> {
    const out = await this.#locked(() =>
      this.#git(
        "commit",
        `${PRELUDE}g add -A
if [ -z "$2" ] && g diff --cached --quiet; then exit 0; fi
g commit -q $2 -m "$1"; g rev-parse HEAD`,
        [message, options.allowEmpty ? "--allow-empty" : ""],
      ),
    );
    return out.trim() || null;
  }

  /**
   * Saves the full working tree (uncommitted and untracked files too) without
   * changing the branch or the index. Pass the sha to `rollback` later.
   */
  async checkpoint(): Promise<string> {
    const out = await this.#locked(() =>
      this.#git(
        "checkpoint",
        `${PRELUDE}${SNAPSHOT}s=$(snap); g update-ref "refs/createos/checkpoints/$s" "$s"; printf '%s' "$s"`,
      ),
    );
    return out.trim();
  }

  /**
   * Restores a checkpoint (or any commit) exactly: HEAD, tracked and untracked
   * files. Untracked files created after the checkpoint are deleted.
   */
  async rollback(sha: string): Promise<void> {
    await this.#locked(() =>
      this.#git(
        "rollback",
        `${PRELUDE}c=$(g rev-parse -q --verify --end-of-options "$1^{commit}") || { echo "unknown revision: $1" >&2; exit 2; }
if g show-ref -q --verify "refs/createos/checkpoints/$c"; then
  g reset -q --hard "$c^"; g clean -fdq; g restore --source="$c" --worktree -- :/
else
  g reset -q --hard "$c"; g clean -fdq
fi`,
        [sha],
      ),
    );
  }

  /**
   * Creates a branch in a new sandbox. Uncommitted work comes along, and the
   * source workspace is left as it was.
   *
   * @example
   * const fix = await main.branch("fix-rounding");
   * await fix.cwd("tests").run("pytest");
   */
  async branch(name: string, options: BranchOptions = {}): Promise<Workspace> {
    const cleanup: CleanupFailure[] = [];
    return finish(await this.#branch(name, options, cleanup), cleanup);
  }

  async #branch(
    name: string,
    options: BranchOptions,
    cleanup: CleanupFailure[],
  ): Promise<Workspace> {
    if (options.via === "fork") {
      const head = (await this.#git("rev-parse", `${PRELUDE}g rev-parse HEAD`)).trim();
      const target = await this.#forkSandbox();
      try {
        await gitScript(
          target,
          "branch",
          `${PRELUDE}g checkout -q -b "$1"`,
          this.root,
          this.author,
          [name],
        );
      } catch (err) {
        await destroyQuietly(target);
        throw err;
      }
      return this.#child(target, head);
    }
    const pool = options.pool;
    if (pool) {
      if (pool.source !== this.#key)
        throw new CreateosSandboxError("this pool belongs to another workspace");
      // Refill only after this branch is done: a fill copies the whole repo
      // out of this source and would slow the branch down (measured 2x).
      try {
        for (let member = pool.take(); member; member = pool.take()) {
          const ws = await this.#warmInto(pool, member, name, options, cleanup);
          if (ws) return ws;
        }
      } finally {
        pool.refill();
      }
    }
    const made = await this.#cloneInto(options.create ?? {}, name, options, cleanup);
    return this.#child(made.sandbox, made.head);
  }

  /**
   * Starts a warm pool for this workspace: `size` sandboxes that already hold
   * a copy of the repo. `branch(name, { pool })` then takes one and moves only
   * what changed since it was filled, and a new member is filled in the
   * background. Pool sandboxes keep running (and cost money) until
   * `pool.close()`.
   *
   * @example
   * const pool = main.pool({ size: 2 });
   * await pool.whenReady();
   * const fix = await main.branch("fix", { pool });
   * await pool.close();
   */
  pool(options: PoolOptions): WarmPool {
    return new WarmPool(this.#key, options.size, async () => {
      const cleanup: CleanupFailure[] = [];
      return finish(await this.#cloneInto(options.create ?? {}, "", options, cleanup), cleanup);
    });
  }

  /**
   * Merges another workspace's committed work into this one. Conflicts and
   * gate failures leave this workspace unchanged.
   *
   * @example
   * const r = await main.merge(fix, { gate: "npm test" });
   * if (!r.merged) console.log(r.reason);
   */
  async merge(other: Workspace, options: MergeOptions = {}): Promise<MergeResult> {
    // The gate and the undo must see only their own merge, so merge holds the
    // repo lock that commit, checkpoint and rollback also take.
    const cleanup: CleanupFailure[] = [];
    return finish(await this.#locked(() => this.#merge(other, options, cleanup)), cleanup);
  }

  // Like git's own fetch negotiation: this repo lists its recent commits, and
  // the bundle leaves out every one of them the other side also has, so only
  // missing commits move. Full history goes only when the two repos share
  // none of them.
  // ponytail: only the last 1000 commits are offered; a longer divergence
  // falls back to full history.
  async #merge(
    other: Workspace,
    options: MergeOptions,
    cleanup: CleanupFailure[],
  ): Promise<MergeResult> {
    if (other.#key === this.#key)
      throw new CreateosSandboxError("cannot merge a workspace into itself");
    // A dirty target cannot be restored exactly after a failed gate, so refuse it.
    const [theirs, mine] = await Promise.all([
      other.#git("rev-parse", `${PRELUDE}g rev-parse HEAD; g symbolic-ref -q --short HEAD || echo`),
      this.#git(
        "merge",
        `${PRELUDE}g update-index -q --refresh >/dev/null || true
g diff-index --quiet HEAD -- || { echo "workspace has uncommitted changes: commit or checkpoint first" >&2; exit 6; }
g rev-list --max-count=1000 HEAD`,
      ),
    ]);
    const [head = "", branch = ""] = theirs.split("\n");
    const known = mine.split("\n").filter(Boolean);
    const pre = known[0]!;
    const upToDate = { merged: true, sha: pre, upToDate: true } as const;
    if (known.includes(head)) return upToDate;
    const bundle = `/tmp/createos-merge-${crypto.randomUUID()}.bundle`;
    const ref = `refs/createos/incoming/${crypto.randomUUID()}`;
    const message = options.message ?? `Merge branch '${branch || "detached HEAD"}'`;
    let tried: ExecResponse;
    let made = false;
    try {
      // Only commits this repo listed: anything else may be missing here and
      // would become a prerequisite the fetch cannot meet.
      const size = await other.#git(
        "bundle",
        `${PRELUDE}ex=$(g cat-file --batch-check='%(objectname) %(objecttype)' | awk '$2 == "commit" { print "^" $1 }')
# Nothing to send: this repo already has every commit.
[ -n "$(g rev-list -1 HEAD $ex)" ] || { echo empty; exit 0; }
g bundle create -q "$1" HEAD $ex; stat -c %s "$1"`,
        [bundle],
        known.join("\n"),
      );
      if (size.trim() === "empty") return upToDate;
      made = true;
      tried = await deliver(
        this.#http,
        other.sandbox,
        bundle,
        Number(size),
        this.sandbox,
        this.#target(
          `trap 'rm -f "$F"; g update-ref -d "$2" 2>/dev/null || true' EXIT
g fetch -q "$F" "+HEAD:$2"
if g merge-base --is-ancestor "$2" HEAD; then exit 21; fi
if out=$(g merge -q --no-ff --no-edit -m "$1" "$2" 2>&1); then
  # With a gate: remember the untracked files, so a failed gate's undo can
  # remove only what the gate created.
  [ -z "$3" ] || g ls-files -o -z > "$(g rev-parse --absolute-git-dir)/createos-gate-untracked"
  g rev-parse HEAD; exit 0
fi
# A conflict leaves unmerged paths. Anything else (for example an untracked
# file the merge would overwrite) is an error: keep git's own message.
if [ -n "$(g ls-files -u)" ]; then g diff --name-only --diff-filter=U -z; g merge --abort; exit 10; fi
g merge --abort 2>/dev/null || true
printf '%s\n' "$out" >&2; exit 11`,
          [message, ref, options.gate ? "gate" : ""],
        ),
        options,
        cleanup,
      );
    } catch (err) {
      made = true; // the bundle may be half written
      throw err;
    } finally {
      if (made) await other.#drop(bundle);
    }
    if (tried.result.exit_code === 21) return upToDate;
    if (tried.result.exit_code === 10) {
      return {
        merged: false,
        reason: "conflict",
        conflicts: tried.result.stdout.split(NUL).filter(Boolean),
      };
    }
    throwIfFailed("merge")(tried);
    if (options.gate) {
      // Back to the exact pre-merge commit, then remove untracked files the
      // gate created. Untracked files from before the merge stay.
      // ponytail: empty folders the gate created stay, and an untracked file
      // the gate changed (not created) cannot be restored.
      const undo = () =>
        this.#git(
          "merge-undo",
          `${PRELUDE}g reset -q --hard "$1"
L=$(g rev-parse --absolute-git-dir)/createos-gate-untracked
if [ -f "$L" ]; then
  g ls-files -o -z | sort -z > "$L.now"
  sort -z "$L" | comm -z -13 - "$L.now" | (cd "$R" && xargs -0 -r rm -f --)
  rm -f "$L" "$L.now"
fi`,
          [pre],
        );
      let gate: ExecResponse;
      try {
        gate = await this.#runAt(this.root, options.gate, { timeoutMs: LONG_TIMEOUT_MS });
      } catch (err) {
        await undo();
        throw err;
      }
      if (gate.result.exit_code !== 0) {
        await undo();
        return { merged: false, reason: "gate", gate };
      }
    }
    return { merged: true, sha: tried.result.stdout.trim(), upToDate: false };
  }

  /** Destroys the sandbox that `branch()` created for this workspace. */
  async discard(): Promise<void> {
    if (!this.ownsSandbox) {
      throw new CreateosSandboxError(
        "discard only destroys sandboxes created by branch(); destroy the sandbox directly",
      );
    }
    await this.sandbox.destroy();
  }

  // ── internals ──────────────────────────────────────────────────────────

  get #key(): string {
    return `${this.sandbox.id}:${this.root}`;
  }

  // One SDK change to this repo at a time (commit, checkpoint, rollback,
  // merge). Commands run with `run()` and file uploads are not covered.
  #locked<T>(task: () => Promise<T>): Promise<T> {
    return serialize(this.#key, task);
  }

  #child(sandbox: Sandbox, head: string): Workspace {
    return new Workspace(this.#http, sandbox, this.root, this.path, this.author, true, head);
  }

  #runAt(dir: string, command: string, options: ExecOptions = {}): Promise<ExecResponse> {
    return this.sandbox.runCommand(
      "bash",
      ["-lc", 'cd -- "$1" && eval "$2"', "ws", dir, command],
      options,
    );
  }

  #git(action: string, script: string, args: string[] = [], stdin?: string): Promise<string> {
    return gitScript(this.sandbox, action, script, this.root, this.author, args, stdin);
  }

  // Removes a transfer file from this sandbox and stops its network listener.
  async #drop(file: string): Promise<void> {
    await runGit(this.sandbox, `${PRELUDE}${DROP}drop "$1"`, this.root, this.author, [file]).catch(
      () => undefined,
    );
  }

  // The target half of a `deliver`: runs in this workspace's repo.
  #target(script: string, args: string[]): TargetScript {
    return { script, root: this.root, author: this.author, args };
  }

  // New sandbox with the same shape, then the repo arrives as one archive
  // with the source's uncommitted work restored on top of HEAD. The new
  // sandbox boots while the archive is built. `name` empty = no checkout -b.
  //
  // The whole .git folder travels as one archive. Unlike a bundle this keeps
  // shallow history, remotes, tags and other branches. The working tree is
  // rebuilt from a snapshot commit so uncommitted and untracked files come
  // too, and the source's index rides along, so staged changes stay staged.
  // The snapshot's objects live in a temp folder that rides along as a second
  // objects/ tree in the same archive, so the source repo is never modified
  // and parallel branches from one source cannot collide. tar exits 1 when
  // files change mid-read (the user may still be working); git objects are
  // immutable once written, so that is harmless.
  async #cloneInto(
    overrides: Partial<CreateSandboxRequest>,
    name: string,
    options: CopyOptions,
    cleanup: CleanupFailure[],
  ): Promise<PoolMember & { head: string }> {
    const archive = `/tmp/createos-branch-${crypto.randomUUID()}.tar`;
    const view: SandboxView = this.sandbox.data;
    const spawned = spawnSandbox(this.#http, {
      shape: view.shape ?? "s-1vcpu-1gb",
      ...(view.disk_mib ? { disk_mib: view.disk_mib } : {}),
      ...(view.rootfs ? { rootfs: view.rootfs } : {}),
      ...(view.egress?.length ? { egress: view.egress } : {}),
      ...overrides,
    });
    // Same image: the source's zstd answer holds for both ends. Another image
    // must be asked first, which costs the overlap with the boot.
    const otherImage = overrides.rootfs !== undefined && overrides.rootfs !== view.rootfs;
    const peer = otherImage
      ? spawned.then(async (t) =>
          (await t.runCommand("sh", ["-c", "command -v zstd >/dev/null"])).result.exit_code === 0
            ? ""
            : "gzip",
        )
      : Promise.resolve("");
    const packed = peer.then((p) =>
      this.#git(
        "archive",
        `${PRELUDE}${SNAPSHOT}${COMPRESS}O=$(mktemp -d); trap 'rm -rf "$O"' EXIT; s=$(snap); c=$(codec "$2")
tar --warning=no-file-changed -I "$(compressor "$c")" -cf "$1" -C "$(g rev-parse --absolute-git-dir)" . -C "$O" objects || [ $? -eq 1 ]
printf '%s %s %s %s' "$(g rev-parse HEAD)" "$s" "$c" "$(stat -c %s "$1")"`,
        [archive, p],
      ),
    );
    const [boot, pack] = await Promise.allSettled([spawned, packed]);
    const target = boot.status === "fulfilled" ? boot.value : undefined;
    try {
      if (pack.status === "rejected") throw pack.reason;
      if (boot.status === "rejected") throw boot.reason;
      const [head = "", snap = "", codec = "", size = "0"] = pack.value.split(" ");
      const r = await deliver(
        this.#http,
        this.sandbox,
        archive,
        Number(size),
        target!,
        this.#target(
          `mkdir -p "$R/.git"; tar -I "$1" -C "$R/.git" -xf "$F"
g restore --source="$2" --worktree -- :/
[ -z "$3" ] || g checkout -q -b "$3"
g for-each-ref --format='%(objectname)' | sort -u`,
          [codec, snap, name],
        ),
        options,
        cleanup,
      );
      // A pool member remembers which commits it has: its ref tips plus the snapshot.
      const tips = throwIfFailed("unpack")(r).result.stdout.split("\n").filter(Boolean);
      return { sandbox: target!, head, snap, codec, tips: [...tips, snap] };
    } catch (err) {
      if (target) await destroyQuietly(target);
      throw err;
    } finally {
      await this.#drop(archive);
    }
  }

  // Warm branch: the pool member already holds an older copy of this repo.
  // The source sends only objects the member lacks (a pack against the
  // member's ref tips) plus .git without objects/ (refs, HEAD, index,
  // config). The member moves its tree to the snapshot, touching only
  // changed files, and takes the metadata verbatim.
  // Returns undefined when the member is dead, so the caller tries the next.
  async #warmInto(
    pool: WarmPool,
    member: PoolMember,
    name: string,
    options: CopyOptions,
    cleanup: CleanupFailure[],
  ): Promise<Workspace | undefined> {
    const file = `/tmp/createos-warm-${crypto.randomUUID()}.tar`;
    const alive = member.sandbox.runCommand("true").then(
      (r) => r.result.exit_code === 0,
      () => false,
    );
    let packed: string;
    try {
      packed = await this.#git(
        "warm-pack",
        `${PRELUDE}${SNAPSHOT}${COMPRESS}F=$1; C=$2
D=$(g rev-parse --absolute-git-dir); O=$(mktemp -d); W=$(mktemp -d); trap 'rm -rf "$O" "$W"' EXIT
s=$(snap); export GIT_ALTERNATE_OBJECT_DIRECTORIES="$O/objects"
{ echo "$s"; g cat-file --batch-check='%(objectname) %(objecttype)' | awk '$2 == "commit" || $2 == "tag" { print "^" $1 }'; } |
  g pack-objects --revs --all --stdout -q > "$W/delta.pack"
tar --warning=no-file-changed -C "$D" --exclude=./objects -cf "$W/meta.tar" . || [ $? -eq 1 ]
tar -I "$(compressor "$C")" -C "$W" -cf "$F" delta.pack meta.tar
printf '%s %s %s' "$(g rev-parse HEAD)" "$s" "$(stat -c %s "$F")"`,
        [file, member.codec],
        member.tips.join("\n"),
      );
    } catch (err) {
      // A source failure says nothing about the member: keep it.
      if (await alive) pool.give(member);
      else pool.drop(member);
      throw err;
    }
    const [head = "", snap = "", size = "0"] = packed.split(" ");
    try {
      if (!(await alive)) {
        pool.drop(member);
        return undefined;
      }
      const r = await deliver(
        this.#http,
        this.sandbox,
        file,
        Number(size),
        member.sandbox,
        this.#target(
          `C=$1; S=$2; P=$3; B=$4
W=$(mktemp -d); trap 'rm -rf "$W" "$F"' EXIT
tar -I "$C" -C "$W" -xf "$F"
g index-pack --stdin < "$W/delta.pack" >/dev/null
g read-tree "$P"; g read-tree -u --reset "$S"; g clean -ffdxq
D=$(g rev-parse --absolute-git-dir)
find "$D" -mindepth 1 -maxdepth 1 ! -name objects -exec rm -rf {} +
tar -C "$D" -xf "$W/meta.tar"
g checkout -q -b "$B"`,
          [member.codec, snap, member.snap, name],
        ),
        options,
        cleanup,
      );
      throwIfFailed("warm-apply")(r);
    } catch (err) {
      pool.drop(member);
      throw err;
    } finally {
      await this.#drop(file);
    }
    return this.#child(member.sandbox, head);
  }

  // Pause, fork, resume. The source always resumes, even when the fork fails,
  // and a fork that does not come up is destroyed.
  async #forkSandbox(): Promise<Sandbox> {
    const source = this.sandbox;
    let fork: Sandbox | undefined;
    try {
      try {
        await source.pause();
        await source.waitUntilPaused();
        // The paused bundle uploads asynchronously; fork answers 409 until it lands.
        for (let attempt = 0; !fork; attempt++) {
          try {
            fork = await source.fork({ start_paused: false });
          } catch (err) {
            if (
              !(err instanceof CreateosSandboxApiError) ||
              err.statusCode !== 409 ||
              attempt >= 60
            )
              throw err;
            await sleep(500);
          }
        }
      } finally {
        await source.resume();
        await source.waitUntilRunning();
      }
      await fork.waitUntilRunning();
      return fork;
    } catch (err) {
      if (fork) await destroyQuietly(fork);
      throw err;
    }
  }
}

const destroyQuietly = (sandbox: Sandbox) => sandbox.destroy().catch(() => undefined);

/** A pool sandbox holding a copy of the repo at snapshot `snap`. */
export interface PoolMember {
  sandbox: Sandbox;
  snap: string;
  codec: string;
  /** Commits the member has: its ref tips plus `snap`. */
  tips: string[];
}

/**
 * Ready sandboxes that already hold a copy of one workspace's repo. Made by
 * `workspace.pool()`, used by `workspace.branch(name, { pool })`.
 *
 * After each pool branch, background fills bring it back to `size`. A fill
 * that fails is recorded in `lastError` and retried after the next branch.
 */
export class WarmPool {
  /** Pool owner key (`<sandbox id>:<repo root>`). */
  readonly source: string;
  readonly size: number;
  /** The last background fill failure, if any. */
  lastError: unknown;
  readonly #fill: () => Promise<PoolMember>;
  readonly #idle: PoolMember[] = [];
  readonly #pending = new Set<Promise<void>>();
  // Member destroys in flight, and the ones that failed, so close() can wait
  // for every paid sandbox to be gone and say so when one is not.
  readonly #destroying = new Set<Promise<void>>();
  readonly #destroyFailures: { id: string; error: unknown }[] = [];
  #closed = false;

  constructor(source: string, size: number, fill: () => Promise<PoolMember>) {
    if (!Number.isInteger(size) || size < 1)
      throw new CreateosSandboxError(`pool size must be a positive integer: ${size}`);
    this.source = source;
    this.size = size;
    this.#fill = fill;
    this.refill();
  }

  /** Members ready to take now. */
  get ready(): number {
    return this.#idle.length;
  }

  /** Resolves once every fill started so far has finished (or failed). */
  async whenReady(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled(this.#pending);
  }

  /**
   * Stops refilling and destroys every idle member, including members whose
   * fill finishes during the close. Resolves once they are all gone. Members
   * already taken by `branch()` are not touched.
   *
   * @throws {CreateosSandboxError} when a pool sandbox could not be destroyed;
   *   the message lists their ids.
   */
  async close(): Promise<void> {
    this.#closed = true;
    await this.whenReady();
    for (const member of this.#idle.splice(0)) this.drop(member);
    while (this.#destroying.size) await Promise.all(this.#destroying);
    const failed = this.#destroyFailures.splice(0);
    if (failed.length) {
      throw new CreateosSandboxError(
        `could not destroy ${failed.length} pool sandbox(es): ${failed
          .map((f) => `${f.id} (${errorText(f.error)})`)
          .join(", ")}`,
        { cause: failed[0]!.error },
      );
    }
  }

  /** @internal */
  take(): PoolMember | undefined {
    return this.#idle.shift();
  }

  /** @internal Puts an unused member back. */
  give(member: PoolMember): void {
    if (this.#closed) this.drop(member);
    else this.#idle.unshift(member);
  }

  /** @internal Destroys a dead or half-used member. A sandbox already gone counts as done. */
  drop(member: PoolMember): void {
    const { id } = member.sandbox;
    WarmPool.#track(
      this.#destroying,
      member.sandbox.destroy().then(
        () => undefined,
        (error: unknown) => {
          if (!(error instanceof CreateosSandboxNotFoundError))
            this.#destroyFailures.push({ id, error });
        },
      ),
    );
  }

  // Keeps `job` in `set` until it settles, so callers can wait for all of them.
  static #track(set: Set<Promise<void>>, job: Promise<void>): void {
    const tracked = job.finally(() => set.delete(tracked));
    set.add(tracked);
  }

  /** @internal Starts background fills until the pool is back to `size`. */
  refill(): void {
    while (!this.#closed && this.#idle.length + this.#pending.size < this.size) {
      const job = (async () => {
        let member: PoolMember | undefined;
        try {
          member = await this.#fill();
          this.lastError = undefined;
        } catch (err) {
          this.lastError = err;
          // The member was made; only a token or network release failed.
          if (err instanceof CreateosSandboxCleanupError) member = err.outcome as PoolMember;
        }
        // drop() is tracked, so a close() waiting on this fill also waits
        // for the destroy.
        if (member && this.#closed) this.drop(member);
        else if (member) this.#idle.push(member);
      })();
      WarmPool.#track(this.#pending, job);
      // A failed fill must not refill at once, or a broken source loops.
      if (this.lastError) break;
    }
  }
}
