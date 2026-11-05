import { describe, expect, test } from "bun:test";
import { makeClient, RUNNING_VIEW, success } from "./helpers.ts";

const CHECKPOINT = {
  id: "cp_first/segment",
  path: "/root/project",
  name: "before-update",
  created_at: "2026-11-05T00:00:00Z",
};

describe("checkpoints", () => {
  test("creates, lists, restores, and deletes with encoded ids", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const client = makeClient((url, init) => {
      const parsed = new URL(String(url));
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push([init.method ?? "", parsed.pathname, body]);
      if (parsed.pathname.endsWith("/restore")) {
        return Promise.resolve(success({ checkpoint_id: CHECKPOINT.id, path: CHECKPOINT.path }));
      }
      if (init.method === "DELETE") return Promise.resolve(success({}));
      if (init.method === "GET" && parsed.pathname.endsWith("/checkpoints")) {
        return Promise.resolve(success([CHECKPOINT]));
      }
      if (init.method === "POST" && parsed.pathname.endsWith("/checkpoints")) {
        return Promise.resolve(success(CHECKPOINT));
      }
      return Promise.resolve(success(RUNNING_VIEW));
    });

    const sandbox = await client.getSandbox("sb_1");
    const checkpoint = await sandbox.checkpoints.create({
      path: "/root/project",
      name: "before-update",
    });
    expect(await sandbox.checkpoints.list()).toEqual([CHECKPOINT]);
    expect((await sandbox.checkpoints.restore(checkpoint.id)).path).toBe("/root/project");
    await sandbox.checkpoints.delete(checkpoint.id);

    expect(calls).toContainEqual([
      "POST",
      "/v1/sandboxes/sb_1/checkpoints",
      { path: "/root/project", name: "before-update" },
    ]);
    expect(calls).toContainEqual([
      "POST",
      "/v1/sandboxes/sb_1/checkpoints/cp_first%2Fsegment/restore",
      undefined,
    ]);
    expect(calls).toContainEqual([
      "DELETE",
      "/v1/sandboxes/sb_1/checkpoints/cp_first%2Fsegment",
      undefined,
    ]);
  });
});
