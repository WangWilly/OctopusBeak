import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import test from "node:test";
import { migrateRendererStorage } from "./renderer-storage-migration.ts";

/** Pages keyed by origin: every file: URL shares one storage, as in Chromium. */
function fakeBrowser(seed: Record<string, Record<string, string>>) {
  const stores = new Map(Object.entries(seed).map(([origin, items]) => [origin, new Map(Object.entries(items))]));
  const loads: string[] = [];
  const originOf = (url: string) => {
    const parsed = new URL(url);
    return parsed.protocol === "file:" ? "file:" : `${parsed.protocol}//${parsed.host}`;
  };
  let origin = "";
  const page = {
    async load(url: string) {
      loads.push(url);
      origin = originOf(url);
      if (!stores.has(origin)) stores.set(origin, new Map());
    },
    async evaluate<T>(script: string): Promise<T> {
      const store = stores.get(origin)!;
      const localStorage = Object.create(null) as Record<string, string>;
      for (const [key, value] of store) localStorage[key] = value;
      Object.defineProperties(localStorage, {
        getItem: { value: (key: string) => (Object.hasOwn(localStorage, key) ? localStorage[key] : null) },
        setItem: {
          value: (key: string, value: string) => {
            localStorage[key] = value;
            store.set(key, value);
          },
        },
      });
      return vm.runInNewContext(script, { localStorage, Object, JSON }) as T;
    },
  };
  return { stores, loads, page };
}

const APP_PAGE = "app://octopusbeak/__storage-migration.html";

test("file-origin preferences reach the app origin once, keeping what it already holds", async () => {
  const userData = mkdtempSync(join(tmpdir(), "octopusbeak-storage-migration-"));
  try {
    const browser = fakeBrowser({
      "file:": { "octopusbeak-locale": "zh-TW", "octopusbeak-welcome-v1": "{\"status\":\"completed\"}" },
      "app://octopusbeak": { "octopusbeak-locale": "en" },
    });
    assert.equal(await migrateRendererStorage({ userData, appOriginPageUrl: APP_PAGE, page: browser.page }), "migrated");
    const app = browser.stores.get("app://octopusbeak")!;
    assert.equal(app.get("octopusbeak-welcome-v1"), "{\"status\":\"completed\"}");
    assert.equal(app.get("octopusbeak-locale"), "en", "a value the new origin already holds wins");
    assert.equal(existsSync(join(userData, "renderer-storage-migration.html")), false, "the blank page is removed");

    browser.stores.get("file:")!.set("octopusbeak-sidebar", "1");
    assert.equal(
      await migrateRendererStorage({ userData, appOriginPageUrl: APP_PAGE, page: browser.page }),
      "already-migrated",
    );
    assert.equal(app.has("octopusbeak-sidebar"), false, "a later launch copies nothing");
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("an empty file origin writes nothing but still ends on the app origin", async () => {
  const userData = mkdtempSync(join(tmpdir(), "octopusbeak-storage-migration-"));
  try {
    const browser = fakeBrowser({});
    assert.equal(await migrateRendererStorage({ userData, appOriginPageUrl: APP_PAGE, page: browser.page }), "migrated");
    assert.equal(browser.loads.at(-1), APP_PAGE, "the renderer then loads same-origin");
    assert.equal(browser.stores.get("app://octopusbeak")?.size, 0);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a failed read leaves no marker, so the next launch tries again", async () => {
  const userData = mkdtempSync(join(tmpdir(), "octopusbeak-storage-migration-"));
  try {
    const failing = {
      load: async () => {},
      evaluate: async () => { throw new Error("renderer crashed"); },
    };
    await assert.rejects(
      migrateRendererStorage({ userData, appOriginPageUrl: APP_PAGE, page: failing as never }),
      /renderer crashed/,
    );
    assert.equal(existsSync(join(userData, "renderer-storage-origin")), false);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
