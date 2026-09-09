import { describe, expect, test } from "bun:test";
import { CreateosSandboxNotFoundError, Sandbox } from "../src/index.ts";
import type { ComputerScreen, ComputerScreenOptions, ComputerWindow } from "../src/types.ts";
import { catchErr, jsonResponse, makeClient, RUNNING_VIEW, success } from "./helpers.ts";

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Routes the implicit `getSandbox` GET (`/v1/sandboxes/sb_1`) to RUNNING_VIEW
 * and every other request to `op` — computer-use reads are also GETs, so the
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

const C = "/v1/sandboxes/sb_1/computer";
const OK = { ok: true };
const SCREEN_1: ComputerScreenOptions = { screenId: "screen-1" };

const WINDOW: ComputerWindow = { id: "w_1", title: "Terminal" };
const SCREEN: ComputerScreen = {
  screen_id: "screen-0",
  display: ":0",
  width: 1280,
  height: 800,
  vnc_port: 5900,
  novnc_port: 6080,
};

interface WireCase {
  name: string;
  call: (sandbox: Sandbox) => Promise<unknown>;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  response: unknown;
}

const MOUSE: WireCase[] = [
  {
    name: "mouse.move POSTs the point",
    call: (s) => s.computer.mouse.move({ x: 10, y: 20 }),
    method: "POST",
    path: `${C}/mouse/move`,
    body: { x: 10, y: 20 },
    response: OK,
  },
  {
    name: "mouse.move threads screenId onto the screen_id query",
    call: (s) => s.computer.mouse.move({ x: 1, y: 2 }, { screenId: "screen-1" }),
    method: "POST",
    path: `${C}/mouse/move`,
    query: { screen_id: "screen-1" },
    body: { x: 1, y: 2 },
    response: OK,
  },
  {
    name: "mouse.click defaults to an empty request body",
    call: (s) => s.computer.mouse.click(),
    method: "POST",
    path: `${C}/mouse/click`,
    body: {},
    response: OK,
  },
  {
    name: "mouse.click POSTs button, coordinates and count",
    call: (s) => s.computer.mouse.click({ button: "right", x: 5, y: 6, count: 2 }),
    method: "POST",
    path: `${C}/mouse/click`,
    body: { button: "right", x: 5, y: 6, count: 2 },
    response: OK,
  },
  {
    name: "mouse.scroll defaults to an empty request body",
    call: (s) => s.computer.mouse.scroll(),
    method: "POST",
    path: `${C}/mouse/scroll`,
    body: {},
    response: OK,
  },
  {
    name: "mouse.scroll POSTs direction and amount",
    call: (s) => s.computer.mouse.scroll({ direction: "down", amount: 3 }),
    method: "POST",
    path: `${C}/mouse/scroll`,
    body: { direction: "down", amount: 3 },
    response: OK,
  },
  {
    name: "mouse.drag POSTs the from/to points",
    call: (s) => s.computer.mouse.drag({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }),
    method: "POST",
    path: `${C}/mouse/drag`,
    body: { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
    response: OK,
  },
  {
    name: "mouse.down POSTs the button",
    call: (s) => s.computer.mouse.down({ button: "middle" }),
    method: "POST",
    path: `${C}/mouse/down`,
    body: { button: "middle" },
    response: OK,
  },
  {
    name: "mouse.up defaults to an empty request body",
    call: (s) => s.computer.mouse.up(undefined, { screenId: "screen-1" }),
    method: "POST",
    path: `${C}/mouse/up`,
    query: { screen_id: "screen-1" },
    body: {},
    response: OK,
  },
];

const KEYBOARD: WireCase[] = [
  {
    name: "keyboard.type wraps a bare string as { text }",
    call: (s) => s.computer.keyboard.type("hello"),
    method: "POST",
    path: `${C}/keyboard/type`,
    body: { text: "hello" },
    response: OK,
  },
  {
    name: "keyboard.type passes a request object through untouched",
    call: (s) => s.computer.keyboard.type({ text: "hi", delay_in_ms: 5 }, SCREEN_1),
    method: "POST",
    path: `${C}/keyboard/type`,
    query: { screen_id: "screen-1" },
    body: { text: "hi", delay_in_ms: 5 },
    response: OK,
  },
  {
    name: "keyboard.press wraps a key array as { keys }",
    call: (s) => s.computer.keyboard.press(["ctrl", "c"]),
    method: "POST",
    path: `${C}/keyboard/press`,
    body: { keys: ["ctrl", "c"] },
    response: OK,
  },
  {
    name: "keyboard.press passes a request object through untouched",
    call: (s) => s.computer.keyboard.press({ keys: ["Return"] }),
    method: "POST",
    path: `${C}/keyboard/press`,
    body: { keys: ["Return"] },
    response: OK,
  },
  {
    name: "keyboard.down wraps a key array as { keys }",
    call: (s) => s.computer.keyboard.down(["shift"]),
    method: "POST",
    path: `${C}/keyboard/down`,
    body: { keys: ["shift"] },
    response: OK,
  },
  {
    name: "keyboard.down passes a request object through untouched",
    call: (s) => s.computer.keyboard.down({ keys: ["alt"] }, SCREEN_1),
    method: "POST",
    path: `${C}/keyboard/down`,
    query: { screen_id: "screen-1" },
    body: { keys: ["alt"] },
    response: OK,
  },
  {
    name: "keyboard.up wraps a key array as { keys }",
    call: (s) => s.computer.keyboard.up(["shift"]),
    method: "POST",
    path: `${C}/keyboard/up`,
    body: { keys: ["shift"] },
    response: OK,
  },
  {
    name: "keyboard.up passes a request object through untouched",
    call: (s) => s.computer.keyboard.up({ keys: ["alt"] }),
    method: "POST",
    path: `${C}/keyboard/up`,
    body: { keys: ["alt"] },
    response: OK,
  },
];

const WINDOWS: WireCase[] = [
  {
    name: "windows.list GETs the collection with no query by default",
    call: (s) => s.computer.windows.list(),
    method: "GET",
    path: `${C}/windows`,
    response: [WINDOW],
  },
  {
    name: "windows.list maps screenId and application onto the query",
    call: (s) => s.computer.windows.list({ screenId: "screen-1", application: "chrome" }),
    method: "GET",
    path: `${C}/windows`,
    query: { screen_id: "screen-1", application: "chrome" },
    response: [WINDOW],
  },
  {
    name: "windows.current GETs the focused window",
    call: (s) => s.computer.windows.current(SCREEN_1),
    method: "GET",
    path: `${C}/windows/current`,
    query: { screen_id: "screen-1" },
    response: WINDOW,
  },
  {
    name: "windows.get GETs one window by id",
    call: (s) => s.computer.windows.get("w_1"),
    method: "GET",
    path: `${C}/windows/w_1`,
    response: WINDOW,
  },
  {
    name: "windows.geometry GETs the window geometry",
    call: (s) => s.computer.windows.geometry("w_1"),
    method: "GET",
    path: `${C}/windows/w_1/geometry`,
    response: { id: "w_1", x: 0, y: 0, width: 800, height: 600, screen: 0 },
  },
  {
    name: "windows.focus POSTs the focus action with no body",
    call: (s) => s.computer.windows.focus("w_1"),
    method: "POST",
    path: `${C}/windows/w_1/focus`,
    response: OK,
  },
  {
    name: "windows.move POSTs the target coordinates",
    call: (s) => s.computer.windows.move("w_1", { x: 12, y: 34 }),
    method: "POST",
    path: `${C}/windows/w_1/move`,
    body: { x: 12, y: 34 },
    response: OK,
  },
  {
    name: "windows.resize POSTs the target size",
    call: (s) => s.computer.windows.resize("w_1", { width: 640, height: 480 }, SCREEN_1),
    method: "POST",
    path: `${C}/windows/w_1/resize`,
    query: { screen_id: "screen-1" },
    body: { width: 640, height: 480 },
    response: OK,
  },
  {
    name: "windows.maximize POSTs the maximize action",
    call: (s) => s.computer.windows.maximize("w_1"),
    method: "POST",
    path: `${C}/windows/w_1/maximize`,
    response: OK,
  },
  {
    name: "windows.minimize POSTs the minimize action",
    call: (s) => s.computer.windows.minimize("w_1"),
    method: "POST",
    path: `${C}/windows/w_1/minimize`,
    response: OK,
  },
  {
    name: "windows.restore POSTs the restore action",
    call: (s) => s.computer.windows.restore("w_1"),
    method: "POST",
    path: `${C}/windows/w_1/restore`,
    response: OK,
  },
  {
    name: "windows.close DELETEs the window",
    call: (s) => s.computer.windows.close("w 1"),
    method: "DELETE",
    path: `${C}/windows/w%201`,
    response: OK,
  },
];

const SCREENS: WireCase[] = [
  {
    name: "screens.list GETs the screen collection",
    call: (s) => s.computer.screens.list(),
    method: "GET",
    path: `${C}/screens`,
    response: [SCREEN],
  },
  {
    name: "screens.create POSTs an empty body by default",
    call: (s) => s.computer.screens.create(),
    method: "POST",
    path: `${C}/screens`,
    body: {},
    response: SCREEN,
  },
  {
    name: "screens.create POSTs the requested geometry",
    call: (s) => s.computer.screens.create({ width: 1920, height: 1080 }),
    method: "POST",
    path: `${C}/screens`,
    body: { width: 1920, height: 1080 },
    response: { ...SCREEN, width: 1920, height: 1080 },
  },
  {
    name: "screens.get GETs one screen by id",
    call: (s) => s.computer.screens.get("screen-0"),
    method: "GET",
    path: `${C}/screens/screen-0`,
    response: SCREEN,
  },
  {
    name: "screens.connect GETs the noVNC connection details",
    call: (s) => s.computer.screens.connect("screen-0"),
    method: "GET",
    path: `${C}/screens/screen-0/connect`,
    response: {
      screen_id: "screen-0",
      port: 6080,
      path: "/vnc",
      token: "t_1",
      expires_at: "2024-01-01T01:00:00Z",
    },
  },
  {
    name: "screens.resize POSTs the new geometry",
    call: (s) => s.computer.screens.resize("screen-0", { width: 1024, height: 768 }),
    method: "POST",
    path: `${C}/screens/screen-0/resize`,
    body: { width: 1024, height: 768 },
    response: { ...SCREEN, width: 1024, height: 768 },
  },
  {
    name: "screens.delete DELETEs the screen",
    call: (s) => s.computer.screens.delete("screen-1"),
    method: "DELETE",
    path: `${C}/screens/screen-1`,
    response: OK,
  },
];

const DESKTOP: WireCase[] = [
  {
    name: "screen GETs the active screen geometry",
    call: (s) => s.computer.screen(),
    method: "GET",
    path: `${C}/screen`,
    response: { width: 1280, height: 800 },
  },
  {
    name: "cursor GETs the cursor position for a screen",
    call: (s) => s.computer.cursor(SCREEN_1),
    method: "GET",
    path: `${C}/cursor`,
    query: { screen_id: "screen-1" },
    response: { x: 4, y: 8 },
  },
  {
    name: "clipboard GETs the clipboard text",
    call: (s) => s.computer.clipboard(),
    method: "GET",
    path: `${C}/clipboard`,
    response: { text: "copied" },
  },
  {
    name: "setClipboard wraps a bare string as { text } and PUTs it",
    call: (s) => s.computer.setClipboard("hi"),
    method: "PUT",
    path: `${C}/clipboard`,
    body: { text: "hi" },
    response: OK,
  },
  {
    name: "setClipboard passes a clipboard object through untouched",
    call: (s) => s.computer.setClipboard({ text: "yo" }, SCREEN_1),
    method: "PUT",
    path: `${C}/clipboard`,
    query: { screen_id: "screen-1" },
    body: { text: "yo" },
    response: OK,
  },
  {
    name: "open wraps a bare string as { target }",
    call: (s) => s.computer.open("https://example.test"),
    method: "POST",
    path: `${C}/open`,
    body: { target: "https://example.test" },
    response: OK,
  },
  {
    name: "open passes a request object through untouched",
    call: (s) => s.computer.open({ target: "file:///tmp/a.txt" }),
    method: "POST",
    path: `${C}/open`,
    body: { target: "file:///tmp/a.txt" },
    response: OK,
  },
  {
    name: "launch POSTs the application and uri",
    call: (s) => s.computer.launch({ application: "chrome", uri: "https://example.test" }),
    method: "POST",
    path: `${C}/launch`,
    body: { application: "chrome", uri: "https://example.test" },
    response: OK,
  },
];

const GROUPS: Array<[string, WireCase[]]> = [
  ["SandboxComputerMouse", MOUSE],
  ["SandboxComputerKeyboard", KEYBOARD],
  ["SandboxComputerWindows", WINDOWS],
  ["SandboxComputerScreens", SCREENS],
  ["SandboxComputer", DESKTOP],
];

for (const [group, cases] of GROUPS) {
  describe(`${group} wire contract`, () => {
    for (const wireCase of cases) {
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
}

describe("SandboxComputer.screenshot", () => {
  test("GETs raw PNG bytes with no query by default", async () => {
    let method: string | undefined;
    let pathname: string | undefined;
    let query: Record<string, string> | undefined;
    const sandbox = await connect((url, init, p) => {
      method = init.method;
      pathname = p;
      query = Object.fromEntries(new URL(String(url)).searchParams);
      return Promise.resolve(
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
    });

    const png = await sandbox.computer.screenshot();

    expect(method).toBe("GET");
    expect(pathname).toBe(`${C}/screenshot`);
    expect(query).toEqual({});
    expect(new Uint8Array(png)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  test("maps the region and target options onto the query string", async () => {
    let query: Record<string, string> | undefined;
    const sandbox = await connect((url) => {
      query = Object.fromEntries(new URL(String(url)).searchParams);
      return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }));
    });

    await sandbox.computer.screenshot({
      screenId: "screen-1",
      windowId: "w_1",
      x: 10,
      y: 20,
      width: 300,
      height: 400,
    });

    expect(query).toEqual({
      screen_id: "screen-1",
      window_id: "w_1",
      x: "10",
      y: "20",
      width: "300",
      height: "400",
    });
  });

  test("surfaces a non-OK raw response as a typed error", async () => {
    const client = makeClient(
      withSandbox(() =>
        Promise.resolve(jsonResponse({ status: "fail", data: {} }, { status: 404 })),
      ),
      { retry: false },
    );
    const sandbox = await client.getSandbox("sb_1");

    const err = await catchErr(() => sandbox.computer.screenshot());

    expect(err).toBeInstanceOf(CreateosSandboxNotFoundError);
    expect(err.method).toBe("GET");
    expect(err.endpoint).toBe(`${C}/screenshot`);
  });
});
