# Git workspaces: design and measurements

Why `branch()` copies a repo into a new sandbox by default (`via: "clone"`),
what else we tried, and the numbers behind each choice. For the API and
recipes see [../how-to/git-workspaces.md](../how-to/git-workspaces.md).

> Status: early preview. Numbers are from test runs on 2026-10-06 and
> 2026-10-07 and will move as the platform changes.

---

## The goal

Give each agent its own isolated copy of a project, the way a git branch
gives each developer their own line of work. Each branch runs in its **own
sandbox**, so two agents can use the same port, install different packages
or break the build without seeing each other. Good work comes back with
`merge()`, behind a test gate.

```
  main sandbox ──branch()──► sandbox A   agent 1 works here
       │        ──branch()──► sandbox B   agent 2 works here
       │
       ◄──merge(A, { gate })── only if the gate passes
```

## Options we considered

### 1. A shared S3 disk holding one bare repo

Every branch sandbox mounts the same bucket and pushes to and pulls from a
bare repo on it.

**Rejected.** Object storage has no atomic rename and no file locks. Git
updates a ref by writing a lock file and renaming it into place; on an S3
mount two sandboxes that update the same ref at the same time can both
"win", and one update is lost without any error. A demo only worked because
each writer used its own branch. Object storage is still a good fit later
for a durable backup of immutable, write-once git objects.

### 2. Fork the whole sandbox (`via: "fork"`)

Pause the source, fork it, resume it. The branch gets everything: memory,
running processes, installed packages and ignored files such as
`node_modules`.

**Kept as an option, not the default.** It is slow and the source is
paused the whole time:

| run | repo | fork branch time |
| --- | --- | --- |
| small test repo | a few files | 8 s – 70 s, once 131 s (timed out) |
| kaset | 28 MB `.git` | 32 s – 144 s, two runs timed out at 120 s |

Use it only when the branch needs live processes or ignored files.

### 3. Copy the repo into a fresh sandbox (`via: "clone"`) — **default**

A new sandbox with the same shape, disk size, image and egress rules is
created. The source's whole `.git` folder travels as one archive, and the
working tree is rebuilt from a snapshot commit, so uncommitted, untracked
and staged changes come along. Ignored files do not. The source keeps
running.

We send the `.git` folder and not a git bundle because a bundle cannot
carry shallow history; a branch of a `--depth 1` clone failed with
bundles.

## Measurements

All runs on `devbox:1` with a 50 GB disk, 2026-10-07. Every operation was
run on every shape with at least 2 vCPU and 2 GB, against a small and a
large public repo. Each branch was checked against its source with file
hashes and `git status`: all were byte-identical, staging area included.

