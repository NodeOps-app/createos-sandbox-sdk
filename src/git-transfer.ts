// Shared plumbing for gitboxes (`sandbox.git`): script runners, the snapshot and
// compression snippets, and `deliver`, which moves one file from a source
// sandbox into a target sandbox and runs the target's script in the same call.
//
// Transfer order (fastest secure path first):
// 1. Big files (>= NET_MIN_BYTES): a private network that holds only the two
//    sandboxes. The source serves the file with `nc` bound to its network IP
//    (not loopback, so ingress and port tunnels cannot reach it); the target
//    connects and reads it. The network is detached and deleted afterwards.
//    Measured 60-100 MB/s.
// 2. Otherwise, or when the network path fails: the target downloads the file
//    from the files API with a short-lived access token scoped to the source.
//    Measured 21-28 MB/s, but no network setup (~1.5 s), so small files win.
// 3. Relay through this process only when the caller passes `relay: true`.
//    Otherwise a copy that cannot go direct throws.

import {
  CreateosSandboxApiError,
  CreateosSandboxError,
  CreateosSandboxNotFoundError,
} from "./errors.js";
import { NetworksApi } from "./client.js";
import { type CreateosSandboxHttp, encodePath } from "./http.js";
import { sleep } from "./poll.js";
import { Sandbox } from "./sandbox.js";
import type {
  CreateSandboxRequest,
  CreateSandboxResponse,
  ExecResponse,
  Network,
  SandboxView,
} from "./types.js";

/** Commit author for commits the workspace makes. */
export interface GitAuthor {
  name: string;
  email: string;
}

