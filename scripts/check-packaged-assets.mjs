import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Compare the artifact to Git's LFS manifest, not the possibly unresolved checkout.
const repository = fileURLToPath(new URL("..", import.meta.url));
const index = process.argv.indexOf("--app-root");
assert.ok(index >= 0 && process.argv[index + 1], "--app-root is required");
const appRoot = resolve(process.argv[index + 1]);
const manifest = JSON.parse(execFileSync("git", ["lfs", "ls-files", "--json"], {
  cwd: repository, encoding: "utf8",
}));
const required = manifest.files.filter(({ name }) => !name.startsWith("site/"));
assert.ok(required.some(({ name }) => name.endsWith("model.int8.onnx")), "Speech model missing from LFS manifest");
assert.ok(required.some(({ name }) => name.startsWith("src/lib/welcome/assets/")), "Welcome assets missing from LFS manifest");
for (const { name, oid, size } of required) {
  const content = readFileSync(join(appRoot, name));
  assert.equal(content.length, size, `Packaged asset size mismatch: ${name}`);
  assert.equal(createHash("sha256").update(content).digest("hex"), oid, `Packaged asset hash mismatch: ${name}`);
}
console.log(`Verified ${required.length} packaged LFS assets against Git SHA-256 objects.`);
