import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_COLUMNS = [
  "Feature ID",
  "Feature Name",
  "User Story",
  "Expected Behaviour",
  "Edge Cases",
  "Test Cases",
  "Current Status",
  "Defect Count",
  "Severity",
  "Notes",
  "Last Tested Date",
];

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];

    if (character === '"') {
      if (quoted && next === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

test("quality matrix is a valid canonical feature ledger", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const rows = parseCsv(await readFile(path.join(root, "quality-matrix.csv"), "utf8"));
  const [header, ...features] = rows;

  expect(header).toEqual(REQUIRED_COLUMNS);
  expect(features.length).toBeGreaterThan(0);
  expect(features.every((feature) => feature.length === REQUIRED_COLUMNS.length)).toBe(true);
  expect(
    features.every(
      ([id, name, story, behavior, edgeCases, testCases, status, defects, severity, notes]) =>
        [id, name, story, behavior, edgeCases, testCases, status, defects, severity, notes].every(
          Boolean,
        ),
    ),
  ).toBe(true);

  const ids = features.map(([id]) => id);
  expect(new Set(ids).size).toBe(ids.length);
});
