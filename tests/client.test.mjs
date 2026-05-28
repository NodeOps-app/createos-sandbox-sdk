import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectRuntime,
  FcApiError,
  FcAuthError,
  FcClient,
  FcNotFoundError,
  FcPermissionError,
  FcRateLimitError,
  FcServerError,
  FcTimeoutError,
  FcValidationError,
  redactHeaders,
  redactQuery,
  redactUrl,
  runtimeTag,
  Sandbox,
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

test("sends X-Api-Key auth and omits it for health checks", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: BASE,
    fetch: async (url, init) => {
      if (String(url).endsWith("/healthz")) {
        assert.equal(init.headers.has("x-api-key"), false);
        return success({ up: true });
      }
      assert.equal(init.headers.get("x-api-key"), "sk_test");
      return success({ user_id: "u", stats: { running: 0, paused: 0, other: 0, total: 0 } });
    },
  });

  assert.deepEqual(await client.healthz(), { up: true });
  await client.whoami();
});

test("apiKey auth removes higher-priority generic auth headers", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: BASE,
    headers: {
      Authorization: "Bearer stale",
      "X-Access-Token": "stale",
      "X-Auth-Token": "stale",
    },
    fetch: async (_url, init) => {
      assert.equal(init.headers.get("x-api-key"), "sk_test");
      assert.equal(init.headers.has("authorization"), false);
      assert.equal(init.headers.has("x-access-token"), false);
      assert.equal(init.headers.has("x-auth-token"), false);
      return success({ user_id: "u", stats: { running: 0, paused: 0, other: 0, total: 0 } });
    },
  });

  await client.whoami();
});

test("auth false strips every credential header", async () => {
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: BASE,
    headers: {
      Authorization: "Bearer stale",
      "X-Api-Key": "stale",
      "X-Access-Token": "stale",
      "X-Auth-Token": "stale",
      Cookie: "sid=abc",
      "Proxy-Authorization": "Basic xyz",
      "X-CSRF-Token": "csrf",
    },
    fetch: async (_url, init) => {
      assert.equal(init.headers.has("authorization"), false);
      assert.equal(init.headers.has("x-api-key"), false);
      assert.equal(init.headers.has("x-access-token"), false);
      assert.equal(init.headers.has("x-auth-token"), false);
      assert.equal(init.headers.has("cookie"), false);
      assert.equal(init.headers.has("proxy-authorization"), false);
      assert.equal(init.headers.has("x-csrf-token"), false);
      return success({ up: true });
    },
  });

  await client.healthz();
});

test("uses authHeaders instead of requiring an apiKey", async () => {
  const client = new FcClient({
    authHeaders: {
      Authorization: "Bearer app-session",
      "X-App-User": "user_1",
    },
    baseUrl: BASE,
    fetch: async (_url, init) => {
      assert.equal(init.headers.get("authorization"), "Bearer app-session");
      assert.equal(init.headers.get("x-app-user"), "user_1");
      return success({ user_id: "u", stats: { running: 0, paused: 0, other: 0, total: 0 } });
    },
  });

  await client.whoami();
});

test("authHeaders remove generic credentials before applying configured auth", async () => {
  const client = new FcClient({
    authHeaders: {
      Authorization: "Bearer app-session",
      "X-App-User": "user_1",
    },
    baseUrl: BASE,
    headers: {
      "X-Api-Key": "stale",
      "X-Access-Token": "stale",
      "X-Auth-Token": "stale",
    },
    fetch: async (_url, init) => {
      assert.equal(init.headers.get("authorization"), "Bearer app-session");
      assert.equal(init.headers.get("x-app-user"), "user_1");
      assert.equal(init.headers.has("x-api-key"), false);
      assert.equal(init.headers.has("x-access-token"), false);
      assert.equal(init.headers.has("x-auth-token"), false);
      return success({ user_id: "u", stats: { running: 0, paused: 0, other: 0, total: 0 } });
    },
  });

  await client.whoami();
});

test("authHeaders are omitted for health checks", async () => {
  const client = new FcClient({
    authHeaders: { Authorization: "Bearer app-session" },
    baseUrl: BASE,
    fetch: async (_url, init) => {
      assert.equal(init.headers.has("authorization"), false);
      return success({ up: true });
    },
  });

  await client.healthz();
});

