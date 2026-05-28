import { FcClient } from "fc-sandbox-sdk";

const TEMPLATE_NAME = `docker-ce-${Date.now()}`;
const SHAPE = "s-1vcpu-1gb";

// Installs Docker CE via the official convenience script.
// FC v1 Dockerfile rules: single FROM (fc-allowed base only), no COPY/ADD.
const DOCKERFILE = `FROM bhautikchudasama/fc-base:debian-1

RUN apt-get update -qq \\
 && apt-get install -y --no-install-recommends curl ca-certificates \\
 && curl -fsSL https://get.docker.com | sh \\
 && rm -rf /var/lib/apt/lists/*
`;

const fc = new FcClient();

console.log(`[1/5] submitting template build: ${TEMPLATE_NAME}`);
const tmpl = await fc.templates.create({ name: TEMPLATE_NAME, dockerfile: DOCKERFILE });
console.log(`      template id: ${tmpl.id}  status: ${tmpl.status}`);

try {
  console.log("[2/5] streaming build logs...");
  try {
    for await (const event of fc.templates.followLogs(tmpl.id)) {
      if (event.line) process.stdout.write(event.line + "\n");
      if (event.final) {
        console.log(`      build finished: ${event.status}`);
        break;
      }
    }
  } catch {
    // stream may close before a final event; confirm status via poll below
  }

  // Confirm status via direct API call — the stream may not deliver a final event.
  let { status } = await fc.templates.get(tmpl.id);
  while (status === "pending" || status === "building") {
    await new Promise<void>((r) => setTimeout(r, 3_000));
    ({ status } = await fc.templates.get(tmpl.id));
  }
  if (status !== "ready") {
    throw new Error(`template build failed (${status}): see build logs above`);
  }
  console.log(`      template ready: ${tmpl.id}`);

  console.log(`[3/5] creating sandbox (shape=${SHAPE}, rootfs=${tmpl.id})...`);
  const sandbox = await fc.createSandbox({ shape: SHAPE, rootfs: tmpl.id });
  console.log(`      sandbox created: ${sandbox.id}`);

  try {
    // No systemd — daemonize dockerd with nohup setsid.
    console.log("[4/5] starting dockerd...");
    await sandbox.runCommand("sh", ["-c", "nohup setsid dockerd > /var/log/dockerd.log 2>&1 &"]);

    let ready = false;
    for (let i = 0; i < 30; i++) {
      const { result } = await sandbox.runCommand(
        "docker",
        ["info", "--format", "{{.ServerVersion}}"],
        {
          timeoutMs: 5_000,
        },
      );
      if (result.exit_code === 0) {
        console.log(`      dockerd ready  (server version: ${result.stdout.trim()})`);
        ready = true;
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 2_000));
    }
    if (!ready) throw new Error("dockerd did not start within 60 s");

    console.log("[5/5] running containers...\n");

    console.log("── docker run hello-world ──────────────────────────────────────");
    const hw = await sandbox.runCommand("docker", ["run", "--rm", "hello-world"], {
      timeoutMs: 120_000,
    });
    console.log(hw.result.stdout.trim());

    console.log("\n── docker run alpine ───────────────────────────────────────────");
    const alp = await sandbox.runCommand(
      "docker",
      ["run", "--rm", "alpine", "sh", "-c", "echo hello from alpine && cat /etc/alpine-release"],
      { timeoutMs: 60_000 },
    );
    console.log(alp.result.stdout.trim());

    console.log("\n── docker images ───────────────────────────────────────────────");
    const imgs = await sandbox.runCommand("docker", ["images"]);
    console.log(imgs.result.stdout.trim());
  } finally {
    await sandbox.destroy().catch(() => {});
    console.log(`\ndestroyed sandbox: ${sandbox.id}`);
  }
} finally {
  await fc.templates.delete(tmpl.id).catch(() => {});
  console.log(`deleted template:  ${tmpl.id}`);
}
