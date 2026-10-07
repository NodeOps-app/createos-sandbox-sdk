import { describe, expect, test } from "bun:test";
import {
  CreateosSandboxCleanupError,
  CreateosSandboxError,
  CreateosSandboxGitError,
  type ExecResponse,
  type Workspace,
} from "../src/index.ts";
import { joinRepoPath, parseNumstat, parseStatus } from "../src/git.ts";
import { CREATE_RESPONSE, RUNNING_VIEW, catchErr, fail, makeClient, success } from "./helpers.ts";

// A tiny fake control plane. Exec calls are answered by `onExec`, which sees
// the bash script (args[1]) and the positional arguments after the author.
type ExecCall = {
  sandbox: string;
  cmd: string;
  script: string;
  args: string[];
  cmdArgs: string[];
  stdin?: string;
};
type Reply = Partial<ExecResponse["result"]> | undefined;
// A test may hold an exec open (a slow gate) by returning a promise.
type AsyncReply = Reply | Promise<Reply>;

function fakePlane(onExec: (call: ExecCall) => AsyncReply) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const execs: ExecCall[] = [];
  const files = new Map<string, string>();
  let next = 2;
  const client = makeClient((url, init) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
    // A test can take over any call, for example to fail or delay it.
    const taken = plane.override?.(method, u.pathname);
    if (taken) return taken;
    const id = u.pathname.split("/")[3] ?? "";
    if (method === "POST" && u.pathname === "/v1/sandboxes") {
      return Promise.resolve(success({ ...CREATE_RESPONSE, id: `sb_${next++}` }));
    }
    if (u.pathname.endsWith("/exec")) {
      const cmdArgs: string[] = body.args;
      const call = {
        sandbox: id,
        cmd: body.cmd,
        script: cmdArgs[1] ?? "",
        args: cmdArgs.slice(6),
        cmdArgs,
        stdin: body.stdin,
      };
      execs.push(call);
      return Promise.resolve(onExec(call)).then((r) =>
        success({ result: { stdout: "", stderr: "", exit_code: 0, ...r }, exec_ms: 1 }),
      );
    }
    if (u.pathname.endsWith("/files")) {
      const key = `${id}:${u.searchParams.get("path")}`;
      if (method === "PUT") {
        files.set(key, "bytes");
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(files.get(key) ?? "bytes"));
    }
    if (u.pathname.endsWith("/access-token")) {
      if (method === "POST") {
        return Promise.resolve(
          plane.tokenStatus === 201
            ? success({ token: "tok", enabled: true, created_at: "x" })
            : fail("token exists", plane.tokenStatus),
        );
      }
      if (method === "GET")
        return Promise.resolve(success({ enabled: true, token_hint: plane.tokenHint }));
      return Promise.resolve(success({ enabled: false }));
    }
    if (method === "POST" && u.pathname === "/v1/networks")
      return Promise.resolve(success({ id: "net_1", name: body.name, created_at: "x" }));
    if (u.pathname.endsWith("/networks") && method === "POST") {
      plane.attached.add(id);
      return Promise.resolve(success({ ok: true }));
    }
    if (method === "GET" && u.pathname === "/v1/networks/net_1") {
      const members = [...plane.attached].map((sid, i) => ({
        sandbox_id: sid,
        status: "running",
        ip: `10.9.0.${i + 1}`,
      }));
      return Promise.resolve(success({ id: "net_1", name: "n", created_at: "x", members }));
    }
    if (u.pathname.endsWith("/fork")) {
      return Promise.resolve(success({ ...RUNNING_VIEW, id: "sb_fork" }));
    }
    if (method === "DELETE") return Promise.resolve(success({ destroyed: true }));
    if (u.pathname.endsWith("/pause"))
      return Promise.resolve(success({ ...RUNNING_VIEW, id, status: "paused" }));
    if (u.pathname.endsWith("/resume")) return Promise.resolve(success({ ...RUNNING_VIEW, id }));
    return Promise.resolve(
      success({ ...RUNNING_VIEW, id, status: pausedIds.has(id) ? "paused" : "running" }),
    );
  });
  const pausedIds = new Set<string>();
  const plane = {
    client,
    calls,
    execs,
    files,
    pausedIds,
    attached: new Set<string>(),
    override: undefined as
      | ((method: string, path: string) => Promise<Response> | undefined)
      | undefined,
    tokenStatus: 201,
    tokenHint: "t...k",
  };
  return plane;
}

const ROOT = "/workspace/app";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SNAP = "c".repeat(40);
const BIG = 200 * 1024 * 1024;
// Default exec behaviour: register finds the repo root, rev-parse returns a
// sha, and the archive / pack / bundle scripts report a small file.
const repoAt =
  (root = ROOT, extra: (c: ExecCall) => Reply = () => undefined) =>
  (c: ExecCall): Reply => {
    const own = extra(c);
    if (own) return own;
    const has = (t: string) => c.script.includes(t);
    if (has("show-toplevel")) return { stdout: `${root}\n` };
    if (has("tar --warning=no-file-changed -I")) return { stdout: `${SHA} ${SNAP} zstd 100` };
    if (has("pack-objects")) return { stdout: `${SHA} ${SNAP} 100` };
    if (has("bundle create")) return { stdout: "100\n" };
    if (has("nc -l")) return { stdout: "100\n" };
    if (has("rev-list --max-count")) return { stdout: `${SHA}\n` };
    if (has("for-each-ref")) return { stdout: `${SHA}\n` };
    if (has("g rev-parse HEAD")) return { stdout: `${SHA}\n` };
    return undefined;
  };
const isUnpack = (c: ExecCall) => c.script.includes('tar -I "$1" -C "$R/.git"');
const lastUnpack = (xs: ExecCall[]) =>
  xs.reduce<ExecCall | undefined>((last, c) => (isUnpack(c) ? c : last), undefined)!;
