/**
 * 02 — Snapshot + fork.
 *
 * createos-sandbox has no decoupled snapshot object: *pausing* a sandbox IS the
 * snapshot, and forking that paused bundle gives a fresh running sandbox with
 * the parent's filesystem state. pause/resume/fork are createos-sandbox-specific
 * and not part of ComputeSDK's portable surface, so this example uses the
 * provider directly and reaches the native handle via `getInstance()`.
 *
 *   CREATEOS_SANDBOX_API_KEY=usr_... CREATEOS_SANDBOX_BASE_URL=https://createos-sandbox.example.com \
 *     npx tsx 02-snapshot-and-fork.ts
 */
import { createosSandbox } from "@computesdk/createos-sandbox";

async function main() {
  const provider = createosSandbox({});

  const sandbox = await provider.sandbox.create({ memoryMb: 1024, image: "devbox:1" });
  const native = sandbox.getInstance();
  console.log("created", native.id);

  let fork: Awaited<ReturnType<typeof native.fork>> | undefined;
  try {
    // Write state we expect to survive into the fork.
    await sandbox.filesystem.writeFile("/root/seed.txt", "from the parent");

    // Pause = snapshot. The source VM stops; its id doubles as the snapshot id.
    await native.pause();
    await native.waitUntilPaused();
    console.log("paused (snapshot id =", native.id, ")");

    // Fork the paused bundle into a fresh running sandbox.
    fork = await native.fork();
    await fork.waitUntilRunning();
    console.log("forked", fork.id);

    // The seed file came along with the snapshot.
    const carried = await fork.files.download("/root/seed.txt");
    console.log("fork sees:", new TextDecoder().decode(carried));
  } finally {
    await fork?.destroy().catch(() => undefined);
    await native.destroy().catch(() => undefined);
    console.log("destroyed both");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