/** A git command inside the sandbox exited non-zero. */
export class CreateosSandboxGitError extends CreateosSandboxError {
  readonly exitCode: number;
  readonly stderr: string;
  constructor(action: string, exitCode: number, stderr: string) {
    super(`git ${action} failed (exit ${exitCode}): ${stderr.trim().slice(-500)}`);
    this.name = "CreateosSandboxGitError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** A cleanup step that failed after the work itself was done. */
export interface CleanupFailure {
  /** What could not be cleaned up, for example "disable the access token of sb-…". */
  what: string;
  error: unknown;
  /** Runs the same cleanup again. */
  retry: () => Promise<void>;
}

/**
 * The operation finished (see `outcome`), but releasing a temporary resource
 * after it failed: an access token is still enabled, or a transfer network
 * still exists. The work is not lost. Call `retry()` to clean up again.
 */
export class CreateosSandboxCleanupError<T = unknown> extends CreateosSandboxError {
  /** What the operation returned: a `MergeResult`, a branch `Workspace`, … */
  readonly outcome: T;
  readonly failures: CleanupFailure[];
  constructor(outcome: T, failures: CleanupFailure[]) {
    super(
      `the operation finished, but cleanup failed: ${failures.map((f) => `${f.what}: ${errorText(f.error)}`).join("; ")}. Call retry() on this error to clean up again`,
      { cause: failures[0]?.error },
    );
    this.outcome = outcome;
    this.failures = failures;
  }

  /** Runs every failed cleanup again. Throws if one still fails. */
  async retry(): Promise<void> {
    for (const f of this.failures) await f.retry();
  }
}

/** Message of an Error, or the value as text. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Runs a cleanup step; a failure comes back as a CleanupFailure that can
// run the same step again, instead of being thrown.
async function tryCleanup(
  what: string,
  step: () => Promise<void>,
): Promise<CleanupFailure | undefined> {
  try {
    await step();
    return undefined;
  } catch (error) {
    return { what, error, retry: step };
  }
}

/** Returns `outcome`, or throws a CreateosSandboxCleanupError that carries it. */
export function finish<T>(outcome: T, cleanup: CleanupFailure[]): T {
  if (cleanup.length) throw new CreateosSandboxCleanupError(outcome, cleanup);
  return outcome;
}

// Clones, archives, copies and gates of big repos take minutes, far past the
// 60 s request default. The server stops any command after 1 h anyway.
export const LONG_TIMEOUT_MS = 30 * 60_000;

// Below this size the token pull beats the network setup. Network setup costs
// ~1.5 s plus 0-4 s until the new allow rule reaches both hosts; after that
// it moves 60-100 MB/s against 21-28 MB/s for the token pull.
const NET_MIN_BYTES = 128 * 1024 * 1024;

// Every git script starts with this preamble. $1 root, $2 name, $3 email;
// the rest of "$@" is the script's own arguments.
export const PRELUDE = `set -e; R=$1; N=$2; E=$3; shift 3
g() { git -c safe.directory='*' -c user.name="$N" -c user.email="$E" -C "$R" "$@"; }
`;
// Writes a commit of the full working tree (tracked + untracked, honouring
// .gitignore) without touching the real index. Prints the commit sha.
// When $O is set, the new objects go to "$O/objects" instead of the repo, so
// throwaway snapshots (diff, branch transfer) never grow the user's .git.
// Read them back with GIT_ALTERNATE_OBJECT_DIRECTORIES="$O/objects".
export const SNAPSHOT = `snap() {
  T=$(mktemp); D=$(g rev-parse --absolute-git-dir)
  cp "$D/index" "$T" 2>/dev/null || rm -f "$T"
  if [ -n "$O" ]; then
    mkdir -p "$O/objects"
    export GIT_OBJECT_DIRECTORY="$O/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$D/objects"
  fi
  GIT_INDEX_FILE=$T g add -A
  t=$(GIT_INDEX_FILE=$T g write-tree); rm -f "$T"
  g commit-tree "$t" -p HEAD -m "createos snapshot"
}
`;
// Transfer compression. Git data is already zlib-compressed, so ratio barely
// moves (zstd -19 saves ~3% over -1) and speed is what counts. Measured on a
// 309 MB .git (django), 1/2/4 vCPU: gzip -6 took 8-12 s, zstd -3 0.5-1.1 s,
// and -3 had the lowest compress + 25 MB/s transfer + decompress total.
// Threads: 1 on <= 2 vCPU (the copy and the user's work need the other one),
// else one per vCPU. gzip is the fallback for images without zstd.
// `codec` prints "zstd" when this sandbox has it and $1 (the other end) is
// not "gzip"; the caller passes "gzip" when it knows the other end lacks zstd.
export const COMPRESS = `codec() { if [ "$1" != gzip ] && command -v zstd >/dev/null; then echo zstd; else echo gzip; fi; }
compressor() {
  if [ "$1" = zstd ]; then n=$(nproc); [ "$n" -gt 2 ] || n=1; echo "zstd -q -3 -T$n"; else echo "gzip -1"; fi
}
`;
// Target side of `deliver`. Consumes $1 file, $2 via, $3 source; then the
// caller's own arguments follow. Exit 90 means the copy itself failed, so
// `deliver` may try the next path. The file is removed when the script ends.
// For "net", $3 is "<ip> <port> <bytes>". A fresh attach needs a few seconds
// before the hosts let the two sandboxes talk, and an early connection may be
// accepted and then go silent, so keep trying for a minute until exactly
// <bytes> arrive (nc -w 5 drops a stalled try).
export const FETCH = `F=$1; V=$2; S=$3; shift 3
trap 'rm -f "$F"' EXIT
case $V in
net) command -v nc >/dev/null || exit 90
  set -- $S "$@"; end=$((SECONDS + 60))
  until nc -w 5 -d "$1" "$2" > "$F" 2>/dev/null; [ "$(stat -c %s "$F")" = "$3" ]; do
    [ $SECONDS -lt $end ] || exit 90; sleep 0.2; done
  shift 3 ;;
token) curl -fsS --retry 3 -K - -o "$F" "$S" || exit 90 ;;
esac
`;
// Source-side cleanup: stops a network listener for $1 (see viaNetwork) and
// removes the file. Callers run it after `deliver`.
export const DROP = `drop() { [ -f "$1.pid" ] && kill -- -"$(cat "$1.pid")" 2>/dev/null; rm -f "$1" "$1.pid"; }
`;

export function runGit(
  sandbox: Sandbox,
  script: string,
  root: string,
  author: GitAuthor,
  args: string[],
  stdin?: string,
): Promise<ExecResponse> {
  return sandbox.runCommand(
    "bash",
    ["-c", script, "git", root, author.name, author.email, ...args],
    { timeoutMs: LONG_TIMEOUT_MS, ...(stdin ? { stdin } : {}) },
  );
}

export function throwIfFailed(action: string): (r: ExecResponse) => ExecResponse {
  return (r) => {
    if (r.result.exit_code !== 0 || r.result.error) {
      throw new CreateosSandboxGitError(
        action,
        r.result.exit_code,
        r.result.stderr || r.result.error || "",
      );
    }
    return r;
  };
}

export async function gitScript(
  sandbox: Sandbox,
  action: string,
  script: string,
  root: string,
  author: GitAuthor,
  args: string[] = [],
  stdin?: string,
): Promise<string> {
  const r = throwIfFailed(action)(await runGit(sandbox, script, root, author, args, stdin));
  return r.result.stdout;
}

// Runs tasks with the same key one after another, in call order.
const queues = new Map<string, Promise<unknown>>();
export function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => queues.get(key) === tail && queues.delete(key));
  return run;
}

