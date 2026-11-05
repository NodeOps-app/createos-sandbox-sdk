import { CreateosSandboxClient } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();
const sandbox = await client.createSandbox({ shape: "s-1vcpu-1gb", rootfs: "devbox:1" });

try {
  await sandbox.sh("mkdir -p /root/project && printf version-1 > /root/project/version");
  const checkpoint = await sandbox.checkpoints.create({
    path: "/root/project",
    name: "before-update",
  });

  await sandbox.sh("printf version-2 > /root/project/version");
  await sandbox.checkpoints.restore(checkpoint.id);
  const restored = await sandbox.sh("cat /root/project/version");
  console.log(`Restored ${restored.result.stdout.trim()}.`);

  await sandbox.checkpoints.delete(checkpoint.id);
} finally {
  await sandbox.destroy();
}