const isMerge = (e: ExecCall) => e.script.includes("merge -q --no-ff");
const netCalls = (calls: { method: string; path: string }[]) =>
  calls.filter((c) => c.path.includes("/networks")).map((c) => `${c.method} ${c.path}`);
const isApply = (e: ExecCall) => e.script.includes("index-pack --stdin");
const noNet = (c: ExecCall): Reply => (c.script.includes("nc -l") ? { exit_code: 32 } : undefined);

async function mainWorkspace(onExec: (c: ExecCall) => AsyncReply = repoAt()) {
  const plane = fakePlane(onExec);
  const sb = await plane.client.getSandbox("sb_1");
  const ws = await sb.git.register(ROOT);
  return { ...plane, plane, sb, ws };
}

describe("joinRepoPath", () => {
  test("normalises and refuses escapes", () => {
    expect(joinRepoPath("", "tests/")).toBe("tests");
    expect(joinRepoPath("a/b", "../c/./d")).toBe("a/c/d");
    expect(joinRepoPath("a", "..")).toBe("");
    expect(() => joinRepoPath("", "..")).toThrow(CreateosSandboxError);
    expect(() => joinRepoPath("a", "../../x")).toThrow("escapes");
    expect(() => joinRepoPath("", "/etc")).toThrow("relative");
    expect(() => joinRepoPath("", "a\u0000b")).toThrow("NUL");
  });
});

describe("parseStatus", () => {
  test("reads branch header, changed, renamed, unmerged and untracked entries", () => {
    const raw = [
      `# branch.oid ${SHA}`,
      "# branch.head feature",
      "# branch.upstream origin/feature",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 aaa bbb src/a file.py",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.py",
      "old.py",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.py",
      "? notes.txt",
      "",
    ].join("\u0000");
    const s = parseStatus(raw);
    expect(s).toMatchObject({
      branch: "feature",
      head: SHA,
      upstream: "origin/feature",
      ahead: 2,
      behind: 3,
      clean: false,
    });
    expect(s.files).toEqual([
      { path: "src/a file.py", kind: "changed", index: ".", worktree: "M" },
      { path: "new.py", from: "old.py", kind: "renamed", index: "R", worktree: "." },
      { path: "conflict.py", kind: "unmerged", index: "U", worktree: "U" },
      { path: "notes.txt", kind: "untracked", index: "?", worktree: "?" },
    ]);
  });

  test("handles detached HEAD and an initial repo", () => {
    expect(parseStatus("# branch.oid (initial)\u0000# branch.head (detached)\u0000")).toMatchObject(
      {
        head: null,
        branch: null,
        clean: true,
        files: [],
      },
    );
  });
});

describe("parseNumstat", () => {
  test("reads counts, binaries and renames", () => {
    const raw = ["3\t1\ta.py", "-\t-\tlogo.png", "2\t0\t", "old.py", "new.py", ""].join("\u0000");
    expect(parseNumstat(raw)).toEqual([
      { path: "a.py", added: 3, deleted: 1, binary: false },
      { path: "logo.png", added: 0, deleted: 0, binary: true },
      { path: "new.py", added: 2, deleted: 0, binary: false },
    ]);
  });
});

describe("register / clone", () => {
  test("register passes the path as an argument and keeps the subfolder as cwd", async () => {
    const plane = fakePlane(repoAt());
    const sb = await plane.client.getSandbox("sb_1");
    const ws = await sb.git.register(`${ROOT}/tests/unit`, { author: { name: "A", email: "a@x" } });
    expect(ws.root).toBe(ROOT);
    expect(ws.path).toBe("tests/unit");
    expect(ws.dir).toBe(`${ROOT}/tests/unit`);
    expect(ws.author).toEqual({ name: "A", email: "a@x" });
    expect(ws.ownsSandbox).toBe(false);
    const call = plane.execs[0]!;
    expect(call.cmdArgs.slice(2, 6)).toEqual(["git", `${ROOT}/tests/unit`, "A", "a@x"]);
    expect(call.script).not.toContain(ROOT); // never interpolated
  });

  test("register sends init when asked", async () => {
    const plane = fakePlane(repoAt());
    const sb = await plane.client.getSandbox("sb_1");
    await sb.git.register(ROOT, { init: true });
    expect(plane.execs[0]!.args).toEqual(["init"]);
  });

  test("register rejects relative paths and surfaces git errors", async () => {
    const plane = fakePlane(() => ({ exit_code: 3, stderr: "not a git repository" }));
    const sb = await plane.client.getSandbox("sb_1");
    expect(await catchErr(() => sb.git.register("app"))).toBeInstanceOf(CreateosSandboxError);
    const err = await catchErr(() => sb.git.register("/plain"));
    expect(err).toBeInstanceOf(CreateosSandboxGitError);
    expect((err as CreateosSandboxGitError).exitCode).toBe(3);
    expect((err as CreateosSandboxGitError).message).toContain("not a git repository");
  });

  test("clone passes url, branch and depth as arguments, then registers", async () => {
    const plane = fakePlane(repoAt());
    const sb = await plane.client.getSandbox("sb_1");
    const ws = await sb.git.clone("https://x.test/r.git", ROOT, {
      branch: "dev",
      depth: 1,
      author: { name: "B", email: "b@x" },
    });
    expect(plane.execs[0]!.args).toEqual([
      "https://x.test/r.git",
      "--branch",
      "dev",
      "--depth",
      "1",
    ]);
    expect(ws.author.name).toBe("B");
    expect(await catchErr(() => sb.git.clone("u", "rel"))).toBeInstanceOf(CreateosSandboxError);
  });

  test("clone without options sends only the url", async () => {
    const plane = fakePlane(repoAt());
    const sb = await plane.client.getSandbox("sb_1");
    await sb.git.clone("https://x.test/r.git", ROOT);
    expect(plane.execs[0]!.args).toEqual(["https://x.test/r.git"]);
  });
});

