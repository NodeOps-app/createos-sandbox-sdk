# Tutorial: build an AI app generator

In this tutorial you will build a small script that takes a plain-English
prompt, asks Claude to write a web app, uploads that app into a live VM
sandbox, starts it, and hands you a public URL you can open in a browser.
That is the SDK's flagship loop: **LLM generates → VM runs → ingress
serves**.

**What you'll learn**

- Spawning a sandbox with public ingress enabled
- Calling the Anthropic Messages API to generate code
- Uploading a file into the sandbox with `sandbox.files.upload`
- Backgrounding a server and waiting for it with `waitForPortReady`
- Resolving a live preview URL with `sandbox.previewUrl`
- Tearing down cleanly with `sandbox.destroy` in a `finally` block

**Prerequisites**

- Node 20+ or Bun (this tutorial uses `bun`)
- A createos-sandbox API key and the URL of your control plane
- An Anthropic API key

**Estimated time**: 20 minutes

---

## Step 1 — Set up

Install the two packages you need:

```sh
bun add @nodeops-createos/sandbox @anthropic-ai/sdk
```

Export your credentials as environment variables. The SDK reads both
automatically — you never need to pass them explicitly:

```sh
export CREATEOS_SANDBOX_BASE_URL="https://your-control-plane"
export CREATEOS_SANDBOX_API_KEY="sk_…"
export ANTHROPIC_API_KEY="sk-ant-…"
```

Create a file called `ai-app-gen.ts` and paste in this three-liner to verify
connectivity before writing the real code:

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient();
console.log(await client.whoami());
```

Run it:

```sh
bun ai-app-gen.ts
```

**Expected output**: a JSON object with your user identity — something like
`{ id: "usr_…", email: "you@example.com" }`. If you see a
`CreateosSandboxAuthError`, double-check your env vars.

---

## Step 2 — Spawn a sandbox with ingress on

Delete the three-liner and start the real script. The key option here is
`ingress_enabled: true` — without it the control plane does not provision a
public hostname, and `previewUrl` has nothing to route to.

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import Anthropic from "@anthropic-ai/sdk";

const client = new CreateosSandboxClient();

const sandbox = await client.createSandbox({
  shape: "s-4vcpu-4gb", // comfortable headroom for a Node process
  rootfs: "devbox:1",
  ingress_enabled: true,
});

// Resolve the preview URL now — the hostname is already provisioned.
// Use scheme: "http" until your ingress domain has a TLS certificate.
const previewUrl = sandbox.previewUrl(3000, { scheme: "http" });

console.log("sandbox id  :", sandbox.id);
console.log("status      :", sandbox.status);
console.log("preview URL :", previewUrl);
```

**Expected output**:

```
sandbox id  : sb_01…
status      : running
preview URL : http://sb_01….your-ingress-domain/
```

`createSandbox` blocks until the sandbox reaches `running` by default, so
`sandbox.status` will already be `"running"` here.

---

## Step 3 — Ask Claude to generate the app

Now bring in the Anthropic client. The call below asks Claude for a
self-contained Node HTTP server — no external dependencies — that binds to
`0.0.0.0:3000` so the ingress proxy can reach it.

```ts
// Reads ANTHROPIC_API_KEY from the environment automatically.
const anthropic = new Anthropic();

const PROMPT =
  "Write a single-file Node.js HTTP server with zero npm dependencies. " +
  "It must bind to 0.0.0.0:3000 and serve an HTML page that shows a " +
  "live clock updating every second. Output only the JavaScript source " +
  "code, no explanation, no markdown fences.";

const response = await anthropic.messages.create({
  // ANTHROPIC_MODEL env var lets you swap models without touching code.
  model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
  max_tokens: 2048,
  messages: [{ role: "user", content: PROMPT }],
});

// The response may contain multiple content blocks; the code is in the
// first text block.
const textBlock = response.content.find((b) => b.type === "text");
if (!textBlock || textBlock.type !== "text") {
  throw new Error("Claude returned no text block");
}
const code = textBlock.text;

console.log(`generated code: ${code.length} characters`);
```

**Expected output**: `generated code: 512 characters` (length varies).

The model is swappable — any model that follows the Anthropic Messages API
works here. Set `ANTHROPIC_MODEL` to `claude-opus-4-8` or any other id to
compare results without touching the script.

---

## Step 4 — Upload the generated code into the sandbox

`sandbox.files.upload` takes an absolute guest path and any `BodyInit` value —
a plain `string` is fine.

```ts
await sandbox.files.upload("/root/app.js", code);

// Confirm the file landed.
const { result } = await sandbox.runCommand("ls", ["-lh", "/root"]);
console.log(result.stdout);
```

**Expected output**: a directory listing that includes `app.js`.

If `exit_code` is non-zero, something went wrong with the upload or the path;
`result.stderr` will say what.

