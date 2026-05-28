import { describe, expect, test } from "bun:test";
import { makeClient, success } from "./helpers.ts";

const NETWORK: Record<string, unknown> = {
  id: "net_1",
  name: "team-net",
  created_at: "2024-01-01T00:00:00Z",
  member_count: 0,
};

describe("NetworksApi", () => {
  test("list returns the network array", async () => {
    let pathname = "";
    const client = makeClient((url) => {
      pathname = new URL(String(url)).pathname;
      return Promise.resolve(success([NETWORK]));
    });
    const networks = await client.networks.list();
    expect(pathname).toBe("/v1/networks");
    expect(networks[0]?.id).toBe("net_1");
  });

  test("create posts { name } and returns the network", async () => {
    let body: Record<string, unknown> | undefined;
    const client = makeClient((_url, init) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve(success(NETWORK));
    });
    const created = await client.networks.create({ name: "team-net" });
    expect(body).toEqual({ name: "team-net" });
    expect(created.name).toBe("team-net");
  });

  test("get reads the network by id", async () => {
    let pathname = "";
    const client = makeClient((url) => {
      pathname = new URL(String(url)).pathname;
      return Promise.resolve(success(NETWORK));
    });
    const network = await client.networks.get("net_1");
    expect(pathname).toBe("/v1/networks/net_1");
    expect(network.id).toBe("net_1");
  });

  test("delete issues a DELETE to the network path", async () => {
    let method = "";
    let pathname = "";
    const client = makeClient((url, init) => {
      method = init.method ?? "";
      pathname = new URL(String(url)).pathname;
      return Promise.resolve(success({ ok: true }));
    });
    await client.networks.delete("net_1");
    expect(method).toBe("DELETE");
    expect(pathname).toBe("/v1/networks/net_1");
  });
});
