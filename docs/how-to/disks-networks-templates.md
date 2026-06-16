# How-to: disks, networks, and custom templates

Three independent recipes. Each has a self-contained code block you can
adapt; they share the same import and client setup.

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();
// reads CREATEOS_SANDBOX_API_KEY + CREATEOS_SANDBOX_BASE_URL from env
```

See [DisksApi / NetworksApi / TemplatesApi](../reference/sub-apis.md) for
full method signatures. Per-sandbox operations are covered in
[Sandbox](../reference/sandbox.md).

---

## 1. Attach an S3-backed disk

### Problem

You want a sandbox to read and write files that outlive the VM — stored
durably in an S3-compatible bucket — without bundling them into the rootfs
image.

### Solution

Register the bucket once as a named disk, then mount it at sandbox create
time via `CreateSandboxRequest.disks` (boot-time) or live-attach it to a
running sandbox with `sandbox.attachDisk`. Detach before destroying so the
bucket is flushed cleanly, then delete the disk registration when you no
longer need it.

```ts
import { CreateosSandboxClient, CreateosSandboxNotFoundError } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();

// 1. Register the S3 bucket as a disk (idempotent by name).
//    The bucket must be reachable from the createos-sandbox agent, not just
//    from this machine. Verify connectivity before registering.
const disk = await client.disks.create({
  name: "my-data",          // ^[a-z0-9][a-z0-9-]{0,62}$
  kind: "s3",
  config: {
    bucket: process.env.S3_BUCKET!,
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION,      // optional
    // use_path_style: true,            // MinIO / R2 with custom domain
  },
  credentials: {
    access_key: process.env.S3_ACCESS_KEY!,
    secret_key: process.env.S3_SECRET_KEY!,
  },
});
// Capture the resolved disk_<ulid> id immediately.
// detachDisk requires this id — it does NOT resolve disk names.
// attachDisk and client.disks.* accept either name or id.
const DISK_ID = disk.id;   // "disk_01abc…"
const MOUNT   = "/mnt/data";

try {
  // 2a. Mount at boot via CreateSandboxRequest.disks (preferred).
  const sandbox = await client.createSandbox({
    shape: "s-4vcpu-4gb",
    rootfs: "devbox:1",
    disks: [{ disk_id: DISK_ID, mount_path: MOUNT }],
    // sub_path: "project/assets",  // expose a bucket sub-folder instead
  });

  try {
    // 3. Use the mount — files written here persist to S3.
    const result = await sandbox.runCommand("ls", ["-la", MOUNT]);
    console.log(result.result.stdout);

    // 2b. Live-attach a second disk to a running sandbox (alternative path).
    //     The sandbox must be in "running" state; paused sandboxes pick up
    //     new disks via CreateSandboxRequest.disks at create or fork time.
    // await sandbox.attachDisk({ diskId: "other-disk", mountPath: "/mnt/other" });

    // 4. Detach before destroy — use the disk_<ulid> id, not the name.
    await sandbox.detachDisk({ diskId: DISK_ID, mountPath: MOUNT });
    // Returns { detached: boolean }. Bucket contents are untouched.
  } finally {
    await sandbox.destroy();
  }
} finally {
  // 5. Delete the disk registration (bucket contents are untouched).
  await client.disks.delete(disk.name).catch((e) => console.warn(e));
}
```

**Gotchas**

- `detachDisk` requires `diskId` to be the `disk_<ulid>` **id**, not the
  human-readable name. The detach handler matches the attachment row by raw
  id. `attachDisk`, `client.disks.get`, and `client.disks.delete` all
  accept either. Capture `disk.id` right after `disks.create` and pass it
  through.
- `mountPath` is required on `detachDisk`. The same disk may be mounted at
  multiple paths; the composite key is `(sandbox, disk, mountPath)`.
- The bucket must be reachable from the createos-sandbox agent's network,
  not just from the machine running this script. A misconfigured endpoint
  or missing credentials causes a mount error — check `mount_status` via
  `sandbox.listDisks()` if the mount fails.
- `bandwidth_quota_bytes` is not a create-time field. Grow it post-create
  with `sandbox.rechargeBandwidth()` if needed.

---

## 2. Connect sandboxes on a private overlay network

### Problem

You want two or more sandboxes to talk to each other by IP without
exposing traffic to the public internet.

### Solution

Create a named overlay network, then either pass it in `networks` at
sandbox create time or attach a running sandbox with
`sandbox.attachNetwork`. After creation, look up per-sandbox overlay IPs
from `client.networks.get(id).members` — `SandboxView.ip` is the
management address, not the overlay address.

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();

// 1. Create the overlay network.
const network = await client.networks.create({ name: "backend" });
// network.id = "net_01abc…"

let sandboxA: Awaited<ReturnType<typeof client.createSandbox>> | undefined;
let sandboxB: Awaited<ReturnType<typeof client.createSandbox>> | undefined;

try {
  // 2. Boot two sandboxes already joined to the network.
  //    Alternatively, call sandbox.attachNetwork(network.id) on a running sandbox.
  [sandboxA, sandboxB] = await Promise.all([
    client.createSandbox({
      shape: "s-4vcpu-4gb",
      rootfs: "devbox:1",
      name: "node-a",
      networks: [{ id: network.id }],
    }),
    client.createSandbox({
      shape: "s-4vcpu-4gb",
      rootfs: "devbox:1",
      name: "node-b",
      networks: [{ id: network.id }],
    }),
  ]);

  // 3. Resolve per-sandbox overlay IPs via networks.get().
  //    networks.get() returns members with per-network IPs on detail GET.
  //    SandboxView.ip is the management IP, not the overlay address —
  //    always read overlay IPs from networkView.members.
  const networkView = await client.networks.get(network.id);
  const ipById = new Map(
    (networkView.members ?? []).map((m) => [m.sandbox_id, m.ip]),
  );
  const ipA = ipById.get(sandboxA.id);
  const ipB = ipById.get(sandboxB.id);
  console.log("overlay IPs:", ipA, ipB);

  // 4. Sandboxes reach each other on the overlay by those IPs.
  if (ipA && ipB) {
    const ping = await sandboxB.runCommand("ping", ["-c", "3", ipA]);
    console.log(ping.result.stdout);
  }

  // 5. Detach and clean up.
  await Promise.all([
    sandboxA.detachNetwork(network.id),
    sandboxB.detachNetwork(network.id),
  ]);
} finally {
  await Promise.allSettled([
    sandboxA?.destroy(),
    sandboxB?.destroy(),
  ]);
  // Delete may fail transiently if members are still tearing down server-side.
  // Retry to avoid leaking against the network quota.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.networks.delete(network.id);
      break;
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
```

