import { describe, expect, test } from "bun:test";
import { FcError, FcTimeoutError, Sandbox } from "../src/index.ts";
import {
  catchErr,
  CREATE_RESPONSE,
  makeClient,
  ndjsonResponse,
  RUNNING_VIEW,
  streamOf,
  success,
} from "./helpers.ts";

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Routes the implicit `getSandbox` GET (`/v1/sandboxes/sb_1`) to RUNNING_VIEW
 * and every other request to `op` — keeps per-operation tests free of the
 * boot-GET boilerplate while leaving sub-resource GETs (e.g. `/egress`) for
 * the operation responder.
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

describe("commands", () => {
  test("runCommand posts cmd/args to /exec and returns buffered output", async () => {
    let pathname = "";
    let body: { cmd: string; args: string[] } | undefined;
    const sandbox = await connect((url, init, p) => {
      pathname = p;
      body = JSON.parse(String(init.body));
      return Promise.resolve(
        success({ result: { stdout: "v20\n", stderr: "", exit_code: 0 }, exec_ms: 5 }),
      );
    });
    const result = await sandbox.runCommand("node", ["--version"]);
    expect(pathname).toBe("/v1/sandboxes/sb_1/exec");
    expect(body).toEqual({ cmd: "node", args: ["--version"] });
    expect(result.result.stdout).toBe("v20\n");
    expect(result.result.exit_code).toBe(0);
  });

  test("runCommand does not throw on a non-zero exit code", async () => {
    const sandbox = await connect(() =>
      Promise.resolve(
        success({ result: { stdout: "", stderr: "boom", exit_code: 1 }, exec_ms: 3 }),
      ),
    );
    const result = await sandbox.runCommand("false");
    expect(result.result.exit_code).toBe(1);
  });

  test("sh wraps the script in bash -lc and returns the response on success", async () => {
    let body: { cmd: string; args: string[] } | undefined;
    const sandbox = await connect((_u, init) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve(
        success({ result: { stdout: "ok\n", stderr: "", exit_code: 0 }, exec_ms: 7 }),
      );
    });
    const out = await sandbox.sh("echo ok");
    expect(body).toEqual({ cmd: "bash", args: ["-lc", "echo ok"] });
    expect(out.result.stdout).toBe("ok\n");
    expect(out.exec_ms).toBe(7);
  });

  test("sh throws on a non-zero exit, tagging the error with the label", async () => {
    const sandbox = await connect(() =>
      Promise.resolve(
        success({ result: { stdout: "", stderr: "boom", exit_code: 2 }, exec_ms: 4 }),
      ),
    );
    const err = await catchErr(() => sandbox.sh("false", { label: "apt" }));
    expect(err).toBeInstanceOf(FcError);
    expect(err.message).toContain("apt: command exited 2");
    expect(err.message).toContain("boom");
  });

  test("sh throws when the agent reports a start error despite exit 0", async () => {
    const sandbox = await connect(() =>
      Promise.resolve(
        success({
          result: { stdout: "", stderr: "", exit_code: 0, error: "exec format error" },
          exec_ms: 1,
        }),
      ),
    );
    const err = await catchErr(() => sandbox.sh("./broken"));
    expect(err).toBeInstanceOf(FcError);
    expect(err.message).toContain("exec format error");
  });

  test("streamCommand projects NDJSON frames to a typed event union", async () => {
    let url = "";
    const sandbox = await connect((u, init) => {
      url = String(u);
      expect(JSON.parse(String(init.body)).stream).toBe(true);
      return Promise.resolve(
        ndjsonResponse(
          streamOf(
            '{"hb":true}\n{"stdout":"hi\\n"}\n{"stderr":"warn"}\n{"error":"oops"}\n{"exit_code":0}\n',
          ),
        ),
      );
    });
    const events = [];
    for await (const event of sandbox.streamCommand("bash", ["-lc", "echo hi"])) events.push(event);
    expect(url).toMatch(/stream=true/);
    expect(events).toEqual([
      { type: "heartbeat" },
      { type: "stdout", data: "hi\n" },
      { type: "stderr", data: "warn" },
      { type: "error", message: "oops" },
      { type: "exit", exitCode: 0 },
    ]);
  });
});