test("rejects apiKey and authHeaders together", () => {
  assert.throws(
    () =>
      new FcClient({
        apiKey: "sk",
        authHeaders: { Authorization: "Bearer app-session" },
        baseUrl: BASE,
      }),
    /either apiKey or authHeaders/,
  );
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
        assert.equal(init.headers.get("x-api-key"), "sk_env");
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
  await assert.rejects(() => client.whoami(), /Authentication is required/);
});

test("destroy returns {id, status} and updates the handle", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (_url, init) =>
      init.method === "GET" ? success(RUNNING_VIEW) : success({ id: "sb_1", status: "destroying" }),
  });

  const sandbox = await client.getSandbox("sb_1");
  assert.equal(sandbox.status, "running");
  const result = await sandbox.destroy();
  assert.deepEqual(result, { id: "sb_1", status: "destroying" });
  assert.equal(sandbox.status, "destroying");
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

test("waitUntilRunning aborts when the sandbox enters destroying", async () => {
  const statuses = ["creating", "destroying"];
  let index = 0;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async () =>
      success({ ...RUNNING_VIEW, status: statuses[Math.min(index++, statuses.length - 1)] }),
  });
  const sandbox = await client.getSandbox("sb_1");
  await assert.rejects(() => sandbox.waitUntilRunning({ timeoutMs: 5000 }), /destroying/);
});

test("waitUntilDestroyed passes through destroying as an intermediate state", async () => {
  const statuses = ["destroying", "destroying", "destroyed"];
  let index = 0;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async () =>
      success({ ...RUNNING_VIEW, status: statuses[Math.min(index++, statuses.length - 1)] }),
  });
  const sandbox = await client.getSandbox("sb_1");
  await sandbox.waitUntilDestroyed({ timeoutMs: 5000 });
  assert.equal(sandbox.status, "destroyed");
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

test("listShapes and listRootfs send no credentials (server-open paths)", async () => {
  const captured = [];
  const client = new FcClient({
    apiKey: "sk_test",
    baseUrl: BASE,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      captured.push({
        path: new URL(url).pathname,
        apiKey: headers.get("x-api-key"),
        authz: headers.get("authorization"),
      });
      if (new URL(url).pathname === "/v1/shapes") {
        return success({ shapes: [] });
      }
      return success({ rootfs: [], default: "" });
    },
  });
  await client.listShapes();
  await client.listRootfs();
  assert.equal(captured.length, 2);
  for (const entry of captured) {
    assert.equal(entry.apiKey, null, `apiKey leaked to ${entry.path}`);
    assert.equal(entry.authz, null, `authorization leaked to ${entry.path}`);
  }
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

// ── runtime detection ────────────────────────────────────────────────────

test("sends User-Agent and X-Fc-Runtime headers tagged with the detected runtime", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (_url, init) => {
      const ua = init.headers.get("user-agent") ?? "";
      const tag = init.headers.get("x-fc-runtime") ?? "";
      assert.match(ua, /^fc-sandbox-sdk\/0\.2\.1 \S+/);
      assert.equal(tag, runtimeTag());
      assert.ok(tag.startsWith("node-") || tag === "node");
      return success({ up: true });
    },
  });
  await client.healthz();
});

test("detectRuntime returns node when running tests under node", () => {
  assert.equal(detectRuntime(), "node");
  assert.match(runtimeTag(), /^node-/);
});

// ── resourceId + body code on errors ─────────────────────────────────────

test("FcNotFoundError carries the sandbox id parsed from the path", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: false,
    fetch: async () => fail({ id: "missing" }, 404),
  });
  await assert.rejects(
    () => client.getSandbox("sb_abc123"),
    (err) => {
      assert.ok(err instanceof FcNotFoundError);
      assert.equal(err.resourceId, "sb_abc123");
      return true;
    },
  );
});

test("FcApiError preserves URL-encoded segments in resourceId", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: false,
    fetch: async () => fail({}, 404),
  });
  await assert.rejects(
    () => client.templates.get("tpl with space"),
    (err) => {
      assert.equal(err.resourceId, "tpl with space");
      return true;
    },
  );
});

