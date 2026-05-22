import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FcApiError,
  FcAuthError,
  FcClient,
  FcNotFoundError,
  FcRateLimitError,
  FcServerError,
  FcTimeoutError,
  FcValidationError,
} from "../dist/index.js";

const BASE = "https://example.test";

const RUNNING_VIEW = {
  id: "sb_1",
  status: "running",
  ip: "10.0.0.2",
  vcpu: 1,
  mem_mib: 256,
  disk_mib: 10240,
  created_at: "2024-01-01T00:00:00Z",
  ingress_enabled: false,
};

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function success(data, init) {
  return jsonResponse({ status: "success", data }, init);
}

function fail(data, status) {
  return jsonResponse({ status: "fail", data }, { status });
}

function errorEnvelope(message, code, status) {
  return jsonResponse({ status: "error", message, code }, { status });
}

const FAST_RETRY = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };

test("createSandbox returns a Sandbox handle and waits until running", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: BASE,
    fetch: async (_url, init) => {
      if (init.method === "POST") {
        return success({
          id: "sb_1",
          name: "brave-otter",
          ip: "10.0.0.2",
          mode: "snapshot",
          shape: "s-1vcpu-256mb",
          rootfs: "devbox:1",
          vcpu: 1,
          mem_mib: 256,
          disk_mib: 10240,
          spawn_ms: 42,
          egress: [],
          bandwidth_quota_bytes: 0,
        });
      }
      return success(RUNNING_VIEW);
    },
  });

  const sandbox = await client.createSandbox({ shape: "s-1vcpu-256mb" });
  assert.equal(sandbox.id, "sb_1");
  assert.equal(sandbox.status, "running");
  assert.equal(sandbox.ip, "10.0.0.2");
});

test("createSandbox with wait:false skips the poll loop", async () => {
  const calls = [];
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      calls.push(init.method);
      if (init.method === "POST") {
        return success({
          id: "sb_1",
          name: "x",
          ip: "10.0.0.2",
          mode: "cold",
          shape: "s",
          rootfs: "r",
          vcpu: 1,
          mem_mib: 256,
          disk_mib: 10240,
          spawn_ms: 1,
          egress: [],
          bandwidth_quota_bytes: 0,
        });
      }
      return success({ ...RUNNING_VIEW, status: "creating" });
    },
  });

  const sandbox = await client.createSandbox({ shape: "s" }, { wait: false });
  assert.equal(sandbox.status, "creating");
  assert.deepEqual(calls, ["POST", "GET"]);
});

test("runCommand posts to the exec endpoint and returns buffered output", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      if (init.method === "GET") {
        return success(RUNNING_VIEW);
      }
      assert.match(String(url), /\/v1\/sandboxes\/sb_1\/exec$/);
      const body = JSON.parse(init.body);
      assert.equal(body.cmd, "node");
      assert.deepEqual(body.args, ["--version"]);
      return success({ result: { stdout: "v20\n", stderr: "", exit_code: 0 }, exec_ms: 5 });
    },
  });

  const sandbox = await client.getSandbox("sb_1");
  const result = await sandbox.runCommand("node", ["--version"]);
  assert.equal(result.result.stdout, "v20\n");
  assert.equal(result.result.exit_code, 0);
});

test("runCommand does not throw on a non-zero exit code", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (_url, init) =>
      init.method === "GET"
        ? success(RUNNING_VIEW)
        : success({ result: { stdout: "", stderr: "boom", exit_code: 1 }, exec_ms: 3 }),
  });

  const sandbox = await client.getSandbox("sb_1");
  const result = await sandbox.runCommand("false");
  assert.equal(result.result.exit_code, 1);
});

test("streamCommand yields parsed NDJSON events", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      if (init.method === "GET") {
        return success(RUNNING_VIEW);
      }
      assert.match(String(url), /stream=true/);
      assert.equal(JSON.parse(init.body).stream, true);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"stdout":"hi\\n"}\n{"exit_code":0}\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    },
  });

  const sandbox = await client.getSandbox("sb_1");
  const events = [];
  for await (const event of sandbox.streamCommand("bash", ["-lc", "echo hi"])) {
    events.push(event);
  }
  assert.deepEqual(events, [{ stdout: "hi\n" }, { exit_code: 0 }]);
});

