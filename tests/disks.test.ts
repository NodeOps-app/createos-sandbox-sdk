import { describe, expect, test } from "bun:test";
import { FcServerError } from "../src/index.ts";
import { catchErr, errorEnvelope, makeClient, RUNNING_VIEW, success } from "./helpers.ts";

const DISK_VIEW: Record<string, unknown> = {
  id: "disk_01HFOO",
  name: "data",
  kind: "s3",
  config: { bucket: "b", endpoint: "https://s3.example" },
};

const S3_REQUEST = {
  name: "data",
  kind: "s3" as const,
  config: { bucket: "b", endpoint: "https://s3.example" },
  credentials: { access_key: "a", secret_key: "s" },
};

describe("DisksApi", () => {
  test("list unwraps to a disks array", async () => {
    let pathname = "";
    const client = makeClient((url) => {
      pathname = new URL(String(url)).pathname;
      return Promise.resolve(success({ disks: [DISK_VIEW] }));
    });
    const disks = await client.disks.list();
    expect(pathname).toBe("/v1/disks");
    expect(disks[0]?.name).toBe("data");
  });

  test("create posts the registration payload", async () => {
    let body: Record<string, unknown> | undefined;
    let pathname = "";
    const client = makeClient((url, init) => {
      pathname = new URL(String(url)).pathname;
      body = JSON.parse(String(init.body));
      return Promise.resolve(success(DISK_VIEW));
    });
    const created = await client.disks.create(S3_REQUEST);
    expect(pathname).toBe("/v1/disks");
    expect(body?.name).toBe("data");
    expect(created.id).toBe("disk_01HFOO");
  });

  test("get and delete address the disk by id or name", async () => {
    const calls: Array<[string, string]> = [];
    const client = makeClient((url, init) => {
      calls.push([init.method ?? "", new URL(String(url)).pathname]);
      return Promise.resolve(
        init.method === "GET" ? success(DISK_VIEW) : success({ deleted: true }),
      );
    });
    const got = await client.disks.get("data");
    expect(got.name).toBe("data");
    const del = await client.disks.delete("disk_01HFOO");
    expect(del.deleted).toBe(true);
    expect(calls).toEqual([
      ["GET", "/v1/disks/data"],
      ["DELETE", "/v1/disks/disk_01HFOO"],
    ]);
  });

  test("create surfaces a 503 'disks API not configured' as FcServerError", async () => {
    const client = makeClient(
      () => Promise.resolve(errorEnvelope("disks API not configured", 0, 503)),
      {
        retry: false,
      },
    );
    const err = await catchErr(() => client.disks.create(S3_REQUEST));
    expect(err).toBeInstanceOf(FcServerError);
    expect(err.statusCode).toBe(503);
  });
});

describe("Sandbox disk attachment", () => {
  test("attachDisk posts disk_id, mount_path and sub_path", async () => {
    let body: Record<string, unknown> | undefined;
    const client = makeClient((url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (init.method === "POST" && pathname.endsWith("/disks")) {
        body = JSON.parse(String(init.body));
        return Promise.resolve(success({ ok: true }));
      }
      return Promise.resolve(success(RUNNING_VIEW));
    });
    const sandbox = await client.getSandbox("sb_1");
    await sandbox.attachDisk({ diskId: "disk_01HFOO", mountPath: "/mnt/data", subPath: "sub" });
    expect(body).toEqual({ disk_id: "disk_01HFOO", mount_path: "/mnt/data", sub_path: "sub" });
  });

  test("attachDisk omits sub_path when it is not provided", async () => {
    let body: Record<string, unknown> = {};
    const client = makeClient((url, init) => {
      if (init.method === "POST" && new URL(String(url)).pathname.endsWith("/disks")) {
        body = JSON.parse(String(init.body));
        return Promise.resolve(success({ ok: true }));
      }
      return Promise.resolve(success(RUNNING_VIEW));
    });
    const sandbox = await client.getSandbox("sb_1");
    await sandbox.attachDisk({ diskId: "disk_01HFOO", mountPath: "/mnt/data" });
    expect(body).toEqual({ disk_id: "disk_01HFOO", mount_path: "/mnt/data" });
    expect("sub_path" in body).toBe(false);
  });

  test("detachDisk deletes the disk path with a mount_path query param", async () => {
    let captured: URL | undefined;
    const client = makeClient((url, init) => {
      if (init.method === "DELETE") {
        captured = new URL(String(url));
        return Promise.resolve(success({ detached: true }));
      }
      return Promise.resolve(success(RUNNING_VIEW));
    });
    const sandbox = await client.getSandbox("sb_1");
    const out = await sandbox.detachDisk({ diskId: "disk_01HFOO", mountPath: "/mnt/data" });
    expect(out.detached).toBe(true);
    expect(captured?.pathname).toBe("/v1/sandboxes/sb_1/disks/disk_01HFOO");
    expect(captured?.searchParams.get("mount_path")).toBe("/mnt/data");
  });

  test("listDisks returns mount status", async () => {
    const attachment = {
      disk_id: "disk_01HFOO",
      name: "data",
      kind: "s3",
      config: { bucket: "b", endpoint: "https://s3.example" },
      mount_path: "/mnt/data",
      mount_status: "mounted",
    };
    const client = makeClient((url, init) => {
      if (init.method === "GET" && new URL(String(url)).pathname.endsWith("/disks")) {
        return Promise.resolve(success({ disks: [attachment] }));
      }
      return Promise.resolve(success(RUNNING_VIEW));
    });
    const sandbox = await client.getSandbox("sb_1");
    const out = await sandbox.listDisks();
    expect(out).toHaveLength(1);
    expect(out[0]?.mount_status).toBe("mounted");
    expect(out[0]?.mount_path).toBe("/mnt/data");
  });
});