test("FcApiError populates code from envelope.data.code on 4xx", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: false,
    fetch: async () => fail({ code: "scaling_locked", message: "host pool draining" }, 403),
  });
  await assert.rejects(
    () => client.getSandbox("sb_xyz"),
    (err) => {
      assert.ok(err instanceof FcPermissionError);
      assert.equal(err.code, "scaling_locked");
      assert.equal(err.resourceId, "sb_xyz");
      return true;
    },
  );
});

test("FcApiError.code is undefined when envelope omits a code", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: false,
    fetch: async () => fail({ id: "broken" }, 400),
  });
  await assert.rejects(
    () => client.createSandbox({ shape: "s" }),
    (err) => {
      assert.ok(err instanceof FcValidationError);
      assert.equal(err.code, undefined);
      return true;
    },
  );
});

// ── NDJSON SSE tolerance ─────────────────────────────────────────────────

test("streamCommand skips SSE control lines and strips data: prefix", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (_url, init) => {
      if (init.method === "GET") {
        return success(RUNNING_VIEW);
      }
      const payload =
        ":heartbeat\n" +
        "event: progress\n" +
        "id: 42\n" +
        "retry: 1000\n" +
        'data: {"stdout":"hi\\n"}\n' +
        '{"exit_code":0}\n';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
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

// ── Sandbox static factories ─────────────────────────────────────────────

test("Sandbox.create builds a client and returns a running sandbox", async () => {
  const sandbox = await Sandbox.create(
    { shape: "s-1vcpu-256mb" },
    {
      apiKey: "sk",
      baseUrl: BASE,
      fetch: async (_url, init) => {
        if (init.method === "POST") {
          return success({
            id: "sb_factory",
            name: "x",
            ip: "10.0.0.9",
            mode: "cold",
            shape: "s-1vcpu-256mb",
            rootfs: "r",
            vcpu: 1,
            mem_mib: 256,
            disk_mib: 10240,
            spawn_ms: 1,
            egress: [],
            bandwidth_quota_bytes: 0,
          });
        }
        return success({ ...RUNNING_VIEW, id: "sb_factory" });
      },
    },
  );
  assert.equal(sandbox.id, "sb_factory");
  assert.equal(sandbox.status, "running");
});

test("Sandbox.connect fetches an existing sandbox by id", async () => {
  const sandbox = await Sandbox.connect("sb_existing", {
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      assert.equal(init.method, "GET");
      assert.match(String(url), /\/v1\/sandboxes\/sb_existing$/);
      return success({ ...RUNNING_VIEW, id: "sb_existing" });
    },
  });
  assert.equal(sandbox.id, "sb_existing");
});

// ── waitForPortReady ─────────────────────────────────────────────────────

test("waitForPortReady runs the bash probe and resolves on exit_code 0", async () => {
  let execBody;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      if (init.method === "GET") return success(RUNNING_VIEW);
      assert.match(String(url), /\/v1\/sandboxes\/sb_1\/exec$/);
      execBody = JSON.parse(init.body);
      return success({
        result: { stdout: "", stderr: "", exit_code: 0 },
        exec_ms: 50,
      });
    },
  });
  const sandbox = await client.getSandbox("sb_1");
  await sandbox.waitForPortReady(8080, { timeoutMs: 5000 });
  assert.equal(execBody.cmd, "bash");
  assert.match(execBody.args[1], /\/dev\/tcp\/127\.0\.0\.1\/8080/);
  assert.match(execBody.args[1], /^timeout 5 bash -c /);
});

test("waitForPortReady honors a custom host", async () => {
  let execBody;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (_url, init) => {
      if (init.method === "GET") return success(RUNNING_VIEW);
      execBody = JSON.parse(init.body);
      return success({
        result: { stdout: "", stderr: "", exit_code: 0 },
        exec_ms: 1,
      });
    },
  });
  const sandbox = await client.getSandbox("sb_1");
  await sandbox.waitForPortReady(3000, { host: "0.0.0.0", timeoutMs: 1000 });
  assert.match(execBody.args[1], /\/dev\/tcp\/0\.0\.0\.0\/3000/);
});

test("waitForPortReady throws FcTimeoutError on non-zero exit", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (_url, init) =>
      init.method === "GET"
        ? success(RUNNING_VIEW)
        : success({
            result: { stdout: "", stderr: "", exit_code: 124 },
            exec_ms: 1000,
          }),
  });
  const sandbox = await client.getSandbox("sb_1");
  await assert.rejects(() => sandbox.waitForPortReady(8080, { timeoutMs: 1000 }), FcTimeoutError);
});