| repo | `.git` size | files |
| --- | --- | --- |
| [kaset](https://github.com/sozercan/kaset) | 28 MB | 847 |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | 1.28 GB | 24,374 |

**Small repo (kaset)**, range over the six shapes:

| operation | time |
| --- | --- |
| `sandbox.git.clone()` from GitHub | 3.9 s – 5.1 s |
| `status()` | 0.19 s – 0.45 s |
| `diff()` | 0.39 s – 0.63 s |
| `checkpoint()` | 0.23 s – 0.51 s |
| `rollback()` | 0.21 s – 0.34 s |
| `branch()` | 2.7 s – 3.0 s (one outlier 6.6 s) |
| `branch()` from a warm pool | 1.8 s – 2.8 s |
| `merge()` with a gate | 2.0 s – 3.3 s |
| branch of a branch | 2.6 s – 5.6 s |

**Large repo (OmniRoute)**, per shape:

| shape | clone from GitHub | `branch()` | warm `branch()` | fill a pool of 2 | `merge()` with a gate | branch of a branch |
| --- | --- | --- | --- | --- | --- | --- |
| s-2vcpu-2gb | 111 s | 21.7 s | 8.6 s – 10.6 s | 191 s, one fill failed | 2.8 s | 27.1 s |
| s-2vcpu-4gb | 170 s | 34.1 s | 9.7 s – 11.2 s | 38.8 s | 3.7 s | 27.3 s |
| s-4vcpu-4gb | 114 s | 19.1 s | 7.9 s – 10.7 s | 76.3 s | 3.4 s | 26.3 s |
| s-4vcpu-8gb | 106 s | 32.0 s | 8.0 s – 9.3 s | 37.6 s | 3.8 s | 23.4 s |
| s-8vcpu-8gb | 99 s | 27.8 s | 7.3 s – 8.4 s | 23.6 s | 3.9 s | 22.7 s |
| s-8vcpu-16gb | 107 s | 28.3 s | 8.0 s – 10.7 s | 22.3 s | 3.5 s | 24.2 s |

On the large repo `status()` took 0.30 s – 0.46 s, `diff()` 0.50 s – 0.66 s,
`checkpoint()` 0.32 s – 0.54 s and `rollback()` 0.48 s – 0.65 s on every
shape. A merge that hits a conflict comes back in about the same time as a
clean one (2.2 s – 5.0 s).

What the numbers say:

- **Shape barely matters.** Above 2 vCPU / 2 GB, time goes to the network
  and to API round trips, not to CPU.
- **A plain branch of a large repo is copy-bound:** 1.28 GB moves in
  19 s – 34 s over the private network. A warm pool cuts it to 7 s – 11 s.
- **Small repos are round-trip-bound.** A branch is about four sequential
  API calls (create ‖ archive, token, pull + unpack + checkout, cleanup),
  down from about eleven.
- **2 GB of memory is tight for a 1.28 GB repo.** Both runs on
  `s-2vcpu-2gb` had a pool fill fail (once a server error, once the sandbox
  was destroyed). Use 4 GB or more for repos of this size.

Earlier numbers, before the private network and the fewer round trips:
`branch()` of OmniRoute took 38 s – 45 s (1 vCPU) and 62 s – 134 s (4 vCPU);
`merge()` of kaset took 4.0 s – 6.6 s.

## Warm pool

A pool keeps sandboxes that already hold a copy of the repo. A pool branch
sends only what changed since the fill:

```
 pool sandbox (older copy)                  source sandbox
   knows its ref tips ──────────────────►  snapshot commit of the working tree
                                           pack of objects the pool lacks
                                           + .git without objects/ (refs, HEAD,
                                             index, config), one zstd file
   ◄────────────────────── small file ──
   add the objects, move the tree to the snapshot (only changed files are
   rewritten), remove files the source no longer has, take the metadata,
   checkout -b <name>
```

On OmniRoute that is about 6 MB instead of 1.28 GB. After each pool branch
the pool fills itself back up in the background. The refill starts only
after the branch is done: when it ran at the same time, it copied the whole
repo out of the same source and made the branch about two times slower
(10 s – 12 s instead of 7 s – 8 s).

A pool member that has died is skipped and replaced. If the pool is empty,
`branch()` makes a normal copy instead of waiting.

## How the bytes move

```
   branch():  source ──.git archive──► new sandbox     (target pulls it)
   pool:      source ──changes only──► pool sandbox
   merge():   branch ──git bundle────► target          (only missing commits)
```

The bytes always go straight from one sandbox to the other. Nothing passes
through your process.

| path | used for | measured speed |
| --- | --- | --- |
| private network | files of 128 MB and more | 60 – 100 MB/s, plus 2 – 5 s setup |
| API pull with a scoped token | smaller files | 21 – 28 MB/s |
| relay through your process | only with `relay: true` | about 0.1 MB/s |

**Private network.** The SDK creates a network, attaches both sandboxes,
and the source serves the file with `nc` on its network address only. The
listener is not on loopback, so a public URL or port tunnel into the source
cannot reach it, and only the two members can reach the network address.
After the copy both sandboxes are detached and the network is deleted. A
fresh attach takes 0 – 4 s before traffic flows, and an early connection
can be accepted and then go silent. So the target keeps trying for up to a
minute until exactly the expected number of bytes has arrived.

**Token pull.** The target downloads the file from the files API with a
short-lived access token scoped to the source sandbox, read from stdin and
disabled right after. If the source already has its own token, the SDK
never touches it and uses the private network instead.

When neither path works, the call throws unless you pass `relay: true`.

`merge()` works like git's own fetch: the target lists its last 1000
commits, and the bundle leaves out every commit the source also has, so
only missing commits move. Before this, a merge that could not use the
branch point sent the full history: 1.2 GB and 140 s – 175 s for
OmniRoute, plus a duplicate 1 GB pack left in the target repo.

## Compression

Git data is already zlib-compressed, so compression barely changes the
size. Speed is what counts. Measured on a 309 MB `.git` (django):

| codec | size | compress time, 1 / 2 / 4 vCPU |
| --- | --- | --- |
| gzip -6 (old) | 97.1 % | 12.3 / 9.0 / 7.9 s |
| zstd -1 | 97.3 % | 0.85 / 0.66 / 0.46 s |
| **zstd -3 (chosen)** | 96.1 % | 1.1 / 1.0 / 0.53 s |
| zstd -6 | 95.7 % | 2.1 / 3.4 / 0.90 s |
| zstd -19 | 94.0 % | 86 / 90 / 31 s |

Level 3 had the lowest or near-lowest total of compress + copy + decompress
on every shape. zstd uses one thread on 1–2 vCPU and one per vCPU above
that. On the 1.2 GB OmniRoute `.git`, zstd -3 took 3.5 s and gzip -1 28 s.

Only `devbox:1` ships zstd today; other images fall back to `gzip -1`.

## Known limits

- **Fork time varies a lot** (8 s to over 2 minutes) and the source is
  paused for all of it.
- **Large repos branch at copy speed** unless you use a warm pool: a
  1.28 GB `.git` takes 19 s – 34 s, or 7 s – 11 s from a pool.
- **Pool sandboxes keep running** and cost money until `pool.close()`.
- **The private network needs `nc`** in both images (`devbox:1` and
  `desktop:1` have it). Without it, big files fall back to the slower
  token pull.
- **`diff()` leaves binary contents out by default.** A 5 MB binary in the
  patch took 8 s – 94 s to download; pass `binary: true` when you need a
  patch for `git apply`.
- **Linked git worktrees are rejected** by `register()`.
- **A merge target must have no uncommitted changes to tracked files**,
  so a failed gate can put it back exactly.
