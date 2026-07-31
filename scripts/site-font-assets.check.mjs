import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
assert.match(index, /assets\/fonts\/fonts\.css/);

for (const path of [
  "site/assets/fonts/fonts.css",
  "site/assets/fonts/noto-sans-tc.woff2",
  "site/assets/fonts/noto-serif-tc.woff2",
  "site/assets/fonts/OFL.txt",
]) {
  assert.equal(existsSync(resolve(path)), true, `${path} must be self-hosted`);
}
