// Polling primitives for the waitUntil* lifecycle helpers.

import { FcError, FcTimeoutError } from "./errors.js";

/** Resolves after `ms`, or early if `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        cleanup();
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
  });
}

export interface PollOptions<T> {
  /** Fetches the current state. */
  poll: () => Promise<T>;
  /** Returns true once the desired state is reached. */
  done: (value: T) => boolean;
  /** Returns an error message when the state is a terminal failure. */
  failed?: ((value: T) => string | undefined) | undefined;
  /** Overall budget in ms. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/**
 * Polls `poll()` with adaptive backoff until `done()` is satisfied. The
 * interval is tight at first (250ms) and ramps after 5s, capped at 2s —
 * fast lifecycle transitions resolve quickly without hammering the API.
 */
export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const start = Date.now();
  let interval = 250;

  for (;;) {
    if (options.signal?.aborted) {
      throw new FcError("Wait aborted.");
    }

    const value = await options.poll();
    if (options.done(value)) {
      return value;
    }

    const failure = options.failed?.(value);
    if (failure !== undefined) {
      throw new FcError(failure);
    }

    if (Date.now() >= deadline) {
      throw new FcTimeoutError(
        `Timed out after ${options.timeoutMs}ms waiting for the expected state.`,
      );
    }

    if (Date.now() - start > 5_000) {
      interval = Math.min(interval * 1.25, 2_000);
    }
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
  }
}
