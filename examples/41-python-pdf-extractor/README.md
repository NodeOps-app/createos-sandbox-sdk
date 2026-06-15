# 41 — Python PDF Form Extractor

Upload a fillable PDF into a sandbox, install PyMuPDF, and extract every
form-field name and value to JSON — no external API required.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_BASE_URL` defaults to the
production control plane and only needs to be set to override.

## What it does

1. Creates a sandbox (`s-2vcpu-2gb`, rootfs `devbox:1`).
2. Uploads `sample-form.pdf` (a minimal fillable PDF with three text fields)
   to `/tmp/form.pdf` via `sandbox.files.upload`.
3. Uploads the single-file `extract.py` script to `/tmp/extract.py`.
4. Runs `pip install pymupdf` inside the sandbox (pure-Python wheel; ~150 MB).
5. Runs `python3 /tmp/extract.py /tmp/form.pdf`; the script walks every page's
   widgets and prints a JSON array of `{name, value, type}` objects.
6. Parses the captured stdout, prints each field, and saves `output.json`
   next to `index.ts`.
7. Destroys the sandbox.

## createos-sandbox primitives exercised

| primitive         | SDK call                          |
| ----------------- | --------------------------------- |
| Sandbox lifecycle | `Sandbox.create()`                |
| File upload       | `sandbox.files.upload()`          |
| Buffered exec     | `sandbox.runCommand()`            |
| Tear down         | `sandbox.destroy()`               |

## Versions captured at build time

See `versions.txt`.
