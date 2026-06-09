import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FcError } from "../src/index.ts";
import { resolveConfig, VERSION } from "../src/config.ts";

const fetchStub = (() => Promise.resolve(new Response())) as unknown as typeof fetch;

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

describe("resolveConfig — sources and precedence", () => {
  test("explicit options win over environment variables", () => {
    process.env.FC_API_KEY = "sk_env";
    process.env.FC_BASE_URL = "https://env.test";
    const cfg = resolveConfig({
      apiKey: "sk_explicit",
      baseUrl: "https://explicit.test",
      fetch: fetchStub,
    });
    expect(cfg.apiKey).toBe("sk_explicit");
    expect(cfg.baseUrl).toBe("https://explicit.test");
  });

  test("falls back to FC_API_KEY / FC_BASE_URL when options are absent", () => {
    process.env.FC_API_KEY = "sk_env";
    process.env.FC_BASE_URL = "https://env.test";
    const cfg = resolveConfig({ fetch: fetchStub });
    expect(cfg.apiKey).toBe("sk_env");
    expect(cfg.baseUrl).toBe("https://env.test");
  });

  test("throws when no base URL is configured", () => {
    expect(() => resolveConfig({ fetch: fetchStub })).toThrow(FcError);
  });

  test("trims trailing slashes from the base URL", () => {
    const cfg = resolveConfig({ baseUrl: "https://api.test/", fetch: fetchStub });
    expect(cfg.baseUrl).toBe("https://api.test");
  });

  test("default user-agent embeds the package VERSION", () => {
    const cfg = resolveConfig({ baseUrl: "https://api.test", fetch: fetchStub });
    expect(VERSION).toBe("0.6.0");
    expect(cfg.userAgent.startsWith(`fc-sandbox-sdk/${VERSION} `)).toBe(true);
  });
});

describe("resolveConfig — validation", () => {
  test("rejects a base URL carrying a query string", () => {
    expect(() => resolveConfig({ baseUrl: "https://api.test/?x=1", fetch: fetchStub })).toThrow(
      FcError,
    );
  });

  test("rejects a base URL carrying a fragment", () => {
    expect(() => resolveConfig({ baseUrl: "https://api.test/#frag", fetch: fetchStub })).toThrow(
      FcError,
    );
  });

  test("rejects an unparseable base URL", () => {
    expect(() => resolveConfig({ baseUrl: "not-a-url", fetch: fetchStub })).toThrow(FcError);
  });

  test("rejects passing both apiKey and authHeaders", () => {
    expect(() =>
      resolveConfig({
        apiKey: "sk",
        authHeaders: { Authorization: "Bearer x" },
        baseUrl: "https://api.test",
        fetch: fetchStub,
      }),
    ).toThrow(FcError);
  });
});

describe("resolveConfig — retry policy", () => {
  test("retry:false is preserved", () => {
    const cfg = resolveConfig({ retry: false, baseUrl: "https://api.test", fetch: fetchStub });
    expect(cfg.retry).toBe(false);
  });

  test("partial retry options merge with defaults", () => {
    const cfg = resolveConfig({
      retry: { maxRetries: 5 },
      baseUrl: "https://api.test",
      fetch: fetchStub,
    });
    expect(cfg.retry).toEqual({ maxRetries: 5, baseDelayMs: 500, maxDelayMs: 30_000 });
  });
});
