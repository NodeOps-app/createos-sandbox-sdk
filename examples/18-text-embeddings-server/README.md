# 18 — Text-embeddings server (model-as-a-service over ingress)

Runs a small CPU text-embeddings model as a long-lived HTTP service
_inside_ one FC sandbox, exposes it on the public ingress URL, and embeds
a batch of texts by POSTing to it from the host with plain `fetch` — no
client SDK in the request path. This is the serving counterpart to
example 13's in-sandbox RAG: there the model lives and dies with a single
script; here it's a network service you can call from anywhere.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env`. `CREATEOS_SANDBOX_API_KEY` is required; `CREATEOS_SANDBOX_BASE_URL` defaults to
the production control plane and only needs to be set to override. No
external API key — the embedding model is public and runs on CPU inside
the sandbox.

## What it does

1. Creates a sandbox on `s-2vcpu-2gb` + `devbox:1` with
   `ingress_enabled: true`.
2. Installs `torch` (CPU wheel) + `sentence-transformers` via a detached
   `pip` run, polling a marker file so no single command stays open long
   enough to trip a gateway timeout.
3. Uploads `server.py` and boots it with `nohup setsid python3 … &`
   (devbox:1 has no systemd). The server binds `0.0.0.0:8080` — ingress
   forwards to `eth0`, not loopback — and loads the model on first start.
4. `waitForPortReady(8080)` blocks until the port accepts connections.
   The ingress URL comes from `sandbox.previewUrl(8080)` (built from the
   control-plane template), with the scheme downgraded to `http://`.
5. Health-checks `GET /health` over ingress until the model reports ready.
6. `POST /embed` with a 4-text batch from the host with global `fetch`,
   asserts the returned vector count and dimension, and prints them as
   evidence.
7. Destroys the sandbox (with retry) in a `finally` block.

Only one sandbox is alive at a time — friendly to the shared
concurrent-sandbox cap.

## Model choice — trade-off

The reference workload uses a GPU and HF Text Embeddings Inference (TEI).
FC has no GPU, so this example serves a **small CPU model**,
`BAAI/bge-small-en-v1.5` (384-dim), via a stdlib `http.server` wrapper
around `sentence-transformers`. That's simpler and more robust on a
CPU-only devbox than the TEI container: no GPU runtime, no extra image,
and the only third-party dependency is `sentence-transformers` plus its
CPU torch wheel. The endpoint shape (`POST /embed` → dense vectors) mirrors
a standard embeddings API, so swapping in a larger model is a one-line
change to `EMBED_MODEL`.

## Ingress

The server is reached at `http://<ulid>-<port>.<region>.<domain>` on port
80 over plain `http://` (the wildcard TLS cert is not in place yet;
`http://` is forward-compatible). `sandbox.previewUrl(port)` returns the
`https://` form built from the control-plane template; the example
downgrades the scheme.

## FC primitives exercised

| primitive                   | SDK call                                      |
| --------------------------- | --------------------------------------------- |
| Create sandbox with ingress | `fc.createSandbox({ ingress_enabled: true })` |
| Upload the server           | `sandbox.files.upload()`                      |
| Install deps / boot daemon  | `sandbox.runCommand()`                        |
| Wait for the port to listen | `sandbox.waitForPortReady()`                  |
| Build the public URL        | `sandbox.previewUrl()`                        |
| Call the service            | host-side global `fetch` over the ingress URL |
| Tear down                   | `sandbox.destroy()`                           |

## Versions captured at build time

See `versions.txt`.