test("waitForPortReady rejects invalid ports", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async () => success(RUNNING_VIEW),
  });
  const sandbox = await client.getSandbox("sb_1");
  await assert.rejects(() => sandbox.waitForPortReady(0), /Invalid port/);
  await assert.rejects(() => sandbox.waitForPortReady(65_536), /Invalid port/);
  await assert.rejects(() => sandbox.waitForPortReady(3.14), /Invalid port/);
});

test("waitForPortReady rejects hosts containing shell metacharacters", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    // Should never be called — host validation runs before any exec.
    fetch: async () => success(RUNNING_VIEW),
  });
  const sandbox = await client.getSandbox("sb_1");
  for (const host of [
    "127.0.0.1; rm -rf /",
    "$(curl evil)",
    "`id`",
    "127.0.0.1|cat /etc/shadow",
    "127.0.0.1 && id",
    "127.0.0.1\nid",
    "127.0.0.1/../etc",
    "",
  ]) {
    await assert.rejects(() => sandbox.waitForPortReady(80, { host }), /Invalid host/);
  }
});

// ── redaction helpers ────────────────────────────────────────────────────

test("redactHeaders redacts sensitive headers and preserves others", () => {
  const out = redactHeaders({
    Authorization: "Bearer secret",
    "X-Api-Key": "sk_real",
    "Some-Token": "t",
    "Some-Key": "k",
    "Content-Type": "application/json",
    "X-Request-Id": "rid_1",
  });
  assert.equal(out["authorization"], "redacted");
  assert.equal(out["x-api-key"], "redacted");
  assert.equal(out["some-token"], "redacted");
  assert.equal(out["some-key"], "redacted");
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["x-request-id"], "rid_1");
});

test("redactUrl strips userinfo and redacts sensitive query params", () => {
  const redacted = redactUrl("https://user:pw@api.example/path?token=sk&keep=ok");
  const parsed = new URL(redacted);
  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
  assert.equal(parsed.searchParams.get("token"), "redacted");
  assert.equal(parsed.searchParams.get("keep"), "ok");
});

test("redactUrl returns the input unchanged when it does not parse", () => {
  assert.equal(redactUrl("not a url"), "not a url");
});

test("redactQuery does not mutate the input", () => {
  const original = new URLSearchParams("token=abc&q=ok");
  const out = redactQuery(original);
  assert.equal(original.get("token"), "abc");
  assert.equal(out.get("token"), "redacted");
  assert.equal(out.get("q"), "ok");
});

// ── disks ──────────────────────────────────────────────────────────────

const DISK_VIEW = {
  id: "disk_01HFOO",
  name: "data",
  kind: "s3",
  config: { bucket: "my-bucket", endpoint: "https://s3.example", region: "us-east-1" },
  created_at: "2026-05-28T00:00:00Z",
};

test("disks.list unwraps the disks array", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      assert.equal(init.method, "GET");
      assert.equal(new URL(url).pathname, "/v1/disks");
      return success({ disks: [DISK_VIEW] });
    },
  });
  const out = await client.disks.list();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "disk_01HFOO");
  assert.equal(out[0].config.bucket, "my-bucket");
});

test("disks.create posts the registration payload", async () => {
  let body;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      assert.equal(init.method, "POST");
      assert.equal(new URL(url).pathname, "/v1/disks");
      body = JSON.parse(init.body);
      return success(DISK_VIEW);
    },
  });
  const out = await client.disks.create({
    name: "data",
    kind: "s3",
    config: { bucket: "my-bucket", endpoint: "https://s3.example", region: "us-east-1" },
    credentials: { access_key: "AKIA", secret_key: "shh" },
  });
  assert.equal(out.id, "disk_01HFOO");
  assert.equal(body.name, "data");
  assert.equal(body.credentials.access_key, "AKIA");
  assert.equal(body.config.bucket, "my-bucket");
});

