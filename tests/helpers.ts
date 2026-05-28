// Shared fixtures and helpers for the bun:test suite.
//
// Tests exercise the SDK source directly (`../src/*.ts`) with `fetch` mocked
// via the client `fetch` option — there is no live control plane. Keep the
// fixtures here in sync with the wire types in `src/types.ts`.

import { FcClient } from "../src/index.ts";
import type { CreateSandboxResponse, FcClientOptions, SandboxView } from "../src/types.ts";

/** Stand-in control-plane origin. Never actually contacted. */
export const BASE = "https://example.test";

/** A minimal `running` SandboxView, the most common GET fixture. */
export const RUNNING_VIEW: SandboxView = {
  id: "sb_1",
  status: "running",
  ip: "10.0.0.2",
  vcpu: 1,
  mem_mib: 256,
  disk_mib: 10240,
  created_at: "2024-01-01T00:00:00Z",
  ingress_enabled: false,
};

/** The CreateSandboxResponse returned by `POST /v1/sandboxes`. */
export const CREATE_RESPONSE: CreateSandboxResponse = {
  id: "sb_1",
  name: "brave-otter",
  ip: "10.0.0.2",
  mode: "snapshot",
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
  vcpu: 1,
  mem_mib: 256,
  disk_mib: 10240,
  spawn_ms: 42,
  egress: [],
  bandwidth_quota_bytes: 0,
};

/** A fast retry policy so retry tests do not sleep for real. */
export const FAST_RETRY = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** JSend success envelope. */
export function success(
  data: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return jsonResponse({ status: "success", data }, init);
}

/** JSend fail envelope (4xx). */
export function fail(data: unknown, status: number): Response {
  return jsonResponse({ status: "fail", data }, { status });
}

/** JSend error envelope (5xx or coded failures). */
export function errorEnvelope(message: string, code: number, status: number): Response {
  return jsonResponse({ status: "error", message, code }, { status });
}

/** Builds a client with the standard test defaults; `extra` overrides them. */
export function makeClient(fetchImpl: FetchImpl, extra: FcClientOptions = {}): FcClient {
  return new FcClient({ apiKey: "sk", baseUrl: BASE, fetch: fetchImpl as typeof fetch, ...extra });
}

/**
 * Invokes `fn` and returns the error it throws. Throws if `fn` resolves —
 * use when a test needs to assert on the thrown error's properties.
 */
export async function catchErr(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** Builds a ReadableStream from string chunks, for NDJSON / stream tests. */
export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** An `application/x-ndjson` Response wrapping `stream`. */
export function ndjsonResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