describe("lifecycle", () => {
  test("refresh re-fetches and updates the handle", async () => {
    let calls = 0;
    const client = makeClient(() => {
      calls += 1;
      return Promise.resolve(
        success({ ...RUNNING_VIEW, status: calls === 1 ? "creating" : "running" }),
      );
    });
    const sandbox = await client.getSandbox("sb_1");
    expect(sandbox.status).toBe("creating");
    await sandbox.refresh();
    expect(sandbox.status).toBe("running");
  });

  test("pause updates the handle to the returned view", async () => {
    const sandbox = await connect((_u, _i, p) => {
      expect(p).toBe("/v1/sandboxes/sb_1/pause");
      return Promise.resolve(success({ ...RUNNING_VIEW, status: "paused" }));
    });
    await sandbox.pause();
    expect(sandbox.status).toBe("paused");
  });

  test("resume updates the handle to the returned view", async () => {
    const sandbox = await connect((_u, _i, p) => {
      expect(p).toBe("/v1/sandboxes/sb_1/resume");
      return Promise.resolve(success({ ...RUNNING_VIEW, status: "running" }));
    });
    await sandbox.resume();
    expect(sandbox.status).toBe("running");
  });

  test("fork returns a new independent handle", async () => {
    const sandbox = await connect((_u, _i, p) => {
      expect(p).toBe("/v1/sandboxes/sb_1/fork");
      return Promise.resolve(success({ ...RUNNING_VIEW, id: "sb_fork", status: "running" }));
    });
    const clone = await sandbox.fork();
    expect(clone).toBeInstanceOf(Sandbox);
    expect(clone.id).toBe("sb_fork");
    expect(sandbox.id).toBe("sb_1");
  });

  test("destroy returns {id,status} and updates the handle", async () => {
    const sandbox = await connect((_u, init) => {
      expect(init.method).toBe("DELETE");
      return Promise.resolve(success({ id: "sb_1", status: "destroying" }));
    });
    const result = await sandbox.destroy();
    expect(result).toEqual({ id: "sb_1", status: "destroying" });
    expect(sandbox.status).toBe("destroying");
  });

  test("resize posts disk_mib and returns the new size", async () => {
    let body: { disk_mib: number } | undefined;
    const sandbox = await connect((_u, init, p) => {
      expect(p).toBe("/v1/sandboxes/sb_1/resize");
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ id: "sb_1", disk_mib: 20480 }));
    });
    const out = await sandbox.resize(20480);
    expect(body).toEqual({ disk_mib: 20480 });
    expect(out.disk_mib).toBe(20480);
    expect(sandbox.data.disk_mib).toBe(20480);
  });
});

describe("auto-pause", () => {
  test("setAutoPause(600) PATCHes auto_pause_after_seconds and updates the handle", async () => {
    let body: { auto_pause_after_seconds: number } | undefined;
    const sandbox = await connect((_u, init, p) => {
      expect(init.method).toBe("PATCH");
      expect(p).toBe("/v1/sandboxes/sb_1");
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ ...RUNNING_VIEW, auto_pause_after_seconds: 600 }));
    });
    await sandbox.setAutoPause(600);
    expect(body).toEqual({ auto_pause_after_seconds: 600 });
    expect(sandbox.data.auto_pause_after_seconds).toBe(600);
  });

  test("setAutoPause(null) sends disable_auto_pause and clears the field", async () => {
    let body: { disable_auto_pause: boolean } | undefined;
    const sandbox = await connect((_u, init, p) => {
      expect(init.method).toBe("PATCH");
      expect(p).toBe("/v1/sandboxes/sb_1");
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ ...RUNNING_VIEW }));
    });
    await sandbox.setAutoPause(null);
    expect(body).toEqual({ disable_auto_pause: true });
    expect(sandbox.data.auto_pause_after_seconds).toBeUndefined();
  });
});

