/**
 * Idle auto-pause — the control plane can pause a sandbox after a stretch of no
 * detected activity, so an idle VM stops billing without the client polling for
 * idleness itself. The timeout is set at create with `auto_pause_after_seconds`
 * and changed on a live sandbox with `setAutoPause(seconds | null)`.
 *
 * Run:   bun 40-idle-auto-pause/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). No external services.
 */
import { Sandbox } from "fc-sandbox-sdk";

// 1. Create with an idle timeout baked in: pause after 5 min (300 s) without
//    activity. Valid range is 60–86400 (1 min – 24 h); the server rejects
//    anything outside it. Omit the field to leave auto-pause off.
const sandbox = await Sandbox.create({
  shape: "s-1vcpu-1gb",
  rootfs: "devbox:1",
  auto_pause_after_seconds: 300,
});
console.log(`created: ${sandbox.id}  auto-pause=${sandbox.data.auto_pause_after_seconds}s`);

try {
  // 2. Change the timeout on the live sandbox. setAutoPause PATCHes the VM and
  //    refreshes the handle, so `data` reflects the new value immediately.
  await sandbox.setAutoPause(600);
  console.log(`updated:  auto-pause=${sandbox.data.auto_pause_after_seconds}s`);

  // 3. Disable it. Passing null clears the timeout — the server cannot express
  //    "clear a nullable int" through omitempty, so the SDK sends
  //    `disable_auto_pause` rather than an absent field (which would mean
  //    "leave unchanged"). The refreshed view drops the key entirely.
  await sandbox.setAutoPause(null);
  console.log(`disabled: auto-pause=${sandbox.data.auto_pause_after_seconds ?? "off"}`);
} finally {
  // 4. Tear down. try/finally guarantees the VM is destroyed even on failure —
  //    otherwise the sandbox would keep billing until its idle timeout fired.
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("destroyed");
}
