import assert from "node:assert/strict";
import {
  DISPLAY_SCALE_DEFAULT,
  applyDisplayScale,
  displayScaleShortcut,
  displayScaleStorageKey,
  legacyDisplayScaleStorageKey,
  normalizeDisplayScale,
  readStoredDisplayScale,
  supportsDisplayScale,
} from "./display-scale.ts";
import { displayScaleZoomFactor } from "./display-zoom.ts";

class MemoryStorage {
  #items = new Map<string, string>();
  getItem(key: string) { return this.#items.get(key) ?? null; }
  setItem(key: string, value: string) { this.#items.set(key, value); }
  removeItem(key: string) { this.#items.delete(key); }
}

const storage = new MemoryStorage();
assert.equal(normalizeDisplayScale(undefined), DISPLAY_SCALE_DEFAULT);
assert.equal(normalizeDisplayScale("bad"), DISPLAY_SCALE_DEFAULT);
assert.equal(normalizeDisplayScale(""), DISPLAY_SCALE_DEFAULT);
assert.equal(normalizeDisplayScale("   "), DISPLAY_SCALE_DEFAULT);
assert.equal(normalizeDisplayScale(72), 75);
assert.equal(normalizeDisplayScale(153), 150);
assert.equal(normalizeDisplayScale(103), 105);
assert.equal(readStoredDisplayScale(storage), 100);
assert.equal(supportsDisplayScale(undefined), false);
assert.equal(supportsDisplayScale({ display: {} }), false);
assert.equal(supportsDisplayScale({ display: { setScale() {} } }), true);

storage.setItem(displayScaleStorageKey, "126");
assert.equal(readStoredDisplayScale(storage), 125);
assert.equal(applyDisplayScale(103, storage), 105);
assert.equal(storage.getItem(displayScaleStorageKey), "105");

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { octopusBeak: { display: {} } },
});
assert.doesNotThrow(() => applyDisplayScale(100, storage));
delete (globalThis as { window?: unknown }).window;

const shortcut = (platform: "mac" | "other", key: string, extra = {}) => displayScaleShortcut({
  key,
  metaKey: platform === "mac",
  ctrlKey: platform === "other",
  altKey: false,
  defaultPrevented: false,
  ...extra,
}, platform);
assert.equal(shortcut("mac", "-"), "decrease");
assert.equal(shortcut("mac", "="), "increase");
assert.equal(shortcut("mac", "+"), "increase");
assert.equal(shortcut("mac", "0"), "reset");
assert.equal(shortcut("mac", "0", { metaKey: false, ctrlKey: true }), null);
assert.equal(shortcut("mac", "0", { ctrlKey: true }), null);
assert.equal(shortcut("other", "-"), "decrease");
assert.equal(shortcut("other", "="), "increase");
assert.equal(shortcut("other", "+"), "increase");
assert.equal(shortcut("other", "0"), "reset");
assert.equal(shortcut("other", "0", { metaKey: true, ctrlKey: false }), null);
assert.equal(shortcut("other", "0", { metaKey: true }), null);
assert.equal(shortcut("mac", "0", { altKey: true }), null);
assert.equal(shortcut("mac", "0", { defaultPrevented: true }), null);
assert.equal(shortcut("mac", "0", { metaKey: false }), null);

const legacy = new MemoryStorage();
legacy.setItem(legacyDisplayScaleStorageKey, "80");
assert.equal(readStoredDisplayScale(legacy), 100, "the old 80% is the new 100%, so the screen looks the same");
assert.equal(legacy.getItem(displayScaleStorageKey), "100");
assert.equal(legacy.getItem(legacyDisplayScaleStorageKey), null);
legacy.setItem(legacyDisplayScaleStorageKey, "100");
assert.equal(readStoredDisplayScale(legacy), 100, "the migrated value wins over a stale legacy key");
const legacyDefault = new MemoryStorage();
legacyDefault.setItem(legacyDisplayScaleStorageKey, "100");
assert.equal(readStoredDisplayScale(legacyDefault), 125);
assert.equal(displayScaleZoomFactor(100), 0.8, "100% renders at the old 80% zoom");
assert.equal(displayScaleZoomFactor(125), 1);
assert.equal(displayScaleZoomFactor(75), 0.6);
assert.equal(displayScaleZoomFactor(150), 1.2);
assert.equal(displayScaleZoomFactor(50), displayScaleZoomFactor(75));
assert.throws(() => displayScaleZoomFactor(Number.NaN), { name: "TypeError" });
