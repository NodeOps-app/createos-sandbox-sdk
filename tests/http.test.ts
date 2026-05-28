import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FcClient,
  FcConnectionError,
  FcError,
  FcRateLimitError,
  FcServerError,
  FcTimeoutError,
  VERSION,
} from "../src/index.ts";
import { parseRetryAfterSeconds } from "../src/errors.ts";
import {
  BASE,
  catchErr,
  errorEnvelope,
  FAST_RETRY,
  jsonResponse,
  makeClient,
  success,
} from "./helpers.ts";

const WHOAMI_OK = { user_id: "u", stats: { running: 0, paused: 0, other: 0, total: 0 } };

/** A CreateSandboxResponse-shaped body for tests that POST /v1/sandboxes. */
function createSandboxBody(): Record<string, unknown> {
  return {
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
  };
}

const TRACKED_ENV_KEYS = ["FC_API_KEY", "FC_BASE_URL"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of TRACKED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TRACKED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("retry policy", () => {
  test("retries an idempotent GET on 503, then succeeds", async () => {
    let attempts = 0;
    const client = makeClient(
      () => {
        attempts += 1;
        return Promise.resolve(attempts < 3 ? errorEnvelope("busy", 503, 503) : success(WHOAMI_OK));
      },
      { retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 } },
    );
    const who = await client.whoami();
    expect(who.user_id).toBe("u");
    expect(attempts).toBe(3);
  });

  test("throws after exhausting retries", async () => {
    let attempts = 0;
    const client = makeClient(
      () => {
        attempts += 1;
        return Promise.resolve(errorEnvelope("down", 503, 503));
      },
      { retry: FAST_RETRY },
    );
    await expect(client.whoami()).rejects.toBeInstanceOf(FcServerError);
    expect(attempts).toBe(3); // initial + 2 retries
  });

  test("does not retry a non-idempotent POST on an ambiguous 500", async () => {
    let attempts = 0;
    const client = makeClient(
      () => {
        attempts += 1;
        return Promise.resolve(errorEnvelope("boom", 500, 500));
      },
      { retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 } },
    );
    await expect(client.createSandbox({ shape: "s" })).rejects.toBeInstanceOf(FcServerError);
    expect(attempts).toBe(1);
  });

  test("retries a POST on 503 — the server provably did not process it", async () => {
    let attempts = 0;
    const client = makeClient(
      () => {
        attempts += 1;
        return Promise.resolve(errorEnvelope("no capacity", 503, 503));
      },
      { retry: FAST_RETRY },
    );
    await expect(client.createSandbox({ shape: "s" })).rejects.toBeInstanceOf(FcServerError);
    expect(attempts).toBe(3);
  });

  test("idempotent GET retries on 408/500/502/503/504", async () => {
    for (const status of [408, 500, 502, 503, 504]) {
      let attempts = 0;
      const client = makeClient(
        () => {
          attempts += 1;
          return Promise.resolve(errorEnvelope("x", status, status));
        },
        { retry: FAST_RETRY },
      );
      await catchErr(() => client.whoami());
      expect(attempts).toBe(3);
    }
  });

  test("non-idempotent POST does NOT retry on 408/500/502/504", async () => {
    for (const status of [408, 500, 502, 504]) {
      let attempts = 0;
      const client = makeClient(
        () => {
          attempts += 1;
          return Promise.resolve(errorEnvelope("x", status, status));
        },
        { retry: FAST_RETRY },
      );
      await catchErr(() => client.createSandbox({ shape: "s" }));
      expect(attempts).toBe(1);
    }
  });

  test("non-idempotent POST retries on 429", async () => {
    let attempts = 0;
    const client = makeClient(
      () => {
        attempts += 1;
        return Promise.resolve(
          jsonResponse(
            { status: "fail", data: {} },
            { status: 429, headers: { "retry-after": "0" } },
          ),
        );
      },
      { retry: FAST_RETRY },
    );
    await expect(client.createSandbox({ shape: "s" })).rejects.toBeInstanceOf(FcRateLimitError);
    expect(attempts).toBe(3);
  });

  test("streaming requests are never retried", async () => {
    let attempts = 0;
    const client = makeClient(
      () => {
        attempts += 1;
        return Promise.resolve(errorEnvelope("busy", 503, 503));
      },
      { retry: FAST_RETRY },
    );
    const err = await catchErr(async () => {
      for await (const event of client.http.stream("GET", "/v1/templates/x/logs", {})) {
        expect(event).toBeDefined();
      }
    });
    expect(err).toBeInstanceOf(FcServerError);
    expect(attempts).toBe(1);
  });
});

