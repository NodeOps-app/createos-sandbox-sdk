import { describe, expect, test } from "bun:test";
import { makeClient, RUNNING_VIEW, success } from "./helpers.ts";

const SNAPSHOT = {
  id: "snap_1",
  sandbox_id: "sb_1",
  name: "checkpoint",
  type: "full" as const,
  status: "ready" as const,
  created_at: "2026-11-03T00:00:00Z",
  shape: "s-1vcpu-1gb",
  vcpu: 1,
  mem_mib: 1024,
  disk_mib: 10240,
  size_bytes: 2048,
};

describe("reusable snapshots", () => {
  test("creates, gets, lists, deletes, and restores snapshots", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const client = makeClient((url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push([init.method ?? "", path, body]);
      if (path === "/v1/sandboxes/sb_1/snapshots") {
        return Promise.resolve(success({ ...SNAPSHOT, status: "creating" }, { status: 202 }));
      }
      if (path === "/v1/snapshots") {
        return Promise.resolve(success({ data: [SNAPSHOT], pagination: { total: 1 } }));
      }
      if (path === "/v1/snapshots/snap_1" && init.method === "DELETE") {
        return Promise.resolve(success({ id: "snap_1", status: "deleting" }, { status: 202 }));
      }
      if (path === "/v1/snapshots/snap_1") return Promise.resolve(success(SNAPSHOT));
      if (path === "/v1/sandboxes" && init.method === "POST") {
        return Promise.resolve(
          success({
            ...RUNNING_VIEW,
            snapshot_id: "snap_1",
            name: "restored",
            shape: "s-1vcpu-1gb",
            rootfs: "alpine:3.20",
            spawn_ms: 1,
            egress: [],
            bandwidth_quota_bytes: 0,
          }),
        );
      }
      return Promise.resolve(success(RUNNING_VIEW));
    });

    const source = await client.getSandbox("sb_1");
    expect((await source.createSnapshot({ type: "full", name: "checkpoint" })).status).toBe(
      "creating",
    );
    expect((await client.snapshots.get("snap_1")).status).toBe("ready");
    expect(await client.snapshots.list()).toHaveLength(1);
    expect((await client.createSandbox({ snapshot_id: "snap_1" })).data.snapshot_id).toBe("snap_1");
    expect((await client.snapshots.delete("snap_1")).status).toBe("deleting");
    expect(calls).toContainEqual([
      "POST",
      "/v1/sandboxes/sb_1/snapshots",
      { type: "full", name: "checkpoint" },
    ]);
    expect(calls).toContainEqual(["POST", "/v1/sandboxes", { snapshot_id: "snap_1" }]);
  });
});
