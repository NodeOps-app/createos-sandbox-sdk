import { describe, expect, test } from "bun:test";
import { CreateosSandboxError, CreateosSandboxTimeoutError } from "../src/index.ts";
import { pollUntil, sleep } from "../src/poll.ts";
import { catchErr } from "./helpers.ts";

describe("sleep", () => {
  test("resolves immediately for non-positive durations", async () => {
    await sleep(0);
    await sleep(-5);
  });

  test("resolves early when the signal is already aborted (never rejects)", async () => {
    const controller = new AbortController();
    controller.abort();
    await sleep(10_000, controller.signal);
  });

  test("resolves early when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const waited = sleep(10_000, controller.signal);
    controller.abort();
    await waited;
  });
});

describe("pollUntil", () => {
  test("returns the value as soon as done() is satisfied", async () => {
    let calls = 0;
    const value = await pollUntil<number>({
      poll: () => Promise.resolve(++calls),
      done: (n) => n >= 3,
      timeoutMs: 1000,
    });
    expect(value).toBe(3);
    expect(calls).toBe(3);
  });

  test("throws CreateosSandboxError with the failure message when failed() returns a string", async () => {
    const err = await catchErr(() =>
      pollUntil<string>({
        poll: () => Promise.resolve("error"),
        done: (s) => s === "running",
        failed: (s) => (s === "error" ? "entered error state" : undefined),
        timeoutMs: 1000,
      }),
    );
    expect(err).toBeInstanceOf(CreateosSandboxError);
    expect(err.message).toBe("entered error state");
  });

  test("throws CreateosSandboxTimeoutError once the budget elapses", async () => {
    const err = await catchErr(() =>
      pollUntil<string>({
        poll: () => Promise.resolve("creating"),
        done: (s) => s === "running",
        timeoutMs: 0,
      }),
    );
    expect(err).toBeInstanceOf(CreateosSandboxTimeoutError);
  });

  test("throws CreateosSandboxError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await catchErr(() =>
      pollUntil<string>({
        poll: () => Promise.resolve("creating"),
        done: () => false,
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    );
    expect(err).toBeInstanceOf(CreateosSandboxError);
    expect(err.message).toBe("Wait aborted.");
  });
});
