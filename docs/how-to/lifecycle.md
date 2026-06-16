# How-to: manage sandbox lifecycle

Recipes for pausing, resuming, forking, recharging bandwidth, and destroying
sandboxes. For the underlying concepts — state machine, billing model, fork
semantics — see [../explanation/lifecycle.md](../explanation/lifecycle.md).

---

## Pause to stop billing, resume later

### Problem

You want to preserve a sandbox's disk and memory state between tasks without
paying for idle compute time.

### Solution

Call `pause()` and confirm the transition with `waitUntilPaused()`. The
sandbox snapshot is stored; billing for compute stops. When you need it back,
call `resume()` and wait with `waitUntilRunning()`.

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ shape: "s-4vcpu-4gb", rootfs: "devbox:1" });

try {
  // ... do work ...

  // Snapshot and suspend. The handle transitions to pausing → paused.
  await sandbox.pause();
  await sandbox.waitUntilPaused();
  console.log("paused:", sandbox.status); // "paused"

  // Later — restore. The handle transitions to resuming → running.
  await sandbox.resume();
  await sandbox.waitUntilRunning();
  console.log("running:", sandbox.status); // "running"

  // ... continue work ...
} finally {
  await sandbox.destroy();
}
```

`pause()` throws `CreateosSandboxValidationError` if the sandbox is not in a
pausable state (e.g. already pausing or destroyed). Both pollers accept a
`timeoutMs` option:

```ts
await sandbox.waitUntilPaused({ timeoutMs: 30_000 });
```

---

## Auto-pause an idle sandbox

### Problem

You want the control plane to pause the sandbox automatically when it sits idle,
without the client polling for idleness itself.

### Solution

Set `auto_pause_after_seconds` at create time, or update it on a live sandbox
with `setAutoPause(seconds)`. Pass `null` to disable.

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();

// Option A — bake the timeout in at create. Valid range: 60–86400 (1 min – 24 h).
const sandbox = await client.createSandbox({
  shape: "s-4vcpu-4gb",
  rootfs: "devbox:1",
  auto_pause_after_seconds: 300, // pause after 5 min idle
});

try {
  // Option B — change the timeout on a running sandbox.
  await sandbox.setAutoPause(600); // update to 10 min
  console.log("timeout:", sandbox.data.auto_pause_after_seconds); // 600

  // Disable auto-pause entirely.
  await sandbox.setAutoPause(null);
  console.log("timeout:", sandbox.data.auto_pause_after_seconds ?? "off"); // "off"
} finally {
  await sandbox.destroy();
}
```

`setAutoPause` refreshes the handle in place, so `sandbox.data.auto_pause_after_seconds`
reflects the new value immediately after the call returns.

The server rejects values outside 60–86400 with `CreateosSandboxValidationError`.
When the idle timeout fires, the control plane pauses the sandbox exactly as if
you had called `pause()` — compute billing stops, disk and memory state are
preserved.

---

## Fork (branch) a sandbox

### Problem

You want to create one or more independent copies of a sandbox from a known
checkpoint — for example to run parallel experiments from the same base state.

### Solution

Pause the sandbox (fork requires `paused` state), then call `fork()`. Each call
returns a handle to a new, fully independent sandbox. The parent stays paused;
you can fork from it again or resume it independently.

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();
const parent = await client.createSandbox({ shape: "s-4vcpu-4gb", rootfs: "devbox:1" });
let branchA: Awaited<ReturnType<typeof parent.fork>> | undefined;
let branchB: Awaited<ReturnType<typeof parent.fork>> | undefined;

try {
  // ... install deps, set up state ...

  // Pause parent before forking.
  await parent.pause();
  // Fork can occasionally stick in a pausing state on the control plane —
  // always wait for paused before relying on the fork.
  await parent.waitUntilPaused();

  // Fork two independent branches from the same checkpoint.
  branchA = await parent.fork();             // auto-resumes
  branchB = await parent.fork();             // auto-resumes

  await branchA.waitUntilRunning();
  await branchB.waitUntilRunning();

  // The branches are independent — changes in one do not affect the other.
  console.log("branch A:", branchA.id);
  console.log("branch B:", branchB.id);
  console.log("parent still paused:", parent.status); // "paused"

  // ... run experiments on branchA and branchB concurrently ...
} finally {
  await Promise.allSettled([
    branchA?.destroy(),
    branchB?.destroy(),
    parent.destroy(),
  ]);
}
```

To keep a fork paused instead of auto-resuming, pass `start_paused: true`:

```ts
const clone = await parent.fork({ start_paused: true });
// clone.status === "paused"
```

`fork()` throws `CreateosSandboxValidationError` if the source sandbox is not in
a forkable state. The source must be `paused` before forking.

---

## Grow bandwidth quota after create

### Problem

You want to raise a running sandbox's egress cap — either proactively or because
`BandwidthView.capped` is `true`.

### Solution

Read the current quota with `getBandwidth()`, then add bytes with
`rechargeBandwidth(addBytes)`.

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const GiB = 1024 ** 3;

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ shape: "s-4vcpu-4gb", rootfs: "devbox:1" });

try {
  const bw = await sandbox.getBandwidth();
  console.log(`quota: ${bw.quota_bytes} used: ${bw.used_bytes} capped: ${bw.capped}`);

  if (bw.capped) {
    const updated = await sandbox.rechargeBandwidth(10 * GiB); // +10 GiB
    console.log(`new quota: ${updated.quota_bytes}`);
  }
} finally {
  await sandbox.destroy();
}
```

**`bandwidth_quota_bytes` is not settable at create time.** The server rejects
non-zero values at create with a `400`. Use `rechargeBandwidth()` post-create as
the only supported path to grow the cap. `quota_bytes === -1` means unmetered;
`rechargeBandwidth` is a no-op on unmetered sandboxes.

---

## Destroy and confirm

### Problem

You want to tear down a sandbox and be certain the resource has been fully
reclaimed before proceeding.

### Solution

`destroy()` is async server-side: the call returns when the row reaches
`destroying`, but reclamation may still be in progress. Use `waitUntilDestroyed()`
to block until the row is fully reclaimed.

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ shape: "s-4vcpu-4gb", rootfs: "devbox:1" });

try {
  // ... do work ...
} finally {
  const result = await sandbox.destroy();
  // result.status is "destroying" | "destroyed"

  // Block until fully reclaimed if needed (e.g. in tests, or before reusing
  // the same name/slot).
  await sandbox.waitUntilDestroyed();
  console.log("reclaimed:", sandbox.status); // "destroyed"
}
```

`waitUntilDestroyed()` treats `destroying` as an intermediate step and does not
abort on it — only `error` and `failed` states cause it to throw.

---

## Pause vs. fork

**Pause** suspends the same sandbox. Its id is unchanged. Resume picks up exactly
where it left off. Use it to stop billing between sessions.

**Fork** creates a new, independent sandbox from the paused snapshot. The parent
keeps its id and stays paused. Use it to branch experiments or spin up parallel
workloads from a shared base.

For deeper treatment of the state machine and billing model, see
[../explanation/lifecycle.md](../explanation/lifecycle.md).

---

## See also

- [Reference: Sandbox](../reference/sandbox.md) — full method signatures and
  parameter tables for `pause`, `resume`, `fork`, `destroy`, `setAutoPause`,
  `getBandwidth`, `rechargeBandwidth`, and the `waitUntil*` pollers.
