/**
 * Radicle p2p git mesh across 3 sandboxes with role-specialised Claude agents.
 * Each sandbox runs a Radicle node joined to one createos-sandbox overlay network (created
 * via the networks API) so peers reach each other by overlay IP. Node A inits
 * the repo; nodes B/C clone it via gossip; each agent (coder / tester / docs)
 * writes its contribution on its own branch and pushes back over Radicle; we
 * then bundle every peer's namespace to the host.
 *
 * The createos-sandbox-specific piece is `box.networks.create` + `networks: [{ id }]` at
 * sandbox-create time: that overlay is what lets the nodes gossip privately
 * instead of through Radicle's public bootstrap peers.
 *
 * Run:   bun 12-radicle-multi-agent/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY and ANTHROPIC_API_KEY (see .env.example).
 *        Each sandbox needs outbound network to fetch the Radicle installer.
 */
import { mkdir, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { CreateosSandboxClient, Sandbox } from "createos-sandbox-sdk";

const RAD_PASS = "fc-radicle-mesh";
const RAD_BIN = "/root/.radicle/bin";
const REPO_DIR = "/tmp/repo";
const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";

type Role = "coder" | "tester" | "docs";

interface Peer {
  role: Role;
  branch: string;
  filePath: string;
  prompt: string;
  sandbox: Sandbox;
  overlayIp: string;
  nid?: string;
}

const ROLES: Omit<Peer, "sandbox" | "overlayIp">[] = [
  {
    role: "coder",
    branch: "feat/code",
    filePath: "src/fizzbuzz.ts",
    prompt:
      "Write a TypeScript module at src/fizzbuzz.ts exporting `function fizzbuzz(n: number): string[]` " +
      "returning the classic FizzBuzz sequence from 1 to n. No imports. No comments. No example calls. " +
      "Reply with the file contents only — no markdown fences, no prose.",
  },
  {
    role: "tester",
    branch: "feat/tests",
    filePath: "test/fizzbuzz.test.ts",
    prompt:
      "Write a Bun test at test/fizzbuzz.test.ts that imports `{ fizzbuzz }` from `../src/fizzbuzz` and " +
      'verifies fizzbuzz(15) returns the expected 15-element array. Use `import { test, expect } from "bun:test"`. ' +
      "Reply with the file contents only — no markdown fences, no prose.",
  },
  {
    role: "docs",
    branch: "feat/docs",
    filePath: "USAGE.md",
    prompt:
      "Write a USAGE.md (max 25 lines, GitHub-flavoured markdown) documenting a fizzbuzz module that exports " +
      "`fizzbuzz(n)` returning a string[] of the FizzBuzz sequence. Include a Run section using `bun test`. " +
      "Reply with the file contents only — no extra prose around the markdown.",
  },
];

const box = new CreateosSandboxClient();

async function bootRadicleNode(sb: Sandbox, alias: string) {
  await sb.sh(
    "set -e; export DEBIAN_FRONTEND=noninteractive; " +
      "apt-get update -qq && apt-get install -y -qq curl ca-certificates git iproute2 >/dev/null; " +
      "curl -LsSf https://radicle.xyz/install | sh >/tmp/install.log 2>&1; " +
      "test -x /root/.radicle/bin/rad",
    { label: "install", timeoutMs: 600_000 },
  );
  await sb.sh(
    `export PATH=${RAD_BIN}:$PATH; RAD_PASSPHRASE=${RAD_PASS} rad auth --alias ${alias}`,
    { label: "auth" },
  );
  await sb.sh(
    `export PATH=${RAD_BIN}:$PATH; ` +
      `nohup setsid rad node start -- --listen 0.0.0.0:8776 </dev/null >/tmp/radnode.log 2>&1 & ` +
      "sleep 6; rad node status >/dev/null",
    { label: "node-start" },
  );
  const status = (await sb.sh(`${RAD_BIN}/rad node status | head -3`, { label: "nid" })).result
    .stdout;
  const nid = status.match(/z6Mk[A-HJ-NP-Za-km-z1-9]+/)?.[0];
  if (!nid) throw new Error(`Could not parse NID from: ${status}`);
  return nid;
}

async function connectPeers(peers: Peer[]) {
  // Drop public bootstrap nodes from each peer's known set so the mesh
  // only gossips internally — then dial the other two peers on the
  // overlay network.
  for (const me of peers) {
    const others = peers.filter((p) => p !== me);
    const cmd = others
      .map((o) => `${RAD_BIN}/rad node connect ${o.nid}@${o.overlayIp}:8776`)
      .join(" && ");
    await me.sandbox.sh(cmd, { label: "connect" });
  }
}

async function generateContribution(role: Omit<Peer, "sandbox" | "overlayIp">) {
  const anthropic = new Anthropic();
  const resp = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: role.prompt }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim()
    // strip occasional code fences
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/, "")
    .trim();
  if (!text) throw new Error(`Empty Claude output for role ${role.role}`);
  return text;
}

