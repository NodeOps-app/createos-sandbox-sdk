# 07 — Docker via Custom Template

Builds a custom FC template with Docker CE pre-installed, launches a sandbox from it,
starts the Docker daemon, then pulls and runs containers inside the microVM.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_BASE_URL` and
`CREATEOS_SANDBOX_API_KEY` are the standard inputs `createos-sandbox-sdk` consumes; any
additional secrets the example needs (LLM keys, third-party API
tokens) are documented in `.env.example`.

## What it does

1. Submits a Dockerfile (Docker CE via the official convenience script) to `fc.templates.create()`.
2. Streams the build log live until the terminal frame (`final: true`) arrives.
3. Launches a sandbox with the built rootfs as its filesystem.
4. Starts the Docker daemon in the background (`nohup setsid dockerd &`).
5. Polls `docker info` until dockerd is ready (up to 60 s).
6. Runs `hello-world` and `alpine` containers, then lists local images.
7. Destroys the sandbox and deletes the template.

## FC primitives exercised

| primitive                               | SDK call                                    |
| --------------------------------------- | ------------------------------------------- |
| Build a custom rootfs from a Dockerfile | `fc.templates.create()`                     |
| Stream live build logs                  | `fc.templates.followLogs()`                 |
| Launch sandbox from custom template     | `fc.createSandbox({ rootfs: template.id })` |
| Run a buffered command                  | `sandbox.runCommand()`                      |
| Tear down sandbox                       | `sandbox.destroy()`                         |
| Delete a template                       | `fc.templates.delete()`                     |

## Versions captured at build time

See `versions.txt`.
