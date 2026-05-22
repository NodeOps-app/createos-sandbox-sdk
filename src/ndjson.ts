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

        if (line.length > 0) {
          yield JSON.parse(line) as T;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    const finalLine = buffer.trim();
    if (finalLine.length > 0) {
      yield JSON.parse(finalLine) as T;
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
