import { safeStorage } from "electron";
import {
  migrateAutomationCredentialsFileEncryption,
  setAutomationCredentialCodec,
  setAutomationCredentialEncryptionRequired,
} from "../src/lib/automation/server/config-files.ts";
import { assertSafeStorageCanEncrypt } from "./safe-storage-availability.ts";

export function registerAutomationCredentialSafeStorage() {
  setAutomationCredentialEncryptionRequired(true);
  assertSafeStorageCanEncrypt(safeStorage);

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
