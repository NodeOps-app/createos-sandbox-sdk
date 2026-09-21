/** Delegate runtime access to one sandbox, then revoke it. */
import { CreateosSandboxClient } from "createos-sandbox-sdk";
import { runWorker } from "./worker.ts";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ shape: "s-1vcpu-1gb", rootfs: "devbox:1" });

try {
  const ownerOutput = await sandbox.runCommand("sh", ["-c", "echo owner-direct"]);
  console.log(ownerOutput.result.stdout);

  const created = await sandbox.createAccessToken();
  // Transfer created.token to the worker through your application's secret channel.
  // This example keeps it in memory and never prints it.
  const worker = sandbox.withAccessToken(created.token);
  const output = await worker.runCommand("sh", ["-c", "echo hello"]);
  console.log(output.result.stdout);

  const metadata = await sandbox.getAccessToken();
  console.log("enabled:", metadata.enabled, "hint:", metadata.token_hint);

  const replacement = await sandbox.rotateAccessToken();
  // A separate worker can reconnect using only the sandbox id and new token.
  console.log(await runWorker(sandbox.id, replacement.token, "rotated"));

  await sandbox.disableAccessToken();
} finally {
  await sandbox.destroy();
}
