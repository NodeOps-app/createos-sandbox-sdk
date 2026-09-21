import { describe, expect, test } from "bun:test";
import {
  CreateosSandboxClient,
  CreateosSandboxError,
  CreateosSandboxNotFoundError,
} from "../src/index.ts";
import { BASE, RUNNING_VIEW, success } from "./helpers.ts";

describe("sandbox access tokens", () => {
  test("create, inspect, rotate, and disable use the owner credential and wire shapes", async () => {
    const seen: string[] = [];
    const client = new CreateosSandboxClient({
      baseUrl: BASE,
      apiKey: "owner-key",
      fetch: (async (url, init) => {
        const path = new URL(String(url)).pathname;
        expect(new Headers(init?.headers).get("x-api-key")).toBe("owner-key");
        seen.push(`${init?.method} ${path}`);
        if (path === "/v1/sandboxes/sb_1") return success(RUNNING_VIEW);
        if (init?.method === "POST" && path.endsWith("/rotate")) {
          return success({
            token: "skp_sb_second",
            enabled: true,
            created_at: "2026-09-18T10:00:00Z",
            rotated_at: "2026-09-18T11:00:00Z",
          });
        }
        if (init?.method === "POST") {
          return success({
            token: "skp_sb_first",
            enabled: true,
            created_at: "2026-09-18T10:00:00Z",
          });
        }
        if (init?.method === "DELETE") return success({ enabled: false });
        return success({
          enabled: true,
          token_hint: "skp_sb_fi...irst",
          created_at: "2026-09-18T10:00:00Z",
        });
      }) as typeof fetch,
    });
    const sandbox = await client.getSandbox("sb_1");
    expect((await sandbox.createAccessToken()).token).toBe("skp_sb_first");
    expect(await sandbox.getAccessToken()).toEqual({
      enabled: true,
      token_hint: "skp_sb_fi...irst",
      created_at: "2026-09-18T10:00:00Z",
    });
    expect((await sandbox.rotateAccessToken()).rotated_at).toBe("2026-09-18T11:00:00Z");
    expect(await sandbox.disableAccessToken()).toEqual({ enabled: false });
    expect(seen).toEqual([
      "GET /v1/sandboxes/sb_1",
      "POST /v1/sandboxes/sb_1/access-token",
      "GET /v1/sandboxes/sb_1/access-token",
      "POST /v1/sandboxes/sb_1/access-token/rotate",
      "DELETE /v1/sandboxes/sb_1/access-token",
    ]);
  });

  test("delegated handle uses only its token and preserves transport settings", async () => {
    const seen: Array<{ key: string | null; path: string }> = [];
    const client = new CreateosSandboxClient({
      baseUrl: BASE,
      authHeaders: { Authorization: "Bearer owner" },
      headers: { "X-Trace": "trace-1" },
      fetch: (async (url, init) => {
        const headers = new Headers(init?.headers);
        const path = new URL(String(url)).pathname;
        expect(headers.get("x-trace")).toBe("trace-1");
        seen.push({ key: headers.get("x-api-key"), path });
        if (path === "/v1/sandboxes/sb_1") return success(RUNNING_VIEW);
        if (path.endsWith("/access-token")) {
          expect(headers.get("authorization")).toBe("Bearer owner");
          return success({ enabled: true });
        }
        expect(headers.has("authorization")).toBe(false);
        expect(headers.get("x-api-key")).toBe("skp_sb_worker");
        return success({ result: { stdout: "hello\n", stderr: "", exit_code: 0 }, exec_ms: 1 });
      }) as typeof fetch,
    });
    const owner = await client.getSandbox("sb_1");
    const worker = owner.withAccessToken(" skp_sb_worker ");
    expect(worker).not.toBe(owner);
    expect(worker.files).toBeDefined();
    expect(worker.processes).toBeDefined();
    expect(worker.computer).toBeDefined();
    expect((await worker.runCommand("echo", ["hello"])).result.stdout).toBe("hello\n");
    await owner.getAccessToken();
    expect(seen.at(-2)?.key).toBe("skp_sb_worker");
    expect(seen.at(-1)?.key).toBeNull();
  });

  test("blank and non-sandbox tokens are rejected before a request", async () => {
    let fetchCalls = 0;
    const client = new CreateosSandboxClient({
      baseUrl: BASE,
      apiKey: "owner-key",
      fetch: (async () => {
        fetchCalls++;
        return success(RUNNING_VIEW);
      }) as unknown as typeof fetch,
    });
    const sandbox = await client.getSandbox("sb_1");
    for (const token of [" \t ", "skp_owner-key", "skp_sb", "skp_mangled"]) {
      expect(() => sandbox.withAccessToken(token)).toThrow(CreateosSandboxError);
    }
    expect(fetchCalls).toBe(1);
  });

  test("rotation surfaces a missing-token response", async () => {
    const client = new CreateosSandboxClient({
      baseUrl: BASE,
      apiKey: "owner-key",
      fetch: (async (url) => {
        if (new URL(String(url)).pathname === "/v1/sandboxes/sb_1") return success(RUNNING_VIEW);
        return new Response(
          JSON.stringify({ status: "fail", data: "sandbox access token not found" }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      }) as typeof fetch,
    });
    const sandbox = await client.getSandbox("sb_1");
    await expect(sandbox.rotateAccessToken()).rejects.toBeInstanceOf(CreateosSandboxNotFoundError);
  });
});
