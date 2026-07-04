import { describe, expect, test } from "bun:test";
import { CreateosSandboxServerError, Sandbox } from "../src/index.ts";
import { catchErr, CREATE_RESPONSE, makeClient, RUNNING_VIEW, success } from "./helpers.ts";

const WHOAMI = {
  user_id: "u_1",
  stats: { running: 1, paused: 0, other: 0, total: 1 },
};

describe("createSandbox", () => {
  test("returns a Sandbox handle and waits until running", async () => {
    const client = makeClient((_url, init) =>
      Promise.resolve(init.method === "POST" ? success(CREATE_RESPONSE) : success(RUNNING_VIEW)),
    );
    const sandbox = await client.createSandbox({ shape: "s-1vcpu-256mb" });
    expect(sandbox).toBeInstanceOf(Sandbox);
    expect(sandbox.id).toBe("sb_1");
    expect(sandbox.status).toBe("running");
    expect(sandbox.ip).toBe("10.0.0.2");
  });

  test("issues a single POST and seeds `running` without a follow-up GET or poll", async () => {
    const calls: string[] = [];
    const client = makeClient((_url, init) => {
      calls.push(init.method ?? "");
      return Promise.resolve(success(CREATE_RESPONSE));
    });
    const sandbox = await client.createSandbox({ shape: "s" });
    // A 200 from POST /v1/sandboxes already means the VM is up and its agent
    // answered a probe, so the handle is seeded `running` from that response.
    expect(sandbox.status).toBe("running");
    expect(calls).toEqual(["POST"]);
  });

  test("forwards a disks array in the create body", async () => {
    let body: Record<string, unknown> | undefined;
    const client = makeClient((url, init) => {
      if (init.method === "POST" && new URL(String(url)).pathname === "/v1/sandboxes") {
        body = JSON.parse(String(init.body));
        return Promise.resolve(success(CREATE_RESPONSE));
      }
      return Promise.resolve(success(RUNNING_VIEW));
    });
    await client.createSandbox({
      shape: "s",
      disks: [{ disk_id: "data", mount_path: "/mnt/data" }],
    });
    expect(body?.disks).toEqual([{ disk_id: "data", mount_path: "/mnt/data" }]);
  });
});

describe("connecting to existing sandboxes", () => {
  test("getSandbox returns a handle for the fetched view", async () => {
    const client = makeClient(() => Promise.resolve(success(RUNNING_VIEW)));
    const sandbox = await client.getSandbox("sb_1");
    expect(sandbox).toBeInstanceOf(Sandbox);
    expect(sandbox.id).toBe("sb_1");
  });

  test("getSandboxByIP hits the by-ip route", async () => {
    let pathname = "";
    const client = makeClient((url) => {
      pathname = new URL(String(url)).pathname;
      return Promise.resolve(success({ ...RUNNING_VIEW, id: "sb_byip" }));
    });
    const sandbox = await client.getSandboxByIP("10.0.0.42");
    expect(pathname).toBe("/v1/sandboxes/by-ip/10.0.0.42");
    expect(sandbox.id).toBe("sb_byip");
  });

  test("listSandboxes maps views to handles and forwards limit/status filters", async () => {
    let url = "";
    const client = makeClient((u) => {
      url = String(u);
      return Promise.resolve(success([RUNNING_VIEW, { ...RUNNING_VIEW, id: "sb_2" }]));
    });
    const sandboxes = await client.listSandboxes({ status: "running", limit: 50 });
    expect(sandboxes).toHaveLength(2);
    expect(sandboxes.every((s) => s instanceof Sandbox)).toBe(true);
    expect(sandboxes[1]?.id).toBe("sb_2");
    const params = new URL(url).searchParams;
    expect(params.get("status")).toBe("running");
    expect(params.get("limit")).toBe("50");
  });
});

describe("health and identity", () => {
  test("healthz resolves and is sent without credentials", async () => {
    let hadKey = true;
    const client = makeClient((_url, init) => {
      hadKey = (init.headers as Headers).has("x-api-key");
      return Promise.resolve(success({ up: true }));
    });
    await client.healthz();
    expect(hadKey).toBe(false);
  });

  test("readyz returns the envelope data when the body is a JSend success", async () => {
    const client = makeClient(() => Promise.resolve(success({ ready: true })));
    const r = await client.readyz();
    expect(r.ready).toBe(true);
  });

  test("readyz returns { ready: false } on a 503 with no JSend body", async () => {
    const client = makeClient(() => Promise.resolve(new Response("unavailable", { status: 503 })));
    const r = await client.readyz();
    expect(r.ready).toBe(false);
  });

  test("readyz returns { ready: true } on a 200 with a non-JSON body", async () => {
    const client = makeClient(() => Promise.resolve(new Response("OK", { status: 200 })));
    const r = await client.readyz();
    expect(r.ready).toBe(true);
  });

  test("readyz throws on a non-503 error status instead of reporting not-ready", async () => {
    const client = makeClient(() =>
      Promise.resolve(new Response("internal error", { status: 500 })),
    );
    const err = await catchErr(() => client.readyz());
    expect(err).toBeInstanceOf(CreateosSandboxServerError);
  });

  test("whoami returns the caller identity", async () => {
    const client = makeClient(() => Promise.resolve(success(WHOAMI)));
    const me = await client.whoami();
    expect(me.user_id).toBe("u_1");
    expect(me.stats.total).toBe(1);
  });
});

