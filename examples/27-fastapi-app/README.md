# 27 — FastAPI App

Run a FastAPI ASGI web server inside an FC microVM, expose it through the
sandbox's public ingress URL, and verify live JSON responses from two routes.

## Run

```sh
cp .env.example .env
# fill in FC_BASE_URL + FC_API_KEY
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a sandbox with `ingress_enabled: true` (`s-1vcpu-1gb`, `devbox:1`).
2. Installs `python3-venv` via `apt-get`, then creates `/opt/venv` and installs
   `fastapi` and `uvicorn` into the venv.
3. Uploads `app.py` (an ASGI app with two routes: `GET /` and
   `GET /items/{item_id}`) into the VM via `sandbox.files.upload`.
4. Daemonises `uvicorn main:app --host 0.0.0.0 --port 8000` via `nohup setsid`
   (no systemd in `devbox:1`), binding `0.0.0.0` so the ingress proxy can reach it.
5. Waits for uvicorn to bind its port with `sandbox.waitForPortReady`.
6. Polls the public ingress URL until `GET /` returns a JSON body.
7. Fetches `GET /items/42?q=hello` and asserts the parsed JSON matches
   `{ item_id: 42, q: "hello" }` — confirming path + query parameter routing.
8. Destroys the sandbox in a `finally` block.

## FC primitives exercised

| Primitive                          | SDK call                                      |
| ---------------------------------- | --------------------------------------------- |
| Create sandbox with public ingress | `fc.createSandbox({ ingress_enabled: true })` |
| Upload app source into the VM      | `sandbox.files.upload(path, contents)`        |
| Run commands (install, daemonise)  | `sandbox.runCommand("bash", ["-lc", ...])`    |
| Build the public preview URL       | `sandbox.previewUrl(port)`                    |
| Block until the server listens     | `sandbox.waitForPortReady(port)`              |
| Tear the sandbox down              | `sandbox.destroy()`                           |

## Versions captured at build time

See `versions.txt`.