describe("cwd / run", () => {
  test("cwd returns a new handle and run executes in that folder", async () => {
    const { ws, execs } = await mainWorkspace();
    const t = ws.cwd("tests");
    expect(t).not.toBe(ws);
    expect(ws.path).toBe("");
    expect(t.cwd("unit").dir).toBe(`${ROOT}/tests/unit`);
    await t.run("python3 test.py", { env: { A: "1" } });
    const last = execs.at(-1)!;
    expect(last.cmdArgs).toEqual([
      "-lc",
      'cd -- "$1" && eval "$2"',
      "ws",
      `${ROOT}/tests`,
      "python3 test.py",
    ]);
  });
});

describe("status / diff / commit / checkpoint / rollback", () => {
  test("status parses porcelain output", async () => {
    const { ws } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        c.script.includes("--porcelain=v2")
          ? { stdout: "# branch.head main\u0000? x\u0000" }
          : undefined,
      ),
    );
    expect(await ws.status()).toMatchObject({
      branch: "main",
      files: [{ path: "x", kind: "untracked" }],
    });
  });

  test("diff splits numstat and patch and passes the base as an argument", async () => {
    const { ws, execs } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        c.script.includes("--numstat")
          ? { stdout: "1\t0\ta\tb.py\u0000diff --git a/a.py" }
          : undefined,
      ),
    );
    const d = await ws.diff({ base: "main~1" });
    expect(d).toEqual({
      base: "main~1",
      files: [{ path: "a\tb.py", added: 1, deleted: 0, binary: false }], // tabs in names survive
      patch: "diff --git a/a.py",
    });
    expect(execs.at(-1)!.args).toEqual(["main~1", ""]); // binary contents are opt-in
    expect((await ws.diff()).base).toBe("HEAD");
    await ws.diff({ binary: true });
    expect(execs.at(-1)!.args).toEqual(["HEAD", "1"]);
  });

  test("commit returns the sha, or null when there was nothing to commit", async () => {
    let out = `${SHA}\n`;
    const { ws, execs } = await mainWorkspace(
      repoAt(ROOT, (c) => (c.script.includes("g commit") ? { stdout: out } : undefined)),
    );
    expect(await ws.commit("msg")).toBe(SHA);
    expect(execs.at(-1)!.args).toEqual(["msg", ""]);
    out = "";
    expect(await ws.commit("empty", { allowEmpty: true })).toBeNull();
    expect(execs.at(-1)!.args).toEqual(["empty", "--allow-empty"]);
  });

  test("checkpoint stores a ref and rollback restores it", async () => {
    const { ws, execs } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        c.script.includes("refs/createos/checkpoints") ? { stdout: SHA } : undefined,
      ),
    );
    expect(await ws.checkpoint()).toBe(SHA);
    await ws.rollback(SHA);
    expect(execs.at(-1)!.args).toEqual([SHA]);
    expect(execs.at(-1)!.script).toContain("clean -fdq");
  });
});