test("maps HTTP status codes to typed errors", async () => {
  const cases = [
    [401, FcAuthError],
    [404, FcNotFoundError],
    [400, FcValidationError],
    [429, FcRateLimitError],
    [503, FcServerError],
  ];

  for (const [status, ErrorClass] of cases) {
    const client = new FcClient({
      apiKey: "sk",
      baseUrl: BASE,
      retry: false,
      fetch: async () => fail({ id: "boom" }, status),
    });
    await assert.rejects(
      () => client.getSandbox("sb_x"),
      (err) => {
        assert.ok(err instanceof ErrorClass, `${status} should map to ${ErrorClass.name}`);
        assert.ok(err instanceof FcApiError);
        assert.equal(err.statusCode, status);
        return true;
      },
    );
  }
});

test("retries an idempotent GET on 503 and then succeeds", async () => {
  let attempts = 0;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 },
    fetch: async () => {
      attempts += 1;
      return attempts < 3
        ? errorEnvelope("busy", 503, 503)
        : success({ user_id: "u", stats: { running: 0, paused: 0, other: 0, total: 0 } });
    },
  });

  const who = await client.whoami();
  assert.equal(who.user_id, "u");
  assert.equal(attempts, 3);
});

test("throws after exhausting retries", async () => {
  let attempts = 0;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: FAST_RETRY,
    fetch: async () => {
      attempts += 1;
      return errorEnvelope("down", 503, 503);
    },
  });

  await assert.rejects(() => client.whoami(), FcServerError);
  assert.equal(attempts, 3);
});

test("does not retry a POST on an ambiguous 500", async () => {
  let attempts = 0;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 },
    fetch: async () => {
      attempts += 1;
      return errorEnvelope("boom", 500, 500);
    },
  });

  await assert.rejects(() => client.createSandbox({ shape: "s" }), FcServerError);
  assert.equal(attempts, 1);
});

test("retries a POST on 503 since the request was not processed", async () => {
  let attempts = 0;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: FAST_RETRY,
    fetch: async () => {
      attempts += 1;
      return errorEnvelope("no capacity", 503, 503);
    },
  });

  await assert.rejects(() => client.createSandbox({ shape: "s" }), FcServerError);
  assert.equal(attempts, 3);
});

test("FcRateLimitError exposes the Retry-After header", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: false,
    fetch: async () =>
      jsonResponse({ status: "fail", data: {} }, { status: 429, headers: { "retry-after": "7" } }),
  });

  await assert.rejects(
    () => client.getSandbox("sb_x"),
    (err) => {
      assert.ok(err instanceof FcRateLimitError);
      assert.equal(err.retryAfterSeconds, 7);
      return true;
    },
  );
});

test("sends bearer auth and omits it for health checks", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: BASE,
    fetch: async (url, init) => {
      if (String(url).endsWith("/healthz")) {
        assert.equal(init.headers.has("authorization"), false);
        return success({ up: true });
      }
      assert.equal(init.headers.get("authorization"), "Bearer sk_test");
      return success({ user_id: "u", stats: { running: 0, paused: 0, other: 0, total: 0 } });
    },
  });

  assert.deepEqual(await client.healthz(), { up: true });
  await client.whoami();
});

test("sends a versioned User-Agent header", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (_url, init) => {
      assert.match(init.headers.get("user-agent") ?? "", /^fc-sandbox-sdk\/\d/);
      return success({ up: true });
    },
  });
  await client.healthz();
});

