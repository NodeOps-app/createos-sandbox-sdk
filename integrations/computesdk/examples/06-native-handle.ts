/**
 * 06 — The native escape hatch (`getInstance()`).
 *
 * ComputeSDK's portable surface deliberately doesn't model createos-sandbox-specific
 * features. `getInstance()` returns the underlying `createos-sandbox-sdk` `Sandbox`
 * handle so you can use them without leaving ComputeSDK: lifecycle
 * (pause/resume), live state (`refresh`/`data`), bandwidth top-up, and
 * attached disks.
 *
 *   CREATEOS_SANDBOX_API_KEY=usr_... CREATEOS_SANDBOX_BASE_URL=https://createos-sandbox.example.com \
 *     npx tsx 06-native-handle.ts
 */
import { createosSandbox } from "@computesdk/createos-sandbox";

async function main() {
  const provider = createosSandbox({});

  const sandbox = await provider.sandbox.create({ memoryMb: 1024, image: "devbox:1" });
  const native = sandbox.getInstance();

  try {
    // Live wire state straight off the handle.
    await native.refresh();
    console.log("status:", native.data.status, "shape:", native.data.shape);

    // Pause to free compute, then bring it back.
    await native.pause();
    await native.waitUntilPaused();
    console.log("paused");
    await native.resume();
    await native.waitUntilRunning();
    console.log("resumed");

    // Top up the egress bandwidth quota (bytes) — not settable at create time.
    const bw = await native.rechargeBandwidth(1_000_000_000);
    console.log("bandwidth quota bytes:", bw.quota_bytes, "remaining:", bw.remaining_bytes);

    // Any persistent disks attached to this sandbox.
    const disks = await native.listDisks();
    console.log("attached disks:", disks.map((d) => d.mount_path));
  } finally {
    await sandbox.destroy();
    console.log("destroyed");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
