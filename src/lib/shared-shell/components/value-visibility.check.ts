import assert from "node:assert/strict";
import { readStoredValuesVisible, valuesStorageKey, writeStoredValuesVisible } from "./value-visibility.ts";

class MemoryStorage {
  #items = new Map<string, string>();

  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.#items.set(key, value);
  }
}

const storage = new MemoryStorage();

assert.equal(readStoredValuesVisible(null), true);
assert.equal(readStoredValuesVisible(storage), true);

storage.setItem(valuesStorageKey, "0");
assert.equal(readStoredValuesVisible(storage), false);

writeStoredValuesVisible(true, storage);
assert.equal(storage.getItem(valuesStorageKey), "1");