describe("branch", () => {
  test("clone mode copies the repo into a new sandbox with the same shape", async () => {
    const { ws, calls, execs, sb } = await mainWorkspace();
    const b = await ws.branch("feature", { create: { disk_mib: 20480 } });
    expect(b.sandbox.id).toBe("sb_2");
    expect(b.ownsSandbox).toBe(true);
    expect(b.base).toBe(SHA);
    expect(b.root).toBe(ROOT);
    const create = calls.find((c) => c.method === "POST" && c.path === "/v1/sandboxes")!;
    expect(create.body).toMatchObject({ disk_mib: 20480 });
    const pack = execs.find((e) => e.script.includes("tar --warning"))!;
    const archive = pack.args[0]!;
    expect(archive).toMatch(/^\/tmp\/createos-branch-.*\.tar$/);
    expect(pack.args[1]).toBe(""); // same image: the source decides the codec
    expect(pack.script).toContain("zstd -q -3 -T$n");
    // The new sandbox pulls the archive itself, with a token scoped to the
    // source, then unpacks and checks out the branch in the same call.
    const unpack = execs.find(isUnpack)!;
    expect(unpack.sandbox).toBe("sb_2");
    expect(unpack.args).toEqual([
      archive,
      "token",
      `https://example.test/v1/sandboxes/${sb.id}/files?path=${encodeURIComponent(archive)}`,
      "zstd",
      SNAP,
      "feature",
    ]);
    expect(unpack.stdin).toContain("tok");
    expect(unpack.cmdArgs).not.toContain("tok");
    expect(
      calls.some((c) => c.method === "DELETE" && c.path === `/v1/sandboxes/${sb.id}/access-token`),
    ).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/files"))).toBe(false);
    expect(calls.some((c) => c.path.startsWith("/v1/networks"))).toBe(false); // small: no network
    // Round trips: archive, unpack, cleanup. No separate HEAD, codec probe or checkout.
    expect(execs.map((e) => e.sandbox)).toEqual(["sb_1", "sb_1", "sb_2", "sb_1"]);
    expect(execs.at(-1)!.script).toContain("rm -f");
    await ws.branch("same-disk");
    const creates = calls.filter((c) => c.method === "POST" && c.path === "/v1/sandboxes");
    const copied = creates[1]!;
    expect(copied.body).toMatchObject({ disk_mib: RUNNING_VIEW.disk_mib }); // source size by default
  });

  test("another image is asked about zstd first and gets gzip when it lacks it", async () => {
    const { ws, execs } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        c.sandbox === "sb_2" && c.script.includes("command -v zstd")
          ? { exit_code: 1 }
          : c.script.includes("tar --warning") && c.args[1] === "gzip"
            ? { stdout: `${SHA} ${SNAP} gzip 100` }
            : undefined,
      ),
    );
    await ws.branch("feature", { create: { rootfs: "debian:13" } });
    expect(execs.find((e) => e.script.includes("tar --warning"))!.args[1]).toBe("gzip");
    expect(execs.find(isUnpack)!.args[3]).toBe("gzip");
  });

  test("parallel branches share one source token and separate archives", async () => {
    const { ws, execs, calls } = await mainWorkspace();
    await Promise.all([ws.branch("a"), ws.branch("b"), ws.branch("c")]);
    const packs = execs.filter((e) => e.script.includes("tar --warning"));
    expect(new Set(packs.map((p) => p.args[0])).size).toBe(3);
    // The snapshot never touches the source repo: objects go to a temp folder.
    expect(packs[0]!.script).toContain("O=$(mktemp -d)");
    expect(packs[0]!.script).not.toContain("update-ref");
    const tokenCalls = calls.filter((c) => c.path === "/v1/sandboxes/sb_1/access-token");
    expect(tokenCalls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
    expect(execs.filter(isUnpack)).toHaveLength(3);
  });

  test("clone mode destroys the new sandbox when unpacking fails", async () => {
    const { ws, calls } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        c.sandbox === "sb_2" && isUnpack(c) ? { exit_code: 1, stderr: "bad tar" } : undefined,
      ),
    );
    const err = await catchErr(() => ws.branch("x"));
    expect(err).toBeInstanceOf(CreateosSandboxGitError);
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/sandboxes/sb_2")).toBe(true);
  });

  test("fork mode pauses, forks, and always resumes the source", async () => {
    const plane = fakePlane(repoAt());
    plane.pausedIds.add("sb_1");
    const sb = await plane.client.getSandbox("sb_1");
    plane.pausedIds.clear();
    const ws = await sb.git.register(ROOT);
    plane.pausedIds.add("sb_1");
    const pending = ws.branch("f", { via: "fork" });
    // waitUntilPaused sees "paused"; clear it before resume polling.
    setTimeout(() => plane.pausedIds.clear(), 0);
    const b = await pending;
    expect(b.sandbox.id).toBe("sb_fork");
    const order = plane.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.path.split("/").pop());
    expect(order).toEqual(["exec", "exec", "pause", "fork", "resume", "exec"]);
  });

  test("fork mode retries 409 while the bundle uploads and resumes on failure", async () => {
    let forks = 0;
    const plane = fakePlane(repoAt());
    const sb = await plane.client.getSandbox("sb_1");
    const ws = await sb.git.register(ROOT);
    const client = makeClient(
      (url, init) => {
        const p = new URL(String(url)).pathname;
        if (p.endsWith("/fork")) {
          forks++;
          return Promise.resolve(forks < 2 ? fail("bundle still uploading", 409) : fail("no", 400));
        }
        if (p.endsWith("/exec"))
          return Promise.resolve(
            success({ result: { stdout: SHA, stderr: "", exit_code: 0 }, exec_ms: 1 }),
          );
        if (p.endsWith("/pause"))
          return Promise.resolve(success({ ...RUNNING_VIEW, status: "paused" }));
        const paused = (init.method ?? "GET") === "GET" && forks === 0;
        return Promise.resolve(success({ ...RUNNING_VIEW, status: paused ? "paused" : "running" }));
      },
      { retry: false },
    );
    const sb2 = await client.getSandbox("sb_1");
    const ws2 = new (ws.constructor as typeof Workspace)(
      client.http,
      sb2,
      ROOT,
      "",
      ws.author,
      false,
      null,
    );
    const err = await catchErr(() => ws2.branch("f", { via: "fork" }));
    expect(err).toBeInstanceOf(CreateosSandboxError);
    expect(forks).toBe(2);
  });
});

