export const SAFE_STORAGE_UNAVAILABLE_MESSAGE =
  "Electron safeStorage encryption is not available. Refusing to read or write automation credentials.";

type SafeStorageAvailability = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
};

export function assertSafeStorageCanEncrypt(storage: SafeStorageAvailability, platform = process.platform) {
  if (!storage.isEncryptionAvailable()) {
    throw new Error(SAFE_STORAGE_UNAVAILABLE_MESSAGE);
  }
  if (platform === "linux" && storage.getSelectedStorageBackend?.() === "basic_text") {
    throw new Error(SAFE_STORAGE_UNAVAILABLE_MESSAGE);
  }
}
