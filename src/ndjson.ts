// Lines beginning with these SSE control prefixes are silently skipped, so the
// same parser tolerates a server that ever wraps NDJSON in SSE framing.
const SSE_CONTROL_PREFIXES = ["event:", "id:", "retry:"];

function parseLine<T>(line: string): T | undefined {
  if (line.length === 0) return undefined;
  if (line.startsWith(":")) return undefined;
  for (const prefix of SSE_CONTROL_PREFIXES) {
    if (line.startsWith(prefix)) return undefined;
  }
  const payload = line.startsWith("data:") ? line.slice(5).trimStart() : line;
  if (payload.length === 0) return undefined;
  return JSON.parse(payload) as T;
}

export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let drained = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        const event = parseLine<T>(line);
        if (event !== undefined) {
          yield event;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    const finalLine = buffer.trim();
    const finalEvent = parseLine<T>(finalLine);
    if (finalEvent !== undefined) {
      yield finalEvent;
    }
    drained = true;
  } finally {
    // If the consumer stopped early (a `break` from the for-await, or a
    // throw), the HTTP body is still open — cancel it so the server-side
    // command or log stream is torn down instead of running on. cancel()
    // also releases the lock; only release explicitly on a clean drain.
    if (drained) {
      reader.releaseLock();
    } else {
      await reader.cancel().catch(() => undefined);
    }
  }
}
