import assert from "node:assert/strict";
import {
  DISPLAY_SCALE_DEFAULT,
  applyDisplayScale,
  displayScaleShortcut,
  displayScaleStorageKey,
  normalizeDisplayScale,
  readStoredDisplayScale,
} from "./display-scale.ts";

class MemoryStorage {
  #items = new Map<string, string>();
  getItem(key: string) { return this.#items.get(key) ?? null; }
  setItem(key: string, value: string) { this.#items.set(key, value); }
}

const storage = new MemoryStorage();
assert.equal(normalizeDisplayScale(undefined), DISPLAY_SCALE_DEFAULT);
assert.equal(normalizeDisplayScale("bad"), DISPLAY_SCALE_DEFAULT);
assert.equal(normalizeDisplayScale(72), 75);
assert.equal(normalizeDisplayScale(153), 150);
assert.equal(normalizeDisplayScale(103), 105);
assert.equal(readStoredDisplayScale(storage), 100);

storage.setItem(displayScaleStorageKey, "126");
assert.equal(readStoredDisplayScale(storage), 125);
assert.equal(applyDisplayScale(103, storage), 105);
assert.equal(storage.getItem(displayScaleStorageKey), "105");

const shortcut = (key: string, extra = {}) => displayScaleShortcut({
  key,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  defaultPrevented: false,
  ...extra,
});
assert.equal(shortcut("-"), "decrease");
assert.equal(shortcut("="), "increase");
assert.equal(shortcut("+"), "increase");
assert.equal(shortcut("0"), "reset");
assert.equal(shortcut("0", { altKey: true }), null);
assert.equal(shortcut("0", { defaultPrevented: true }), null);
assert.equal(shortcut("0", { metaKey: false }), null);
