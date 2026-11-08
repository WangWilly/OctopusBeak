import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appFilePath, appFileResponse, RENDERER_URL, STORAGE_MIGRATION_URL } from "./app-protocol.ts";

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "octopusbeak-app-protocol-"));
  const build = join(root, "build");
  mkdirSync(join(build, "_app", "immutable"), { recursive: true });
  writeFileSync(join(build, "index.html"), "<!doctype html><title>OctopusBeak</title>");
  writeFileSync(join(build, "_app", "immutable", "start.js"), "export {};");
  writeFileSync(join(build, "space name.webp"), "webp");
  writeFileSync(join(root, "secret.txt"), "outside");
  return { root, build };
}

test("the renderer URL and its hash routes resolve to the built index", () => {
  const { root, build } = buildFixture();
  try {
    assert.equal(appFilePath(build, RENDERER_URL), join(build, "index.html"));
    assert.equal(appFilePath(build, `${RENDERER_URL}#/settings`), join(build, "index.html"));
    assert.equal(appFilePath(build, "app://octopusbeak/"), join(build, "index.html"));
    assert.equal(appFilePath(build, "app://octopusbeak/space%20name.webp"), join(build, "space name.webp"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("another host, scheme, or a path that leaves the build is refused", () => {
  const { root, build } = buildFixture();
  try {
    for (const url of [
      "app://other/index.html",
      "file:///etc/passwd",
      "app://octopusbeak/..%2Fsecret.txt",
      "app://octopusbeak/%2e%2e/secret.txt",
      "app://octopusbeak/%2Fetc%2Fpasswd",
      "app://octopusbeak/index.html%00.js",
      "app://octopusbeak/%E0%A4%A",
      "not a url",
    ]) {
      const file = appFilePath(build, url);
      assert.ok(file === null || file.startsWith(build), `${url} resolved to ${file}`);
      assert.notEqual(file, join(root, "secret.txt"), url);
    }
    assert.equal(appFilePath(build, "app://other/index.html"), null);
    assert.equal(appFilePath(build, "app://octopusbeak/..%2Fsecret.txt"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a served file carries its content type and a missing one is a 404", async () => {
  const { root, build } = buildFixture();
  try {
    const page = await appFileResponse(build, RENDERER_URL);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    const script = await appFileResponse(build, "app://octopusbeak/_app/immutable/start.js");
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(await script.text(), "export {};");
    assert.equal((await appFileResponse(build, "app://octopusbeak/missing.js")).status, 404);
    const migration = await appFileResponse(build, STORAGE_MIGRATION_URL);
    assert.equal(migration.status, 200);
    assert.doesNotMatch(await migration.text(), /<script/, "the migration page runs no renderer code");
    assert.equal((await appFileResponse(build, "app://octopusbeak/..%2Fsecret.txt")).status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