describe("merge", () => {
  async function pair(onExec: (c: ExecCall) => Reply) {
    // The branch (sb_2) has moved on to SHA2.
    const plane = fakePlane(
      repoAt(
        ROOT,
        (c) =>
          onExec(c) ??
          (c.sandbox === "sb_2" && c.script.includes("symbolic-ref")
            ? { stdout: `${SHA2}\nfeature\n` }
            : undefined),
      ),
    );
    const sb = await plane.client.getSandbox("sb_1");
    const main = await sb.git.register(ROOT);
    const b = await main.branch("feature");
    plane.execs.length = 0;
    plane.calls.length = 0;
    return { ...plane, main, b };
  }

  test("sends only new commits and merges in one call on the target", async () => {
    const { main, b, execs } = await pair(() => undefined);
    const r = await main.merge(b, { message: "merge it" });
    expect(r).toEqual({ merged: true, sha: SHA, upToDate: false });
    const bundle = execs.find((e) => e.sandbox === "sb_2" && e.script.includes("bundle create"))!;
    expect(bundle.stdin).toBe(SHA); // the target's commits, on stdin
    const merge = execs.find(isMerge)!;
    expect(merge.sandbox).toBe("sb_1");
    expect(merge.args.slice(1, 2)).toEqual(["token"]);
    expect(merge.args[3]).toBe("merge it");
    expect(merge.args[4]).toStartWith("refs/createos/incoming/");
    expect(merge.script).toContain('update-ref -d "$2"'); // the ref is dropped in the same call
  });

  test("default message names the other branch", async () => {
    const { main, b, execs } = await pair(() => undefined);
    await main.merge(b);
    expect(execs.find(isMerge)!.args[3]).toBe("Merge branch 'feature'");
  });

  test("an unchanged branch is up to date without any transfer", async () => {
    const { main, b, execs } = await pair((c) =>
      c.sandbox === "sb_1" && c.script.includes("rev-list --max-count")
        ? { stdout: `${SHA}\n${SHA2}\n` }
        : undefined,
    );
    expect(await main.merge(b)).toEqual({ merged: true, sha: SHA, upToDate: true });
    expect(execs.some((e) => e.script.includes("bundle create"))).toBe(false);
  });

  test("an empty bundle means up to date and moves nothing", async () => {
    const { main, b, execs, calls } = await pair((c) =>
      c.script.includes("bundle create") ? { stdout: "empty\n" } : undefined,
    );
    expect(await main.merge(b)).toEqual({ merged: true, sha: SHA, upToDate: true });
    expect(execs.some(isMerge)).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/access-token"))).toBe(false);
  });

  test("an already merged branch reports up to date", async () => {
    const { main, b } = await pair((c) => (isMerge(c) ? { exit_code: 21 } : undefined));
    expect(await main.merge(b, { gate: "false" })).toMatchObject({ merged: true, upToDate: true });
  });

  test("conflicts come back as data", async () => {
    const { main, b } = await pair((c) =>
      isMerge(c) ? { exit_code: 10, stdout: "a.py\u0000b.py\u0000" } : undefined,
    );
    expect(await main.merge(b)).toEqual({
      merged: false,
      reason: "conflict",
      conflicts: ["a.py", "b.py"],
    });
  });

  test("a failing gate undoes the merge", async () => {
    const { main, b, execs } = await pair((c) =>
      c.cmdArgs.at(-1) === "npm test" ? { exit_code: 1, stderr: "boom" } : undefined,
    );
    const r = await main.merge(b, { gate: "npm test" });
    expect(r.merged).toBe(false);
    if (!r.merged && r.reason === "gate") expect(r.gate.result.stderr).toBe("boom");
    const undo = execs.find((e) => e.script.includes('reset -q --hard "$1"'))!;
    expect(undo.args).toEqual([SHA]); // back to the exact pre-merge commit
    expect(execs.find((e) => e.cmdArgs.at(-1) === "npm test")!.cmdArgs[3]).toBe(ROOT); // gate runs at the root
  });

  test("other merge failures throw", async () => {
    const { main, b } = await pair((c) =>
      isMerge(c) ? { exit_code: 1, stderr: "fatal" } : undefined,
    );
    expect(await catchErr(() => main.merge(b))).toBeInstanceOf(CreateosSandboxGitError);
  });

  test("leaves out every commit the target already has", async () => {
    const { main, b, execs } = await pair((c) =>
      c.sandbox === "sb_1" && c.script.includes("rev-list --max-count")
        ? { stdout: "c1\nc2\n" }
        : undefined,
    );
    expect((await main.merge(b)).merged).toBe(true);
    const bundles = execs.filter((e) => e.script.includes("bundle create"));
    expect(bundles).toHaveLength(1); // one bundle, never a second full-history try
    expect(bundles[0]!.stdin).toBe("c1\nc2"); // never the branch's own base
    expect(bundles[0]!.script).toContain("cat-file --batch-check"); // only those it has
  });

  test("a gate that throws still undoes the merge", async () => {
    const plane = fakePlane(repoAt());
    const sb = await plane.client.getSandbox("sb_1");
    const main = await sb.git.register(ROOT);
    const b = await main.branch("feature");
    const orig = main.sandbox.runCommand.bind(main.sandbox);
    main.sandbox.runCommand = (cmd, args, opts) =>
      args?.at(-1) === "boom" ? Promise.reject(new Error("net")) : orig(cmd, args, opts);
    plane.execs.length = 0;
    // b's HEAD must differ from main's, or the merge is a no-op.
    const borig = b.sandbox.runCommand.bind(b.sandbox);
    b.sandbox.runCommand = async (cmd, args, opts) => {
      const r = await borig(cmd, args, opts);
      if (String(args?.[1]).includes("symbolic-ref")) r.result.stdout = `${SHA2}\nfeature\n`;
      return r;
    };
    const err = await catchErr(() => main.merge(b, { gate: "boom" }));
    expect((err as Error).message).toBe("net");
    expect(plane.execs.some((e) => e.script.includes("reset -q --hard"))).toBe(true);
  });

  test("refuses a target with uncommitted changes", async () => {
    const { main, b } = await pair((c) =>
      c.script.includes("diff-index") ? { exit_code: 6, stderr: "uncommitted" } : undefined,
    );
    expect(await catchErr(() => main.merge(b))).toBeInstanceOf(CreateosSandboxGitError);
  });

  test("parallel merges into one repo run one at a time on their own refs", async () => {
    const { main, b, execs } = await pair(() => undefined);
    await Promise.all([main.merge(b), main.merge(b)]);
    const merges = execs.filter(isMerge);
    expect(new Set(merges.map((e) => e.args[4])).size).toBe(2);
    // The second merge starts only after the first one finished.
    const order = execs
      .filter((e) => e.sandbox === "sb_1" && (isMerge(e) || e.script.includes("diff-index")))
      .map((e) => (isMerge(e) ? "merge" : "check"));
    expect(order).toEqual(["check", "merge", "check", "merge"]);
  });

  test("refuses to merge a workspace into itself", async () => {
    const { main } = await pair(() => undefined);
    expect(await catchErr(() => main.merge(main.cwd("x")))).toBeInstanceOf(CreateosSandboxError);
  });
});

