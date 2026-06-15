# 42 — Python doc to Markdown converter

Uploads a local document (HTML, DOCX, PDF, XLSX, …) into a createos-sandbox sandbox,
converts it to Markdown using [Microsoft MarkItDown](https://github.com/microsoft/markitdown)
(installed with pip inside the guest), downloads the result, and prints it
to stdout — no external API keys required.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY and CREATEOS_SANDBOX_BASE_URL
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_BASE_URL` and `CREATEOS_SANDBOX_API_KEY`
are the only required inputs.  To convert a different file, swap `sample.html`
for any document MarkItDown supports, update `INPUT_LOCAL` at the top of
`index.ts`, and adjust `REMOTE_INPUT` to match the file extension.

## What it does

1. Creates an `s-4vcpu-4gb` sandbox on the `devbox:1` rootfs.
2. Uploads `sample.html` (the local source document) to `/tmp/input.html`
   inside the guest via `files.upload`.
3. Installs `markitdown[all]` with pip — this pulls in every optional
   converter (DOCX, PDF, XLSX, images, audio, etc.).
4. Verifies the tool is on PATH (`python3 -m markitdown --version`).
5. Converts the input file: `python3 -m markitdown /tmp/input.html -o /tmp/out.md`.
6. Downloads `/tmp/out.md` with `files.download` and prints the Markdown to
   stdout.
7. Destroys the sandbox in the `finally` block.

## createos-sandbox primitives exercised

| Primitive                          | SDK call                                           |
| ---------------------------------- | -------------------------------------------------- |
| Boot stock devbox rootfs           | `Sandbox.create({ rootfs: "devbox:1" })`           |
| Upload local file to the guest     | `sandbox.files.upload(path, bytes)`                |
| Run a buffered guest command       | `sandbox.runCommand(cmd, args, { timeoutMs })`     |
| Download a file from the guest     | `sandbox.files.download(path)`                     |
| Tear the sandbox down              | `sandbox.destroy()`                                |

## Versions captured at build time

See `versions.txt`.
