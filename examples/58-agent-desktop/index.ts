/** Semantic desktop automation using the existing SDK command transport. */
import { Sandbox } from "../../src/index.ts";
import assert from "node:assert/strict";

interface Element {
  role?: string;
  name?: string;
  ref_id?: string;
  children?: Element[];
}

interface DesktopResult {
  ok: boolean;
  error?: { code: string; message: string };
  data: {
    tree?: Element;
    complete?: boolean;
    session_id?: string;
    found?: boolean;
    supported_surfaces?: string[];
    permissions?: { accessibility: { state: string } };
  };
}

function findElement(tree: Element, role: string, name?: string): string {
  if (tree.role === role && (name === undefined || tree.name === name) && tree.ref_id) {
    return tree.ref_id;
  }
  for (const child of tree.children ?? []) {
    const ref = findElement(child, role, name);
    if (ref) return ref;
  }
  return "";
}

export async function proveDesktop(sandbox: Sandbox): Promise<void> {
  const directory = import.meta.dir;
  const command = async (cmd: string, args: string[]) => {
    // A possibly delivered UI action must never be replayed by the transport.
    const output = await sandbox.runCommand(cmd, args, { retry: false, timeoutMs: 300_000 });
    assert.equal(output.result.exit_code, 0, output.result.stderr || output.result.stdout);
    return output.result.stdout;
  };
  await sandbox.files.upload(
    "/tmp/createos-desktop-session.py",
    await Bun.file(`${directory}/session.py`).text(),
  );
  await sandbox.files.upload(
    "/tmp/createos-agent-desktop-setup.sh",
    await Bun.file(`${directory}/setup.sh`).text(),
  );
  await command("sh", ["/tmp/createos-agent-desktop-setup.sh"]);

  let session: string | undefined;
  const desktop = async (...args: string[]): Promise<DesktopResult> => {
    const stdout = await command("python3", [
      "/tmp/createos-desktop-session.py",
      "agent-desktop",
      ...(session ? ["--session", session] : []),
      ...args,
    ]);
    const result: DesktopResult = JSON.parse(stdout);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result;
  };
  const status = await desktop("status");
  assert.equal(status.data.permissions?.accessibility.state, "granted");
  assert.ok(status.data.supported_surfaces?.includes("window"));
  await desktop("skills", "get", "desktop");
  await desktop("skills", "get", "platform");
  session = (await desktop("session", "start", "--name", "createos-proof", "--no-trace")).data
    .session_id;
  assert.ok(session);
  try {
    await desktop("launch", "gnome-calculator");
    await desktop(
      "wait",
      "--window",
      "Calculator",
      "--app",
      "gnome-calculator",
      "--timeout",
      "10000",
    );
    for (const name of ["C", "7", "+", "5", "="]) {
      const snapshot = await desktop("snapshot", "--app", "gnome-calculator", "-i", "--compact");
      assert.equal(snapshot.data.complete, true);
      assert.ok(snapshot.data.tree);
      const ref = findElement(snapshot.data.tree, "button", name);
      assert.ok(ref, `Missing Calculator button ${name}`);
      await desktop("click", ref);
      // Observe after every mutation; take fresh refs for the next action.
      const after = await desktop("snapshot", "--app", "gnome-calculator", "-i", "--compact");
      assert.ok(after.data.tree);
      const display = findElement(after.data.tree, "textfield");
      assert.ok(display);
      const expected =
        name === "C" ? "" : name === "=" ? "12" : name === "5" ? "7+5" : name === "+" ? "7+" : "7";
      const verified = await desktop(
        "wait",
        "--element",
        display,
        "--predicate",
        "value",
        "--value",
        expected,
        "--timeout",
        "10000",
      );
      assert.equal(verified.data.found, true);
      console.log(`verified ${name}: ${expected || "empty"}`);
    }
    console.log("verified: semantic 7 + 5 = 12 through SDK runCommand");
  } finally {
    await desktop("session", "end", session);
  }
}

if (import.meta.main) {
  const sandbox = await Sandbox.create({ shape: "s-2vcpu-4gb", rootfs: "desktop:1" });
  try {
    console.log("created:", sandbox.id);
    await proveDesktop(sandbox);
  } finally {
    await sandbox.destroy();
  }
}
