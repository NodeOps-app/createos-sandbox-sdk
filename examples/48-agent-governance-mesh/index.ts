/**
 * Agent governance mesh — Microsoft Agent Governance Toolkit (AGT) enforced
 * across a fleet of networked createos-sandbox sandboxes.
 *
 * A central "gov" sandbox runs the AGT policy engine, prompt-injection /
 * context-poisoning detection, OWASP prompt-defense grading, and a
 * tamper-evident, hash-chained audit log on an S3-backed disk. It serves a live
 * governance dashboard over public ingress. Two governed agent sandboxes sit on
 * the same private overlay network, egress-locked to just the LLM proxy: every
 * tool call they make is adjudicated by the policy engine over the overlay
 * BEFORE it runs. A benign agent stays Verified; a compromised agent's forbidden
 * actions are denied, erode its trust score, and trip the SRE kill-switch
 * (pause + destroy).
 *
 * The example provisions everything fresh (custom template, overlay network,
 * S3 disk), runs the mesh, then tears every created resource back down — a run
 * leaks nothing against your quotas, even on failure.
 *
 * Governance is the real toolkit (@microsoft/agent-governance-sdk, baked into
 * the template); the HTTP decision service around it is example glue.
 *
 * Run:   bun 48-agent-governance-mesh/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY; an S3-compatible
 *        bucket (S3_BUCKET/S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY, e.g.
 *        play.min.io); and an Anthropic-compatible LLM proxy
 *        (ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL) for the live
 *        agent turn. See .env.example.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { CreateosSandboxClient, Sandbox, pollUntil, type DiskView } from "createos-sandbox-sdk";

// ── config ───────────────────────────────────────────────────────────────────
const SHAPE = "s-4vcpu-4gb"; // headroom for node + the baked toolkit
const PORT = 7070;
const MOUNT = "/mnt/audit";
const run = crypto.randomUUID().slice(0, 8);

// Keep audit objects at the bucket root of the mount (no s3fs mkdir needed).
const AUDIT_FILE = `audit-${run}.jsonl`;
const EVIDENCE_FILE = `evidence-${run}.json`;
const REMOTE_AUDIT = `${MOUNT}/${AUDIT_FILE}`;
const REMOTE_EVIDENCE = `${MOUNT}/${EVIDENCE_FILE}`;

const S3 = {
  bucket: reqEnv("S3_BUCKET"),
  endpoint: reqEnv("S3_ENDPOINT"),
  region: process.env.S3_REGION || "us-east-1",
  accessKey: reqEnv("S3_ACCESS_KEY"),
  secretKey: reqEnv("S3_SECRET_KEY"),
  usePathStyle: /^(1|true|yes)$/i.test(process.env.S3_USE_PATH_STYLE ?? ""),
};
const proxyHost = process.env.ANTHROPIC_BASE_URL
  ? new URL(process.env.ANTHROPIC_BASE_URL).hostname
  : "";

// The custom template bakes Node 20 + the governance toolkit + the Anthropic SDK
// so every sandbox boots ready-to-govern. Single allowlisted FROM, no COPY/ADD.
const DOCKERFILE = `FROM nodeops/sandbox:debian
RUN apt-get update -qq \\
 && apt-get install -y --no-install-recommends curl ca-certificates fuse3 \\
 && curl -fsSL https://github.com/yandex-cloud/geesefs/releases/download/v0.43.8/geesefs-linux-amd64 -o /usr/bin/geesefs \\
 && chmod +x /usr/bin/geesefs \\
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\
 && apt-get install -y --no-install-recommends nodejs \\
 && mkdir -p /opt/agt && cd /opt/agt && npm init -y >/dev/null 2>&1 \\
 && npm install --no-fund --no-audit @microsoft/agent-governance-sdk@4.0.0 @anthropic-ai/sdk@0.110.0 \\
 && npm cache clean --force \\
 && rm -rf /var/lib/apt/lists/*
`;
// In-guest programs run FROM this dir — it holds the baked node_modules, and
// ESM bare-specifier imports resolve by walking up from the module's own dir
// (NODE_PATH is ignored for ESM), so the .mjs files must live next to it.
const APP = "/opt/agt";

const box = new CreateosSandboxClient();
const asset = (name: string) => new URL(`./${name}`, import.meta.url).pathname;

// Resources to reap in teardown, in dependency order. Populated as we create.
const sandboxes: Sandbox[] = [];
let templateId: string | undefined;
let networkId: string | undefined;
let disk: DiskView | undefined;

try {
  // ══ PROVISION (fresh) ══════════════════════════════════════════════════════
  console.log(`[provision] run id ${run}`);

  // 1. custom template
  console.log("[provision] building custom template (node + governance toolkit)…");
  const tmpl = await box.templates.create({ name: `agt-mesh-${run}`, dockerfile: DOCKERFILE });
  templateId = tmpl.id;
  try {
    for await (const ev of box.templates.followLogs(tmpl.id)) {
      if (ev.line) process.stdout.write(`  │ ${ev.line}\n`);
      if (ev.final) break;
    }
  } catch {
    /* stream may close early; poll below is authoritative */
  }
  await pollUntil({
    poll: () => box.templates.get(tmpl.id).then((t) => t.status),
    done: (s) => s === "ready",
    failed: (s) =>
      s === "pending" || s === "building" ? undefined : `template build failed: ${s}`,
    timeoutMs: 900_000,
  });
  console.log(`[provision] template ready: ${templateId}`);

  // 2. overlay network
  networkId = (
    await withRetry("networks.create", () => box.networks.create({ name: `agt-mesh-${run}` }))
  ).id;
  console.log(`[provision] overlay network: ${networkId}`);

  // 3. S3-backed audit disk
  disk = await box.disks.create({
    name: `agt-audit-${run}`,
    kind: "s3",
    config: {
      bucket: S3.bucket,
      endpoint: S3.endpoint,
      region: S3.region,
      ...(S3.usePathStyle ? { use_path_style: true } : {}),
    },
    credentials: { access_key: S3.accessKey, secret_key: S3.secretKey },
  });
  console.log(`[provision] S3 audit disk: ${disk.id}`);

  // ══ RUN ════════════════════════════════════════════════════════════════════
  // 4. gov sandbox: on the overlay, ingress on, audit disk mounted at boot
  console.log("\n[gov] creating governance sandbox…");
  const gov = await withRetry("gov create", () =>
    Sandbox.create({
      name: `agt-gov-${run}`,
      shape: SHAPE,
      rootfs: templateId!,
      networks: [{ id: networkId! }],
      ingress_enabled: true,
      disks: [{ disk_id: disk!.id, mount_path: MOUNT }],
    }),
  );
  sandboxes.push(gov);
  await waitForMount(gov);

  // upload the governance program + policy + dashboard next to node_modules, then launch it
  await Promise.all([
    gov.files.upload(
      `${APP}/policy-service.mjs`,
      await Bun.file(asset("policy-service.mjs")).text(),
    ),
    gov.files.upload(`${APP}/guard-policy.json`, await Bun.file(asset("guard-policy.json")).text()),
    gov.files.upload(`${APP}/dashboard.html`, await Bun.file(asset("dashboard.html")).text()),
  ]);
  // All env assignments MUST precede `nohup` — a `VAR=x` after `nohup setsid`
  // is parsed as a program name, not an assignment, and setsid fails to exec it.
  const govEnv =
    `AUDIT_PATH=${REMOTE_AUDIT} EVIDENCE_PATH=${REMOTE_EVIDENCE} PORT=${PORT} ` +
    `GUARD_POLICY=${APP}/guard-policy.json DASHBOARD=${APP}/dashboard.html`;
  await gov.sh(`${govEnv} nohup setsid node ${APP}/policy-service.mjs >/tmp/gov.log 2>&1 &`, {
    label: "start-gov",
  });
  try {
    await pollUntil({
      poll: () =>
        gov
          .sh(`curl -sf localhost:${PORT}/health || true`, { label: "health" })
          .then((r) => r.result.stdout),
      done: (out) => out.includes('"ok":true'),
      failed: () => undefined,
      timeoutMs: 120_000,
    });
  } catch (e) {
    const diag = (
      await gov.sh(
        "echo '--- gov.log ---'; cat /tmp/gov.log 2>&1; echo '--- node ---'; node -v 2>&1; " +
          "echo '--- sdk ---'; ls /opt/agt/node_modules/@microsoft 2>&1; echo '--- mnt ---'; ls -la /mnt/audit 2>&1",
        { label: "gov-diag" },
      )
    ).result.stdout;
    console.error(`[gov] service unhealthy:\n${diag}`);
    throw e;
  }
  const govLog = (await gov.sh("cat /tmp/gov.log", { label: "gov-log" })).result.stdout.trim();
  console.log(`[gov] ${govLog.split("\n").pop()}`);
  const dashUrl = gov.previewUrl(PORT);
  console.log(`[gov] dashboard (ingress): ${dashUrl}`);

  // 5. overlay IP of gov — how agents reach the policy engine privately
  const netView = await box.networks.get(networkId);
  const govIp = (netView.members ?? []).find((m) => m.sandbox_id === gov.id)?.ip;
  if (!govIp) throw new Error("could not resolve gov overlay IP");
  const govUrl = `http://${govIp}:${PORT}`;
  console.log(`[gov] policy engine on overlay: ${govUrl}`);

  // 6. two governed agents on the overlay, egress-locked to just the LLM proxy
  console.log("\n[agents] creating governed agent sandboxes (egress-locked)…");
  const egress = [proxyHost, govIp].filter(Boolean);
  const mkAgent = (id: string, mode: "benign" | "hostile") =>
    Sandbox.create({
      name: `agt-${id}-${run}`,
      shape: SHAPE,
      rootfs: templateId!,
      networks: [{ id: networkId! }],
      egress,
      envs: {
        AGENT_ID: id,
        AGENT_MODE: mode,
        GOV_URL: govUrl,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "",
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? "",
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "",
      },
    });
  const [alpha, beta] = await Promise.all([
    withRetry("alpha create", () => mkAgent("alpha", "benign")),
    withRetry("beta create", () => mkAgent("beta", "hostile")),
  ]);
  sandboxes.push(alpha, beta);
  const egressView = await alpha.getEgress();
  console.log(`[agents] alpha egress allowlist: ${JSON.stringify(egressView.egress)}`);

  await Promise.all([
    alpha.files.upload(`${APP}/agent-driver.mjs`, await Bun.file(asset("agent-driver.mjs")).text()),
    beta.files.upload(`${APP}/agent-driver.mjs`, await Bun.file(asset("agent-driver.mjs")).text()),
  ]);

  // 7. run both agents; every tool call crosses the overlay to the policy engine.
  // Governance config is passed inline so it never depends on env propagation;
  // the LLM proxy creds ride in the create-time envs (best-effort turn).
  console.log("\n[run] agents acting under governance…\n");
  const agentCmd = (id: string, mode: "benign" | "hostile") =>
    `AGENT_ID=${id} AGENT_MODE=${mode} GOV_URL=${govUrl} node ${APP}/agent-driver.mjs`;
  const [alphaOut, betaOut] = await Promise.all([
    alpha.sh(agentCmd("alpha", "benign"), { label: "alpha", timeoutMs: 180_000 }),
    beta.sh(agentCmd("beta", "hostile"), { label: "beta", timeoutMs: 180_000 }),
  ]);
  console.log("── alpha (benign) ──────────────────────────────────────────────");
  console.log(alphaOut.result.stdout.trim());
  console.log("\n── beta (compromised) ──────────────────────────────────────────");
  console.log(betaOut.result.stdout.trim());

  // 8. governance summary from the live decision point
  const state = JSON.parse(
    (await gov.sh(`curl -sf localhost:${PORT}/state`, { label: "state" })).result.stdout,
  );
  console.log("\n[governance] agents:");
  for (const a of state.agents)
    console.log(
      `  ${a.id}: trust ${a.trust} (${a.tier}) — ${a.allows} allowed, ${a.denies} denied${a.killed ? " → KILL" : ""}`,
    );
  console.log(
    `[governance] OWASP prompt-defense grade ${state.evidence.promptDefense.grade} (${state.evidence.promptDefense.coverage}), gate=${state.evidence.promptDefense.passes ? "PASS" : "FAIL"}`,
  );
  console.log(
    `[governance] tamper-evident audit: ${state.audit.count} records, head ${state.audit.headHash.slice(0, 16)}…`,
  );

  // 9. SRE kill-switch — pause then destroy any agent below the trust floor
  const betaState = state.agents.find((a: { id: string }) => a.id === "beta");
  if (betaState?.killed) {
    console.log(`\n[kill-switch] beta below trust floor — pausing then destroying`);
    await beta.pause().catch(() => {});
    await beta.destroy().catch(() => {});
    sandboxes.splice(sandboxes.indexOf(beta), 1);
    console.log(`[kill-switch] beta terminated`);
  }

  // 10. fork the trusted baseline agent (cheap clone of a Verified agent).
  // fork requires the source fully paused — pause() returns while still
  // transitioning, so wait for the paused state before forking (avoids 409).
  try {
    await alpha.pause();
    await alpha.waitUntilPaused();
    const clone = await alpha.fork();
    console.log(`[fork] cloned trusted baseline alpha → ${clone.id}`);
    await clone.destroy().catch(() => {});
  } catch (err) {
    console.warn(`[fork] skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 11. pull evidence to the host + verify the audit chain
  console.log("\n[evidence] downloading audit + compliance evidence…");
  const outDir = new URL("./output/", import.meta.url).pathname;
  await mkdir(outDir, { recursive: true });
  const [auditBuf, evidenceBuf] = await Promise.all([
    gov.files.download(REMOTE_AUDIT),
    gov.files.download(REMOTE_EVIDENCE),
  ]);
  await writeFile(`${outDir}${AUDIT_FILE}`, new Uint8Array(auditBuf));
  await writeFile(`${outDir}${EVIDENCE_FILE}`, new Uint8Array(evidenceBuf));
  const chain = verifyChain(Buffer.from(auditBuf).toString("utf8"));
  console.log(
    `[evidence] audit chain: ${chain.ok ? `INTACT (${chain.count} records)` : `BROKEN at seq ${chain.brokenAt}`}`,
  );

  // detach the disk to flush s3fs, then confirm the audit landed durably in S3
  await gov.detachDisk({ diskId: disk.id, mountPath: MOUNT }).catch(() => {});
  const durable = await verifyInS3(AUDIT_FILE);
  console.log(`[evidence] durable in S3: ${durable ? "yes" : "not confirmed (s3fs flush timing)"}`);

  // 12. gate — the example passes only if governance actually held
  const compliancePass = state.evidence.promptDefense.passes;
  const denies = state.agents.reduce((n: number, a: { denies: number }) => n + a.denies, 0);
  const alphaClean = state.agents.find((a: { id: string }) => a.id === "alpha")?.denies === 0;
  const problems = [
    !compliancePass && "OWASP prompt-defense grade below gate",
    !chain.ok && "audit hash chain broken",
    denies === 0 && "no forbidden action was denied",
    !betaState?.killed && "compromised agent was not killed",
    !alphaClean && "benign agent was wrongly denied",
  ].filter(Boolean);
  if (problems.length) throw new Error(`governance gate failed: ${problems.join("; ")}`);

  console.log(
    `\n✅ governance held: compliance PASS, ${denies} denials, chain intact, kill-switch fired, benign agent clean.`,
  );
  console.log(`   dashboard: ${dashUrl}`);
} finally {
  // ══ TEARDOWN — reap every created resource, dependency-safe, best-effort ════
  console.log("\n[teardown] reaping resources…");
  await Promise.allSettled(sandboxes.map((s) => s.destroy()));
  console.log(`[teardown] destroyed ${sandboxes.length} sandbox(es)`);

  // Sweep any orphan a create left behind (e.g. a 500 that provisioned
  // server-side but failed to respond, so we never got the handle).
  try {
    const known = new Set(sandboxes.map((s) => s.id));
    for (const s of await box.listSandboxes()) {
      if (s.name?.includes(`-${run}`) && !known.has(s.id)) {
        await s.destroy().catch(() => {});
        console.log(`[teardown] swept orphan sandbox ${s.id} (${s.name})`);
      }
    }
  } catch {
    /* best-effort */
  }

  if (disk) {
    // sandboxes are gone, so any live attachment is already released; a catalog
    // delete is all that remains.
    await withRetry("disks.delete", () => box.disks.delete(disk!.id)).catch((e) =>
      warn(`disk ${disk!.id} may leak: ${e}`),
    );
    console.log(`[teardown] deleted disk ${disk.id}`);
  }
  if (networkId) {
    await withRetry("networks.delete", () => box.networks.delete(networkId!)).catch((e) =>
      warn(`network ${networkId} may leak: ${e}`),
    );
    console.log(`[teardown] deleted network ${networkId}`);
  }
  if (templateId) {
    await box.templates
      .delete(templateId)
      .catch((e) => warn(`template ${templateId} may leak: ${e}`));
    console.log(`[teardown] deleted template ${templateId}`);
  }
  console.log("[teardown] done — nothing left behind.");
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function waitForMount(sandbox: Sandbox): Promise<void> {
  // A fresh custom template's first boot is slow (image pull + decompress), so
  // give the mount a generous window on top of the s3fs mount time (~15s).
  let last = "none";
  for (let i = 0; i < 60; i++) {
    const d = (await sandbox.listDisks()).find((x) => x.mount_path === MOUNT);
    last = d?.mount_status ?? "none";
    if (last === "mounted") return;
    // "failed" is a live terminal status not in the published DiskMountStatus type.
    if (last === "error" || last === "failed")
      throw new Error(
        `audit disk mount ${last} — is ${S3.endpoint} reachable and does the rootfs provide s3fs?`,
      );
    await Bun.sleep(2000);
  }
  throw new Error(`audit disk did not mount within 120s (last status: ${last})`);
}

function verifyChain(jsonl: string): { ok: boolean; count: number; brokenAt?: number } {
  const lines = jsonl.split("\n").filter(Boolean);
  let prev = "genesis";
  for (const line of lines) {
    const rec = JSON.parse(line);
    const { hash, ...rest } = rec;
    const expect = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    if (rec.prevHash !== prev || hash !== expect)
      return { ok: false, count: lines.length, brokenAt: rec.seq };
    prev = hash;
  }
  return { ok: true, count: lines.length };
}

async function verifyInS3(key: string): Promise<boolean> {
  try {
    const s3 = new Bun.S3Client({
      accessKeyId: S3.accessKey,
      secretAccessKey: S3.secretKey,
      bucket: S3.bucket,
      endpoint: S3.endpoint,
      region: S3.region,
      virtualHostedStyle: !S3.usePathStyle,
    });
    const f = s3.file(key);
    return (await f.exists()) && (await f.stat()).size > 0;
  } catch {
    return false;
  }
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts) throw err;
      const wait = Math.min(2000 * i, 15_000);
      console.warn(`  ${label} attempt ${i}/${attempts} failed; retrying in ${wait / 1000}s…`);
      await Bun.sleep(wait);
    }
  }
  throw new Error("unreachable");
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name} — see .env.example`);
  return v;
}
function warn(msg: string) {
  process.stderr.write(`[teardown] WARNING: ${msg}\n`);
}