describe("catalog", () => {
  test("listShapes unwraps to a shapes array", async () => {
    const client = makeClient(() =>
      Promise.resolve(
        success({
          shapes: [{ id: "s-1vcpu-256mb", vcpu: 1, mem_mib: 256, default_disk_mib: 10240 }],
        }),
      ),
    );
    const shapes = await client.listShapes();
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.id).toBe("s-1vcpu-256mb");
  });

  test("listRootfs unwraps to a rootfs array", async () => {
    const client = makeClient(() =>
      Promise.resolve(success({ rootfs: ["devbox:1"], default: "devbox:1" })),
    );
    const data = await client.listRootfs();
    expect(data.rootfs).toContain("devbox:1");
    expect(data.default).toBe("devbox:1");
  });

  test("listShapes and listRootfs are sent without credentials (server-open paths)", async () => {
    const captured: Array<{ path: string; hadKey: boolean }> = [];
    const client = makeClient(
      (url, init) => {
        captured.push({
          path: new URL(String(url)).pathname,
          hadKey: (init.headers as Headers).has("x-api-key"),
        });
        return new URL(String(url)).pathname.endsWith("/shapes")
          ? Promise.resolve(success({ shapes: [] }))
          : Promise.resolve(success({ rootfs: [], default: "" }));
      },
      { apiKey: "sk_test" },
    );
    await client.listShapes();
    await client.listRootfs();
    expect(captured).toHaveLength(2);
    for (const entry of captured) expect(entry.hadKey).toBe(false);
  });

  test("listHosts returns the host list", async () => {
    const client = makeClient(() =>
      Promise.resolve(
        success([
          { id: "h1", status: "active", free_mib: 1024, vm_count: 2, rootfses: ["devbox:1"] },
        ]),
      ),
    );
    const hosts = await client.listHosts();
    expect(hosts[0]?.id).toBe("h1");
    expect(hosts[0]?.status).toBe("active");
  });
});

describe("paginated list endpoints", () => {
  test("unwraps the doubly-nested paginated envelope ({ data: { data, pagination } })", async () => {
    const client = makeClient(() =>
      Promise.resolve(
        success({
          data: [{ id: "s-1vcpu-256mb", vcpu: 1, mem_mib: 256, default_disk_mib: 10240 }],
          pagination: { total: 1, limit: 500, offset: 0, count: 1 },
        }),
      ),
    );
    const shapes = await client.listShapes();
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.id).toBe("s-1vcpu-256mb");
  });

  test("walks every page until the reported total is reached", async () => {
    const offsets: number[] = [];
    const client = makeClient((url) => {
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      offsets.push(offset);
      // total=3 but the server hands back fewer rows than requested, so the
      // loop must advance by the actual item count, not the requested limit.
      const page =
        offset === 0
          ? [RUNNING_VIEW, { ...RUNNING_VIEW, id: "sb_2" }]
          : [{ ...RUNNING_VIEW, id: "sb_3" }];
      return Promise.resolve(
        success({ data: page, pagination: { total: 3, limit: 500, offset, count: page.length } }),
      );
    });
    const sandboxes = await client.listSandboxes();
    expect(sandboxes.map((s) => s.id)).toEqual(["sb_1", "sb_2", "sb_3"]);
    expect(offsets).toEqual([0, 2]);
  });

  test("limit caps the number of handles and stops paging early", async () => {
    let calls = 0;
    const client = makeClient((url) => {
      calls += 1;
      const limit = Number(new URL(String(url)).searchParams.get("limit"));
      expect(limit).toBe(1);
      return Promise.resolve(
        success({
          data: [{ ...RUNNING_VIEW, id: `sb_${calls}` }],
          pagination: { total: 99, limit: 1, offset: calls - 1, count: 1 },
        }),
      );
    });
    const sandboxes = await client.listSandboxes({ limit: 1 });
    expect(sandboxes).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
