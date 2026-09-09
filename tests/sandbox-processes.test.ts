import { describe, expect, test } from "bun:test";
import { Sandbox } from "../src/index.ts";
import type { ManagedProcess, ManagedProcessConnectEvent } from "../src/types.ts";
import { makeClient, ndjsonResponse, RUNNING_VIEW, streamOf, success } from "./helpers.ts";

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Routes the implicit `getSandbox` GET (`/v1/sandboxes/sb_1`) to RUNNING_VIEW
 * and every other request to `op` — sub-resource reads are also GETs, so the
 * route is matched on the pathname, never on the method alone.
 */
function withSandbox(
  op: (url: string, init: RequestInit, pathname: string) => Promise<Response>,
): FetchImpl {
  return (url, init) => {
    const pathname = new URL(String(url)).pathname;
    if (init.method === "GET" && pathname === "/v1/sandboxes/sb_1") {
      return Promise.resolve(success(RUNNING_VIEW));
    }
    return op(url, init, pathname);
  };
}

async function connect(op: Parameters<typeof withSandbox>[0]): Promise<Sandbox> {
  const client = makeClient(withSandbox(op));
  return client.getSandbox("sb_1");
}

const PROCESS: ManagedProcess = {
  process_id: "p_1",
  kind: "process",
  pid: 42,
  state: "running",
  leader_exited: false,
  tree_exited: false,
  created_at: "2024-01-01T00:00:00Z",
  cmd: "sleep",
  args: ["60"],
  output: { oldest_seq: 0, newest_seq: 3, bytes: 12 },
};

const OK = { ok: true };
const PROCESSES = "/v1/sandboxes/sb_1/processes";

interface WireCase {
  name: string;
  call: (sandbox: Sandbox) => Promise<unknown>;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  response: unknown;
}

const CASES: WireCase[] = [
  {
    name: "create POSTs the request body and returns the process",
    call: (s) => s.processes.create({ cmd: "sleep", args: ["60"], cwd: "/srv" }),
    method: "POST",
    path: PROCESSES,
    body: { cmd: "sleep", args: ["60"], cwd: "/srv" },
    response: PROCESS,
  },
  {
    name: "create passes a pty size through untouched",
    call: (s) => s.processes.create({ pty: { rows: 24, cols: 80 } }),
    method: "POST",
    path: PROCESSES,
    body: { pty: { rows: 24, cols: 80 } },
    response: { ...PROCESS, kind: "pty" },
  },
  {
    name: "list GETs the collection and returns the processes envelope",
    call: (s) => s.processes.list(),
    method: "GET",
    path: PROCESSES,
    response: { processes: [PROCESS] },
  },
  {
    name: "get GETs one process by id",
    call: (s) => s.processes.get("p_1"),
    method: "GET",
    path: `${PROCESSES}/p_1`,
    response: PROCESS,
  },
  {
    name: "get percent-encodes the process id",
    call: (s) => s.processes.get("p 1/x"),
    method: "GET",
    path: `${PROCESSES}/p%201%2Fx`,
    response: PROCESS,
  },
  {
    name: "closeStdin POSTs to /stdin/close with no body",
    call: (s) => s.processes.closeStdin("p_1"),
    method: "POST",
    path: `${PROCESSES}/p_1/stdin/close`,
    response: OK,
  },
  {
    name: "resize POSTs rows and cols",
    call: (s) => s.processes.resize("p_1", { rows: 40, cols: 120 }),
    method: "POST",
    path: `${PROCESSES}/p_1/resize`,
    body: { rows: 40, cols: 120 },
    response: OK,
  },
  {
    name: "signal POSTs the signal name",
    call: (s) => s.processes.signal("p_1", "SIGINT"),
    method: "POST",
    path: `${PROCESSES}/p_1/signal`,
    body: { signal: "SIGINT" },
    response: OK,
  },
  {
    name: "wait GETs /wait with no query by default",
    call: (s) => s.processes.wait("p_1"),
    method: "GET",
    path: `${PROCESSES}/p_1/wait`,
    response: { ...PROCESS, state: "exited", leader_exited: true, exit_code: 0 },
  },
  {
    name: "wait maps scope and waitTimeoutMs onto the query string",
    call: (s) => s.processes.wait("p_1", { scope: "tree", waitTimeoutMs: 5000 }),
    method: "GET",
    path: `${PROCESSES}/p_1/wait`,
    query: { scope: "tree", timeout_ms: "5000" },
    response: { ...PROCESS, state: "exited", tree_exited: true },
  },
  {
    name: "delete DELETEs the process with no query by default",
    call: (s) => s.processes.delete("p_1"),
    method: "DELETE",
    path: `${PROCESSES}/p_1`,
    response: { ...PROCESS, state: "terminating" },
  },
  {
    name: "delete maps graceMs onto grace_ms",
    call: (s) => s.processes.delete("p_1", { graceMs: 250 }),
    method: "DELETE",
    path: `${PROCESSES}/p_1`,
    query: { grace_ms: "250" },
    response: { ...PROCESS, state: "terminating" },
  },
];

