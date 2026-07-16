// Self-signal: a workload running *inside* a sandbox can pause or delete
// its own sandbox by POSTing to the loopback agent on 127.0.0.1:1029.
//
// No auth and no client config: the agent binds to loopback only, so it is
// reachable solely from inside the sandbox. These calls work only from code
// running inside a sandbox; anywhere else they fail with a connection error.

const SELF_SIGNAL_BASE = "http://127.0.0.1:1029";

async function selfSignal(action: "pause" | "delete", reason?: string): Promise<void> {
  const url = new URL(`/self/${action}`, SELF_SIGNAL_BASE);
  if (reason) url.searchParams.set("reason", reason);
  const res = await fetch(url, { method: "POST" });
  if (res.status !== 202) {
    throw new Error(`self-${action} failed: HTTP ${res.status}`);
  }
}

/**
 * Pause the sandbox this code is running inside. Snapshots disk and memory,
 * then frees the host. Resume it later with the control-plane API or CLI.
 *
 * @param reason Optional label recorded with the pause (truncated to 128 chars).
 */
export function selfPause(reason?: string): Promise<void> {
  return selfSignal("pause", reason);
}

/**
 * Delete the sandbox this code is running inside. Irreversible: the sandbox
 * and its state are destroyed.
 *
 * @param reason Optional label recorded with the deletion (truncated to 128 chars).
 */
export function selfDelete(reason?: string): Promise<void> {
  return selfSignal("delete", reason);
}
