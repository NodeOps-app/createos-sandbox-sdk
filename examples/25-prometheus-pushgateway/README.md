# 25 — Prometheus Pushgateway

Runs a [Prometheus Pushgateway](https://github.com/prometheus/pushgateway)
inside an FC microVM with public HTTP ingress, pushes a custom metric to it,
then scrapes `/metrics` through the ingress URL to verify the full round-trip.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_BASE_URL and CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example directory. No other secrets are
required — Prometheus Pushgateway is installed from the official GitHub
releases and runs entirely inside the sandbox.

## What it does

1. Creates an FC sandbox (`s-1vcpu-1gb`, `devbox:1`) with `ingress_enabled: true`
   so the Pushgateway's HTTP API is reachable from outside the microVM.
2. Downloads the official Prometheus Pushgateway binary from GitHub and
   installs it at `/usr/local/bin/pushgateway`.
3. Daemonises the Pushgateway on `0.0.0.0:9091` using `nohup setsid` (no
   systemd in devbox) — binding `0.0.0.0` is required for FC ingress
   forwarding.
4. Waits for port 9091 to accept connections via `waitForPortReady`.
5. Pushes a custom counter metric (`fc_example_requests_total{env="sandbox"} 42`)
   to the Pushgateway's `/metrics/job/fc_example_job` endpoint using `curl`
   inside the sandbox.
6. Scrapes the public `/metrics` ingress URL until the metric appears,
   confirming the full push→scrape round-trip over the FC ingress layer.
7. Prints the scraped metric lines and destroys the sandbox in the `finally`
   block.

## FC primitives exercised

| primitive                      | SDK call                                      |
| ------------------------------ | --------------------------------------------- |
| Boot with HTTP ingress         | `fc.createSandbox({ ingress_enabled: true })` |
| Public preview URL             | `sandbox.previewUrl(9091)`                    |
| Run buffered commands in guest | `sandbox.runCommand()`                        |
| Wait for server to bind port   | `sandbox.waitForPortReady(9091)`              |
| Tear the sandbox down          | `sandbox.destroy()`                           |

## Versions captured at build time

See `versions.txt`.
