import { afterEach, describe, expect, test } from "bun:test";
import { selfDelete, selfPause } from "../src/index.ts";

// self.ts has no client, so unlike the rest of the suite there is no
// per-client `fetch` option to inject. The global `fetch` is the only seam;
// each test swaps it and afterEach restores it.

const realFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string | undefined;
}

function stubFetch(status: number): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return Promise.resolve(new Response(null, { status }));
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("selfPause", () => {
  test("POSTs to the loopback pause endpoint and resolves on 202", async () => {
    const calls = stubFetch(202);
    await selfPause();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://127.0.0.1:1029/self/pause");
  });

  test("appends reason as a query parameter", async () => {
    const calls = stubFetch(202);
    await selfPause("job complete");
    expect(calls[0]?.url).toBe("http://127.0.0.1:1029/self/pause?reason=job+complete");
  });

  test("throws on a non-202 status", async () => {
    stubFetch(502);
    await expect(selfPause()).rejects.toThrow("self-pause failed: HTTP 502");
  });
});

describe("selfDelete", () => {
  test("POSTs to the loopback delete endpoint and resolves on 202", async () => {
    const calls = stubFetch(202);
    await selfDelete();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://127.0.0.1:1029/self/delete");
  });

  test("appends reason as a query parameter", async () => {
    const calls = stubFetch(202);
    await selfDelete("done");
    expect(calls[0]?.url).toBe("http://127.0.0.1:1029/self/delete?reason=done");
  });

  test("throws on a non-202 status", async () => {
    stubFetch(404);
    await expect(selfDelete()).rejects.toThrow("self-delete failed: HTTP 404");
  });
});
