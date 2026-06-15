import { describe, expect, it } from "vitest";
import type { Shape } from "createos-sandbox-sdk";
import {
  buildScript,
  createosSandbox,
  defaultShape,
  mapStatus,
  parseLsOutput,
  pickShape,
} from "../index.js";

// Deliberately unsorted, to prove selection sorts the live catalog rather than
// trusting server order (listShapes() makes no ordering guarantee).
const SHAPES: Shape[] = [
  { id: "s-4vcpu-4gb", vcpu: 4, mem_mib: 4096, default_disk_mib: 10240 },
  { id: "s-1vcpu-256mb", vcpu: 1, mem_mib: 256, default_disk_mib: 10240 },
  { id: "s-2vcpu-2gb", vcpu: 2, mem_mib: 2048, default_disk_mib: 10240 },
  { id: "s-1vcpu-1gb", vcpu: 1, mem_mib: 1024, default_disk_mib: 10240 },
];

describe("pickShape", () => {
  it("returns undefined when neither cpus nor memoryMb given", () => {
    expect(pickShape(SHAPES)).toBeUndefined();
  });
  it("picks the smallest shape that fits the memory", () => {
    expect(pickShape(SHAPES, 200)).toBe("s-1vcpu-256mb");
    expect(pickShape(SHAPES, 1024)).toBe("s-1vcpu-1gb");
    expect(pickShape(SHAPES, 1500)).toBe("s-2vcpu-2gb");
  });
  it("honours the cpu floor", () => {
    expect(pickShape(SHAPES, 256, 2)).toBe("s-2vcpu-2gb");
  });
  it("clamps oversized requests to the largest shape", () => {
    expect(pickShape(SHAPES, 64_000)).toBe("s-4vcpu-4gb");
  });
});

describe("defaultShape", () => {
  it("picks the smallest live shape meeting the RAM floor", () => {
    expect(defaultShape(SHAPES)).toBe("s-1vcpu-1gb");
  });
  it("falls back to the smallest shape when none meet the floor", () => {
    expect(defaultShape([{ id: "s-tiny", vcpu: 1, mem_mib: 256, default_disk_mib: 10240 }])).toBe(
      "s-tiny",
    );
  });
  it("returns undefined for an empty catalog", () => {
    expect(defaultShape([])).toBeUndefined();
  });
});

describe("mapStatus", () => {
  it("maps running to running", () => {
    expect(mapStatus("running")).toBe("running");
  });
  it("maps error/failed to error", () => {
    expect(mapStatus("error")).toBe("error");
    expect(mapStatus("failed")).toBe("error");
  });
  it("maps transitional/paused states to stopped", () => {
    expect(mapStatus("paused")).toBe("stopped");
    expect(mapStatus("creating")).toBe("stopped");
    expect(mapStatus("resuming")).toBe("stopped");
  });
});

describe("buildScript", () => {
  it("returns the command unchanged with no options", () => {
    expect(buildScript("echo hi")).toBe("echo hi");
  });
  it("prepends a cd for cwd", () => {
    expect(buildScript("ls", { cwd: "/app" })).toBe("cd /app && ls");
  });
  it("exports per-command env (synthesised, since the server drops exec env)", () => {
    expect(buildScript("node x.js", { env: { FOO: "bar" } })).toBe("export FOO=bar; node x.js");
  });
  it("wraps background commands in nohup", () => {
    expect(buildScript("server", { background: true })).toContain("nohup sh -c");
  });
});

describe("parseLsOutput", () => {
  it("parses files and directories with size + mtime", () => {
    const out = [
      "total 12",
      "drwxr-xr-x 2 root root 4096 1700000000 data",
      "-rw-r--r-- 1 root root  245 1700000001 config.json",
      "lrwxrwxrwx 1 root root    7 1700000002 link -> /target",
    ].join("\n");
    const entries = parseLsOutput(out);
    expect(entries).toEqual([
      { name: "data", type: "directory", size: 4096, modified: new Date(1700000000 * 1000) },
      { name: "config.json", type: "file", size: 245, modified: new Date(1700000001 * 1000) },
      { name: "link", type: "file", size: 7, modified: new Date(1700000002 * 1000) },
    ]);
  });
  it("returns an empty array for an empty directory", () => {
    expect(parseLsOutput("total 0\n")).toEqual([]);
  });
});

describe("createosSandbox provider", () => {
  it("builds a provider exposing sandbox, snapshot and template managers", () => {
    const provider = createosSandbox({ apiKey: "test-key" });
    expect(provider.name).toBe("createos-sandbox");
    expect(provider.sandbox).toBeDefined();
    expect(provider.snapshot).toBeDefined();
    expect(provider.template).toBeDefined();
  });
});
