import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOTS = ["src", "electron", "scripts"];
const SOURCE_FILE = /\.(?:[cm]?[jt]s|svelte)$/u;
// Playwright ignores every isVisible option and returns at once, so a timeout
// there reads as a wait that never happens. Waiting needs locator.waitFor.
const VISIBILITY_OPTIONS = /\.isVisible\(\s*\{/gu;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

test("no Locator.isVisible call passes options Playwright ignores", () => {
  const offenders = [];
  for (const file of ROOTS.flatMap(sourceFiles)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(VISIBILITY_OPTIONS))
      offenders.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "isVisible returns immediately and ignores its timeout; use locator.waitFor({ state: \"visible\", timeout }) to wait.",
  );
});