describe("ingress", () => {
  test("setIngress(true) PATCHes ingress_enabled and updates the handle", async () => {
    let body: { ingress_enabled: boolean } | undefined;
    const sandbox = await connect((_u, init, p) => {
      expect(init.method).toBe("PATCH");
      expect(p).toBe("/v1/sandboxes/sb_1");
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ ...RUNNING_VIEW, ingress_enabled: true }));
    });
    await sandbox.setIngress(true);
    expect(body).toEqual({ ingress_enabled: true });
    expect(sandbox.data.ingress_enabled).toBe(true);
  });

  test("previewUrl renders the template from the canonical sandbox view", async () => {
    // A running ingress-enabled view carries ingress_url_template (matches
    // the live control plane), so the handle reads it straight from #data.
    const client = makeClient((_url, init) =>
      Promise.resolve(
        init.method === "POST"
          ? success(CREATE_RESPONSE)
          : success({
              ...RUNNING_VIEW,
              ingress_enabled: true,
              ingress_url_template: "https://<port>-sb_1.fc.test",
            }),
      ),
    );
    const sandbox = await client.createSandbox({ shape: "s", ingress_enabled: true });
    expect(sandbox.previewUrl(8080)).toBe("https://8080-sb_1.fc.test");
    expect(sandbox.previewUrl(8080, { scheme: "https" })).toBe("https://8080-sb_1.fc.test");
    expect(sandbox.previewUrl(8080, { scheme: "http" })).toBe("http://8080-sb_1.fc.test");
  });

  test("previewUrl uses the create-response template before the view is populated (wait:false)", async () => {
    // wait:false skips the poll refresh; if the freshly-created view doesn't
    // carry the template yet, the create response's value is seeded onto it.
    const client = makeClient((_url, init) =>
      Promise.resolve(
        init.method === "POST"
          ? success({ ...CREATE_RESPONSE, ingress_url_template: "https://<port>-sb_1.fc.test" })
          : success({ ...RUNNING_VIEW, status: "creating", ingress_enabled: true }),
      ),
    );
    const sandbox = await client.createSandbox(
      { shape: "s", ingress_enabled: true },
      { wait: false },
    );
    expect(sandbox.previewUrl(8080)).toBe("https://8080-sb_1.fc.test");
  });

  test("previewUrl throws when ingress is not enabled", async () => {
    const sandbox = await connect(() => Promise.resolve(success(RUNNING_VIEW)));
    expect(() => sandbox.previewUrl(8080)).toThrow(FcError);
  });

  test("setIngress(false) invalidates the preview URL template", async () => {
    const client = makeClient((_url, init) =>
      Promise.resolve(
        init.method === "POST"
          ? success(CREATE_RESPONSE)
          : init.method === "PATCH"
            ? success({ ...RUNNING_VIEW, ingress_enabled: false })
            : success({
                ...RUNNING_VIEW,
                ingress_enabled: true,
                ingress_url_template: "https://<port>-sb_1.fc.test",
              }),
      ),
    );
    const sandbox = await client.createSandbox({ shape: "s", ingress_enabled: true });
    expect(sandbox.previewUrl(8080)).toBe("https://8080-sb_1.fc.test");
    await sandbox.setIngress(false);
    expect(() => sandbox.previewUrl(8080)).toThrow(FcError);
  });

  test("previewUrl rejects an out-of-range port", async () => {
    const sandbox = await connect(() => Promise.resolve(success(RUNNING_VIEW)));
    expect(() => sandbox.previewUrl(0)).toThrow(FcError);
  });
});

describe("ssh pubkeys", () => {
  test("addSSHPubkeys POSTs keys and returns the new count", async () => {
    let pathname = "";
    let body: { keys: string[] } | undefined;
    const sandbox = await connect((_url, init, p) => {
      pathname = p;
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ count: 2 }));
    });
    const keys = ["ssh-ed25519 AAAAkey1", "ssh-rsa AAAAkey2"];
    const out = await sandbox.addSSHPubkeys(keys);
    expect(pathname).toBe("/v1/sandboxes/sb_1/ssh-pubkeys");
    expect(body).toEqual({ keys });
    expect(out.count).toBe(2);
  });
});

describe("egress / bandwidth / networks", () => {
  test("getEgress reads /egress", async () => {
    const sandbox = await connect((_u, init, p) => {
      expect(init.method).toBe("GET");
      expect(p).toBe("/v1/sandboxes/sb_1/egress");
      return Promise.resolve(success({ id: "sb_1", egress: ["api.openai.com:443"] }));
    });
    const view = await sandbox.getEgress();
    expect(view.egress).toEqual(["api.openai.com:443"]);
  });

  test("setEgress PUTs the rule list", async () => {
    let body: { egress: string[] | null } | undefined;
    const sandbox = await connect((_u, init, p) => {
      expect(init.method).toBe("PUT");
      expect(p).toBe("/v1/sandboxes/sb_1/egress");
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ id: "sb_1", egress: ["registry.npmjs.org:443"] }));
    });
    const view = await sandbox.setEgress(["registry.npmjs.org:443"]);
    expect(body).toEqual({ egress: ["registry.npmjs.org:443"] });
    expect(view.egress).toEqual(["registry.npmjs.org:443"]);
  });

  test("getBandwidth reads /bandwidth", async () => {
    const sandbox = await connect((_u, init, p) => {
      expect(init.method).toBe("GET");
      expect(p).toBe("/v1/sandboxes/sb_1/bandwidth");
      return Promise.resolve(success({ id: "sb_1", quota_bytes: 1000, remaining_bytes: 400 }));
    });
    const view = await sandbox.getBandwidth();
    expect(view.remaining_bytes).toBe(400);
  });

  test("rechargeBandwidth posts add_bytes", async () => {
    let body: { add_bytes: number } | undefined;
    const sandbox = await connect((_u, init, p) => {
      expect(p).toBe("/v1/sandboxes/sb_1/bandwidth/recharge");
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ id: "sb_1", quota_bytes: 2000, remaining_bytes: 1400 }));
    });
    const view = await sandbox.rechargeBandwidth(1000);
    expect(body).toEqual({ add_bytes: 1000 });
    expect(view.quota_bytes).toBe(2000);
  });

  test("attachNetwork posts { id } to /networks", async () => {
    let body: { id: string } | undefined;
    const sandbox = await connect((_u, init, p) => {
      expect(init.method).toBe("POST");
      expect(p).toBe("/v1/sandboxes/sb_1/networks");
      body = JSON.parse(String(init.body));
      return Promise.resolve(success({ ok: true }));
    });
    await sandbox.attachNetwork("net_1");
    expect(body).toEqual({ id: "net_1" });
  });

  test("detachNetwork deletes /networks/<id>", async () => {
    let pathname = "";
    const sandbox = await connect((_u, init, p) => {
      expect(init.method).toBe("DELETE");
      pathname = p;
      return Promise.resolve(success({ ok: true }));
    });
    await sandbox.detachNetwork("net_1");
    expect(pathname).toBe("/v1/sandboxes/sb_1/networks/net_1");
  });
});

