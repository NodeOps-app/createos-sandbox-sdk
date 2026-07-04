import { describe, expect, test } from "bun:test";
import { createClient, CreateosSandboxClient, Sandbox } from "../src/index.ts";
import { BASE, CREATE_RESPONSE, RUNNING_VIEW, success } from "./helpers.ts";

const fetchView = ((_url: string, init: RequestInit) =>
  Promise.resolve(
    init.method === "POST" ? success(CREATE_RESPONSE) : success(RUNNING_VIEW),
  )) as unknown as typeof fetch;

describe("createClient", () => {
  test("returns a configured CreateosSandboxClient", () => {
    const client = createClient({ apiKey: "sk", baseUrl: BASE, fetch: fetchView });
    expect(client).toBeInstanceOf(CreateosSandboxClient);
    expect(client.baseUrl).toBe(BASE);
  });
});

describe("Sandbox static factories", () => {
  test("Sandbox.connect resolves a handle without an explicit client", async () => {
    const sandbox = await Sandbox.connect("sb_1", {
      apiKey: "sk",
      baseUrl: BASE,
      fetch: fetchView,
    });
    expect(sandbox).toBeInstanceOf(Sandbox);
    expect(sandbox.id).toBe("sb_1");
  });

  test("Sandbox.create provisions and waits without an explicit client", async () => {
    const sandbox = await Sandbox.create(
      { shape: "s-1vcpu-256mb" },
      { apiKey: "sk", baseUrl: BASE, fetch: fetchView },
    );
    expect(sandbox).toBeInstanceOf(Sandbox);
    expect(sandbox.status).toBe("running");
  });

  test("Sandbox.create issues a single POST and seeds `running`", async () => {
    const calls: string[] = [];
    const fetchCreate = ((_url: string, init: RequestInit) => {
      calls.push(init.method ?? "");
      return Promise.resolve(success(CREATE_RESPONSE));
    }) as unknown as typeof fetch;
    const sandbox = await Sandbox.create(
      { shape: "s" },
      { apiKey: "sk", baseUrl: BASE, fetch: fetchCreate },
    );
    expect(sandbox.status).toBe("running");
    expect(calls).toEqual(["POST"]);
  });
});
