import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function readMarkdownFiles(
  directory: string,
): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return readMarkdownFiles(entryPath);
      if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
      return [{ path: entryPath, content: await readFile(entryPath, "utf8") }];
    }),
  );
  return files.flat();
}

test("tracked documentation uses the published SDK package in executable snippets", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const { name: packageName } = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as {
    name: string;
  };
  const docs = await readMarkdownFiles(path.join(root, "docs"));
  const legacyUsages = docs.flatMap(({ path: filePath, content }) =>
    [
      ...content.matchAll(/(?:from\s+["']|\b(?:bun add|npm install)\s+)createos-sandbox-sdk\b/g),
    ].map((match) => `${path.relative(root, filePath)}: ${match[0]}`),
  );

  expect(legacyUsages).toEqual([]);
  expect(docs.some(({ content }) => content.includes(`from "${packageName}"`))).toBe(true);
  expect(docs.some(({ content }) => content.includes(`bun add ${packageName}`))).toBe(true);
});