describe("parseRetryAfterSeconds", () => {
  test("parses delta-seconds", () => {
    expect(parseRetryAfterSeconds("7")).toBe(7);
    expect(parseRetryAfterSeconds("0")).toBe(0);
  });

  test("parses an HTTP-date in the future to a non-negative delay", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const seconds = parseRetryAfterSeconds(future);
    expect(seconds).toBeGreaterThan(50);
    expect(seconds).toBeLessThanOrEqual(61);
  });

  test("clamps a past HTTP-date to 0", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterSeconds(past)).toBe(0);
  });

  test("returns undefined for unparseable or missing values", () => {
    expect(parseRetryAfterSeconds("not-a-date")).toBeUndefined();
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
  });
});

describe("timeouts and cancellation", () => {
  test("a fired timeout surfaces as FcTimeoutError", async () => {
    const client = makeClient(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      { retry: false, timeoutMs: 5 },
    );
    await expect(client.whoami()).rejects.toBeInstanceOf(FcTimeoutError);
  });

  test("user-supplied AbortSignal cancellation propagates the original abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = makeClient(
      (_url, init) =>
        new Promise((resolve, reject) => {
          if (init.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
          else resolve(success(WHOAMI_OK));
        }),
      { retry: false },
    );
    const err = await catchErr(() => client.whoami({ signal: controller.signal }));
    expect(err.name).toBe("AbortError");
  });

  test("a non-abort fetch rejection becomes FcConnectionError", async () => {
    const client = makeClient(() => Promise.reject(new TypeError("dns")), { retry: false });
    await expect(client.whoami()).rejects.toBeInstanceOf(FcConnectionError);
  });
});

