/**
 * Bandwidth recharge — every sandbox starts on a server-assigned egress quota
 * (the default, 10 GiB). The quota can no longer be chosen at create time —
 * `bandwidth_quota_bytes` was removed from the create body in SDK 0.6.0 — so
 * `rechargeBandwidth` is the supported way to raise a running sandbox's cap.
 *
 * Run:   bun 39-bandwidth-recharge/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example). No external services.
 */
import { Sandbox } from "createos-sandbox-sdk";

const GiB = 1024 ** 3;

// `quota_bytes === -1` means unmetered; render that instead of a bogus size.
const fmt = (bytes: number): string =>
  bytes < 0 ? "unmetered" : `${(bytes / GiB).toFixed(2)} GiB`;

// 1. Create. The new sandbox lands on the default bandwidth quota — there is no
//    create-time field to pick a different one anymore.
const sandbox = await Sandbox.create({
  shape: "s-1vcpu-1gb",
  rootfs: "devbox:1",
});
console.log("created:", sandbox.id);

try {
  // 2. Read the quota + usage counters the control plane assigned at create.
  const before = await sandbox.getBandwidth();
  console.log(
    `initial:   quota=${fmt(before.quota_bytes)} used=${fmt(before.used_bytes)} ` +
      `remaining=${fmt(before.remaining_bytes)} capped=${before.capped}`,
  );

  // 3. Top up. rechargeBandwidth(addBytes) adds to the quota and returns the
  //    fresh counters — the only supported path to grow a live sandbox's cap.
  const add = 5 * GiB;
  const after = await sandbox.rechargeBandwidth(add);
  console.log(
    `recharged: +${fmt(add)} → quota=${fmt(after.quota_bytes)} ` +
      `remaining=${fmt(after.remaining_bytes)} capped=${after.capped}`,
  );

  // 4. Confirm the top-up landed. This is a delta check, so it holds regardless
  //    of the default quota's exact size. Skip it on unmetered sandboxes, where
  //    recharge is a no-op. Reported, not thrown — mirrors the leak check in 19.
  if (before.quota_bytes >= 0) {
    const grew = after.quota_bytes - before.quota_bytes;
    if (grew === add) {
      console.log(`quota grew by exactly ${fmt(add)} — recharge confirmed`);
    } else {
      console.error(`unexpected: quota grew by ${fmt(grew)}, expected ${fmt(add)}`);
    }
  }
} finally {
  // 5. Tear down. try/finally guarantees the VM is destroyed even on failure —
  //    otherwise the sandbox would keep billing.
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("destroyed");
}