> Guest paths must be absolute. Parent directories must already exist — use
> `sandbox.runCommand("mkdir", ["-p", "/some/path"])` if you need to create
> them first. See [how-to: files](./how-to/files.md) for more.

---

## Step 5 — Run the app

`runCommand` waits for the process to exit. To keep a server alive you must
background it and redirect its stdio, otherwise the call blocks forever:

```ts
await sandbox.runCommand("sh", [
  "-c",
  "nohup setsid node /root/app.js >/tmp/app.log 2>&1 &",
]);

// Block until port 3000 accepts TCP connections inside the VM.
// This fires before the ingress route matters, so it's a reliable gate.
await sandbox.waitForPortReady(3000, { timeoutMs: 15_000 });

console.log("server is listening on :3000");
```

**Expected output**: `server is listening on :3000` — printed once the port
is bound.

The daemonise pattern is: `nohup` (ignore SIGHUP) + `setsid` (new session, no
controlling terminal) + `>/tmp/app.log 2>&1` (detach stdio) + `&` (background
the shell). All four pieces matter. See
[how-to: expose a service](./how-to/expose-a-service.md) for a deeper
explanation.

---

## Step 6 — Open the live preview URL

You already have `previewUrl` from Step 2. Fetch it to confirm the app
responds, then open the URL in a browser:

```ts
const res = await fetch(previewUrl);

console.log("preview URL :", previewUrl);
console.log("HTTP status :", res.status);

if (!res.ok) {
  const body = await res.text();
  throw new Error(`app returned HTTP ${res.status}:\n${body}`);
}

console.log("\nOpen this URL in your browser:");
console.log(previewUrl);
```

**Expected output**:

```
preview URL : http://sb_01….your-ingress-domain/
HTTP status : 200

Open this URL in your browser:
http://sb_01….your-ingress-domain/
```

Paste the URL into your browser. You should see the live-clock page Claude
generated.

---

## Step 7 — Iterate (optional)

The real power of this pattern is that the generate → upload → run → preview
loop is repeatable. Ask Claude to add a feature, re-upload the updated file,
restart the server, and re-fetch:

```ts
const iterateResponse = await anthropic.messages.create({
  model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
  max_tokens: 2048,
  messages: [
    { role: "user", content: PROMPT },
    { role: "assistant", content: response.content },
    {
      role: "user",
      content:
        "Good. Now add a visitor counter below the clock. " +
        "It should count how many times the page has been loaded since " +
        "the server started. Keep everything in one file, no deps. " +
        "Output only the updated JavaScript, no markdown fences.",
    },
  ],
});

const updatedBlock = iterateResponse.content.find((b) => b.type === "text");
if (!updatedBlock || updatedBlock.type !== "text") {
  throw new Error("Claude returned no text block on iteration");
}
const updatedCode = updatedBlock.text;

// Re-upload and restart.
await sandbox.files.upload("/root/app.js", updatedCode);

// Kill the old server process, then start the new one.
await sandbox.runCommand("sh", ["-c", "pkill -f 'node /root/app.js' || true"]);
await sandbox.runCommand("sh", [
  "-c",
  "nohup setsid node /root/app.js >/tmp/app.log 2>&1 &",
]);
await sandbox.waitForPortReady(3000, { timeoutMs: 15_000 });

const res2 = await fetch(previewUrl);
console.log("iteration HTTP status:", res2.status);
console.log("Reload the preview URL to see the visitor counter.");
```

Each iteration is just another pass through the same loop. You can keep
refining until you're satisfied, then tear down.

---

## Step 8 — Tear down

Always destroy the sandbox in a `finally` block so it is reclaimed even when
earlier steps throw:

```ts
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(
      "cleanup: destroy failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
  console.log("sandbox destroyed");
}
```

The `.catch` inside `finally` prevents a destroy failure from masking the
original error.

---

## Complete script

Here is the full script, steps 1–8 assembled into a single runnable file.
Copy it into `ai-app-gen.ts` and run with `bun ai-app-gen.ts`.

