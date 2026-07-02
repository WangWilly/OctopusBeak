import assert from "node:assert/strict";
import { assertSafeStorageCanEncrypt, SAFE_STORAGE_UNAVAILABLE_MESSAGE } from "./safe-storage-availability.ts";

assert.throws(
  () => assertSafeStorageCanEncrypt({ isEncryptionAvailable: () => false }),
  { message: SAFE_STORAGE_UNAVAILABLE_MESSAGE },
);

assert.throws(
  () =>
    assertSafeStorageCanEncrypt(
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "basic_text",
      },
      "linux",
    ),
  { message: SAFE_STORAGE_UNAVAILABLE_MESSAGE },
);

assert.doesNotThrow(() =>
  assertSafeStorageCanEncrypt(
    {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
    },
    "linux",
  ),
);

assert.doesNotThrow(() =>
  assertSafeStorageCanEncrypt(
    {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
    },
    "darwin",
  ),
);
