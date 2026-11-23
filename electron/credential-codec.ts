import { safeStorage } from "electron";
import {
  createAutomationCredentialStore,
  type AutomationCredentialCodec,
  type AutomationCredentialStore,
} from "../src/lib/automation/server/config-files.ts";
import { provisionCardIdentitySecretAtStartup } from "../src/lib/automation/server/card-identity-verifier.ts";
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

/** Opens credentials.json even when it cannot be read, so the App still starts (ADR 0149). */
export function openSafeStorageCredentialStore(
  credentialsPath: string,
  cardIdentityVerifierPath: string,
): AutomationCredentialStore {
  const credentials = createAutomationCredentialStore(credentialsPath, safeStorageCredentialCodec());
  provisionCardIdentitySecretAtStartup(credentials, cardIdentityVerifierPath, (code, message) =>
    console.error(code, message));
  return credentials;
}
