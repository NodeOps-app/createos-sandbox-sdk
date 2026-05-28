import { describe, expect, test } from "bun:test";
import {
  redactHeaders,
  redactQuery,
  redactUrl,
  SENSITIVE_HEADER_NAMES,
  SENSITIVE_QUERY_PARAMS,
} from "../src/index.ts";

describe("redactHeaders", () => {
  test("redacts credential headers and the *-token / *-key suffix families", () => {
    const out = redactHeaders({
      Authorization: "Bearer secret",
      "X-Api-Key": "sk_real",
      "Some-Token": "t",
      "Some-Key": "k",
      "Content-Type": "application/json",
      "X-Request-Id": "rid_1",
    });
    expect(out.authorization).toBe("redacted");
    expect(out["x-api-key"]).toBe("redacted");
    expect(out["some-token"]).toBe("redacted");
    expect(out["some-key"]).toBe("redacted");
    expect(out["content-type"]).toBe("application/json");
    expect(out["x-request-id"]).toBe("rid_1");
  });

  test("covers every name in SENSITIVE_HEADER_NAMES", () => {
    for (const name of SENSITIVE_HEADER_NAMES) {
      const out = redactHeaders({ [name]: "leak" });
      expect(out[name]).toBe("redacted");
    }
  });
});

describe("redactUrl", () => {
  test("strips userinfo and redacts sensitive query params, keeping the rest", () => {
    const redacted = redactUrl("https://user:pw@api.example/path?token=sk&keep=ok");
    const parsed = new URL(redacted);
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
    expect(parsed.searchParams.get("token")).toBe("redacted");
    expect(parsed.searchParams.get("keep")).toBe("ok");
  });

  test("returns the input unchanged when it does not parse as a URL", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("redactQuery", () => {
  test("redacts sensitive params and does not mutate the input", () => {
    const input = new URLSearchParams({ api_key: "sk", page: "2" });
    const out = redactQuery(input);
    expect(out.get("api_key")).toBe("redacted");
    expect(out.get("page")).toBe("2");
    // input untouched
    expect(input.get("api_key")).toBe("sk");
  });

  test("covers every name in SENSITIVE_QUERY_PARAMS", () => {
    for (const name of SENSITIVE_QUERY_PARAMS) {
      const out = redactQuery(new URLSearchParams({ [name]: "leak" }));
      expect(out.get(name)).toBe("redacted");
    }
  });
});