// Same as CreateosSandboxClient.createSandbox: the POST returns once the
// sandbox is running, so the response seeds the handle directly.
export async function spawnSandbox(
  http: CreateosSandboxHttp,
  request: CreateSandboxRequest,
): Promise<Sandbox> {
  const created = await http.request<CreateSandboxResponse>("POST", "/v1/sandboxes", {
    body: request,
  });
  return new Sandbox(http, {
    ...(created as unknown as SandboxView),
    status: "running",
    ingress_enabled: request.ingress_enabled ?? false,
  });
}

/** The commands `deliver` runs on the target, after the file has arrived. */
export interface TargetScript {
  /** Script body; it runs after PRELUDE and FETCH, with $F set to the file. */
  script: string;
  root: string;
  author: GitAuthor;
  args: string[];
}

// How a strategy hands the file to the target script (see FETCH).
type Fetch = { via: "net" | "token" | "local"; src: string; stdin?: string };
type OnTarget = (fetch: Fetch) => Promise<ExecResponse>;
// undefined: the path is not possible here. Exit 90: the copy itself failed.
const failed = (r: ExecResponse | undefined) => !r || r.result.exit_code === 90;

/**
 * Moves `file` (`size` bytes) from `from` to `to`, then runs `target` there in
 * the same call and returns its result. A failure to release the token or
 * network afterwards never replaces the result: it is added to `cleanup`, so
 * the caller can finish its own work (gate, undo) first and report it with
 * `finish()`. The source file is left in place; the caller removes it with
 * DROP.
 */
export async function deliver(
  http: CreateosSandboxHttp,
  from: Sandbox,
  file: string,
  size: number,
  to: Sandbox,
  target: TargetScript,
  options: { relay?: boolean },
  cleanup: CleanupFailure[],
): Promise<ExecResponse> {
  const onTarget: OnTarget = (f) =>
    runGit(
      to,
      `${PRELUDE}${FETCH}${target.script}`,
      target.root,
      target.author,
      [file, f.via, f.src, ...target.args],
      f.stdin,
    );
  // Two repos in one sandbox: the file is already there.
  if (from.id === to.id) return onTarget({ via: "local", src: "" });
  const net = () => viaNetwork(http, from, file, to, onTarget, cleanup);
  const token = () => viaToken(http, from, file, onTarget, cleanup);
  // A small file whose source already holds a user token still has the network.
  let r: ExecResponse | undefined;
  for (const path of size >= NET_MIN_BYTES ? [net, token] : [token, net]) {
    r = await path();
    if (!failed(r)) return r!;
  }
  if (!options.relay) {
    throw new CreateosSandboxError(
      `could not copy ${file} from ${from.id} to ${to.id} directly` +
        (r ? `: ${r.result.stderr.trim().slice(-300)}` : "") +
        "; pass { relay: true } to relay the bytes through this process",
    );
  }
  const data = await from.files.download(file, { timeoutMs: LONG_TIMEOUT_MS });
  await to.files.upload(file, data, { timeoutMs: LONG_TIMEOUT_MS });
  return onTarget({ via: "local", src: "" });
}

