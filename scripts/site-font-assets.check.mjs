import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function siteTextFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) return siteTextFiles(entryPath);
    return entry.isFile() && /\.(?:css|html)$/i.test(entry.name)
      ? [entryPath]
      : [];
  });
}

const siteSources = siteTextFiles(resolve("site")).map((path) => ({
  path,
  content: readFileSync(path, "utf8"),
}));
const index = siteSources.find(({ path }) => path.endsWith("index.html"))?.content ?? "";
assert.ok(index, "site/index.html is missing");
for (const { path, content } of siteSources) {
  assert.doesNotMatch(
    content,
    /fonts\.(?:googleapis|gstatic)\.com/,
    `${path} must not load Google Fonts`,
  );
  assert.doesNotMatch(
    content,
    /Material Symbols/,
    `${path} must not depend on Material Symbols`,
  );
  if (path.endsWith(".css")) {
    assert.doesNotMatch(
      content,
      /(?:@import\s+|url\(\s*["']?)https?:\/\//i,
      `${path} must not load remote CSS or font assets`,
    );
  }
}
// The page renders with the platform UI font, like the desktop app, so it ships and fetches no font files.
for (const { path, content } of siteSources) {
  assert.doesNotMatch(content, /@font-face/, `${path} must not declare web fonts`);
}
const remoteFetches = [...index.matchAll(/<link\b[^>]*>/gi)]
  .map(([tag]) => tag)
  .filter((tag) => /\brel=["'](?:stylesheet|preload|preconnect|dns-prefetch)["']/i.test(tag) && /\bhref=["']https?:\/\//i.test(tag));
assert.deepEqual(remoteFetches, [], "index.html must not fetch remote stylesheets or fonts");
