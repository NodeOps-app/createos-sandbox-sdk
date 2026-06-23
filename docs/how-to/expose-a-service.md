# How-to: expose a service with a preview URL

## Problem

You started an HTTP server inside the sandbox and want to reach it from
outside — from a browser, a CI job, or your own code — without setting up
SSH tunnels or port mappings.

## Solution

The control plane provisions a public hostname for every sandbox created
with `ingress_enabled: true`. Any TCP server bound to `0.0.0.0` on an
arbitrary port inside the VM becomes reachable at a stable URL derived
from that hostname.

The canonical recipe:

1. Create the sandbox with `ingress_enabled: true`.
2. Start your server bound to `0.0.0.0:<port>` (not `127.0.0.1`).
3. Call `waitForPortReady(port)` to block until the listener is up.
4. Call `previewUrl(port)` to get the public URL.
5. `fetch` it, hand it to a browser, or pass it downstream.

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient({
  baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL!,
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY!,
});

const sandbox = await client.createSandbox({
  shape: "s-4vcpu-4gb",
  rootfs: "devbox:1",
  ingress_enabled: true,          // provisions the public hostname
});

// Get the URL before try so you can log it even if setup fails.
// Use scheme: "http" — see "Scheme: http vs https" below.
const url = sandbox.previewUrl(8080, { scheme: "http" });
console.log("preview URL:", url);

try {
  // Start the server in the background.
  // IMPORTANT: bind to 0.0.0.0, not 127.0.0.1 — ingress forwards to eth0,
  // not loopback. A server bound to localhost is unreachable from outside.
  // nohup/setsid daemonises without systemd; redirect stdio or runCommand blocks.
  await sandbox.runCommand("sh", [
    "-c",
    "nohup setsid python3 -m http.server 8080 --bind 0.0.0.0 >/tmp/srv.log 2>&1 &",
  ]);

  // Block until the port accepts connections inside the VM.
  // waitForPortReady probes /dev/tcp from inside — it confirms the listener
  // is up before ingress routing matters.
  await sandbox.waitForPortReady(8080, { timeoutMs: 15_000 });

  // The port is bound. Fetch through the public ingress URL.
  const res = await fetch(url);
  console.log("HTTP", res.status, await res.text());
} finally {
  await sandbox.destroy();
}
```

### Binding to `0.0.0.0` is required

Ingress routes traffic to the VM's `eth0` interface, **not** loopback.
A server bound to `127.0.0.1` or `localhost` will not be reachable from
outside the VM, even though `waitForPortReady` (which probes from inside)
will succeed. Always pass `--bind 0.0.0.0`, `--host 0.0.0.0`, or the
equivalent flag for your server.

### Backgrounding a long-running server

`runCommand` waits for the process to exit. To start a persistent server
you must detach it:

```ts
// Pattern: nohup + setsid + stdio redirect + trailing &
await sandbox.runCommand("sh", [
  "-c",
  "nohup setsid my-server --port 8080 >/tmp/server.log 2>&1 &",
]);
```

- `nohup` — ignore SIGHUP so the process survives the shell dying.
- `setsid` — move into a new session (no controlling terminal).
- `>/tmp/server.log 2>&1` — redirect stdout/stderr; without this, the
  shell's stdio stays open and `runCommand` blocks forever.
- `&` — background the process so the shell exits, returning control.

### Scheme: `http` vs `https`

`previewUrl` defaults to `https`. Use `{ scheme: "http" }` unless your
ingress wildcard domain has a provisioned TLS certificate:

```ts
// https (default) — only safe if TLS is provisioned for the hostname
const secureUrl = sandbox.previewUrl(8080);

// http — always works; use this when TLS is not yet provisioned
const plainUrl = sandbox.previewUrl(8080, { scheme: "http" });
```

An `https` preview against a missing or self-signed certificate will fail
in standard fetch clients and browsers. Prefer `http` unless you have
confirmed that TLS is available for the sandbox domain.

### Enabling ingress after creation

If you created the sandbox without `ingress_enabled`, toggle it on with
`setIngress`:

```ts
await sandbox.setIngress(true);   // PATCH; refreshes the handle in place
const url = sandbox.previewUrl(8080, { scheme: "http" });
```

`setIngress` returns `this` so it is chainable. The handle's cached
projection is updated with the new `ingress_url_template`.

## Disable ingress

To revoke the public hostname while keeping the sandbox alive:

```ts
await sandbox.setIngress(false);  // clears ingress_url_template on the handle
```

After this, `previewUrl` throws until ingress is re-enabled. Destroying
the sandbox also removes the hostname.

## See also

- [`Sandbox` reference](../reference/sandbox.md) — full `setIngress`,
  `waitForPortReady`, and `previewUrl` signatures.
- [Tutorial](../tutorial.md) — end-to-end walkthrough including sandbox
  creation and cleanup.
