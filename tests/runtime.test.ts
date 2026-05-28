import { describe, expect, test } from "bun:test";
import { detectRuntime, runtimeTag } from "../src/index.ts";

const KNOWN = [
  "node",
  "bun",
  "deno",
  "workerd",
  "edge-light",
  "browser",
  "react-native",
  "unknown",
];

describe("runtime detection", () => {
  test("detectRuntime returns one of the known runtimes", () => {
    expect(KNOWN).toContain(detectRuntime());
  });

  test("runtimeTag is non-empty and shaped as <runtime> or <runtime>-<version>", () => {
    const tag = runtimeTag();
    expect(tag.length).toBeGreaterThan(0);
    expect(KNOWN.some((r) => tag === r || tag.startsWith(`${r}-`))).toBe(true);
  });
});
