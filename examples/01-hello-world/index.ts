import { Sandbox } from "fc-sandbox-sdk";

const sandbox = await Sandbox.create({
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
});
console.log("created:", sandbox.id);

try {
  const uname = await sandbox.runCommand("uname", ["-a"]);
  process.stdout.write(uname.result.stdout);

  const osr = await sandbox.runCommand("cat", ["/etc/os-release"]);
  process.stdout.write(osr.result.stdout);
} finally {
  await sandbox.destroy();
  console.log("destroyed");
}
