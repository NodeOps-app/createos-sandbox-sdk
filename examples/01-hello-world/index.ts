/**
 * Hello world — the smallest end-to-end smoke test: create a sandbox, run two
 * buffered commands inside it, destroy it. The shortest path to confirming your
 * credentials and the control plane are wired up correctly.
 *
 * Run:   bun 01-hello-world/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). No external services.
 */
import { Sandbox } from "fc-sandbox-sdk";

// 1. Create. Sandbox.create is the client-less factory — it builds the FcClient
//    from FC_BASE_URL / FC_API_KEY and does not resolve until the VM is `running`.
const sandbox = await Sandbox.create({
  // smallest shape — this smoke test runs a single command
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
});
console.log("created:", sandbox.id);

try {
  // 2. Run. runCommand is buffered: it blocks until the process exits and
  //    returns the full stdout/stderr/exit_code (vs streamCommand for live output).
  const uname = await sandbox.runCommand("uname", ["-a"]);
  process.stdout.write(uname.result.stdout);

  const osr = await sandbox.runCommand("cat", ["/etc/os-release"]);
  process.stdout.write(osr.result.stdout);
} finally {
  // 3. Tear down. try/finally guarantees the VM is destroyed even if a command
  //    throws — otherwise the sandbox would keep billing.
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("destroyed");
}
