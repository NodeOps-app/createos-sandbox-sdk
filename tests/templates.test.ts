import { describe, expect, test } from "bun:test";
import { CreateosSandboxNotFoundError } from "../src/index.ts";
import { catchErr, makeClient, ndjsonResponse, streamOf, success } from "./helpers.ts";

const TEMPLATE: Record<string, unknown> = {
  id: "tpl_1",
  name: "my-template",
  base: "devbox:1",
  status: "ready",
  ext4_size_bytes: 1024,
  created_at: "2024-01-01T00:00:00Z",
};

describe("TemplatesApi", () => {
  test("list unwraps to a templates array", async () => {
    const client = makeClient(() => Promise.resolve(success({ templates: [TEMPLATE] })));
    const templates = await client.templates.list();
    expect(templates).toHaveLength(1);
    expect(templates[0]?.id).toBe("tpl_1");
  });

  test("create posts the registration payload", async () => {
    let body: Record<string, unknown> | undefined;
    let pathname = "";
    const client = makeClient((url, init) => {
      pathname = new URL(String(url)).pathname;
      body = JSON.parse(String(init.body));
      return Promise.resolve(success(TEMPLATE));
    });
    const created = await client.templates.create({
      name: "my-template",
      dockerfile: "FROM scratch",
    });
    expect(pathname).toBe("/v1/templates");
    expect(body).toEqual({ name: "my-template", dockerfile: "FROM scratch" });
    expect(created.id).toBe("tpl_1");
  });

  test("get forwards the include query parameter", async () => {
    let url = "";
    const client = makeClient((u) => {
      url = String(u);
      return Promise.resolve(success(TEMPLATE));
    });
    await client.templates.get("tpl_1", { include: "dockerfile" });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v1/templates/tpl_1");
    expect(parsed.searchParams.get("include")).toBe("dockerfile");
  });

  test("delete issues a DELETE to the template path", async () => {
    let method = "";
    let pathname = "";
    const client = makeClient((url, init) => {
      method = init.method ?? "";
      pathname = new URL(String(url)).pathname;
      return Promise.resolve(success({ ok: true }));
    });
    await client.templates.delete("tpl_1");
    expect(method).toBe("DELETE");
    expect(pathname).toBe("/v1/templates/tpl_1");
  });

  test("logs returns the build log as plain text and forwards attempt", async () => {
    let url = "";
    const client = makeClient((u) => {
      url = String(u);
      return Promise.resolve(new Response("step 1\nstep 2\n", { status: 200 }));
    });
    const text = await client.templates.logs("tpl_1", { attempt: 2 });
    expect(text).toBe("step 1\nstep 2\n");
    expect(new URL(url).searchParams.get("attempt")).toBe("2");
  });

  test("logs surfaces a 404 as a typed error with the correct method and endpoint", async () => {
    const client = makeClient(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ status: "fail", data: {} }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        ),
      { retry: false },
    );
    const err = await catchErr(() => client.templates.logs("tpl_1"));
    expect(err).toBeInstanceOf(CreateosSandboxNotFoundError);
    expect(err.method).toBe("GET");
    expect(err.endpoint).toBe("/v1/templates/tpl_1/logs");
  });

  test("followLogs streams NDJSON log events", async () => {
    let url = "";
    const client = makeClient((u) => {
      url = String(u);
      return Promise.resolve(
        ndjsonResponse(streamOf('{"line":"step 1\\n"}\n{"line":"done\\n"}\n')),
      );
    });
    const lines: string[] = [];
    for await (const event of client.templates.followLogs("tpl_1")) {
      if (event.line) lines.push(event.line);
    }
    expect(lines).toEqual(["step 1\n", "done\n"]);
    expect(new URL(url).searchParams.get("follow")).toBe("true");
  });
});