describe("auth headers", () => {
  test("sends X-Api-Key on authenticated requests and omits it for auth:false probes", async () => {
    let sawKeyOnHealth: boolean | undefined;
    let sawKeyOnWhoami: string | null | undefined;
    const client = makeClient(
      (url, init) => {
        if (String(url).endsWith("/healthz")) {
          sawKeyOnHealth = (init.headers as Headers).has("x-api-key");
          return Promise.resolve(success({ up: true }));
        }
        sawKeyOnWhoami = (init.headers as Headers).get("x-api-key");
        return Promise.resolve(success(WHOAMI_OK));
      },
      { apiKey: "sk_test" },
    );
    await client.healthz();
    await client.whoami();
    expect(sawKeyOnHealth).toBe(false);
    expect(sawKeyOnWhoami).toBe("sk_test");
  });

  test("apiKey auth strips higher-priority generic credential headers", async () => {
    let headers: Headers | undefined;
    const client = makeClient(
      (_url, init) => {
        headers = init.headers as Headers;
        return Promise.resolve(success(WHOAMI_OK));
      },
      {
        apiKey: "sk_test",
        headers: {
          Authorization: "Bearer stale",
          "X-Access-Token": "stale",
          "X-Auth-Token": "stale",
          Cookie: "sid=abc",
          "Proxy-Authorization": "Basic xyz",
          "X-CSRF-Token": "csrf",
        },
      },
    );
    await client.whoami();
    expect(headers?.has("authorization")).toBe(false);
    expect(headers?.has("x-access-token")).toBe(false);
    expect(headers?.has("x-auth-token")).toBe(false);
    expect(headers?.has("cookie")).toBe(false);
    expect(headers?.has("proxy-authorization")).toBe(false);
    expect(headers?.has("x-csrf-token")).toBe(false);
    expect(headers?.get("x-api-key")).toBe("sk_test");
  });

  test("authHeaders mode replaces credentials and drops the rest", async () => {
    let headers: Headers | undefined;
    const client = new FcClient({
      baseUrl: BASE,
      authHeaders: { "X-Custom-Auth": "tok" },
      fetch: ((_url: string, init: RequestInit) => {
        headers = init.headers as Headers;
        return Promise.resolve(success(WHOAMI_OK));
      }) as unknown as typeof fetch,
    });
    await client.whoami();
    expect(headers?.get("x-custom-auth")).toBe("tok");
    expect(headers?.has("x-api-key")).toBe(false);
  });

  test("auth:false strips every credential header supplied by the caller", async () => {
    let headers: Headers | undefined;
    const client = makeClient(
      (_url, init) => {
        headers = init.headers as Headers;
        return Promise.resolve(success({ up: true }));
      },
      { apiKey: "sk_test", headers: { Authorization: "Bearer x", Cookie: "s=1" } },
    );
    await client.healthz();
    expect(headers?.has("authorization")).toBe(false);
    expect(headers?.has("cookie")).toBe(false);
    expect(headers?.has("x-api-key")).toBe(false);
  });

  test("authHeaders are also stripped on auth:false probes", async () => {
    let headers: Headers | undefined;
    const client = new FcClient({
      baseUrl: BASE,
      authHeaders: { "X-Custom-Auth": "tok" },
      fetch: ((_url: string, init: RequestInit) => {
        headers = init.headers as Headers;
        return Promise.resolve(success({ up: true }));
      }) as unknown as typeof fetch,
    });
    await client.healthz();
    expect(headers?.has("x-custom-auth")).toBe(false);
  });

  test("requires an apiKey (or authHeaders) for authenticated requests", async () => {
    const client = new FcClient({
      baseUrl: BASE,
      fetch: (() => Promise.resolve(success(WHOAMI_OK))) as unknown as typeof fetch,
      retry: false,
    });
    await expect(client.whoami()).rejects.toBeInstanceOf(FcError);
  });

  test("reads apiKey and baseUrl from environment variables", async () => {
    process.env.FC_API_KEY = "sk_env";
    process.env.FC_BASE_URL = "https://env.test";
    let seenUrl = "";
    let seenKey: string | null | undefined;
    const client = new FcClient({
      fetch: ((url: string, init: RequestInit) => {
        seenUrl = String(url);
        seenKey = (init.headers as Headers).get("x-api-key");
        return Promise.resolve(success(WHOAMI_OK));
      }) as unknown as typeof fetch,
    });
    await client.whoami();
    expect(seenUrl).toBe("https://env.test/v1/whoami");
    expect(seenKey).toBe("sk_env");
  });

  test("sends a versioned User-Agent and an X-Fc-Runtime header", async () => {
    let ua = "";
    let runtime = "";
    const client = makeClient((_url, init) => {
      ua = (init.headers as Headers).get("user-agent") ?? "";
      runtime = (init.headers as Headers).get("x-fc-runtime") ?? "";
      return Promise.resolve(success({ up: true }));
    });
    await client.healthz();
    expect(ua.startsWith(`fc-sandbox-sdk/${VERSION} `)).toBe(true);
    expect(runtime.length).toBeGreaterThan(0);
  });
});

describe("URL building", () => {
  test("preserves a base URL path prefix", async () => {
    let pathname = "";
    const client = makeClient(
      (url) => {
        pathname = new URL(String(url)).pathname;
        return Promise.resolve(success({ ...createSandboxBody(), status: "running" }));
      },
      { baseUrl: "https://example.test/prefix" },
    );
    await client.getSandbox("sb_1");
    expect(pathname).toBe("/prefix/v1/sandboxes/sb_1");
  });

  test("refuses to dispatch to a non-base origin (credential exfiltration guard)", async () => {
    const client = makeClient(() => Promise.resolve(success({})));
    await expect(client.http.request("GET", "https://evil.test/steal", {})).rejects.toBeInstanceOf(
      FcError,
    );
  });
});

