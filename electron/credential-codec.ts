import { safeStorage } from "electron";
import {
  migrateAutomationCredentialsFileEncryption,
  setAutomationCredentialCodec,
} from "../src/lib/automation/server/config-files.ts";

export function registerAutomationCredentialSafeStorage() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage encryption is not available. Refusing to read or write automation credentials.");
  }

  setAutomationCredentialCodec({
    encrypt(text: string) {
      return safeStorage.encryptString(text).toString("base64");
    },
    decrypt(payload: string) {
      return safeStorage.decryptString(Buffer.from(payload, "base64"));
    },
  });

  migrateAutomationCredentialsFileEncryption();
}