describe("copy between sandboxes", () => {
  test("a big archive goes over a private network bound to the source's IP", async () => {
    const { ws, calls, execs } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        c.script.includes("tar --warning") ? { stdout: `${SHA} ${SNAP} zstd ${BIG}` } : undefined,
      ),
    );
    await ws.branch("x");
    const serve = execs.find((e) => e.script.includes("nc -l"))!;
    expect(serve.sandbox).toBe("sb_1");
    const ip = serve.cmdArgs[3]!;
    expect(ip).toMatch(/^10\.9\.0\.\d$/); // the network IP, never 0.0.0.0 or loopback
    const unpack = execs.find(isUnpack)!;
    expect(unpack.args.slice(1, 3)).toEqual(["net", `${ip} ${serve.cmdArgs[4]} 100`]);
    expect(calls.some((c) => c.path.endsWith("/access-token"))).toBe(false);
    expect(netCalls(calls)).toEqual([
      "POST /v1/networks",
      "POST /v1/sandboxes/sb_1/networks",
      "POST /v1/sandboxes/sb_2/networks",
      "GET /v1/networks/net_1",
      "DELETE /v1/sandboxes/sb_1/networks/net_1",
      "DELETE /v1/sandboxes/sb_2/networks/net_1",
      "DELETE /v1/networks/net_1",
    ]);
  });

  test("falls back to the token pull when the network path fails, and still drops the network", async () => {
    const { ws, calls, execs } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        c.script.includes("tar --warning")
          ? { stdout: `${SHA} ${SNAP} zstd ${BIG}` }
          : c.script.includes("nc -l")
            ? { exit_code: 32 }
            : undefined,
      ),
    );
    await ws.branch("x");
    expect(execs.find(isUnpack)!.args[1]).toBe("token");
    expect(netCalls(calls).at(-1)).toBe("DELETE /v1/networks/net_1");
  });

  test("a source with its own token uses the network and keeps the token", async () => {
    const plane = fakePlane(repoAt());
    plane.tokenStatus = 409;
    const sb = await plane.client.getSandbox("sb_1");
    await (await sb.git.register(ROOT)).branch("x");
    expect(plane.execs.find(isUnpack)!.args[1]).toBe("net");
    expect(plane.calls.some((c) => c.path.endsWith("/files"))).toBe(false);
    // A token we did not create is never disabled.
    expect(plane.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/access-token"))).toBe(
      false,
    );
  });

  test("a failed token pull falls back to the network", async () => {
    const { ws, execs } = await mainWorkspace(
      repoAt(ROOT, (c) => (isUnpack(c) && c.args[1] === "token" ? { exit_code: 90 } : undefined)),
    );
    await ws.branch("x");
    expect(execs.filter(isUnpack).map((e) => e.args[1])).toEqual(["token", "net"]);
  });

  test("throws when no direct path works, unless relay is allowed", async () => {
    const plane = fakePlane(repoAt(ROOT, noNet));
    plane.tokenStatus = 409;
    const sb = await plane.client.getSandbox("sb_1");
    const ws = await sb.git.register(ROOT);
    const err = await catchErr(() => ws.branch("x"));
    expect(err).toBeInstanceOf(CreateosSandboxError);
    expect((err as Error).message).toContain("relay: true");
    expect(plane.calls.some((c) => c.method === "DELETE" && c.path === "/v1/sandboxes/sb_2")).toBe(
      true,
    );
    expect(plane.calls.some((c) => c.path.endsWith("/files"))).toBe(false);

    await ws.branch("y", { relay: true });
    expect(
      plane.calls.some((c) => c.method === "GET" && c.path === "/v1/sandboxes/sb_1/files"),
    ).toBe(true);
    expect(
      plane.calls.some((c) => c.method === "PUT" && c.path === "/v1/sandboxes/sb_3/files"),
    ).toBe(true);
    expect(lastUnpack(plane.execs).args[1]).toBe("local");
  });

  test("never disables a token the user rotated meanwhile", async () => {
    const plane = fakePlane(repoAt());
    plane.tokenHint = "u...z";
    const sb = await plane.client.getSandbox("sb_1");
    await (await sb.git.register(ROOT)).branch("x");
    expect(plane.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/access-token"))).toBe(
      false,
    );
  });

  test("other token errors are not hidden", async () => {
    const plane = fakePlane(repoAt());
    plane.tokenStatus = 403;
    const sb = await plane.client.getSandbox("sb_1");
    const ws = await sb.git.register(ROOT);
    expect(await catchErr(() => ws.branch("x"))).toBeInstanceOf(CreateosSandboxError);
  });
});

