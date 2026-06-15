/**
 * PostgreSQL as a filesystem — TigerFS mounts a Postgres database as a FUSE
 * tree, so files written under the mount land as rows in the DB. This runs the
 * whole stack inside one microVM: install + start Postgres without systemd
 * (`pg_ctlcluster`), install TigerFS, `migrate` the schema, `mount` it over
 * FUSE, write a markdown note through the filesystem, then prove via `psql`
 * that the note is a row in `tigerfs.notes`. The SDK's role is the orchestrator
 * — every step is a `runCommand` against the sandbox.
 *
 * Run:   bun 11-tigerfs-postgres-filesystem/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example). The sandbox needs
 *        outbound network to fetch the TigerFS installer (install.tigerfs.io).
 */
import { CreateosSandboxClient } from "createos-sandbox-sdk";
import { readFileSync } from "node:fs";

const SHAPE = "s-2vcpu-2gb";
const PG_USER = "demo";
const PG_PASSWORD = "demo";
const PG_DB = "demodb";
const MOUNT = "/mnt/db";

const box = new CreateosSandboxClient();

console.log(`[1/9] creating sandbox (shape=${SHAPE}, rootfs=devbox:1)...`);
const sandbox = await box.createSandbox({
  shape: SHAPE,
  rootfs: "devbox:1",
  envs: {
    PGPASSWORD: PG_PASSWORD,
    DEBIAN_FRONTEND: "noninteractive",
  },
});
console.log(`      sandbox: ${sandbox.id}  ip: ${sandbox.ip}`);

