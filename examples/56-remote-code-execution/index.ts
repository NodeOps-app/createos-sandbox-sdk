/**
 * Remote code execution — run Go, Python, and JavaScript submissions in a
 * sandbox and return Hackerrank-style stdin/stdout/stderr/exit-code results.
 *
 * Run:   bun 56-remote-code-execution/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example).
 */
import { Sandbox } from "createos-sandbox-sdk";

interface Submission {
  language: "go" | "python" | "javascript";
  sourcePath: string;
  command: string;
  args: string[];
  code: string;
  stdin: string;
}

interface RunResult {
  language: Submission["language"];
  stdin: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const WORKDIR = "/tmp/createos-rce";

const submissions: Submission[] = [
  {
    language: "go",
    sourcePath: `${WORKDIR}/go/main.go`,
    command: "go",
    args: ["run", `${WORKDIR}/go/main.go`],
    stdin: "3 5\n",
    code: `
package main

import (
  "fmt"
  "os"
)

func main() {
  var a, b int
  fmt.Fscan(os.Stdin, &a, &b)
  fmt.Fprintln(os.Stderr, "go: read two numbers")
  fmt.Println(a + b)
}
`.trimStart(),
  },
  {
    language: "python",
    sourcePath: `${WORKDIR}/python/main.py`,
    command: "python3",
    args: [`${WORKDIR}/python/main.py`],
    stdin: "createos sandbox\n",
    code: `
import sys

text = sys.stdin.read().strip()
print("python: received input", file=sys.stderr)
print(text.upper())
`.trimStart(),
  },
  {
    language: "javascript",
    sourcePath: `${WORKDIR}/javascript/main.js`,
    command: "node",
    args: [`${WORKDIR}/javascript/main.js`],
    stdin: "7\n",
    code: `
const fs = require("node:fs");

const value = Number(fs.readFileSync(0, "utf8").trim());
console.error("js: computing square");
console.log(value * value);
`.trimStart(),
  },
];

const sandbox = await Sandbox.create({
  shape: "s-2vcpu-2gb",
  rootfs: "devbox:1",
});
console.log("created:", sandbox.id);

try {
  const results: RunResult[] = [];
  for (const submission of submissions) {
    console.log(`\n[${submission.language}] uploading and running submission...`);
    const cwd = dirname(submission.sourcePath);
    await sandbox.runCommand("mkdir", ["-p", cwd]);
    await sandbox.files.upload(submission.sourcePath, submission.code);

    const result = await runSubmission(sandbox, submission);
    results.push(result);

    console.log(`      exit: ${result.exitCode}`);
    console.log(`      duration: ${result.durationMs}ms`);
    console.log("      stdin:");
    process.stdout.write(indent(result.stdin.trim()));
    console.log("      stdout:");
    process.stdout.write(indent(result.stdout.trim()));
    console.log("      stderr:");
    process.stdout.write(indent(result.stderr.trim()));
  }

  assertResult(results, "go", "8", "go: read two numbers");
  assertResult(results, "python", "CREATEOS SANDBOX", "python: received input");
  assertResult(results, "javascript", "49", "js: computing square");

  console.log("\nverified end-to-end: remote code execution for Go, Python, and JavaScript");
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log("destroyed");
}

async function runSubmission(targetSandbox: Sandbox, submission: Submission): Promise<RunResult> {
  const { result, exec_ms } = await targetSandbox.runCommand(submission.command, submission.args, {
    stdin: submission.stdin,
    timeoutMs: 30_000,
  });

  return {
    language: submission.language,
    stdin: submission.stdin,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exit_code,
    durationMs: exec_ms,
  };
}

function assertResult(
  results: RunResult[],
  language: Submission["language"],
  stdout: string,
  stderr: string,
): void {
  const result = results.find((item) => item.language === language);
  if (!result) throw new Error(`missing ${language} result`);
  if (result.exitCode !== 0) throw new Error(`${language} exited with ${result.exitCode}`);
  if (result.stdout.trim() !== stdout) throw new Error(`${language} stdout mismatch`);
  if (!result.stderr.includes(stderr)) throw new Error(`${language} stderr mismatch`);
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n") + "\n";
}