describe("warm pool", () => {
  test("fills, takes a member, sends only the delta and refills", async () => {
    const { ws, execs, calls } = await mainWorkspace();
    const pool = ws.pool({ size: 2 });
    await pool.whenReady();
    expect(pool.ready).toBe(2);
    // Members are unpacked without a branch name and remember their tips.
    expect(execs.filter(isUnpack).map((e) => e.args[5])).toEqual(["", ""]);
    execs.length = 0;
    const b = await ws.branch("warm", { pool });
    expect(b.sandbox.id).toBe("sb_2");
    expect(b.base).toBe(SHA);
    expect(b.ownsSandbox).toBe(true);
    const pack = execs.find((e) => e.script.includes("pack-objects"))!;
    expect(pack.sandbox).toBe("sb_1");
    expect(pack.stdin).toBe(`${SHA}\n${SNAP}`); // member tips + its snapshot
    const apply = execs.find(isApply)!;
    expect(apply.sandbox).toBe("sb_2");
    expect(apply.args.slice(3)).toEqual(["zstd", SNAP, SNAP, "warm"]);
    expect(apply.script).toContain("clean -ffdxq"); // no leftovers from the fill
    await pool.whenReady();
    expect(pool.ready).toBe(2);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/sandboxes")).toHaveLength(3);
    await pool.close();
    expect(pool.ready).toBe(0);
    for (const id of ["sb_3", "sb_4"])
      expect(calls.some((c) => c.method === "DELETE" && c.path === `/v1/sandboxes/${id}`)).toBe(
        true,
      );
  });

  test("a dead member is dropped and the next one is used", async () => {
    const { ws, calls } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        c.sandbox === "sb_2" && c.cmd === "true" ? { exit_code: 1 } : undefined,
      ),
    );
    const pool = ws.pool({ size: 2 });
    await pool.whenReady();
    const b = await ws.branch("warm", { pool });
    expect(b.sandbox.id).toBe("sb_3");
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/sandboxes/sb_2")).toBe(true);
    await pool.close();
  });

  test("a failed apply drops the member and throws", async () => {
    const { ws, calls } = await mainWorkspace(
      repoAt(ROOT, (c) => (isApply(c) ? { exit_code: 1, stderr: "bad pack" } : undefined)),
    );
    const pool = ws.pool({ size: 1 });
    await pool.whenReady();
    expect(await catchErr(() => ws.branch("warm", { pool }))).toBeInstanceOf(
      CreateosSandboxGitError,
    );
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/sandboxes/sb_2")).toBe(true);
    await pool.close();
  });

  test("an empty or failing pool falls back to a normal branch", async () => {
    const { ws, execs } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        isUnpack(c) && c.args[5] === "" ? { exit_code: 1, stderr: "fill broke" } : undefined,
      ),
    );
    const pool = ws.pool({ size: 1 });
    await pool.whenReady();
    expect(pool.ready).toBe(0);
    expect(pool.lastError).toBeInstanceOf(CreateosSandboxGitError);
    const b = await ws.branch("cold", { pool });
    expect(lastUnpack(execs).args[5]).toBe("cold");
    expect(b.ownsSandbox).toBe(true);
    await pool.close();
  });

  test("rejects bad sizes and pools of another workspace", async () => {
    const { ws, client } = await mainWorkspace();
    expect(() => ws.pool({ size: 0 })).toThrow(CreateosSandboxError);
    const other = await (await client.getSandbox("sb_9")).git.register(ROOT);
    const pool = other.pool({ size: 1 });
    expect(await catchErr(() => ws.branch("x", { pool }))).toBeInstanceOf(CreateosSandboxError);
    await pool.close();
  });
});

const isGate = (e: ExecCall) => e.cmdArgs.at(-1) === "slow-gate";
const isUndo = (e: ExecCall) =>
  e.script.includes("createos-gate-untracked") && e.script.includes("reset -q --hard");