try {
  console.log("[2/9] installing postgresql-18 (PGDG) + python3 (apt-get)...");
  const apt = await sandbox.sh(
    [
      "set -e",
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3",
      "curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg",
      'echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release; echo $VERSION_CODENAME)-pgdg main" > /etc/apt/sources.list.d/pgdg.list',
      "apt-get update -qq && apt-get install -y --no-install-recommends postgresql-18",
    ].join(" && "),
    { label: "apt-get install", timeoutMs: 420_000 },
  );
  console.log(`      apt-get done (${apt.exec_ms} ms)`);

  console.log("[3/9] starting postgres cluster (no systemd, use pg_ctlcluster)...");
  const pgVer = await sandbox.runCommand("bash", ["-lc", "ls /usr/lib/postgresql/ | head -1"]);
  const PG_VERSION = pgVer.result.stdout.trim();
  if (!PG_VERSION) throw new Error("could not detect postgres version");
  console.log(`      postgres version: ${PG_VERSION}`);

  const pgStart = await sandbox.runCommand("bash", [
    "-lc",
    `pg_ctlcluster ${PG_VERSION} main start && pg_lsclusters`,
  ]);
  console.log(pgStart.result.stdout.trim());
  if (pgStart.result.exit_code !== 0) {
    throw new Error(`pg_ctlcluster start failed:\n${pgStart.result.stderr}`);
  }

  console.log(`[4/9] provisioning ${PG_DB} / ${PG_USER}...`);
  await sandbox.sh(
    [
      `su - postgres -c "psql -v ON_ERROR_STOP=1 -c \\"CREATE USER ${PG_USER} WITH PASSWORD '${PG_PASSWORD}' SUPERUSER;\\""`,
      `su - postgres -c "psql -v ON_ERROR_STOP=1 -c \\"CREATE DATABASE ${PG_DB} OWNER ${PG_USER};\\""`,
    ].join(" && "),
    { label: "provision" },
  );
  console.log("      role + database created");

  console.log("[5/9] installing TigerFS (curl -fsSL https://install.tigerfs.io | sh)...");
  const tigerInstall = await sandbox.sh(
    "curl -fsSL https://install.tigerfs.io | sh && ln -sf /root/bin/tigerfs /usr/local/bin/tigerfs && tigerfs version",
    { label: "tigerfs install", timeoutMs: 180_000 },
  );
  console.log(tigerInstall.result.stdout.trim());

  const TIGER_VERSION = (tigerInstall.result.stdout.match(/tigerfs\s+v?[\d.]+/i) ?? ["unknown"])[0];

  const PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:5432/${PG_DB}`;

  console.log("[6/9] running tigerfs migrate (creates schema on empty db)...");
  const migrate = await sandbox.runCommand(
    "bash",
    ["-lc", `tigerfs migrate --insecure-no-ssl '${PG_URL}'`],
    { timeoutMs: 120_000 },
  );
  console.log(migrate.result.stdout.trim() || "(no output)");
  if (migrate.result.stderr) console.log("      stderr:", migrate.result.stderr.trim());

  console.log(`[7/9] mounting ${PG_DB} at ${MOUNT} via FUSE (background)...`);
  await sandbox.runCommand("bash", ["-lc", `mkdir -p ${MOUNT}`]);
  await sandbox.runCommand("bash", [
    "-lc",
    `nohup setsid tigerfs mount --insecure-no-ssl '${PG_URL}' ${MOUNT} >/var/log/tigerfs.log 2>&1 &`,
  ]);

  // The mount ran detached (nohup setsid), so FUSE attaches asynchronously —
  // poll `mountpoint` until the kernel reports the mount is live.
  let mounted = false;
  for (let i = 0; i < 30; i++) {
    const check = await sandbox.runCommand("bash", [
      "-lc",
      `mountpoint -q ${MOUNT} && echo ok || echo nope`,
    ]);
    if (check.result.stdout.trim() === "ok") {
      mounted = true;
      break;
    }
    await sandbox.runCommand("bash", ["-lc", "sleep 1"]);
  }
  if (!mounted) {
    const log = await sandbox.runCommand("bash", ["-lc", "tail -40 /var/log/tigerfs.log"]);
    throw new Error(`tigerfs mount did not surface within 30 s. Log:\n${log.result.stdout}`);
  }
  console.log(`      mounted: ${MOUNT}`);

  const info = await sandbox.runCommand("bash", ["-lc", `tigerfs info ${MOUNT}`]);
  console.log(info.result.stdout.trim());

  console.log("[8/9] creating file-first markdown app + seed note...");
  // plain `markdown` app — `markdown,history` would require the TimescaleDB
  // extension, which the stock Debian `postgresql` package does not ship.
  await sandbox.sh(`echo "markdown" > ${MOUNT}/.build/notes`, { label: "build app" });

  // Writing the app name into .build/notes is TigerFS's provision trigger; the
  // backing notes/ directory materialises lazily once TigerFS processes it.
  let notesDir = false;
  for (let i = 0; i < 20; i++) {
    const probe = await sandbox.runCommand("bash", [
      "-lc",
      `test -d ${MOUNT}/notes && echo yes || echo no`,
    ]);
    if (probe.result.stdout.trim() === "yes") {
      notesDir = true;
      break;
    }
    await sandbox.runCommand("bash", ["-lc", "sleep 1"]);
  }
  if (!notesDir) {
    const dbg = await sandbox.runCommand("bash", [
      "-lc",
      `ls -a ${MOUNT}; echo ---; ls -a ${MOUNT}/.build/; echo ---; tail -40 /var/log/tigerfs.log`,
    ]);
    throw new Error(`notes/ dir never appeared:\n${dbg.result.stdout}`);
  }
  console.log(`      notes/ dir is live`);

  const helloMd =
    "---\n" +
    "title: Hello World\n" +
    "author: createos-sandbox-sdk-example\n" +
    "---\n" +
    "# Hello from TigerFS\n" +
    "\n" +
    "This markdown file is stored as a row in Postgres.\n";
  await sandbox.files.upload("/tmp/hello.md", helloMd);
  const seed = await sandbox.sh(`cp /tmp/hello.md ${MOUNT}/notes/hello.md && ls ${MOUNT}/notes/`, {
    label: "seed",
  });
  console.log(`      notes/: ${seed.result.stdout.trim()}`);

  console.log("[9/9] uploading hello.py and running it inside the sandbox...");
  const helloPy = readFileSync(new URL("./hello.py", import.meta.url), "utf8");
  await sandbox.files.upload("/root/hello.py", helloPy);

  console.log("── python3 /root/hello.py ───────────────────────────────────────");
  const py = await sandbox.runCommand("python3", ["/root/hello.py"]);
  process.stdout.write(py.result.stdout);
  if (py.result.stderr) process.stderr.write(py.result.stderr);
  if (py.result.exit_code !== 0) {
    throw new Error(`hello.py exited ${py.result.exit_code}`);
  }

  console.log("\n── psql proof: rows backing the filesystem ──────────────────────");
  const schema = await sandbox.runCommand("bash", [
    "-lc",
    `su - postgres -c "psql -d ${PG_DB} -c '\\d tigerfs.notes'"`,
  ]);
  process.stdout.write(schema.result.stdout);

  const rows = await sandbox.runCommand("bash", [
    "-lc",
    // Schema is small — list every column. \x on toggles expanded output so
    // long markdown bodies stay readable in the terminal.
    `su - postgres -c "psql -d ${PG_DB} -c '\\x on' -c 'SELECT * FROM tigerfs.notes ORDER BY 1'"`,
  ]);
  process.stdout.write(rows.result.stdout);

  console.log(`\nverified end-to-end. tigerfs build: ${TIGER_VERSION}, postgres: ${PG_VERSION}`);
} finally {
  console.log("\nunmounting tigerfs...");
  await sandbox
    .runCommand("bash", ["-lc", `tigerfs unmount ${MOUNT} || fusermount3 -u ${MOUNT} || true`])
    .catch(() => {});
  await sandbox.destroy().catch(() => {});
  console.log(`destroyed sandbox: ${sandbox.id}`);
}
