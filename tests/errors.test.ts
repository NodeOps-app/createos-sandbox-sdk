import { describe, expect, test } from "bun:test";
import {
  CreateosSandboxApiError,
  CreateosSandboxAuthError,
  CreateosSandboxConnectionError,
  CreateosSandboxNotFoundError,
  CreateosSandboxPaymentRequiredError,
  CreateosSandboxPermissionError,
  CreateosSandboxRateLimitError,
  CreateosSandboxServerError,
  CreateosSandboxValidationError,
} from "../src/index.ts";
import { BASE, catchErr, fail, jsonResponse, makeClient, success } from "./helpers.ts";

describe("status code → typed error mapping", () => {
  const cases: [number, new (...args: never[]) => CreateosSandboxApiError][] = [
    [401, CreateosSandboxAuthError],
    [403, CreateosSandboxPermissionError],
    [404, CreateosSandboxNotFoundError],
    [400, CreateosSandboxValidationError],
    [409, CreateosSandboxValidationError],
    [422, CreateosSandboxValidationError],
    [402, CreateosSandboxPaymentRequiredError],
    [429, CreateosSandboxRateLimitError],
    [500, CreateosSandboxServerError],
    [502, CreateosSandboxServerError],
    [503, CreateosSandboxServerError],
    [504, CreateosSandboxServerError],
  ];

  for (const [status, ErrorClass] of cases) {
    test(`${status} maps to ${ErrorClass.name}`, async () => {
      const client = makeClient(() => Promise.resolve(fail({ id: "boom" }, status)), {
        retry: false,
      });
      const err = await catchErr(() => client.getSandbox("sb_x"));
      expect(err).toBeInstanceOf(ErrorClass);
      expect(err).toBeInstanceOf(CreateosSandboxApiError);
      expect(err.statusCode).toBe(status);
    });
  }
});

describe("CreateosSandboxApiError metadata", () => {
  test("CreateosSandboxRateLimitError exposes the Retry-After delay", async () => {
    const client = makeClient(
      () =>
        Promise.resolve(
          jsonResponse(
            { status: "fail", data: {} },
            { status: 429, headers: { "retry-after": "7" } },
          ),
        ),
      { retry: false },
    );
    const err = await catchErr(() => client.getSandbox("sb_x"));
    expect(err).toBeInstanceOf(CreateosSandboxRateLimitError);
    expect(err.retryAfterSeconds).toBe(7);
  });

  test("CreateosSandboxNotFoundError parses the resource id from the path", async () => {
    const client = makeClient(() => Promise.resolve(fail({ id: "missing" }, 404)), {
      retry: false,
    });
    const err = await catchErr(() => client.getSandbox("sb_abc123"));
    expect(err).toBeInstanceOf(CreateosSandboxNotFoundError);
    expect(err.resourceId).toBe("sb_abc123");
  });

  test("parses the resource id from a disks path", async () => {
    const client = makeClient(() => Promise.resolve(fail({ id: "missing" }, 404)), {
      retry: false,
    });
    const err = await catchErr(() => client.disks.get("disk_abc123"));
    expect(err).toBeInstanceOf(CreateosSandboxNotFoundError);
    expect(err.resourceId).toBe("disk_abc123");
  });

  test("preserves URL-encoded path segments in resourceId", async () => {
    const client = makeClient(() => Promise.resolve(fail({ id: "missing" }, 404)), {
      retry: false,
    });
    const err = await catchErr(() => client.getSandbox("sb id/with space"));
    expect(err).toBeInstanceOf(CreateosSandboxNotFoundError);
    expect(err.resourceId).toBe("sb id/with space");
  });

  test("endpoint and method reflect the request (GET)", async () => {
    const client = makeClient(() => Promise.resolve(fail({ id: "x" }, 404)), { retry: false });
    const err = await catchErr(() => client.getSandbox("sb_xyz"));
    expect(err.endpoint).toBe("/v1/sandboxes/sb_xyz");
    expect(err.method).toBe("GET");
  });

  test("method reflects a POST request", async () => {
    const client = makeClient(() => Promise.resolve(fail({ id: "x" }, 400)), { retry: false });
    const err = await catchErr(() => client.createSandbox({ shape: "s" }));
    expect(err.method).toBe("POST");
    expect(err.endpoint).toBe("/v1/sandboxes");
  });

  test("requestId is taken from the X-Request-Id header", async () => {
    const client = makeClient(
      () =>
        Promise.resolve(
          jsonResponse(
            { status: "fail", data: {} },
            { status: 404, headers: { "x-request-id": "req-abc-123" } },
          ),
        ),
      { retry: false },
    );
    const err = await catchErr(() => client.getSandbox("sb_xyz"));
    expect(err.requestId).toBe("req-abc-123");
  });

  test("requestId falls back to X-Fc-Request-Id", async () => {
    const client = makeClient(
      () =>
        Promise.resolve(
          jsonResponse(
            { status: "fail", data: {} },
            { status: 404, headers: { "x-fc-request-id": "rid-fallback" } },
          ),
        ),
      { retry: false },
    );
    const err = await catchErr(() => client.getSandbox("sb_xyz"));
    expect(err.requestId).toBe("rid-fallback");
  });

  test("code is undefined when the envelope omits a code", async () => {
    const client = makeClient(() => Promise.resolve(fail({ id: "broken" }, 400)), { retry: false });
    const err = await catchErr(() => client.createSandbox({ shape: "s" }));
    expect(err.code).toBeUndefined();
  });

  test("code is populated from envelope.data.code on a fail envelope", async () => {
    const client = makeClient(() => Promise.resolve(fail({ code: "QUOTA_EXCEEDED" }, 400)), {
      retry: false,
    });
    const err = await catchErr(() => client.createSandbox({ shape: "s" }));
    expect(err.code).toBe("QUOTA_EXCEEDED");
  });
});

describe("CreateosSandboxConnectionError", () => {
  test("wraps a non-abort network failure", async () => {
    const client = makeClient(() => Promise.reject(new TypeError("socket hang up")), {
      retry: false,
    });
    const err = await catchErr(() => client.getSandbox("sb_x"));
    expect(err).toBeInstanceOf(CreateosSandboxConnectionError);
  });

  test("baseUrl is reachable through the client", () => {
    const client = makeClient(() => Promise.resolve(success({})), {});
    expect(client.baseUrl).toBe(BASE);
  });
});