// Returns undefined when the network path is not possible (setup failed, no
// `nc`), so `deliver` moves on. Errors from the target script itself pass,
// so a failed apply is never run a second time through another path.
async function viaNetwork(
  http: CreateosSandboxHttp,
  from: Sandbox,
  file: string,
  to: Sandbox,
  onTarget: OnTarget,
  cleanup: CleanupFailure[],
): Promise<ExecResponse | undefined> {
  const networks = new NetworksApi(http);
  let net: Network | undefined;
  const attached: Sandbox[] = [];
  try {
    let src: string | undefined;
    try {
      net = await networks.create({ name: `createos-git-${crypto.randomUUID().slice(0, 8)}` });
      // Wait for both attaches to settle, so the cleanup below knows exactly
      // which sandboxes joined and none joins after it ran.
      const settled = await Promise.allSettled(
        [from, to].map(async (s) => {
          await s.attachNetwork(net!.id);
          attached.push(s);
        }),
      );
      const refused = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (refused) throw refused.reason;
      src = await serve(networks, net.id, from, file);
    } catch (err) {
      if (err instanceof CreateosSandboxApiError) return undefined;
      throw err;
    }
    return src ? await onTarget({ via: "net", src }) : undefined;
  } finally {
    if (net) {
      const failure = await dropNetwork(networks, net.id, attached);
      if (failure) cleanup.push(failure);
    }
  }
}

// Starts the source's listener and returns "<ip> <port> <bytes>" for FETCH,
// or undefined when the source has no network address yet or no `nc`.
async function serve(
  networks: NetworksApi,
  id: string,
  from: Sandbox,
  file: string,
): Promise<string | undefined> {
  // The member address appears once the membership is programmed.
  let ip: string | undefined;
  for (let attempt = 0; !ip && attempt < 3; attempt++) {
    if (attempt) await sleep(200);
    ip = (await networks.get(id)).members?.find((m) => m.sandbox_id === from.id)?.ip;
  }
  if (!ip) return undefined;
  const port = String(20000 + Math.floor(Math.random() * 40000));
  // Serves the file to every connection until DROP kills the process group
  // (pid in "<file>.pid"), or after 30 min. Bound to the network IP only,
  // which just the two members can reach.
  const served = await from.runCommand("bash", [
    "-c",
    `command -v nc >/dev/null || exit 32
setsid timeout 1800 sh -c 'while :; do nc -l -q 1 "$1" "$2" < "$3"; done' x "$1" "$2" "$3" </dev/null >/dev/null 2>&1 &
echo $! > "$3.pid"; stat -c %s "$3"`,
    "serve",
    ip,
    port,
    file,
  ]);
  return served.result.exit_code === 0 ? `${ip} ${port} ${served.result.stdout.trim()}` : undefined;
}

const gone = (err: unknown) => err instanceof CreateosSandboxNotFoundError;

