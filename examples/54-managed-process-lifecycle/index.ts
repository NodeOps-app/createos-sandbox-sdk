/**
 * Managed process lifecycle — start pipe processes and PTYs, interact with
 * stdin, replay output, wait for completion, and terminate process trees.
 *
 * Run:   bun 54-managed-process-lifecycle/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example).
 */
import { Sandbox } from "createos-sandbox-sdk";

const sandbox = await Sandbox.create({
  shape: "s-1vcpu-1gb",
  rootfs: "devbox:1",
  envs: {
    PROCESS_DEMO_BASE: "from-sandbox-env",
    PROCESS_DEMO_OVERRIDE: "declared-at-create",
  },
});
console.log("created:", sandbox.id);

try {
  console.log("\n[1/4] pipe process with stdin/stdout/stderr...");
  const pipe = await sandbox.processes.create({
    cmd: "/bin/sh",
    args: [
      "-c",
      [
        "printf 'base:%s\\n' \"$PROCESS_DEMO_BASE\"",
        "printf 'override:%s\\n' \"$PROCESS_DEMO_OVERRIDE\"",
        "printf 'stderr:ready\\n' >&2",
        "IFS= read -r line",
        "printf 'stdin:%s\\n' \"$line\"",
      ].join("; "),
    ],
    cwd: "/root",
    env: { PROCESS_DEMO_OVERRIDE: "from-process-env" },
  });
  console.log(`      pipe: ${pipe.process_id}`);

  const listed = await sandbox.processes.list();
  console.log(`      listed processes: ${listed.processes.length}`);

  await sandbox.processes.input(pipe.process_id, "hello managed process\n");
  await sandbox.processes.closeStdin(pipe.process_id);
  const pipeDone = await sandbox.processes.wait(pipe.process_id, {
    scope: "tree",
    waitTimeoutMs: 5_000,
  });
  console.log(`      pipe exit: ${pipeDone.exit_code}`);

  const pipeOutput = await collectOutput(sandbox.processes.connect(pipe.process_id));
  console.log("      stdout:");
  process.stdout.write(indent(pipeOutput.stdout.trim()));
  console.log("      stderr:");
  process.stdout.write(indent(pipeOutput.stderr.trim()));

  console.log("\n[2/4] reconnect from output offset...");
  const firstSeq = pipeOutput.lastSeq > 0 ? pipeOutput.lastSeq - 1 : 0;
  const replay = await collectOutput(
    sandbox.processes.connect(pipe.process_id, { after: firstSeq }),
  );
  console.log(`      replayed data frames after seq ${firstSeq}: ${replay.dataFrames}`);

  console.log("\n[3/4] interactive PTY shell...");
  const pty = await sandbox.processes.create({
    cwd: "/root",
    pty: { rows: 24, cols: 80 },
  });
  console.log(`      pty: ${pty.process_id}`);

  await sandbox.processes.input(pty.process_id, "echo terminal-ready; stty size\n");
  await sandbox.processes.resize(pty.process_id, { rows: 32, cols: 100 });
  await sandbox.processes.input(
    pty.process_id,
    "echo after-resize; stty size; exit\n",
  );
  const ptyDone = await sandbox.processes.wait(pty.process_id, {
    scope: "tree",
    waitTimeoutMs: 5_000,
  });
  console.log(`      pty exit: ${ptyDone.exit_code}`);
  const ptyOutput = await collectOutput(sandbox.processes.connect(pty.process_id));
  process.stdout.write(indent(ptyOutput.pty.trim()));

  console.log("\n[4/4] terminate a long-running process tree...");
  const longRunning = await sandbox.processes.create({
    cmd: "/bin/sh",
    args: ["-c", "trap '' TERM; sleep 300 & wait"],
  });
  const killed = await sandbox.processes.delete(longRunning.process_id, { graceMs: 100 });
  console.log(
    `      terminated: leader_exited=${killed.leader_exited} tree_exited=${killed.tree_exited}`,
  );

  if (!pipeOutput.stdout.includes("stdin:hello managed process")) {
    throw new Error("pipe stdout did not include stdin echo");
  }
  if (!ptyOutput.pty.includes("terminal-ready") || !ptyOutput.pty.includes("after-resize")) {
    throw new Error("PTY output did not include command markers");
  }
  if (!killed.tree_exited) {
    throw new Error("terminated process tree did not exit");
  }

  console.log("\nverified end-to-end: managed pipe process and PTY lifecycle");
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("destroyed");
}

async function collectOutput(
  events: AsyncGenerator<
    | { type: "data"; seq: number; stream: "stdout" | "stderr" | "pty"; data: string }
    | { type: "exit" | "heartbeat" | "error" }
  >,
): Promise<{ stdout: string; stderr: string; pty: string; lastSeq: number; dataFrames: number }> {
  const output = { stdout: "", stderr: "", pty: "", lastSeq: 0, dataFrames: 0 };
  for await (const event of events) {
    if (event.type === "data") {
      output[event.stream] += event.data;
      output.lastSeq = Math.max(output.lastSeq, event.seq);
      output.dataFrames += 1;
    } else if (event.type === "exit") {
      break;
    }
  }
  return output;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n") + "\n";
}
