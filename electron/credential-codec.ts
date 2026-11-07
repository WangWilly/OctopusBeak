import { safeStorage } from "electron";
import {
  createAutomationCredentialStore,
  ensureAutomationManagedSecrets,
  migrateAutomationCredentialsFileEncryption,
  type AutomationCredentialCodec,
  type AutomationCredentialStore,
} from "../src/lib/automation/server/config-files.ts";
import { assertSafeStorageCanEncrypt } from "./safe-storage-availability.ts";

/** Refuses to return a codec unless safeStorage can really encrypt. */
export function safeStorageCredentialCodec(): AutomationCredentialCodec {
  assertSafeStorageCanEncrypt(safeStorage);
  return {
    encrypt(text: string) {
      return safeStorage.encryptString(text).toString("base64");
    },
    decrypt(payload: string) {
      return safeStorage.decryptString(Buffer.from(payload, "base64"));
    },
  };
}

export function openSafeStorageCredentialStore(credentialsPath: string): AutomationCredentialStore {
  const codec = safeStorageCredentialCodec();
  migrateAutomationCredentialsFileEncryption(credentialsPath, codec);
  ensureAutomationManagedSecrets({ credentialsPath, codec });
  return createAutomationCredentialStore(credentialsPath, codec);
}
