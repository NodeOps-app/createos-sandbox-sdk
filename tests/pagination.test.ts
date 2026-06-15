import { describe, expect, test } from "bun:test";
import { makeClient, RUNNING_VIEW, success } from "./helpers.ts";

/** A paginated-envelope page: `{ data: [...], pagination: { total, ... } }`. */
function page(items: unknown[], total: number, offset: number): Response {
  return success({ data: items, pagination: { total, limit: 500, offset, count: items.length } });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const view = (id: string): typeof RUNNING_VIEW => ({ ...RUNNING_VIEW, id });

describe("CreateosSandboxClient.iterateSandboxes", () => {
  test("walks pages lazily until the server total is reached", async () => {
    const client = makeClient((u) => {
      const offset = Number(new URL(String(u)).searchParams.get("offset") ?? "0");
      return Promise.resolve(
        offset === 0 ? page([view("sb_1"), view("sb_2")], 3, 0) : page([view("sb_3")], 3, 2),
      );
    });
    const ids = (await collect(client.iterateSandboxes())).map((s) => s.id);
    expect(ids).toEqual(["sb_1", "sb_2", "sb_3"]);
  });

  test("limit caps the number of handles yielded", async () => {
    const client = makeClient(() =>
      Promise.resolve(page([view("sb_1"), view("sb_2"), view("sb_3")], 3, 0)),
    );
    const ids = (await collect(client.iterateSandboxes({ limit: 2 }))).map((s) => s.id);
    expect(ids).toEqual(["sb_1", "sb_2"]);
  });
});

describe("list iterators stream every paginated endpoint", () => {
  test("templates / networks / disks / hosts / sandbox.iterateDisks each yield items", async () => {
    const client = makeClient((u) => {
      const path = new URL(String(u)).pathname;
      if (path === "/v1/sandboxes/sb_1") return Promise.resolve(success(RUNNING_VIEW));
      return Promise.resolve(page([{ id: "x" }], 1, 0));
    });

    expect(await collect(client.templates.iterate())).toHaveLength(1);
    expect(await collect(client.networks.iterate())).toHaveLength(1);
    expect(await collect(client.disks.iterate())).toHaveLength(1);
    expect(await collect(client.iterateHosts())).toHaveLength(1);

    const sandbox = await client.getSandbox("sb_1");
    expect(await collect(sandbox.iterateDisks())).toHaveLength(1);
  });
});