// Detaches the members, then deletes the network. The delete may answer 409
// for a moment after the detach; retry with a short backoff for up to a
// minute. A member or network that is already gone counts as done.
async function dropNetwork(
  networks: NetworksApi,
  id: string,
  members: Sandbox[],
): Promise<CleanupFailure | undefined> {
  const drop = async () => {
    const detached = await Promise.allSettled(members.map((s) => s.detachNetwork(id)));
    const bad = detached.find(
      (r): r is PromiseRejectedResult => r.status === "rejected" && !gone(r.reason),
    );
    if (bad) throw bad.reason;
    for (let wait = 100, spent = 0; ; spent += wait, wait = Math.min(wait * 2, 1000)) {
      try {
        await networks.delete(id);
        return;
      } catch (err) {
        if (gone(err)) return;
        const busy = err instanceof CreateosSandboxApiError && err.statusCode === 409;
        if (!busy || spent >= 60_000) throw err;
        await sleep(wait);
      }
    }
  };
  return tryCleanup(`remove transfer network ${id}`, drop);
}

// Returns undefined when the source already has a user token: we cannot read
// it and must not replace it.
async function viaToken(
  http: CreateosSandboxHttp,
  from: Sandbox,
  file: string,
  onTarget: OnTarget,
  cleanup: CleanupFailure[],
): Promise<ExecResponse | undefined> {
  const token = await leaseToken(from);
  try {
    if (!token) return undefined;
    const url = `${http.baseUrl}/v1/sandboxes/${encodePath(from.id)}/files?path=${encodeURIComponent(file)}`;
    // curl reads the token from a config on stdin, so it is never in any argv.
    return await onTarget({ via: "token", src: url, stdin: `header = "X-Api-Key: ${token}"\n` });
  } finally {
    const failure = await releaseToken(from);
    if (failure) cleanup.push(failure);
  }
}

// A sandbox holds at most one access token, so parallel copies out of one
// source share a single lease; the last one to finish disables the token.
// `undefined` means the user already had a token.
const leases = new Map<string, { token: Promise<string | undefined>; users: number }>();
// Tokens we created but could not disable yet, by sandbox id. The next lease
// on that sandbox tries again first; until then our token would look like a
// user's token (409) and push copies onto the network path.
const unreleased = new Map<string, () => Promise<void>>();

// A hint is "<prefix><first 4>...<last 4>" of the token.
function isOurToken(token: string, hint: string | undefined): boolean {
  const [head, tail] = (hint ?? "").split("...");
  return !!head && !!tail && token.startsWith(head) && token.endsWith(tail);
}

async function leaseToken(from: Sandbox): Promise<string | undefined> {
  let lease = leases.get(from.id);
  if (!lease) {
    await unreleased
      .get(from.id)?.()
      .catch(() => undefined);
    lease = leases.get(from.id); // another caller may have leased meanwhile
  }
  if (!lease) {
    lease = {
      users: 0,
      token: from.createAccessToken().then(
        (r) => r.token,
        (err: unknown) => {
          if (err instanceof CreateosSandboxApiError && err.statusCode === 409) return undefined;
          throw err;
        },
      ),
    };
    leases.set(from.id, lease);
  }
  lease.users++;
  try {
    return await lease.token;
  } catch (err) {
    await releaseToken(from);
    throw err;
  }
}

// Never throws: a failure comes back as a CleanupFailure and the token stays
// in `unreleased`, so the caller's result survives and the disable can be
// retried.
async function releaseToken(from: Sandbox): Promise<CleanupFailure | undefined> {
  const lease = leases.get(from.id);
  if (!lease || --lease.users > 0) return undefined;
  leases.delete(from.id);
  const token = await lease.token.catch(() => undefined);
  if (!token) return undefined;
  // Never disable a token the user rotated or replaced meanwhile.
  // ponytail: GET-then-DELETE leaves a tiny race; needs a server-side
  // disable-if-hint-matches to close fully.
  const disable = async () => {
    const meta = await from.getAccessToken();
    if (meta.enabled && !meta.rotated_at && isOurToken(token, meta.token_hint))
      await from.disableAccessToken();
    unreleased.delete(from.id);
  };
  const failure = await tryCleanup(
    `disable the access token the SDK created on ${from.id}`,
    disable,
  );
  if (failure) unreleased.set(from.id, disable);
  return failure;
}