describe("SandboxProcesses wire contract", () => {
  for (const wireCase of CASES) {
    test(wireCase.name, async () => {
      let method: string | undefined;
      let pathname: string | undefined;
      let query: Record<string, string> | undefined;
      let body: string | undefined;
      const sandbox = await connect((url, init, p) => {
        method = init.method;
        pathname = p;
        query = Object.fromEntries(new URL(String(url)).searchParams);
        if (init.body !== undefined && init.body !== null) body = String(init.body);
        return Promise.resolve(success(wireCase.response));
      });

      const out = await wireCase.call(sandbox);

      expect(method).toBe(wireCase.method);
      expect(pathname).toBe(wireCase.path);
      expect(query).toEqual(wireCase.query ?? {});
      expect(body === undefined ? undefined : JSON.parse(body)).toEqual(wireCase.body);
      expect(out).toEqual(wireCase.response);
    });
  }
});

describe("SandboxProcesses input", () => {
  test("input base64-encodes the UTF-8 bytes of the string", async () => {
    let pathname: string | undefined;
    let body: { data_base64: string } | undefined;
    const sandbox = await connect((_url, init, p) => {
      pathname = p;
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ input_seq: 7 }));
    });

    const out = await sandbox.processes.input("p_1", "hé");

    expect(pathname).toBe(`${PROCESSES}/p_1/input`);
    // "hé" is 3 UTF-8 bytes (68 c3 a9), not 2 code units.
    expect(body).toEqual({ data_base64: "aMOp" });
    expect(out.input_seq).toBe(7);
  });

  test("inputBytes base64-encodes raw bytes, including non-UTF-8 ones", async () => {
    let body: { data_base64: string } | undefined;
    const sandbox = await connect((_url, init) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ input_seq: 1 }));
    });

    await sandbox.processes.inputBytes("p_1", new Uint8Array([0x00, 0x01, 0x02, 0xfd]));

    expect(body).toEqual({ data_base64: "AAEC/Q==" });
  });

  test("inputBytes falls back to btoa when Buffer is unavailable", async () => {
    const globals = globalThis as { Buffer?: unknown };
    const savedBuffer = globals.Buffer;
    delete globals.Buffer;
    try {
      let body: { data_base64: string } | undefined;
      const sandbox = await connect((_url, init) => {
        body = JSON.parse(String(init.body));
        return Promise.resolve(success({ input_seq: 2 }));
      });

      await sandbox.processes.inputBytes("p_1", new Uint8Array([0x68, 0xc3, 0xa9]));

      expect(body).toEqual({ data_base64: "aMOp" });
    } finally {
      globals.Buffer = savedBuffer;
    }
  });
});

describe("SandboxProcesses connect", () => {
  const FRAMES = [
    '{"type":"heartbeat"}',
    '{"type":"data","seq":1,"stream":"stdout","data_base64":"aMOp"}',
    '{"type":"exit","exit_code":0}',
    '{"type":"exit","signal":"SIGKILL"}',
    '{"type":"error","error":"gap","oldest_available_seq":5}',
    '{"type":"error","error":"boom"}',
  ].join("\n");

  const EXPECTED: ManagedProcessConnectEvent[] = [
    { type: "heartbeat" },
    { type: "data", seq: 1, stream: "stdout", data: "hé" },
    { type: "exit", exitCode: 0 },
    { type: "exit", signal: "SIGKILL" },
    { type: "error", message: "gap", oldestAvailableSeq: 5 },
    { type: "error", message: "boom" },
  ];

  test("decodes every frame kind into the typed event union", async () => {
    let method: string | undefined;
    let pathname: string | undefined;
    let after: string | null | undefined;
    const sandbox = await connect((url, init, p) => {
      method = init.method;
      pathname = p;
      after = new URL(String(url)).searchParams.get("after");
      return Promise.resolve(ndjsonResponse(streamOf(`${FRAMES}\n`)));
    });

    const events: ManagedProcessConnectEvent[] = [];
    for await (const event of sandbox.processes.connect("p_1", { after: 3 })) events.push(event);

    expect(method).toBe("GET");
    expect(pathname).toBe(`${PROCESSES}/p_1/connect`);
    expect(after).toBe("3");
    expect(events).toEqual(EXPECTED);
  });

  test("omits the after query when no replay offset is given", async () => {
    let query: Record<string, string> | undefined;
    const sandbox = await connect((url) => {
      query = Object.fromEntries(new URL(String(url)).searchParams);
      return Promise.resolve(ndjsonResponse(streamOf('{"type":"heartbeat"}\n')));
    });

    const events: ManagedProcessConnectEvent[] = [];
    for await (const event of sandbox.processes.connect("p_1")) events.push(event);

    expect(query).toEqual({});
    expect(events).toEqual([{ type: "heartbeat" }]);
  });

  test("decodes data frames via atob when Buffer is unavailable", async () => {
    const globals = globalThis as { Buffer?: unknown };
    const savedBuffer = globals.Buffer;
    delete globals.Buffer;
    try {
      const sandbox = await connect(() =>
        Promise.resolve(
          ndjsonResponse(streamOf('{"type":"data","seq":9,"stream":"pty","data_base64":"aMOp"}\n')),
        ),
      );

      const events: ManagedProcessConnectEvent[] = [];
      for await (const event of sandbox.processes.connect("p_1")) events.push(event);

      expect(events).toEqual([{ type: "data", seq: 9, stream: "pty", data: "hé" }]);
    } finally {
      globals.Buffer = savedBuffer;
    }
  });
});
