import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationSettingsStore } from "./config-files.ts";

function storeInTemp() {
  const dir = mkdtempSync(join(tmpdir(), "octopusbeak-settings-store-"));
  const path = join(dir, "settings.json");
  const store = createAutomationSettingsStore(path);
  const heard: unknown[] = [];
  store.subscribe((settings) => heard.push(settings));
  return { dir, path, store, heard };
}

test("a write that its companion write refuses leaves the previous settings and announces nothing", () => {
  const { dir, path, store, heard } = storeInTemp();
  try {
    writeFileSync(path, "{\n  \"MAX_SUB_ACCOUNT\": \"before\"\n}\n");
    const before = readFileSync(path, "utf8");
    assert.throws(
      () => store.write({ MAX_SUB_ACCOUNT: "after" }, () => { throw new Error("credentials disk full"); }),
      /credentials disk full/,
    );
    assert.equal(readFileSync(path, "utf8"), before, "settings.json is back to what it held");
    assert.deepEqual(heard, [], "no listener hears a write that did not happen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused first write leaves no settings file behind", () => {
  const { dir, path, store, heard } = storeInTemp();
  try {
    assert.throws(() => store.write({ MAX_SUB_ACCOUNT: "after" }, () => { throw new Error("refused"); }), /refused/);
    assert.equal(existsSync(path), false);
    assert.deepEqual(heard, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write and its companion both land before listeners hear the new settings once", () => {
  const { dir, path, store, heard } = storeInTemp();
  try {
    const order: string[] = [];
    store.subscribe(() => order.push("announced"));
    store.write({ MAX_SUB_ACCOUNT: "after" }, () => {
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { MAX_SUB_ACCOUNT: "after" }, "settings are written first");
      order.push("companion");
    });
    assert.deepEqual(order, ["companion", "announced"]);
    assert.deepEqual(heard, [{ MAX_SUB_ACCOUNT: "after" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two stores keep separate listeners with no shared registry", () => {
  const first = storeInTemp();
  const second = storeInTemp();
  try {
    first.store.write({ MAX_SUB_ACCOUNT: "one" });
    assert.deepEqual(first.heard, [{ MAX_SUB_ACCOUNT: "one" }]);
    assert.deepEqual(second.heard, []);
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
    rmSync(second.dir, { recursive: true, force: true });
  }
});