```ts
/**
 * AI app generator — Claude writes a web app, the sandbox runs it, ingress
 * serves it at a live preview URL.
 *
 * Run:   bun ai-app-gen.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY
 *        ANTHROPIC_API_KEY
 *        ANTHROPIC_MODEL (optional — defaults to claude-sonnet-4-6)
 */
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import Anthropic from "@anthropic-ai/sdk";

// Both clients read credentials from env automatically.
const client = new CreateosSandboxClient();
const anthropic = new Anthropic();

// ── Step 2: spawn a sandbox with public ingress ───────────────────────────
const sandbox = await client.createSandbox({
  shape: "s-4vcpu-4gb",
  rootfs: "devbox:1",
  ingress_enabled: true,
});

// Resolve the preview URL now; the hostname is already provisioned.
const previewUrl = sandbox.previewUrl(3000, { scheme: "http" });

console.log("sandbox id  :", sandbox.id);
console.log("status      :", sandbox.status);
console.log("preview URL :", previewUrl);

try {
  // ── Step 3: ask Claude to generate the app ─────────────────────────────
  const PROMPT =
    "Write a single-file Node.js HTTP server with zero npm dependencies. " +
    "It must bind to 0.0.0.0:3000 and serve an HTML page that shows a " +
    "live clock updating every second. Output only the JavaScript source " +
    "code, no explanation, no markdown fences.";

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: PROMPT }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text block");
  }
  const code = textBlock.text;
  console.log(`generated code: ${code.length} characters`);

  // ── Step 4: upload the generated code ─────────────────────────────────
  await sandbox.files.upload("/root/app.js", code);

  const { result: lsResult } = await sandbox.runCommand("ls", ["-lh", "/root"]);
  console.log(lsResult.stdout);

  // ── Step 5: start the server and wait for it ───────────────────────────
  await sandbox.runCommand("sh", [
    "-c",
    "nohup setsid node /root/app.js >/tmp/app.log 2>&1 &",
  ]);

  await sandbox.waitForPortReady(3000, { timeoutMs: 15_000 });
  console.log("server is listening on :3000");

  // ── Step 6: verify via the public preview URL ──────────────────────────
  const res = await fetch(previewUrl);
  console.log("preview URL :", previewUrl);
  console.log("HTTP status :", res.status);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`app returned HTTP ${res.status}:\n${body}`);
  }

  console.log("\nOpen this URL in your browser:");
  console.log(previewUrl);

  // ── Step 7 (optional): iterate — add a visitor counter ─────────────────
  const iterateResponse = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [
      { role: "user", content: PROMPT },
      { role: "assistant", content: response.content },
      {
        role: "user",
        content:
          "Good. Now add a visitor counter below the clock. " +
          "It should count how many times the page has been loaded since " +
          "the server started. Keep everything in one file, no deps. " +
          "Output only the updated JavaScript, no markdown fences.",
      },
    ],
  });

  const updatedBlock = iterateResponse.content.find((b) => b.type === "text");
  if (!updatedBlock || updatedBlock.type !== "text") {
    throw new Error("Claude returned no text block on iteration");
  }
  const updatedCode = updatedBlock.text;

  await sandbox.files.upload("/root/app.js", updatedCode);
  await sandbox.runCommand("sh", ["-c", "pkill -f 'node /root/app.js' || true"]);
  await sandbox.runCommand("sh", [
    "-c",
    "nohup setsid node /root/app.js >/tmp/app.log 2>&1 &",
  ]);
  await sandbox.waitForPortReady(3000, { timeoutMs: 15_000 });

  const res2 = await fetch(previewUrl);
  console.log("iteration HTTP status:", res2.status);
  console.log("Reload the preview URL to see the visitor counter.");
} finally {
  // ── Step 8: always destroy ─────────────────────────────────────────────
  await sandbox.destroy().catch((err) => {
    console.error(
      "cleanup: destroy failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
  console.log("sandbox destroyed");
}
```

---

## What you learned

You built the canonical **create → AI-generate → upload → run → preview →
destroy** loop:

1. A sandbox with `ingress_enabled: true` gets a public hostname at create
   time; `previewUrl(port)` turns that hostname into a clickable URL.
2. The Anthropic Messages API is just a `fetch` — you call it from the same
   script, extract the text block, and pass the string straight to
   `sandbox.files.upload`.
3. `runCommand("sh", ["-c", "nohup setsid … &"])` is the standard way to
   background a long-running server inside the VM. `waitForPortReady` gates
   your next step on the port actually being bound.
4. The loop is repeatable — re-upload, restart, re-fetch — so iterative
   generation works without touching the sandbox plumbing again.
5. `try { … } finally { sandbox.destroy() }` ensures the VM is always
   reclaimed, even when earlier steps throw.

This pattern generalises: swap Claude for any model or codegen pipeline, swap
Node for Python or Deno, swap the preview fetch for a Playwright screenshot —
the sandbox wiring stays the same.

## Next steps

- [Quickstart](./quickstart.md) — the 30-second tour if you want a simpler
  starting point
- [How-to: expose a service](./how-to/expose-a-service.md) — deep dive into
  `ingress_enabled`, `waitForPortReady`, and `previewUrl`
- [How-to: files](./how-to/files.md) — bulk transfers, binary uploads,
  download artifacts
- [Reference: Sandbox](./reference/sandbox.md) — full method signatures for
  `runCommand`, `files`, `previewUrl`, `waitForPortReady`, `destroy`
- [Explanation: VM sandboxes](./explanation/vm-sandboxes.md) — why
  VMs, isolation model, cold-start latency
- [examples/04-ai-code-agent](../examples/04-ai-code-agent/index.ts) — a
  richer tool-use loop where Claude runs code iteratively and reacts to output
