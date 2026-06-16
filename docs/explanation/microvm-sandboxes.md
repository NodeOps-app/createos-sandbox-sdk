# What is a microVM sandbox?

A createos-sandbox **sandbox** is a Firecracker microVM — a real virtual machine
running its own Linux kernel on KVM hardware virtualization, not a
container sharing the host kernel. Each sandbox has its own kernel, its own
memory address space, and its own set of virtual devices. That hard
boundary is the foundation everything else in this platform is built on.

## Why not just a container?

Containers are processes isolated by Linux namespaces and cgroups. They
share the host kernel, so a kernel-level exploit in one container can
escape to every other container and the host. A Firecracker microVM has its
own kernel and memory; a kernel exploit stays inside the VM. The blast
radius of a compromised sandbox is the sandbox. This property is what makes
it safe to run untrusted or model-generated code — code that, by
definition, may attempt to do things you did not intend.

## Rootfs and templates

Every sandbox boots from a **rootfs**: a read-only base image that supplies
the Linux kernel, init system, and pre-installed tooling. On top of that
base the platform layers a writable overlay — changes the sandbox makes
(installed packages, written files, running processes) live in that overlay
and do not affect the base image or any other sandbox.

There are two ways to choose a rootfs:

- **Built-in catalog.** The platform ships a set of curated rootfs images.
  `client.listRootfs()` returns the catalog (`RootfsData`), including the
  default image used when a create request omits `rootfs` entirely. Each
  entry in `entries` carries a `name`, an optional `description`, and a
  deprecation flag with a recommended `successor`.

- **Custom templates.** If you need specific system packages, runtimes, or
  configuration baked in, build a template from a Dockerfile via
  `client.templates.create()`. The platform builds an ext4 rootfs image
  from that Dockerfile (on top of an optional base catalog image) and
  stores it as a reusable template. Once the template's `status` is
  `"ready"`, pass its id or name as the `rootfs` field on a create request
  exactly as you would a catalog name.

Separating the read-only base from the writable overlay means sandbox
startup is fast (the base image is cached on the host) and the base is
never mutated by a running sandbox.

See [../how-to/disks-networks-templates.md](../how-to/disks-networks-templates.md)
for the step-by-step guide to building and using templates.

## Shapes

A **shape** is a sizing preset: a fixed combination of vCPU count
(`vcpu`), memory (`mem_mib`, in MiB), and a default overlay disk size
(`default_disk_mib`, in MiB). Shapes are named, e.g. `s-4vcpu-4gb`. You
pick one at create time by passing its `id` as `CreateSandboxRequest.shape`
— the only required field on a create request.

`client.listShapes()` returns the live catalog. Some shapes carry an
optional `cpu_quota_pct` field (a cgroup v2 `cpu.max` fraction), which
expresses a sub-vCPU soft cap; shapes without it are uncapped. You can
override the disk size at create time via `disk_mib`; the shape default
applies when you omit it.

Always read the catalog rather than hardcoding shape ids — the available
set can change across regions and platform versions.

See [../reference/client.md](../reference/client.md) for `listShapes()` details.

## The guest environment

Inside a sandbox you have a normal Linux system. You can run commands
(via `sandbox.runCommand()`), install packages with the distro's package
manager, bind ports, read and write files, and so on. Env vars can be
injected at create time via `envs`, and SSH public keys via `ssh_pubkeys`
enable direct SSH access through the gateway.

Sandboxes get a private IP (`ip`) and can join overlay (VPC-style) networks
at create time by passing `networks`, which lets sandboxes reach each other
over private addresses. HTTP ingress is opt-in (`ingress_enabled: true` on
the create request) and exposes a public URL template for the sandbox.

Do not assume a specific default working directory — it is determined by
the rootfs, not the SDK.

## What happens when you create a sandbox

Calling `client.createSandbox({ shape: "s-4vcpu-4gb" })` triggers the
following sequence, which the SDK abstracts into a single awaitable call:

1. **Schedule.** The control plane selects a worker host with enough free
   memory for the requested shape and places the sandbox there.

2. **Boot.** Firecracker starts a microVM on that host: it loads the
   rootfs, applies the writable overlay, brings up the Linux kernel, and
   waits for the in-VM agent to come online.

3. **Assign.** The control plane records the sandbox's private IP and
   transitions its `status` to `"running"`.

4. **Poll.** The SDK polls `GET /v1/sandboxes/:id` with adaptive backoff
   until `status` is `"running"` (or until it transitions to `"failed"`).

5. **Return.** You receive a `Sandbox` handle. Every subsequent operation
   on that handle — running commands, managing files, snapshotting — talks
   to that specific sandbox via its id.

The whole sequence typically completes in seconds. The `Sandbox` handle
returned by `createSandbox` is scoped to one VM; to release its resources,
call `sandbox.destroy()` — normally inside a `finally` block:

```ts
const sandbox = await client.createSandbox({ shape: "s-4vcpu-4gb" });
try {
  // ... work ...
} finally {
  await sandbox.destroy();
}
```

See [./lifecycle.md](./lifecycle.md) for the full state machine
(`creating` → `running` → `paused` / `destroying` → `destroyed`),
[./handle-model.md](./handle-model.md) for how the `Sandbox` handle is
designed, and [../quickstart.md](../quickstart.md) to get running in
minutes.