test("disks.get and disks.delete address by id or name", async () => {
  const calls = [];
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      calls.push([init.method, new URL(url).pathname]);
      if (init.method === "GET") return success(DISK_VIEW);
      return success({ deleted: true });
    },
  });
  const got = await client.disks.get("data");
  assert.equal(got.name, "data");
  const del = await client.disks.delete("disk_01HFOO");
  assert.equal(del.deleted, true);
  assert.deepEqual(calls, [
    ["GET", "/v1/disks/data"],
    ["DELETE", "/v1/disks/disk_01HFOO"],
  ]);
});

test("disks.create surfaces 503 disks-not-configured as FcServerError", async () => {
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    retry: false,
    fetch: async () => errorEnvelope("disks API not configured", 0, 503),
  });
  await assert.rejects(
    () =>
      client.disks.create({
        name: "x",
        kind: "s3",
        config: { bucket: "b", endpoint: "https://s3.example" },
        credentials: { access_key: "a", secret_key: "s" },
      }),
    (err) => err instanceof FcServerError && err.statusCode === 503,
  );
});

test("sandbox.attachDisk posts disk_id, mount_path and sub_path", async () => {
  let body;
  let url;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (u, init) => {
      url = u;
      if (init.method === "POST" && u.endsWith("/disks")) {
        body = JSON.parse(init.body);
        return success({ ok: true });
      }
      return success(RUNNING_VIEW);
    },
  });
  const sandbox = await client.getSandbox("sb_1");
  const out = await sandbox.attachDisk("disk_01HFOO", "/mnt/data", "subdir");
  assert.equal(out.ok, true);
  assert.equal(new URL(url).pathname, "/v1/sandboxes/sb_1/disks");
  assert.deepEqual(body, {
    disk_id: "disk_01HFOO",
    mount_path: "/mnt/data",
    sub_path: "subdir",
  });
});

test("sandbox.attachDisk omits sub_path when not provided", async () => {
  let body;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (u, init) => {
      if (init.method === "POST" && u.endsWith("/disks")) {
        body = JSON.parse(init.body);
        return success({ ok: true });
      }
      return success(RUNNING_VIEW);
    },
  });
  const sandbox = await client.getSandbox("sb_1");
  await sandbox.attachDisk("disk_01HFOO", "/mnt/data");
  assert.deepEqual(body, { disk_id: "disk_01HFOO", mount_path: "/mnt/data" });
});

test("sandbox.detachDisk sends mount_path as a query param", async () => {
  let captured;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (u, init) => {
      if (init.method === "DELETE") {
        captured = new URL(u);
        return success({ detached: true });
      }
      return success(RUNNING_VIEW);
    },
  });
  const sandbox = await client.getSandbox("sb_1");
  const out = await sandbox.detachDisk("disk_01HFOO", "/mnt/data");
  assert.equal(out.detached, true);
  assert.equal(captured.pathname, "/v1/sandboxes/sb_1/disks/disk_01HFOO");
  assert.equal(captured.searchParams.get("mount_path"), "/mnt/data");
});

test("sandbox.listDisks returns per-attachment mount status", async () => {
  const attachment = {
    disk_id: "disk_01HFOO",
    name: "data",
    kind: "s3",
    config: { bucket: "b", endpoint: "https://s3.example" },
    mount_path: "/mnt/data",
    mount_status: "mounted",
  };
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (u, init) => {
      if (init.method === "GET" && u.endsWith("/disks")) {
        return success({ disks: [attachment] });
      }
      return success(RUNNING_VIEW);
    },
  });
  const sandbox = await client.getSandbox("sb_1");
  const out = await sandbox.listDisks();
  assert.equal(out.length, 1);
  assert.equal(out[0].mount_status, "mounted");
  assert.equal(out[0].mount_path, "/mnt/data");
});

test("createSandbox forwards the disks attachment list in the create body", async () => {
  let createBody;
  const client = new FcClient({
    apiKey: "sk",
    baseUrl: BASE,
    fetch: async (url, init) => {
      if (init.method === "POST" && new URL(url).pathname === "/v1/sandboxes") {
        createBody = JSON.parse(init.body);
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
      return success(RUNNING_VIEW);
    },
  });
  await client.createSandbox({
    shape: "s",
    disks: [{ disk_id: "data", mount_path: "/mnt/data" }],
  });
  assert.deepEqual(createBody.disks, [{ disk_id: "data", mount_path: "/mnt/data" }]);
});