describe("observability hooks", () => {
  test("onRequest and onResponse fire with method, attempt, status, requestId, durationMs", async () => {
    const events: Array<Record<string, unknown>> = [];
    const client = makeClient(
      () =>
        Promise.resolve(
          success(
            { ...createSandboxBody(), status: "running" },
            { headers: { "x-request-id": "req-1" } },
          ),
        ),
      {
        retry: false,
        hooks: {
          onRequest: (ctx) => {
            events.push({ kind: "req", ...ctx });
          },
          onResponse: (ctx) => {
            events.push({ kind: "res", ...ctx });
          },
        },
      },
    );
    await client.getSandbox("sb_xyz");
    expect(events.map((e) => e.kind)).toEqual(["req", "res"]);
    expect(events[0]?.method).toBe("GET");
    expect(events[0]?.attempt).toBe(1);
    expect(events[1]?.status).toBe(200);
    expect(events[1]?.requestId).toBe("req-1");
    expect(typeof events[1]?.durationMs).toBe("number");
  });

  test("hook header payloads redact the API key", async () => {
    let captured: Record<string, string> = {};
    const client = makeClient(
      () => Promise.resolve(success({ ...createSandboxBody(), status: "running" })),
      {
        apiKey: "sk_secret_should_not_appear",
        retry: false,
        hooks: {
          onRequest: (ctx) => {
            captured = ctx.headers;
          },
        },
      },
    );
    await client.getSandbox("sb_a");
    expect(captured["x-api-key"]).toBe("redacted");
    expect(JSON.stringify(captured).includes("sk_secret_should_not_appear")).toBe(false);
  });

  test("a throwing hook never crashes the request", async () => {
    const client = makeClient(() => Promise.resolve(success(WHOAMI_OK)), {
      retry: false,
      hooks: {
        onRequest: () => {
          throw new Error("hook boom");
        },
        onResponse: () => {
          throw new Error("hook boom");
        },
      },
    });
    const who = await client.whoami();
    expect(who.user_id).toBe("u");
  });

  test("hook url payload redacts sensitive query params", async () => {
    let url = "";
    const client = makeClient(() => Promise.resolve(success({})), {
      apiKey: "sk",
      retry: false,
      hooks: {
        onRequest: (ctx) => {
          url = ctx.url;
        },
      },
    });
    await client.http.request("GET", "/v1/whoami", { query: { token: "sk_leak" } });
    expect(url).toContain("token=redacted");
    expect(url.includes("sk_leak")).toBe(false);
  });

  test("hook url payload strips userinfo from the base URL", async () => {
    let url = "";
    const client = new FcClient({
      apiKey: "sk",
      baseUrl: "https://user:pass@redacted.test",
      retry: false,
      fetch: (() => Promise.resolve(success({}))) as unknown as typeof fetch,
      hooks: {
        onRequest: (ctx) => {
          url = ctx.url;
        },
      },
    });
    await client.http.request("GET", "/v1/whoami");
    expect(url.includes("user")).toBe(false);
    expect(url.includes("pass")).toBe(false);
    expect(url).toContain("redacted.test");
  });

  test("onRetry fires with reason, status, attempt and delayMs", async () => {
    let attempts = 0;
    const events: Array<Record<string, unknown>> = [];
    const client = makeClient(
      () => {
        attempts += 1;
        return Promise.resolve(attempts < 2 ? errorEnvelope("busy", 503, 503) : success(WHOAMI_OK));
      },
      {
        retry: FAST_RETRY,
        hooks: {
          onRetry: (ctx) => {
            events.push({ ...ctx });
          },
        },
      },
    );
    await client.whoami();
    expect(events.length).toBe(1);
    expect(events[0]?.reason).toBe("status");
    expect(events[0]?.status).toBe(503);
    expect(events[0]?.attempt).toBe(1);
    expect(typeof events[0]?.delayMs).toBe("number");
  });
});
