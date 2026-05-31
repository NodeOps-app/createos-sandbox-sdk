# 30 — Headless Chromium + DevTools Port

Install Google Chrome stable inside an FC sandbox, start it in headless mode
with the Chrome DevTools Protocol (CDP) port, then prove remote debugging
works by fetching `/json/version` through the public ingress URL.

## Run

```sh
cp .env.example .env
# fill in FC_BASE_URL and FC_API_KEY
bun index.ts
```

Expected output (timings vary — Chrome + deps install takes ~60–90 s):

```
[1/8] creating sandbox (shape=s-1vcpu-2gb, rootfs=devbox:1, ingress on)...
      sandbox: sb-<id>  ip: 10.0.0.x
      preview URL: http://<id>-8080.fc-spawn.example.com
[2/8] installing Chrome deps + nginx (apt-get)...
[3/8] downloading + installing Google Chrome stable...
      Google Chrome 148.0.7778.215
[4/8] writing nginx reverse proxy config...
[5/8] launching Google Chrome headless on CDP port 9222...
[6/8] starting nginx proxy...
[7/8] waiting for nginx proxy to bind port 8080...
      port is accepting connections
[8/8] polling /json/version through the ingress URL...

── GET /json/version  (HTTP 200) ──────────────────────────────
  Browser:              Chrome/148.0.7778.215
  Protocol-Version:     1.3
  webSocketDebuggerUrl: ws://127.0.0.1:9222/devtools/browser/<uuid>

── GET /json/list  (HTTP 200, 6 target(s)) ──
  type: background_page
  ...

verified end-to-end: Chrome/148.0.7778.215 reachable at http://<id>-8080.fc-spawn.example.com/json/version
```

## What it does

1. Creates a sandbox (`s-1vcpu-2gb`) with `ingress_enabled: true`.
2. Installs Google Chrome stable runtime libraries and nginx via `apt-get`.
3. Downloads and installs Google Chrome stable from the official `.deb`.
4. Writes an nginx config that listens on `0.0.0.0:8080` (the ingress-exposed
   port) and proxies to Chrome's CDP listener at `127.0.0.1:9222`, rewriting
   the `Host` header to `127.0.0.1:9222` — Chrome's `/json/*` endpoints
   reject DNS-name Host headers as a DNS-rebinding defence; the IP literal
   satisfies the check.
5. Launches Chrome headless with `--remote-debugging-port=9222` via
   `nohup setsid` (no systemd in FC sandboxes).
6. Starts nginx in the foreground, also daemonized via `nohup setsid`.
7. Waits for nginx to bind port 8080 with `sandbox.waitForPortReady`.
8. Polls `<previewUrl>/json/version` through the public ingress until Chrome
   responds with a JSON object containing a `Browser` field.
9. Fetches `/json/list` to confirm debugging targets are listed.
10. Destroys the sandbox in a `finally` block.

## FC primitives exercised

| Primitive                         | SDK call                                        |
| --------------------------------- | ----------------------------------------------- |
| Sandbox with public ingress       | `fc.createSandbox({ ingress_enabled: true })`   |
| Run commands (install, daemonize) | `sandbox.runCommand("bash", ["-lc", script])`   |
| Upload a config file              | `sandbox.files.upload(path, content)`           |
| Wait for a port to bind           | `sandbox.waitForPortReady(port, { timeoutMs })` |
| Public ingress URL                | `sandbox.previewUrl(port)`                      |
| Cleanup                           | `sandbox.destroy()` in `finally`                |

## Versions captured at build time

See `versions.txt`.
