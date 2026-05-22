import assert from "node:assert/strict";
import { test } from "node:test";
import { FcApiError, FcClient } from "../dist/index.js";

test("sends bearer auth and unwraps success envelopes", async () => {
  const calls = [];
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: "https://example.test",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ status: "success", data: { user_id: "user_1", stats: { running: 1, paused: 0, other: 0, total: 1 } } });
    }
  });

  const result = await client.whoami();

  assert.equal(result.user_id, "user_1");
  assert.equal(calls[0].url, "https://example.test/v1/whoami");
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer sk_test");
});

test("throws FcApiError for fail envelopes", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: "https://example.test",
    fetch: async () => jsonResponse({ status: "fail", data: { id: "sandbox not found" } }, { status: 404 })
  });

  await assert.rejects(() => client.getSandbox("sb_missing"), (error) => {
    assert.ok(error instanceof FcApiError);
    assert.equal(error.statusCode, 404);
    assert.deepEqual(error.envelope?.data, { id: "sandbox not found" });
    return true;
  });
});

test("throws FcApiError for error envelopes", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: "https://example.test",
    fetch: async () => jsonResponse({ status: "error", message: "scheduler unavailable", code: 503 }, { status: 503 })
  });

  await assert.rejects(() => client.createSandbox({ shape: "s-1vcpu-256mb" }), (error) => {
    assert.ok(error instanceof FcApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, "scheduler unavailable");
    assert.equal(error.envelope?.code, 503);
    return true;
  });
});

test("throws FcApiError for non-json errors", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: "https://example.test",
    fetch: async () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
  });

  await assert.rejects(() => client.getSandbox("sb_missing"), (error) => {
    assert.ok(error instanceof FcApiError);
    assert.equal(error.statusCode, 404);
    assert.equal(error.envelope, undefined);
    return true;
  });
});

test("requires apiKey for authenticated requests", async () => {
  const client = new FcClient({
    baseUrl: "https://example.test",
    fetch: async () => {
      throw new Error("fetch should not be called");
    }
  });

  await assert.rejects(() => client.whoami(), /apiKey is required/);
});

test("does not send auth for health checks", async () => {
  const client = new FcClient({
    baseUrl: "https://example.test",
    fetch: async (_url, init) => {
      assert.equal(init.headers.has("authorization"), false);
      return jsonResponse({ status: "success", data: { up: true } });
    }
  });

  await assert.deepEqual(await client.healthz(), { up: true });
});

test("returns idempotent pause fallback for empty 200 responses", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: "https://example.test",
    fetch: async () => new Response(null, { status: 200 })
  });

  await assert.deepEqual(await client.pauseSandbox("sb_1"), { id: "sb_1", status: "paused" });
});

test("normalizes baseUrl and preserves path prefixes", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: "https://example.test/control///",
    fetch: async (url) => {
      assert.equal(url, "https://example.test/control/v1/sandboxes?limit=10&status=running");
      return jsonResponse({ status: "success", data: [] });
    }
  });

  await client.listSandboxes({ limit: 10, status: "running" });
  assert.equal(client.baseUrl, "https://example.test/control");
});

test("encodes path and query parameters", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: "https://example.test",
    fetch: async (url) => {
      assert.equal(url, "https://example.test/v1/sandboxes/sb%2F1/files?path=%2Ftmp%2Fhello+world.txt");
      return new Response(new TextEncoder().encode("hello"), { status: 200 });
    }
  });

  const bytes = await client.downloadFile("sb/1", "/tmp/hello world.txt");
  assert.equal(new TextDecoder().decode(bytes), "hello");
});

test("parses exec NDJSON streams", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"stdout":"hi\\n"}\n{"exit_code":0}\n'));
      controller.close();
    }
  });
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: "https://example.test",
    fetch: async (url, init) => {
      assert.equal(url, "https://example.test/v1/sandboxes/sb_1/exec?stream=true");
      assert.equal(JSON.parse(init.body).stream, true);
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" }
      });
    }
  });

  const events = [];
  for await (const event of client.execSandboxStream("sb_1", { cmd: "echo", args: ["hi"] })) {
    events.push(event);
  }

  assert.deepEqual(events, [{ stdout: "hi\n" }, { exit_code: 0 }]);
});

test("requires baseUrl", () => {
  assert.throws(() => new FcClient({ apiKey: "sk_test" }), /baseUrl is required/);
  assert.throws(() => new FcClient({ apiKey: "sk_test", baseUrl: "   " }), /baseUrl is required/);
  assert.throws(() => new FcClient({ apiKey: "sk_test", baseUrl: "not a url" }), /Invalid URL/);
});

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
}
