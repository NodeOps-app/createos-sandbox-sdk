# Shapes

A shape describes the resource envelope of a sandbox. The control plane
ships five canonical shapes:

- `s-1vcpu-256mb`: 1 vCPU, 256 MiB RAM, 10 GiB default overlay disk.
- `s-1vcpu-1gb`: 1 vCPU, 1024 MiB RAM, 10 GiB default disk.
- `s-2vcpu-2gb`: 2 vCPU, 2048 MiB RAM, 10 GiB default disk.
- `s-2vcpu-4gb`: 2 vCPU, 4096 MiB RAM, 10 GiB default disk.
- `s-4vcpu-4gb`: 4 vCPU, 4096 MiB RAM, 10 GiB default disk.

The overlay disk can be grown after creation with the `resize` operation,
up to the host's free capacity. The shape's memory cannot be resized
in-place; clone the sandbox into a larger shape via `fork` instead.

The default disk is shared between the rootfs overlay and any data the
workload writes; long-running build sandboxes typically request 20480 MiB
or more.
