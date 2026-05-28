import { Sandbox } from "fc-sandbox-sdk";

const sandbox = await Sandbox.create({
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
  ingress_enabled: true,
});
console.log("created:", sandbox.id);

try {
  // devbox:1 has no systemd — daemonise with nohup/setsid.
  // Bind 0.0.0.0: ingress forwards to eth0, not loopback.
  await sandbox.runCommand("sh", [
    "-c",
    'mkdir -p /srv && echo "<h1>hello from fc preview URL</h1>" > /srv/index.html && cd /srv && nohup setsid python3 -m http.server 8080 --bind 0.0.0.0 >/tmp/srv.log 2>&1 &',
  ]);

  await sandbox.waitForPortReady(8080, { timeoutMs: 10_000 });

  const ulid = sandbox.id.replace(/^sb-/, "");
  const url = `http://${ulid}-8080.eu.bhautik.in/`;
  console.log("URL:", url);

  console.log("--- response ---");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  process.stdout.write(await res.text());
} finally {
  await sandbox.destroy();
  console.log("destroyed");
}