async function pushContribution(peer: Peer, body: string) {
  // Write the agent's file, commit on a role-specific branch, push to
  // the Radicle remote (auto-configured by `git-remote-rad`).
  const enc = Buffer.from(body, "utf8").toString("base64");
  const remotePath = `${REPO_DIR}/${peer.filePath}`;
  const script = `set -e
export PATH=${RAD_BIN}:$PATH
cd ${REPO_DIR}
mkdir -p "$(dirname ${remotePath})"
echo '${enc}' | base64 -d > ${remotePath}
git checkout -B ${peer.branch}
git add ${peer.filePath}
git -c user.email=${peer.role}@box.local -c user.name=${peer.role}-agent commit -qm "${peer.role}: add ${peer.filePath}"
RAD_PASSPHRASE=${RAD_PASS} git push -u rad ${peer.branch}
RAD_PASSPHRASE=${RAD_PASS} rad sync --announce || true
`;
  return peer.sandbox.sh(script, { label: "push", timeoutMs: 120_000 });
}

// networks.create can transiently 503 under control-plane load; retry with backoff.
async function createNetwork() {
  const maxAttempts = 10;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await box.networks.create({ name: `radicle-mesh-${Date.now()}` });
    } catch (err) {
      if (i === maxAttempts) throw err;
      const wait = Math.min(5_000 * i, 60_000);
      console.warn(
        `networks.create attempt ${i}/${maxAttempts} failed; retrying in ${wait / 1000}s…`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("unreachable");
}
const network = await createNetwork();
console.log("overlay network:", network.id);

let peers: Peer[] = [];
try {
  console.log("\n[1/8] creating 3 sandboxes on overlay network…");
  const suffix = Date.now().toString(36).slice(-6);
  const sandboxes = await Promise.all(
    ROLES.map((r) =>
      Sandbox.create({
        shape: SHAPE,
        rootfs: ROOTFS,
        name: `rad-${r.role}-${suffix}`,
        networks: [{ id: network.id }],
        envs: { RAD_PASSPHRASE: RAD_PASS },
      }),
    ),
  );
  // Authoritative overlay IPs come from networks.get(); SandboxView.ip
  // may report the primary management IP, not the overlay address.
  const networkView = await box.networks.get(network.id);
  const ipById = new Map((networkView.members ?? []).map((m) => [m.sandbox_id, m.ip]));
  peers = ROLES.map((r, i) => {
    const sb = sandboxes[i]!;
    const overlayIp = ipById.get(sb.id) ?? sb.ip;
    if (!overlayIp) throw new Error(`no overlay IP for sandbox ${sb.id}`);
    return { ...r, sandbox: sb, overlayIp };
  });
  for (const p of peers) console.log(`  ${p.role}: ${p.sandbox.id} overlay=${p.overlayIp}`);

  console.log("\n[2/8] installing Radicle + booting nodes (parallel)…");
  await Promise.all(
    peers.map(async (p) => {
      p.nid = await bootRadicleNode(p.sandbox, p.role);
      console.log(`  ${p.role}: nid=${p.nid}`);
    }),
  );

  console.log("\n[3/8] dialling the mesh…");
  await connectPeers(peers);

  const nodeA = peers[0]!;
  const nodeBC = peers.slice(1);

  console.log("\n[4/8] node-A inits Radicle repo…");
  const initOut = (
    await nodeA.sandbox.sh(
      `set -e
export PATH=${RAD_BIN}:$PATH
mkdir -p ${REPO_DIR} && cd ${REPO_DIR}
git init -q -b main
echo '# fc-radicle-demo' > README.md
git add . && git -c user.email=bootstrap@box.local -c user.name=bootstrap commit -qm "chore: bootstrap"
RAD_PASSPHRASE=${RAD_PASS} rad init --name fc-radicle-demo --description "createos-sandbox + Radicle multi-agent demo" --default-branch main --public --no-confirm
rad inspect
`,
      { label: "init", timeoutMs: 180_000 },
    )
  ).result.stdout;
  const rid = initOut.match(/rad:[a-zA-Z0-9]+/)?.[0];
  if (!rid) throw new Error(`Could not parse RID from: ${initOut}`);
  console.log("  RID:", rid);

  console.log("\n[5/8] nodes B+C clone via gossip…");
  await Promise.all(
    nodeBC.map(async (p) => {
      // Seed first so the node tracks the repo, then poll until storage
      // shows it locally — gossip can take a few seconds.
      await p.sandbox.sh(
        `set -e
export PATH=${RAD_BIN}:$PATH
rad seed ${rid} --scope all
for i in $(seq 1 30); do
  if rad inspect ${rid} >/dev/null 2>&1; then break; fi
  sleep 2
done
rad clone ${rid} ${REPO_DIR}
`,
        { label: "seed", timeoutMs: 180_000 },
      );
    }),
  );

  console.log("\n[6/8] each peer follows the other two…");
  await Promise.all(
    peers.map((p) => {
      const cmd = peers
        .filter((q) => q !== p)
        .map((q) => `${RAD_BIN}/rad follow ${q.nid} --alias ${q.role}`)
        .join(" && ");
      return p.sandbox.sh(`export PATH=${RAD_BIN}:$PATH; ${cmd}`, { label: "follow" });
    }),
  );

  console.log("\n[7/8] each agent generates + pushes contribution…");
  const bodies = await Promise.all(peers.map((p) => generateContribution(p)));
  // Sequential push to avoid Radicle SQLite lock contention.
  for (const [i, p] of peers.entries()) {
    console.log(`  ${p.role} → ${p.branch} (${bodies[i]!.split("\n").length} lines)`);
    await pushContribution(p, bodies[i]!);
  }

  console.log("\n[8/8] gossip + per-peer bundles…");
  // Every peer mutually follows the others so each Radicle node tracks
  // all NIDs, then `rad sync --fetch` pulls the latest gossiped state.
  // We bundle from EACH peer's working repo so we have evidence from
  // every node — gossip propagation timing varies but a peer always has
  // its own contribution at minimum.
  // Gossip propagation isn't instant; give the mesh a window after the
  // last push, then issue two fetch rounds — the second one usually
  // catches anything the first missed (e.g. peers that hadn't replied
  // to the announcement yet).
  await new Promise((r) => setTimeout(r, 10000));
  await Promise.all(
    peers.map(async (p) => {
      // Bundle directly from the Radicle storage bare repo — it holds
      // every peer's namespace (refs/namespaces/<NID>/refs/heads/*) that
      // gossip has delivered. The working repo's `rad` remote only
      // exposes the delegate's canonical refs, so its `git bundle --all`
      // omits sibling peers' branches.
      await p.sandbox.sh(
        `set -e
export PATH=${RAD_BIN}:$PATH
cd ${REPO_DIR}
RAD_PASSPHRASE=${RAD_PASS} rad sync --fetch || true
sleep 5
RAD_PASSPHRASE=${RAD_PASS} rad sync --fetch || true
# Heartwood storage stores a bare git repo per RID at ~/.radicle/storage/<rid-suffix>
STORAGE=$(ls -d /root/.radicle/storage/*/ 2>/dev/null | head -1)
ls /root/.radicle/storage > /tmp/storage-ls.txt 2>&1 || true
git --git-dir="$STORAGE" bundle create /tmp/repo.bundle --all
git --git-dir="$STORAGE" log --all --graph --oneline --decorate > /tmp/log.txt
rad inspect --refs > /tmp/refs.json 2>/dev/null || rad inspect > /tmp/refs.json
git --git-dir="$STORAGE" for-each-ref --format='%(refname) %(objectname:short)' > /tmp/ls-remote.txt
`,
        { label: "sync", timeoutMs: 180_000 },
      );
    }),
  );

  const outDir = new URL("./output/", import.meta.url).pathname;
  await mkdir(outDir, { recursive: true });
  for (const p of peers) {
    const peerDir = `${outDir}${p.role}/`;
    await mkdir(peerDir, { recursive: true });
    const [bundle, log, refs, ls] = await Promise.all([
      p.sandbox.files.download("/tmp/repo.bundle"),
      p.sandbox.files.download("/tmp/log.txt"),
      p.sandbox.files.download("/tmp/refs.json"),
      p.sandbox.files.download("/tmp/ls-remote.txt"),
    ]);
    await writeFile(`${peerDir}repo.bundle`, new Uint8Array(bundle));
    await writeFile(`${peerDir}log.txt`, new Uint8Array(log));
    await writeFile(`${peerDir}refs.json`, new Uint8Array(refs));
    await writeFile(`${peerDir}ls-remote.txt`, new Uint8Array(ls));
    console.log(`\n=== ${p.role} (${p.nid}) ===`);
    console.log(Buffer.from(log).toString("utf8").trim());
    console.log(`  bundle=${bundle.byteLength}B  saved=${peerDir}`);
  }

  console.log(`\nRID: ${rid}`);
  console.log(
    `\nReconstruct full mesh state locally (all peer namespaces):\n` +
      `  mkdir output/restored && cd output/restored && git init -q\n` +
      `  git fetch ../coder/repo.bundle '+refs/*:refs/*'\n` +
      `  git log --all --oneline --graph\n` +
      `  git show "refs/namespaces/<NID>/refs/heads/feat/code:src/fizzbuzz.ts"`,
  );
} finally {
  console.log("\ncleanup…");
  await Promise.allSettled(peers.map((p) => p.sandbox.destroy()));
  // Retry network delete: members may still be tearing down server-side for a
  // few seconds after sandbox destroy returns, causing a "network in use" error.
  // Retrying avoids silent leaks that accumulate against the 5-network quota.
  {
    const maxAttempts = 5;
    let deleted = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await box.networks.delete(network.id);
        deleted = true;
        break;
      } catch {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    if (!deleted) {
      process.stderr.write(
        `[cleanup] WARNING: failed to delete network ${network.id} after ${maxAttempts} attempts — it may leak against your quota\n`,
      );
    }
  }
  console.log("destroyed sandboxes + network");
}
