import { describe, expect, test } from "bun:test";
import { readNdjson } from "../src/ndjson.ts";
import { streamOf } from "./helpers.ts";

async function drain<T>(stream: ReadableStream<Uint8Array>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of readNdjson<T>(stream)) out.push(event);
  return out;
}

describe("readNdjson", () => {
  test("parses consecutive JSON lines", async () => {
    const events = await drain(streamOf('{"a":1}\n{"b":2}\n'));
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("yields the final line even without a trailing newline", async () => {
    const events = await drain(streamOf('{"a":1}\n{"b":2}'));
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("reassembles a payload split across chunks", async () => {
    const events = await drain(streamOf('{"a":', "1}", "\n"));
    expect(events).toEqual([{ a: 1 }]);
  });

  test("skips blank lines", async () => {
    const events = await drain(streamOf('\n{"a":1}\n\n'));
    expect(events).toEqual([{ a: 1 }]);
  });

  test("strips the SSE data: prefix before parsing", async () => {
    const events = await drain(streamOf('data: {"x":1}\n'));
    expect(events).toEqual([{ x: 1 }]);
  });

  test("tolerates SSE control lines (event/id/retry/:comment)", async () => {
    const events = await drain(
      streamOf(":heartbeat\n", "event: progress\n", "id: 42\n", "retry: 1000\n", '{"done":true}\n'),
    );
    expect(events).toEqual([{ done: true }]);
  });

  test("cancels the underlying reader when the consumer stops early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n{"b":2}\n'));
        // deliberately left open — early break must tear it down
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of readNdjson<{ a?: number }>(stream)) {
      expect(event.a).toBe(1);
      break;
    }
    expect(cancelled).toBe(true);
  });

  test("swallows a rejection from the reader's cancel()", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n{"b":2}\n'));
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });
    // Must not reject despite cancel() throwing.
    for await (const event of readNdjson(stream)) {
      expect(event).toBeDefined();
      break;
    }
  });
});
