// Runtime detection for the User-Agent and X-Fc-Runtime headers.
//
// Every guard is a typeof check that cannot throw — the SDK ships to
// node, bun, deno, workerd, edge-light, browsers and react-native, and
// any of these globals can legitimately be undefined.

export type Runtime =
  | "node"
  | "bun"
  | "deno"
  | "workerd"
  | "edge-light"
  | "browser"
  | "react-native"
  | "unknown";

interface BunGlobal {
  version?: string;
}

interface DenoGlobal {
  version?: { deno?: string };
}

interface ProcessGlobal {
  versions?: { node?: string };
  env?: Record<string, string | undefined>;
}

interface NavigatorGlobal {
  product?: string;
}

type RuntimeGlobals = {
  Bun?: BunGlobal;
  Deno?: DenoGlobal;
  process?: ProcessGlobal;
  navigator?: NavigatorGlobal;
  window?: unknown;
  document?: unknown;
  WebSocketPair?: unknown;
};

function globals(): RuntimeGlobals {
  return globalThis as unknown as RuntimeGlobals;
}

/** Detects the JS runtime the SDK is executing on. Never throws. */
export function detectRuntime(): Runtime {
  const g = globals();
  if (g.Bun?.version) return "bun";
  if (g.Deno?.version?.deno) return "deno";
  if (g.process?.env?.NEXT_RUNTIME === "edge") return "edge-light";
  if (typeof g.WebSocketPair !== "undefined") return "workerd";
  if (g.navigator?.product === "ReactNative") return "react-native";
  if (g.process?.versions?.node) return "node";
  if (typeof g.window !== "undefined" && typeof g.document !== "undefined") {
    return "browser";
  }
  return "unknown";
}

/** Returns `"<runtime>-<version>"` for the current runtime, e.g. `"node-22.10.0"`. */
export function runtimeTag(): string {
  const g = globals();
  const r = detectRuntime();
  switch (r) {
    case "bun":
      return `bun-${g.Bun?.version ?? "unknown"}`;
    case "deno":
      return `deno-${g.Deno?.version?.deno ?? "unknown"}`;
    case "node":
      return `node-${g.process?.versions?.node ?? "unknown"}`;
    case "workerd":
    case "edge-light":
    case "browser":
    case "react-native":
    case "unknown":
      return r;
  }
}