const isCommit = (e: ExecCall) => e.script.includes("g commit -q $2");
// One test per finding of the 2026-10-07 code review.
describe("review fixes", () => {
  const withBranchHead = (extra: (c: ExecCall) => AsyncReply) => (c: ExecCall) =>
    extra(c) ??
    repoAt(ROOT, (x) =>
      x.sandbox === "sb_2" && x.script.includes("symbolic-ref")
        ? { stdout: `${SHA2}\nfeature\n` }
        : undefined,
    )(c);
  async function pairWith(extra: (c: ExecCall) => AsyncReply) {
    const plane = fakePlane(withBranchHead(extra));
    const sb = await plane.client.getSandbox("sb_1");
    const main = await sb.git.register(ROOT);
    const b = await main.branch("feature");
    plane.execs.length = 0;
    plane.calls.length = 0;
    return { ...plane, plane, main, b };
  }

  test("1: commit and rollback wait for a running merge, its gate and its undo", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { main, b, execs } = await pairWith((c) =>
      isGate(c) ? held.then(() => ({ exit_code: 1 })) : undefined,
    );
    const merging = main.merge(b, { gate: "slow-gate" });
    while (!execs.some(isGate)) await Bun.sleep(1);
    const committing = main.commit("concurrent commit");
    const rolling = main.rollback(SHA);
    await Bun.sleep(20);
    expect(execs.some(isCommit)).toBe(false); // blocked behind the merge
    release();
    expect(await merging).toMatchObject({ merged: false, reason: "gate" });
    await Promise.all([committing, rolling]);
    const order = execs
      .filter(
        (e) => isGate(e) || isUndo(e) || isCommit(e) || e.script.includes("show-ref -q --verify"),
      )
      .map((e) => (isGate(e) ? "gate" : isUndo(e) ? "undo" : isCommit(e) ? "commit" : "rollback"));
    expect(order).toEqual(["gate", "undo", "commit", "rollback"]);
  });

  test("1: with a gate, the merge records untracked files so the undo removes only new ones", async () => {
    const { main, b, execs } = await pairWith(() => undefined);
    await main.merge(b, { gate: "true" });
    const merge = execs.find((e) => e.script.includes("merge -q --no-ff"))!;
    expect(merge.args.at(-1)).toBe("gate");
    expect(merge.script).toContain("ls-files -o -z >");
    await main.merge(b);
    const merges = execs.filter((e) => e.script.includes("merge -q --no-ff"));
    expect(merges[1]!.args.at(-1)).toBe(""); // the second merge had no gate
  });

  test("2: a token that cannot be disabled never hides an applied merge; retry() disables it", async () => {
    const { main, b, calls, execs, plane } = await pairWith(() => undefined);
    let failDisable = true;
    plane.override = (m, p) =>
      failDisable && m === "GET" && p === "/v1/sandboxes/sb_2/access-token"
        ? Promise.resolve(fail("metadata down", 403))
        : undefined;
    const err = await catchErr(() => main.merge(b, { gate: "npm test" }));
    expect(err).toBeInstanceOf(CreateosSandboxCleanupError);
    const cleanupErr = err as CreateosSandboxCleanupError<unknown>;
    expect(cleanupErr.outcome).toEqual({ merged: true, sha: SHA, upToDate: false });
    expect(execs.some((e) => e.cmdArgs.at(-1) === "npm test")).toBe(true); // the gate still ran
    expect(cleanupErr.message).toContain("sb_2");
    const disabled = () =>
      calls.some((c) => c.method === "DELETE" && c.path === "/v1/sandboxes/sb_2/access-token");
    expect(disabled()).toBe(false);
    failDisable = false;
    await cleanupErr.retry();
    expect(disabled()).toBe(true);
  });

  test("2: a failed gate is still undone when the token cleanup fails", async () => {
    const { main, b, execs, plane } = await pairWith((c) =>
      c.cmdArgs.at(-1) === "npm test" ? { exit_code: 1 } : undefined,
    );
    plane.override = (m, p) =>
      m === "GET" && p === "/v1/sandboxes/sb_2/access-token"
        ? Promise.resolve(fail("metadata down", 403))
        : undefined;
    const err = (await catchErr(() =>
      main.merge(b, { gate: "npm test" }),
    )) as CreateosSandboxCleanupError<unknown>;
    expect(err.outcome).toMatchObject({ merged: false, reason: "gate" });
    expect(execs.some(isUndo)).toBe(true);
  });

  test("2: the next copy from that sandbox retries the pending disable first", async () => {
    const { main, b, calls, plane } = await pairWith(() => undefined);
    let fails = 1;
    plane.override = (m, p) =>
      fails > 0 && m === "GET" && p === "/v1/sandboxes/sb_2/access-token"
        ? (fails--, Promise.resolve(fail("metadata down", 403)))
        : undefined;
    await catchErr(() => main.merge(b));
    await b.run("true"); // b moves on, so the next merge has work to do
    await main.merge(b).catch(() => undefined);
    const seq = calls
      .filter((c) => c.path === "/v1/sandboxes/sb_2/access-token")
      .map((c) => c.method);
    // lease, failed check, then on the next copy: retry check + disable, new lease
    expect(seq.slice(0, 5)).toEqual(["POST", "GET", "GET", "DELETE", "POST"]);
  });

  test("3: a failed attach waits for the other attach, then detaches only what joined", async () => {
    const events: string[] = [];
    const { ws, plane } = await mainWorkspace(
      repoAt(ROOT, (c) =>
        c.script.includes("tar --warning") ? { stdout: `${SHA} ${SNAP} zstd ${BIG}` } : undefined,
      ),
    );
    plane.override = (m, p) => {
      if (m === "POST" && p === "/v1/sandboxes/sb_1/networks") {
        events.push("attach sb_1 refused");
        return Promise.resolve(fail("no", 400));
      }
      if (m === "POST" && p === "/v1/sandboxes/sb_2/networks")
        return Bun.sleep(30).then(() => {
          events.push("attach sb_2 done");
          return success({ ok: true });
        });
      if (m === "DELETE" && p.includes("/networks")) events.push(`${m} ${p}`);
      return undefined;
    };
    await ws.branch("x"); // falls back to the token pull
    expect(events).toEqual([
      "attach sb_1 refused",
      "attach sb_2 done",
      "DELETE /v1/sandboxes/sb_2/networks/net_1",
      "DELETE /v1/networks/net_1",
    ]);
  });

  test("4: close() waits for a member whose fill ends during the close", async () => {
    const { ws, plane } = await mainWorkspace();
    let destroyed = false;
    plane.override = (m, p) => {
      if (m === "POST" && p === "/v1/sandboxes")
        return Bun.sleep(30).then(() => success({ ...CREATE_RESPONSE, id: "sb_slow" }));
      if (m === "DELETE" && p === "/v1/sandboxes/sb_slow")
        return Bun.sleep(30).then(() => {
          destroyed = true;
          return success({ destroyed: true });
        });
      return undefined;
    };
    const pool = ws.pool({ size: 1 });
    await pool.close(); // the fill is still running
    expect(destroyed).toBe(true);
    expect(pool.ready).toBe(0);
  });

  test("4: close() reports pool sandboxes it could not destroy", async () => {
    const { ws, plane } = await mainWorkspace();
    const pool = ws.pool({ size: 1 });
    await pool.whenReady();
    plane.override = (m, p) =>
      m === "DELETE" && p === "/v1/sandboxes/sb_2" ? Promise.resolve(fail("nope", 403)) : undefined;
    const err = await catchErr(() => pool.close());
    expect(err).toBeInstanceOf(CreateosSandboxError);
    expect((err as Error).message).toContain("sb_2");
  });

  test("6: a merge failure that is not a conflict throws git's own message", async () => {
    const { main, b } = await pairWith((c) =>
      c.script.includes("merge -q --no-ff")
        ? {
            exit_code: 11,
            stderr:
              "error: The following untracked working tree files would be overwritten by merge:\n\tclash.txt",
          }
        : undefined,
    );
    const err = await catchErr(() => main.merge(b));
    expect(err).toBeInstanceOf(CreateosSandboxGitError);
    expect((err as Error).message).toContain("would be overwritten");
  });

  test("6: only unmerged paths count as a conflict", async () => {
    const { main, b, execs } = await pairWith(() => undefined);
    await main.merge(b);
    const script = execs.find((e) => e.script.includes("merge -q --no-ff"))!.script;
    expect(script).toContain('if [ -n "$(g ls-files -u)" ]');
    expect(script).toContain("exit 11");
  });
});

describe("discard", () => {
  test("destroys branch sandboxes only", async () => {
    const { ws, calls } = await mainWorkspace();
    const b = await ws.branch("x");
    await b.discard();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/sandboxes/sb_2")).toBe(true);
    expect(await catchErr(() => ws.discard())).toBeInstanceOf(CreateosSandboxError);
  });
});
