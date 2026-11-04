import { CreateosSandboxClient, sleep, type SnapshotView } from "createos-sandbox-sdk";

const client = new CreateosSandboxClient();
const source = await client.createSandbox({ shape: "s-1vcpu-1gb", rootfs: "alpine:3.20" });
let snapshot: SnapshotView | undefined;
let restored;

try {
  snapshot = await source.createSnapshot({ type: "disk", name: "configured-workspace" });
  const deadline = Date.now() + 5 * 60_000;
  while (snapshot.status === "creating" && Date.now() < deadline) {
    await sleep(1_000);
    snapshot = await client.snapshots.get(snapshot.id);
  }
  if (snapshot.status !== "ready") throw new Error(`Snapshot entered ${snapshot.status}`);

  restored = await client.createSandbox({ snapshot_id: snapshot.id });
  console.log(`Restored sandbox ${restored.id} from snapshot ${snapshot.id}.`);
} finally {
  if (restored) await restored.destroy();
  await source.destroy();
  if (snapshot?.status === "ready" || snapshot?.status === "failed") {
    await client.snapshots.delete(snapshot.id);
  }
}
