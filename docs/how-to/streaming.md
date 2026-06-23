# How-to: stream command output

Stream live stdout/stderr from a long-running command instead of waiting
for it to finish.

## Problem

You want to see stdout/stderr as a command produces it — not after it
exits — so you can pipe logs into a UI, kill the command on a pattern
match, or keep the user informed during long builds.

## Availability caveat

On some control-plane versions the streaming exec endpoint returns 404.
`runCommand` (buffered) is the reliable default. Use `streamCommand` only
when the control plane is known to support it; if you receive a
`CreateosSandboxNotFoundError` on the first iteration, fall back to
`runCommand`.

## Solution

`sandbox.streamCommand` is an async generator — no buffering, no waiting.
It yields a discriminated `ExecStreamEvent` union; switch on `event.type`
to handle each variant:

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ template: "base-debian-12" });

try {
  for await (const event of sandbox.streamCommand("npm", ["install"])) {
    switch (event.type) {
      case "stdout":
        process.stdout.write(event.data);
        break;
      case "stderr":
        process.stderr.write(event.data);
        break;
      case "exit":
        console.log(`exited ${event.exitCode}`);
        break;
      case "error":
        // Control-plane reported an agent-level error.
        console.error("agent error:", event.message);
        break;
      case "heartbeat":
        // Emitted every ~5 s to keep the connection alive. No payload.
        break;
    }
  }
} finally {
  await sandbox.destroy();
}
```

TypeScript narrows the union inside each `case`: `event.data` is only
accessible under `"stdout"` / `"stderr"`, `event.exitCode` only under
`"exit"`, `event.message` only under `"error"`.

### Event types

| `event.type` | Extra fields | Notes |
|---|---|---|
| `"stdout"` | `data: string` | A chunk of stdout text. |
| `"stderr"` | `data: string` | A chunk of stderr text. |
| `"exit"` | `exitCode: number` | Command finished; last event before the generator returns. |
| `"error"` | `message: string` | Agent-level error from the control plane. |
| `"heartbeat"` | — | Keepalive emitted every ~5 s. Safe to ignore. |

## Bail out early

Throw inside the loop to cancel the stream at any point. The generator
unwinds and the HTTP connection closes:

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ template: "base-debian-12" });

try {
  const lines: string[] = [];
  for await (const event of sandbox.streamCommand("bash", ["-lc", "while true; do date; sleep 1; done"])) {
    if (event.type === "stdout") {
      lines.push(event.data.trimEnd());
      if (lines.length >= 5) throw new Error("done");
    }
    if (event.type === "error") throw new Error(event.message);
  }
} catch (err) {
  if ((err as Error).message !== "done") throw err;
} finally {
  await sandbox.destroy();
}
```

You can also pass an `AbortSignal` via `options.signal` to cancel from
outside the loop — for example, on a wall-clock deadline:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000);

for await (const event of sandbox.streamCommand("make", ["build"], { signal: ac.signal })) {
  if (event.type === "stdout") process.stdout.write(event.data);
}
```

## Raw frames (escape hatch)

For pipelines that need the server's native snake_case shape — log
forwarders, raw proxies — bypass the `ExecStreamEvent` projection and
drive the low-level transport directly:

```ts
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type { ExecStreamFrame } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ template: "base-debian-12" });
const id = sandbox.id;

try {
  const frames = client.http.stream<ExecStreamFrame>(
    "POST",
    `/v1/sandboxes/${id}/exec`,
    {
      query: { stream: true },
      body: { cmd: "sh", args: ["-c", "echo hello"], stream: true },
    },
  );
  for await (const frame of frames) {
    if (frame.stdout) process.stdout.write(frame.stdout);
    if (frame.stderr) process.stderr.write(frame.stderr);
  }
} finally {
  await sandbox.destroy();
}
```

`ExecStreamFrame` wire fields (snake_case, server-native):

| Field | Type | Notes |
|---|---|---|
| `stdout` | `string?` | Stdout chunk. |
| `stderr` | `string?` | Stderr chunk. |
| `exit_code` | `number?` | Process exit code. |
| `error` | `string?` | Agent-level error message. |
| `hb` | `boolean?` | Heartbeat marker (emitted every ~5 s). |

`streamCommand` is the right choice for most callers — it projects these
fields into the typed `ExecStreamEvent` union so TypeScript's narrowing
works without manual null-checks.

## Not retried

Streaming requests are never retried by the SDK. A half-consumed NDJSON
stream cannot be replayed — the server has already flushed frames that are
gone. When the connection breaks the iterator throws a
`CreateosSandboxError` and your loop unwinds. Reconnect and restart from
scratch if you need retry semantics.

By contrast, `runCommand` (buffered, idempotent) is retried automatically
on network errors and transient server failures (`500`/`502`/`503`/`504`).
Prefer it when the command is safe to re-run and live output is not
required.

## See also

- [`Sandbox.streamCommand` reference](../reference/sandbox.md#streamcommand)
- [`Sandbox.runCommand` reference](../reference/sandbox.md#runcommand)
- [`CreateosSandboxHttp.stream` escape hatch](../reference/helpers.md)
- [Error handling](./error-handling.md)