**Gotchas**

- `sandbox.attachNetwork` requires the sandbox to be running. Use
  `networks: [{ id }]` in `createSandbox` if you want the sandbox to join
  at boot.
- Overlay IPs come from `networkView.members[].ip`, not from
  `SandboxView.ip`. Poll `client.networks.get()` after create if the
  membership is still being programmed (`ip` is absent until then).
- `networks.delete` may return a "network in use" error for a few seconds
  after sandbox destroy. Retry with a short delay rather than ignoring the
  error — uncleaned networks count against the per-account quota.

---

## 3. Build a custom rootfs template from a Dockerfile

### Problem

You want a prebuilt rootfs image with custom packages or configuration so
sandboxes boot from it instantly, without re-running `apt-get install` on
every create.

### Solution

`client.templates.create` accepts a Dockerfile and builds a rootfs image
server-side. Follow build progress with `templates.followLogs` (streaming),
then poll `templates.get` for terminal status, and finally pass the
template's `id` or `name` as `rootfs` in `createSandbox`.

```ts
import { CreateosSandboxClient, pollUntil } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();

// Dockerfile rules: single FROM using an allowlisted createos-sandbox base
// image. No COPY / ADD — layer content comes from RUN only.
const DOCKERFILE = `FROM nodeops/sandbox:debian
RUN apt-get update -qq \\
 && apt-get install -y --no-install-recommends ripgrep ca-certificates \\
 && rm -rf /var/lib/apt/lists/*
`;

const TEMPLATE_NAME = `rg-base-${Date.now()}`;

// 1. Submit the build. Returns immediately with status "pending".
const tmpl = await client.templates.create({
  name: TEMPLATE_NAME,
  dockerfile: DOCKERFILE,
  // base: "devbox:1",   // override the base rootfs (empty = host default)
});
console.log("template id:", tmpl.id, "status:", tmpl.status);

try {
  // 2. Stream build logs until the terminal event arrives.
  //    Pass a generous timeoutMs — builds can outlast the default 60 s deadline.
  try {
    for await (const event of client.templates.followLogs(tmpl.id, { timeoutMs: 600_000 })) {
      if (event.line) process.stdout.write(event.line + "\n");
      if (event.final) {
        console.log("build finished:", event.status);
        break;
      }
    }
  } catch {
    // Stream may close before the final event; confirm status by polling below.
  }

  // 3. Poll for terminal status — the log stream may close before "ready".
  await pollUntil({
    poll: () => client.templates.get(tmpl.id).then((t) => t.status),
    done: (status) => status === "ready",
    failed: (status) =>
      status === "pending" || status === "building"
        ? undefined
        : `template build failed (${status}) — see build logs`,
    timeoutMs: 600_000,
  });
  console.log("template ready:", tmpl.id);

  // 4. Boot a sandbox on the template.
  //    rootfs accepts the template id or its name.
  const sandbox = await client.createSandbox({
    shape: "s-4vcpu-4gb",
    rootfs: tmpl.id,
  });

  try {
    const rg = await sandbox.runCommand("rg", ["--version"]);
    console.log(rg.result.stdout.trim());
  } finally {
    await sandbox.destroy();
  }
} finally {
  // 5. Delete the template when no longer needed.
  await client.templates.delete(tmpl.id).catch((e) => console.warn(e));
}
```

You can also fetch the full build log as plain text after the fact:

```ts
const log = await client.templates.logs(tmpl.id);
console.log(log);
```

Or re-fetch the template with its Dockerfile included:

```ts
const detail = await client.templates.get(tmpl.id, { include: "dockerfile" });
console.log(detail.dockerfile);
```

**Gotchas**

- `templates.create` returns immediately; the build is asynchronous. Always
  wait for `status === "ready"` before creating a sandbox on the template.
- `templates.followLogs` may close the stream before emitting the `final`
  event — always poll `templates.get` as a fallback (see step 3 above).
- Dockerfile must use a single `FROM` pointing to an allowlisted createos-sandbox
  base image. `COPY` and `ADD` are not permitted — bring content in via
  `RUN`.
- Build time is unbounded. Pass `timeoutMs: 600_000` (or longer) to
  `followLogs` and `pollUntil`.
- `TemplateStatus` values: `"pending"` → `"building"` → `"ready"` |
  `"failed"`.
