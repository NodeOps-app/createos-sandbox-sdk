/**
 * Python PDF form extractor — upload a fillable PDF into a sandbox, pip-install
 * PyMuPDF, run a Python script that reads every form widget's name and value,
 * then download the resulting JSON back to the host.
 *
 * Run:   bun 41-python-pdf-extractor/index.ts
 * Needs: FC_BASE_URL + FC_API_KEY (see .env.example). No external services.
 */
import { readFile, writeFile } from "node:fs/promises";
import { Sandbox } from "fc-sandbox-sdk";

// PyMuPDF (pymupdf) needs ~150 MB of disk and a modest amount of RAM.
// 2 GB covers pip install + import overhead comfortably.
const SHAPE = "s-2vcpu-2gb";
const ROOTFS = "devbox:1";

// Python script executed inside the sandbox.
// Iterates every page's widgets, collects {name, value, type} tuples,
// writes JSON to stdout which is captured by runCommand.
const EXTRACTOR_PY = `\
import fitz
import json
import sys

path = sys.argv[1]
doc = fitz.open(path)
fields = []
for page in doc:
    for widget in page.widgets():
        fields.append({
            "name": widget.field_name,
            "value": widget.field_value,
            "type": widget.field_type_string,
        })
doc.close()
print(json.dumps(fields, ensure_ascii=False))
`;

// bridge FCSPAWN_URL -> baseUrl when set; fall back to FC_BASE_URL
const baseUrl = process.env.FCSPAWN_URL ?? process.env.FC_BASE_URL;
if (!baseUrl) {
  process.stderr.write("FC_BASE_URL (or FCSPAWN_URL) is required — see .env.example\n");
  process.exit(1);
}

const sandbox = await Sandbox.create({ shape: SHAPE, rootfs: ROOTFS }, { baseUrl });
console.log(`[1/6] sandbox: ${sandbox.id}`);

try {
  // Upload the sample fillable PDF
  const pdfBytes = await readFile(new URL("./sample-form.pdf", import.meta.url));
  await sandbox.files.upload("/tmp/form.pdf", pdfBytes);
  console.log(`[2/6] uploaded sample-form.pdf  (${pdfBytes.byteLength} B)`);

  // Upload the extractor script
  await sandbox.files.upload("/tmp/extract.py", EXTRACTOR_PY);
  console.log("[3/6] uploaded extract.py");

  // Install PyMuPDF inside the sandbox — pure-Python wheel, no system libs needed
  console.log("[4/6] pip install pymupdf ...");
  const install = await sandbox.runCommand(
    "pip",
    ["install", "--quiet", "--no-cache-dir", "pymupdf"],
    { timeoutMs: 300_000 },
  );
  if (install.result.exit_code !== 0) {
    throw new Error(`pip install failed:\n${install.result.stderr}`);
  }

  // Run the extractor
  console.log("[5/6] running extractor ...");
  const run = await sandbox.runCommand("python3", ["/tmp/extract.py", "/tmp/form.pdf"]);
  if (run.result.exit_code !== 0) {
    throw new Error(`extractor failed:\n${run.result.stderr}`);
  }

  // Parse stdout as JSON and pretty-print
  const fields: Array<{ name: string; value: string; type: string }> = JSON.parse(
    run.result.stdout,
  );
  console.log(`[6/6] extracted ${fields.length} field(s):`);
  for (const f of fields) {
    console.log(`  ${f.name.padEnd(16)} (${f.type})  = ${JSON.stringify(f.value)}`);
  }

  // Write the result JSON next to this file for local inspection
  const outPath = new URL("./output.json", import.meta.url).pathname;
  await writeFile(outPath, JSON.stringify(fields, null, 2));
  console.log(`\nresult saved to ${outPath}`);
} finally {
  await sandbox.destroy().catch((err) => {
    console.error(`cleanup: destroy failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log(`destroyed: ${sandbox.id}`);
}
