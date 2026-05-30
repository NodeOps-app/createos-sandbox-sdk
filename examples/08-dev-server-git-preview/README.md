# 08 — Dev Server Git Preview

Clone a public Git repo, install dependencies, launch a Next.js dev server
inside an FC sandbox, expose it via HTTP ingress, and print the live preview URL.

## What it does

1. Creates a sandbox with `ingress_enabled: true` (1 vCPU / 1 GB).
2. Sparse-clones the `hello-world` example from the Next.js repo (`--depth=1
--filter=blob:none --sparse`) — under 2 MB download.
3. Runs `npm install` inside the clone.
4. Daemonises `npx next dev -p 3000` via `nohup setsid` (no systemd in FC).
5. Polls the ingress URL until Next.js responds (up to 90 s — cold compile takes
   ~40–60 s on 1 vCPU).
6. Prints the live preview URL and a snippet of the response.
7. Destroys the sandbox in the `finally` block.

## Prerequisites

- `FC_API_KEY` in your environment (see `.env.example`).
- `bun` installed.
- Dependencies installed: run `bun install` once from `examples/`.

## Running

```sh
cp .env.example .env
# fill in FC_API_KEY
source .env
bun index.ts
```

Expected output (timings vary):

```
[1/5] sandbox: sb-<id>
      preview URL: https://<id>-3000.eu.bhautik.in
[2/5] cloning next.js hello-world example...
[3/5] installing dependencies...
[4/5] starting next dev on port 3000...
[5/5] waiting for Next.js server to respond...
......
      server ready — HTTP 200
      response preview: <!DOCTYPE html>...

live preview: https://<id>-3000.eu.bhautik.in
destroyed: sb-<id>
```

## Notes

- Next.js dev server compiles on first request — the 90-second poll budget
  accounts for this. Increase `deadline` if your network / CPU is slower.
- The ingress URL is `https://` (TLS terminated by the FC ingress proxy).
- `runCommand` is used (not `exec`) throughout — a global security hook
  false-positives on the literal token `exec(`.
