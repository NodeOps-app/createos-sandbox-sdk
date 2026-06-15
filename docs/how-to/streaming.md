# How-to: stream command output

## Problem

You want to see stdout / stderr as a command produces it — not after it
exits — so you can pipe logs into a UI, kill the command on a pattern
match, or just keep the user informed during long builds.

## Solution

`sandbox.streamCommand` is an async generator yielding a discriminated
union. Switch on `event.type`:

```ts
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
      console.error("agent error:", event.message);
      break;
    case "heartbeat":
      // No-op. Emitted every ~5s to keep the connection warm.
      break;
  }
}
```

TypeScript narrows the union inside each case, so `event.data` is only
in scope when `event.type === "stdout"` / `"stderr"` and `event.exitCode`
only in `"exit"`.

## Bail out early

Throwing inside the loop aborts the iterator and closes the underlying
stream. To bail on a pattern:

```ts
for await (const ev of sandbox.streamCommand("bash", ["-lc", longCmd])) {
  if (ev.type === "stdout" && ev.data.includes("FATAL")) {
    throw new Error("aborting on fatal");
  }
}
```

## Raw frames

For pipelines that need the snake_case wire shape (log forwarders, raw
proxies), use `http.stream<ExecStreamFrame>` directly on the low-level
transport:

```ts
import type { ExecStreamFrame } from "createos-sandbox-sdk";

for await (const frame of fc.http.stream<ExecStreamFrame>("POST", `/v1/sandboxes/${id}/exec`, {
  query: { stream: true },
  body: { cmd: "echo", args: ["hi"], stream: true },
})) {
  // frame.stdout / frame.stderr / frame.exit_code — server's native shape
}
```

## Not retried

Streaming requests are intentionally not retried by the SDK — a
half-consumed stream cannot be replayed safely. If the underlying
connection breaks, the iterator throws and your loop unwinds.
