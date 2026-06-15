/**
 * Python doc-to-Markdown converter — upload a local HTML (or .docx) document
 * into a createos-sandbox sandbox, install Microsoft MarkItDown via pip, convert the file,
 * download the output, and print the resulting Markdown to stdout.
 *
 * Run:   bun 42-doc-to-markdown/index.ts
 * Needs: CREATEOS_SANDBOX_BASE_URL + CREATEOS_SANDBOX_API_KEY (see .env.example). No external API keys.
 */
import { readFile } from "node:fs/promises";
import { Sandbox } from "createos-sandbox-sdk";

// Bridge the shared-env variable name to what the SDK reads (CREATEOS_SANDBOX_BASE_URL).
// bun auto-loads .env from the example dir so FCSPAWN_URL is already in
// process.env when this runs if the caller uses the FCSPAWN_URL convention.
if (!process.env.CREATEOS_SANDBOX_BASE_URL && process.env.FCSPAWN_URL) {
  process.env.CREATEOS_SANDBOX_BASE_URL = process.env.FCSPAWN_URL;
}

const INPUT_LOCAL = new URL("./sample.html", import.meta.url).pathname;
const REMOTE_INPUT = "/tmp/input.html";
const REMOTE_OUTPUT = "/tmp/out.md";

// s-4vcpu-4gb: pip install + markitdown[all] needs ~600 MB RAM + CPU headroom
const sandbox = await Sandbox.create({
  shape: "s-4vcpu-4gb",
  rootfs: "devbox:1",
});
console.log(`[1/6] sandbox: ${sandbox.id}`);

try {
  // Upload the source document into the guest.
  console.log("[2/6] uploading input document...");
  const inputBytes = await readFile(INPUT_LOCAL);
  await sandbox.files.upload(REMOTE_INPUT, inputBytes);

  // Install MarkItDown with all optional converters (handles HTML, DOCX,
  // PDF, XLSX, images, audio, etc.). ~300 MB download — 5-minute budget.
  console.log("[3/6] installing markitdown[all] via pip...");
  const install = await sandbox.runCommand("sh", ["-c", "pip install --quiet 'markitdown[all]'"], {
    timeoutMs: 300_000,
  });
  if (install.result.exit_code !== 0) {
    throw new Error(
      `pip install failed (exit ${install.result.exit_code}):\n${install.result.stderr}`,
    );
  }

  // Verify the tool is available before running the conversion.
  console.log("[4/6] verifying markitdown is on PATH...");
  const verify = await sandbox.runCommand("sh", ["-c", "python3 -m markitdown --version"]);
  console.log(`      ${verify.result.stdout.trim() || "(no --version output; binary present)"}`);

  // Convert: python3 -m markitdown <input> -o <output>
  console.log("[5/6] converting document to Markdown...");
  const convert = await sandbox.runCommand(
    "sh",
    ["-c", `python3 -m markitdown '${REMOTE_INPUT}' -o '${REMOTE_OUTPUT}'`],
    { timeoutMs: 60_000 },
  );
  if (convert.result.exit_code !== 0) {
    throw new Error(
      `markitdown failed (exit ${convert.result.exit_code}):\n${convert.result.stderr}`,
    );
  }

  // Download the converted Markdown from the guest and print it.
  console.log("[6/6] downloading converted Markdown...");
  const outBytes = await sandbox.files.download(REMOTE_OUTPUT);
  const markdown = Buffer.from(outBytes).toString("utf8");

  console.log("\n--- converted Markdown ---");
  process.stdout.write(markdown);
  console.log("--- end ---");
  console.log(
    `\n${markdown.split("\n").length} lines of Markdown from ${inputBytes.byteLength} bytes of HTML`,
  );
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log(`destroyed: ${sandbox.id}`);
}
