import { describe, expect, test } from "bun:test";
import { FcNotFoundError } from "../src/index.ts";
import { catchErr, makeClient, RUNNING_VIEW, success } from "./helpers.ts";

describe("SandboxFiles.upload", () => {
  test("PUTs raw bytes with the path query and octet-stream content type", async () => {
    let method = "";
    let url = "";
    let contentType: string | null | undefined;
    let bodyText = "";
    const client = makeClient((u, init) => {
      if (init.method === "PUT") {
        method = init.method;
        url = String(u);
        contentType = (init.headers as Headers).get("content-type");
        bodyText = String(init.body);
        return Promise.resolve(success({}));
      }
      return Promise.resolve(success(RUNNING_VIEW));
    });
    const sandbox = await client.getSandbox("sb_1");
    await sandbox.files.upload("/srv/index.html", "<h1>Hello</h1>");
    expect(method).toBe("PUT");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v1/sandboxes/sb_1/files");
    expect(parsed.searchParams.get("path")).toBe("/srv/index.html");
    expect(contentType).toBe("application/octet-stream");
    expect(bodyText).toBe("<h1>Hello</h1>");
  });
});

describe("SandboxFiles.download", () => {
  test("GETs the file bytes with an encoded path query", async () => {
    let url = "";
    const client = makeClient((u, init) => {
      if (init.method === "GET" && new URL(String(u)).pathname.endsWith("/files")) {
        url = String(u);
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      }
      return Promise.resolve(success(RUNNING_VIEW));
    });
    const sandbox = await client.getSandbox("sb_1");
    const buf = await sandbox.files.download("/etc/os release");
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new URL(url).searchParams.get("path")).toBe("/etc/os release");
  });

  test("surfaces a 404 as a typed error with the correct method and endpoint", async () => {
    const client = makeClient(
      (u, init) => {
        if (init.method === "GET" && new URL(String(u)).pathname.endsWith("/files")) {
          return Promise.resolve(
            new Response(JSON.stringify({ status: "fail", data: {} }), {
              status: 404,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(success(RUNNING_VIEW));
      },
      { retry: false },
    );
    const sandbox = await client.getSandbox("sb_1");
    const err = await catchErr(() => sandbox.files.download("/missing"));
    expect(err).toBeInstanceOf(FcNotFoundError);
    expect(err.method).toBe("GET");
    expect(err.endpoint).toBe("/v1/sandboxes/sb_1/files");
  });
});
