# How-to: move files in and out of a sandbox

## Problem

You need to push code, data, or configuration into a running sandbox and
pull artifacts back out — a script to run, a PDF to process, a generated
report to save locally.

## Solution

File transfer lives on `sandbox.files`, a [`SandboxFiles`](../reference/sandbox.md#sandboxfiles)
instance scoped to that sandbox.

- `upload(path, data)` — writes `data` to an absolute guest path.
  `data` is `BodyInit`: a `string`, `Uint8Array` / `Buffer`, `Blob`, or
  `ReadableStream`.
- `download(path)` — reads a guest file and returns an `ArrayBuffer`.

Both methods accept an optional `RequestOptions` third argument
(`timeoutMs`, `signal`, etc.).

## Upload: text and binary

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();
const sandbox = await client.sandboxes.create({ shape: "s-4vcpu-4gb", rootfs: "devbox:1" });

try {
  // Text — a string is valid BodyInit.
  await sandbox.files.upload("/tmp/hello.sh", "#!/bin/sh\necho hello\n");

  // Binary — pass a Uint8Array or Buffer.
  import { readFile } from "node:fs/promises";
  const bytes = await readFile("/local/data/input.bin");
  await sandbox.files.upload("/tmp/input.bin", bytes);
} finally {
  await sandbox.destroy();
}
```

Guest paths must be **absolute**. Parent directories must already exist;
create them first if needed:

```ts
await sandbox.runCommand("mkdir", ["-p", "/opt/myapp/data"]);
await sandbox.files.upload("/opt/myapp/data/config.json", configJson);
```

## Download: text and binary

`download` always returns an `ArrayBuffer`. Decode it with `TextDecoder`
for text, or pass it straight to `writeFile` / `Buffer.from` for binary:

```ts
// Read as text
const buf = await sandbox.files.download("/tmp/result.txt");
console.log(new TextDecoder().decode(buf));

// Save binary artifact to disk
import { writeFile } from "node:fs/promises";
const imgBuf = await sandbox.files.download("/tmp/output.png");
await writeFile("output.png", Buffer.from(imgBuf));
```

## End-to-end recipe: upload → run → download

Upload a script, run it, pull back the output file it wrote.

```ts
import { CreateosSandboxClient } from "createos-sandbox-sdk";
import { readFile, writeFile } from "node:fs/promises";

const client = new CreateosSandboxClient();
const sandbox = await client.sandboxes.create({ shape: "s-4vcpu-4gb", rootfs: "devbox:1" });

try {
  // 1. Upload the processing script.
  const script = await readFile("./process.py");
  await sandbox.files.upload("/tmp/process.py", script);

  // 2. Upload the input data.
  const input = await readFile("./data.csv");
  await sandbox.files.upload("/tmp/data.csv", input);

  // 3. Run the script; it writes its output to /tmp/report.json.
  const { result } = await sandbox.runCommand("python3", ["/tmp/process.py"]);
  if (result.exit_code !== 0) {
    throw new Error(`script failed (exit ${result.exit_code}):\n${result.stderr}`);
  }

  // 4. Download the artifact.
  const report = await sandbox.files.download("/tmp/report.json");
  await writeFile("report.json", Buffer.from(report));
  console.log("report.json written locally");
} finally {
  await sandbox.destroy();
}
```

See the [streaming how-to](./streaming.md) if you want to watch stdout /
stderr while the script runs instead of waiting for it to exit.

## Bulk transfers: tar inside, unpack with runCommand

The SDK does one-shot transfers — `upload` and `download` move one file
per call. There is no directory mirror or watch mode. For bulk input,
pack a directory into an archive on the host, upload the archive, and
unpack it inside the guest:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";

const run = promisify(execFile);

// Pack on the host.
await run("tar", ["-czf", "/tmp/bundle.tar.gz", "-C", "./src", "."]);
const archive = await readFile("/tmp/bundle.tar.gz");

// Upload and unpack inside the sandbox.
await sandbox.files.upload("/tmp/bundle.tar.gz", archive);
await sandbox.runCommand("mkdir", ["-p", "/opt/app"]);
await sandbox.runCommand("tar", ["-xzf", "/tmp/bundle.tar.gz", "-C", "/opt/app"]);
```

The same pattern works in reverse: tar an output directory inside the
guest, download the archive, and unpack locally.

## Relative vs absolute guest paths

The API requires **absolute** guest paths (starting with `/`). Relative
paths like `script.py` are rejected with a validation error. Use `/tmp`
for ephemeral files; for anything you need to persist across a resize or
across the sandbox lifetime, mount a disk and target its mount point
instead.

---

Reference: [`SandboxFiles`](../reference/sandbox.md#sandboxfiles) —
full method signatures and error types.
