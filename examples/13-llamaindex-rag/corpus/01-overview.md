# createos-sandbox Overview

createos-sandbox is a microVM sandbox control plane built on Firecracker. It exposes
an HTTP API that lets clients spawn lightweight VMs, run commands inside
them, move files in and out, and join sandboxes onto private overlay
networks.

A sandbox is a single Firecracker VM with a kernel, a read-only rootfs and
an overlay disk. The createos-sandbox-agent daemon inside the guest brokers commands,
file operations, and lifecycle signals from the control plane.

Each sandbox is identified by an opaque id of the form `sb_01K...`. Ids are
ULIDs, so they sort lexically by creation time.