describe("projection getters", () => {
  test("toJSON / data return the last-known view", async () => {
    const sandbox = await connect(() => Promise.resolve(success(RUNNING_VIEW)));
    expect(sandbox.toJSON()).toEqual(RUNNING_VIEW);
    expect(sandbox.data).toEqual(RUNNING_VIEW);
    expect(JSON.parse(JSON.stringify(sandbox)).id).toBe("sb_1");
  });
});

describe("waitUntil* helpers", () => {
  test("waitUntilRunning resolves once the status is running", async () => {
    const states = ["creating", "running"];
    let i = 0;
    const client = makeClient(() =>
      Promise.resolve(success({ ...RUNNING_VIEW, status: states[Math.min(i++, 1)] })),
    );
    const sandbox = await client.getSandbox("sb_1");
    await sandbox.waitUntilRunning({ timeoutMs: 5000 });
    expect(sandbox.status).toBe("running");
  });

  test("waitUntilRunning aborts when the sandbox enters a terminal failure state", async () => {
    const states = ["creating", "destroying"];
    let i = 0;
    const client = makeClient(() =>
      Promise.resolve(success({ ...RUNNING_VIEW, status: states[Math.min(i++, 1)] })),
    );
    const sandbox = await client.getSandbox("sb_1");
    const err = await catchErr(() => sandbox.waitUntilRunning({ timeoutMs: 5000 }));
    expect(err).toBeInstanceOf(FcError);
    expect(err.message).toMatch(/destroying/);
  });

  test("waitUntilPaused resolves on paused", async () => {
    const states = ["pausing", "paused"];
    let i = 0;
    const client = makeClient(() =>
      Promise.resolve(success({ ...RUNNING_VIEW, status: states[Math.min(i++, 1)] })),
    );
    const sandbox = await client.getSandbox("sb_1");
    await sandbox.waitUntilPaused({ timeoutMs: 5000 });
    expect(sandbox.status).toBe("paused");
  });

  test("waitUntilDestroyed resolves on destroyed", async () => {
    const states = ["destroying", "destroyed"];
    let i = 0;
    const client = makeClient(() =>
      Promise.resolve(success({ ...RUNNING_VIEW, status: states[Math.min(i++, 1)] })),
    );
    const sandbox = await client.getSandbox("sb_1");
    await sandbox.waitUntilDestroyed({ timeoutMs: 5000 });
    expect(sandbox.status).toBe("destroyed");
  });
});

describe("waitForPortReady", () => {
  test("embeds a custom host in the probe script and resolves on exit 0", async () => {
    let script = "";
    const sandbox = await connect((_u, init) => {
      script = JSON.parse(String(init.body)).args[1];
      return Promise.resolve(
        success({ result: { stdout: "", stderr: "", exit_code: 0 }, exec_ms: 1 }),
      );
    });
    await sandbox.waitForPortReady(3000, { host: "0.0.0.0", timeoutMs: 1000 });
    expect(script).toMatch(/\/dev\/tcp\/0\.0\.0\.0\/3000/);
  });

  test("throws FcTimeoutError when the probe exits non-zero", async () => {
    const sandbox = await connect(() =>
      Promise.resolve(success({ result: { stdout: "", stderr: "", exit_code: 1 }, exec_ms: 1 })),
    );
    await expect(sandbox.waitForPortReady(8080, { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      FcTimeoutError,
    );
  });

  test("rejects an out-of-range port before issuing any request", async () => {
    const sandbox = await connect(() => Promise.resolve(success(RUNNING_VIEW)));
    await expect(sandbox.waitForPortReady(70_000)).rejects.toBeInstanceOf(FcError);
  });

  test("rejects a host containing shell metacharacters (injection guard)", async () => {
    const sandbox = await connect(() => Promise.resolve(success(RUNNING_VIEW)));
    await expect(
      sandbox.waitForPortReady(8080, { host: "127.0.0.1; rm -rf /" }),
    ).rejects.toBeInstanceOf(FcError);
  });
});
