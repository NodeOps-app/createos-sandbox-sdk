# 03 — Dev Server with Preview URL

Bind an HTTP server inside a sandbox and reach it from the public
internet via FC's per-sandbox ingress URL — no SSH tunnel, no
port-forward, no DNS setup.

## Run

```sh
cp .env.example .env  # fill in FC_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. `FC_BASE_URL` defaults to the
production control plane and only needs to be set to override.

> ℹ️ The example fetches the preview URL over `http://` (port 80). The
> wildcard `*.eu.bhautik.in` does not yet have a real TLS cert — tracked
> at [fc#41](https://github.com/NodeOps-app/fc/issues/41). `http://` is
> forward-compatible: once the cert lands, ingress-nginx will redirect
> to `https://` and `fetch` follows it transparently.

## What it does

1. Creates a sandbox on `s-1vcpu-256mb` + `devbox:1` with
   `ingress_enabled: true`.
2. Launches `python3 -m http.server 8080 --bind 0.0.0.0` daemonised
   (devbox:1 has no systemd).
3. Polls `waitForPortReady(8080)` until the server accepts connections.
4. Derives the public URL: `http://<ulid>-8080.eu.bhautik.in/` (the
   `sb-` prefix is stripped from `sandbox.id`).
5. `fetch`es the URL and prints the response body.
6. Destroys the sandbox.

## FC primitives exercised

| primitive                | SDK call                                              |
| ------------------------ | ----------------------------------------------------- |
| Public ingress           | `ingress_enabled: true` on `Sandbox.create()`         |
| URL derivation           | `http://<ulid>-<port>.<region>.<domain>/`             |
| Background process in VM | `nohup setsid … &` (devbox:1 has no systemd)          |
| Port readiness           | `sandbox.waitForPortReady()`                          |
| Loopback gotcha          | bind `0.0.0.0`, not `127.0.0.1` — ingress is via eth0 |
| Tear down                | `sandbox.destroy()`                                   |

## Versions captured at build time

See `versions.txt`.