test("reads apiKey and baseUrl from environment variables", async () => {
  process.env.FC_API_KEY = "sk_env";
  process.env.FC_BASE_URL = "https://env.test";
  try {
    const client = new FcClient({
      fetch: async (url, init) => {
        assert.equal(String(url), "https://env.test/v1/whoami");
        assert.equal(init.headers.get("authorization"), "Bearer sk_env");
        return success({ user_id: "u", stats: { running: 0, paused: 0, other: 0, total: 0 } });
      },
    });
    await client.whoami();
  } finally {
    delete process.env.FC_API_KEY;
    delete process.env.FC_BASE_URL;
  }
});

test("requires an apiKey for authenticated requests", async () => {
  const client = new FcClient({
    baseUrl: BASE,
    fetch: async () => {
      throw new Error("fetch should not be reached");
    },
  });
  await assert.rejects(() => client.whoami(), /API key is required/);
});

test("destroy returns the destroy result", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (_url, init) =>
      init.method === "GET" ? success(RUNNING_VIEW) : success({ destroyed: "sb_1" }),
  });

  const sandbox = await client.getSandbox("sb_1");
  assert.deepEqual(await sandbox.destroy(), { destroyed: "sb_1" });
});

test("pause updates the handle with the returned view", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url) =>
      String(url).endsWith("/pause")
        ? success({ ...RUNNING_VIEW, status: "pausing" }, { status: 202 })
        : success(RUNNING_VIEW),
  });

  const sandbox = await client.getSandbox("sb_1");
  await sandbox.pause();
  assert.equal(sandbox.status, "pausing");
});

test("waitUntilRunning polls until the sandbox is running", async () => {
  const statuses = ["creating", "creating", "running"];
  let index = 0;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async () =>
      success({ ...RUNNING_VIEW, status: statuses[Math.min(index++, statuses.length - 1)] }),
  });

  const sandbox = await client.getSandbox("sb_1");
  await sandbox.waitUntilRunning({ timeoutMs: 5000 });
  assert.equal(sandbox.status, "running");
});

test("downloads a file with an encoded path query", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      if (init.method === "GET" && String(url).includes("/files")) {
        assert.match(String(url), /path=%2Ftmp%2Fhello\+world\.txt/);
        return new Response(new TextEncoder().encode("hello"), { status: 200 });
      }
      return success(RUNNING_VIEW);
    },
  });

  const sandbox = await client.getSandbox("sb_1");
  const bytes = await sandbox.files.download("/tmp/hello world.txt");
  assert.equal(new TextDecoder().decode(bytes), "hello");
});

test("normalizes baseUrl and preserves a path prefix", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: "https://example.test/control///",
    fetch: async (url) => {
      assert.equal(String(url), "https://example.test/control/v1/shapes");
      return success({ shapes: [] });
    },
  });
  assert.equal(client.baseUrl, "https://example.test/control");
  await client.listShapes();
});

test("listShapes unwraps to a Shape array", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async () =>
      success({
        shapes: [{ id: "s-1vcpu-256mb", vcpu: 1, mem_mib: 256, default_disk_mib: 10240 }],
      }),
  });
  const shapes = await client.listShapes();
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].id, "s-1vcpu-256mb");
});

test("templates.logs returns plain text without NDJSON parsing", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url) => {
      assert.match(String(url), /\/v1\/templates\/tpl_1\/logs/);
      assert.doesNotMatch(String(url), /follow/);
      return new Response("step 1\nstep 2\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
  });
  assert.equal(await client.templates.logs("tpl_1"), "step 1\nstep 2\n");
});

test("templates.followLogs streams NDJSON with follow=true", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url) => {
      assert.match(String(url), /follow=true/);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"line":"a"}\n{"final":true,"status":"ready"}\n'),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    },
  });

  const events = [];
  for await (const event of client.templates.followLogs("tpl_1")) {
    events.push(event);
  }
  assert.deepEqual(events, [{ line: "a" }, { final: true, status: "ready" }]);
});

test("surfaces a request timeout as FcTimeoutError", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    timeoutMs: 10,
    retry: false,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });
  await assert.rejects(() => client.whoami(), FcTimeoutError);
});
