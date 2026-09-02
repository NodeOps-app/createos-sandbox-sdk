/**
 * Desktop noVNC connect — create a graphical desktop sandbox, capture PNGs,
 * use basic computer controls, and mint a noVNC URL for screen-0.
 *
 * Run:   bun 55-desktop-vnc-connect/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example).
 */
import { Sandbox } from "createos-sandbox-sdk";

const SCREEN_ID = "screen-0";

const sandbox = await Sandbox.create({
  shape: "s-2vcpu-4gb",
  rootfs: "desktop:1",
  ingress_enabled: true,
});
console.log("created:", sandbox.id);

try {
  console.log("\n[1/5] reading primary screen...");
  // The desktop stack boots after the sandbox does: every computer call 409s
  // with `desktop_unavailable` until it is up.
  const desktopDeadline = Date.now() + 120_000;
  const geometry = await sandbox.computer.screen({ screenId: SCREEN_ID }).catch(async (err) => {
    while (Date.now() < desktopDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const screen = await sandbox.computer.screen({ screenId: SCREEN_ID }).catch(() => undefined);
      if (screen) return screen;
    }
    throw err;
  });
  const screens = await sandbox.computer.screens.list();
  const primary = await sandbox.computer.screens.get(SCREEN_ID);
  console.log(`      geometry: ${geometry.width}x${geometry.height}`);
  console.log(`      screens: ${screens.map((screen) => screen.screen_id).join(", ")}`);
  console.log(`      primary display: ${primary.display}, noVNC port ${primary.novnc_port}`);

  console.log("\n[2/5] capturing PNG screenshots...");
  const fullPng = await sandbox.computer.screenshot({
    screenId: SCREEN_ID,
    timeoutMs: 45_000,
  });
  const fullSize = pngSize(fullPng);
  console.log(`      full screenshot: ${fullSize.width}x${fullSize.height}`);

  const regionPng = await sandbox.computer.screenshot({
    screenId: SCREEN_ID,
    x: 0,
    y: 0,
    width: 240,
    height: 160,
    timeoutMs: 45_000,
  });
  const regionSize = pngSize(regionPng);
  console.log(`      region screenshot: ${regionSize.width}x${regionSize.height}`);

  console.log("\n[3/5] moving cursor and round-tripping clipboard...");
  const target = {
    x: Math.min(Math.max(Math.floor(geometry.width / 3), 10), geometry.width - 1),
    y: Math.min(Math.max(Math.floor(geometry.height / 3), 10), geometry.height - 1),
  };
  await sandbox.computer.mouse.move(target, { screenId: SCREEN_ID });
  const cursor = await sandbox.computer.cursor({ screenId: SCREEN_ID });
  console.log(`      cursor: ${cursor.x},${cursor.y}`);

  const clipboardText = `CreateOS desktop ${sandbox.id}`;
  await sandbox.computer.setClipboard(clipboardText, { screenId: SCREEN_ID });
  const clipboard = await sandbox.computer.clipboard({ screenId: SCREEN_ID });
  console.log(`      clipboard: ${clipboard.text}`);

  console.log("\n[4/5] opening a URL in the desktop browser...");
  await sandbox.computer.open("https://example.com", { screenId: SCREEN_ID });
  console.log("      opened: https://example.com");

  console.log("\n[5/5] creating live noVNC connection...");
  const connection = await sandbox.computer.screens.connect(SCREEN_ID);
  console.log(`      screen: ${connection.screen_id}`);
  console.log(`      expires: ${connection.expires_at}`);
  console.log(`      noVNC URL: ${connection.url ?? "(not available)"}`);

  if (screens.length === 0 || primary.screen_id !== SCREEN_ID) {
    throw new Error("primary screen was not listed");
  }
  if (fullSize.width !== geometry.width || fullSize.height !== geometry.height) {
    throw new Error("full screenshot dimensions did not match screen geometry");
  }
  if (regionSize.width !== 240 || regionSize.height !== 160) {
    throw new Error("region screenshot dimensions did not match request");
  }
  if (cursor.x !== target.x || cursor.y !== target.y) {
    throw new Error("cursor did not move to requested coordinates");
  }
  if (clipboard.text !== clipboardText) {
    throw new Error("clipboard round trip failed");
  }
  if (!connection.url || !connection.url.startsWith("https://")) {
    throw new Error("noVNC connection did not include a public HTTPS URL");
  }

  console.log("\nverified end-to-end: desktop computer API and noVNC connection");
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("destroyed");
}

function pngSize(buffer: ArrayBuffer): { width: number; height: number } {
  const bytes = new Uint8Array(buffer);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) {
    throw new Error("response is not a PNG");
  }
  const view = new DataView(buffer);
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}
