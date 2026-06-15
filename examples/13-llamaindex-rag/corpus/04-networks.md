# Networks

An createos-sandbox network is a layer-2 overlay that joins multiple sandboxes
into a private broadcast domain. Networks have an opaque id, a
human-readable name, and a member list.

When a sandbox is attached to a network it is assigned a stable overlay
IP from the network's CIDR. Sandboxes on the same network reach each
other directly by IP across the overlay; the host kernel routes packets
between TAP devices on the same bridge.

Membership is mutable — sandboxes can be attached and detached after
creation. Deleting a network detaches every remaining member and frees
the bridge.

Overlay IPs are authoritative when read from `client.networks.get(id)`'s
`members[]` projection. The `SandboxView.ip` field may surface the
sandbox's primary management address, which is not the overlay IP.
