export const valuesStorageKey = "octopusbeak-values-visible";

type ValueVisibilityStorage = Pick<Storage, "getItem" | "setItem">;

export function readStoredValuesVisible(storage = browserStorage()) {
  const stored = storage?.getItem(valuesStorageKey);
  return stored == null ? true : stored === "1";
}

export function writeStoredValuesVisible(visible: boolean, storage = browserStorage()) {
  storage?.setItem(valuesStorageKey, visible ? "1" : "0");
}

function browserStorage(): ValueVisibilityStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
