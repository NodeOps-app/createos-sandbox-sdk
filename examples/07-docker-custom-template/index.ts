/**
 * Docker custom template — build a bespoke rootfs from a Dockerfile, then run
 * Docker containers inside the microVM (Docker-in-microVM). Shows the full
 * template lifecycle: submit a build, follow its logs to ready, boot a sandbox
 * on it, and use the baked-in tooling.
 *
 * Run:   bun 07-docker-custom-template/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example). The DOCKERFILE below uses
 *        the createos-sandbox debian base image (bhautikchudasama/fc-base:debian-1). The
 *        in-VM `docker run` steps also need network egress to pull images.
 */
import { CreateosSandboxClient, pollUntil } from "createos-sandbox-sdk";

// Unique name per run so repeated runs don't collide on an existing template.
const TEMPLATE_NAME = `docker-ce-${Date.now()}`;
const SHAPE = "s-1vcpu-1gb";

// Installs Docker CE via the official convenience script.
// createos-sandbox v1 Dockerfile rules: single FROM (createos-sandbox-allowed base only), no COPY/ADD.
// Uses the createos-sandbox debian base (apt-based, required for Docker CE install).
const DOCKERFILE = `FROM bhautikchudasama/fc-base:debian-1

RUN apt-get update -qq \\
 && apt-get install -y --no-install-recommends curl ca-certificates \\
 && curl -fsSL https://get.docker.com | sh \\
 && rm -rf /var/lib/apt/lists/*
`;

// Template builds are a catalog-level operation, so go through CreateosSandboxClient
// directly rather than the per-sandbox Sandbox.create factory.
const box = new CreateosSandboxClient();

// 1. Submit the build. Returns immediately with a pending template; the actual
//    image build runs server-side.
console.log(`[1/5] submitting template build: ${TEMPLATE_NAME}`);
const tmpl = await box.templates.create({ name: TEMPLATE_NAME, dockerfile: DOCKERFILE });
console.log(`      template id: ${tmpl.id}  status: ${tmpl.status}`);

try {
  // 2. Follow the build logs until the build emits its final event.
  console.log("[2/5] streaming build logs...");
  try {
    for await (const event of box.templates.followLogs(tmpl.id)) {
      if (event.line) process.stdout.write(event.line + "\n");
      if (event.final) {
        console.log(`      build finished: ${event.status}`);
        break;
      }
    }
  } catch {
    // stream may close before a final event; confirm status via poll below
  }

  // Poll for terminal status — the log stream may close before the final event arrives.
  // The build has no inherent upper bound, so cap the wait at a generous 10 minutes.
  await pollUntil({
    poll: () => box.templates.get(tmpl.id).then((t) => t.status),
    done: (status) => status === "ready",
    failed: (status) =>
      status === "pending" || status === "building"
        ? undefined
        : `template build failed (${status}): see build logs above`,
    timeoutMs: 600_000,
  });
  console.log(`      template ready: ${tmpl.id}`);

  // 3. Boot a sandbox on the freshly built template (rootfs = the template id).
  console.log(`[3/5] creating sandbox (shape=${SHAPE}, rootfs=${tmpl.id})...`);
  const sandbox = await box.createSandbox({ shape: SHAPE, rootfs: tmpl.id });
  console.log(`      sandbox created: ${sandbox.id}`);

  try {
    // 4. Start the Docker daemon and wait for it. As in example 03, the daemon
    //    is detached (nohup setsid + redirected stdio) so the buffered runCommand
    //    returns instead of blocking on the long-lived process.
    // No systemd — daemonize dockerd with nohup setsid.
    console.log("[4/5] starting dockerd...");
    await sandbox.runCommand("sh", ["-c", "nohup setsid dockerd > /var/log/dockerd.log 2>&1 &"]);

    // Poll `docker info` until the daemon answers — dockerd needs a few seconds
    // to come up and the socket isn't ready the instant the command returns.
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

    // 5. Run containers inside the microVM — proof Docker-in-microVM works.
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
    // Nested teardown: destroy the sandbox first, then (outer finally) the
    // template. .catch(() => {}) so a failed cleanup can't mask the real error.
    await sandbox.destroy().catch(() => {});
    console.log(`\ndestroyed sandbox: ${sandbox.id}`);
  }
} finally {
  await box.templates.delete(tmpl.id).catch(() => {});
  console.log(`deleted template:  ${tmpl.id}`);
}
