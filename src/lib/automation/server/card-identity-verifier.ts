import { readFileSync } from "node:fs";
import { cardIdentitySecretVerifier } from "../../../ledger/pglite/card-identity-secret.ts";
import {
  atomicWriteFile,
  CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY,
  ensureAutomationManagedSecrets,
  migrateAutomationCredentialsFileEncryption,
  type AutomationCredentialStore,
} from "./config-files.ts";

/** Beside credentials.json; the PGlite worker reads it, so it holds only the verifier (ADR 0149). */
export const CARD_IDENTITY_VERIFIER_FILE = "card-identity-verifier";

const VERIFIER = /^[0-9a-f]{64}$/u;

/**
 * The recorded verifier, or undefined when none is recorded or the record is
 * unreadable; the ledger then leaves its own record as it is. Startup writes
 * the file again from the credentials.
 */
export function readCardIdentityVerifier(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return VERIFIER.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gives the credentials file its Card identity secret, creating one when it
 * has none, and records the secret's verifier for the ledger. A secret
 * created while the ledger holds card accounts from an earlier one does not
 * split them silently: the ledger compares verifiers and asks for a
 * Canonical Reset. Throws when the credentials cannot be read.
 */
export function provisionCardIdentitySecret(
  credentials: AutomationCredentialStore,
  verifierPath: string,
): void {
  migrateAutomationCredentialsFileEncryption(credentials.path, credentials.codec);
  ensureAutomationManagedSecrets({ credentialsPath: credentials.path, codec: credentials.codec });
  const secret = credentials.read()[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  if (!secret) throw new Error("The Card identity secret is missing after provisioning.");
  const verifier = cardIdentitySecretVerifier(secret);
  if (readCardIdentityVerifier(verifierPath) !== verifier) atomicWriteFile(verifierPath, `${verifier}\n`);
}

/**
 * Startup provisioning that never stops the App. Credentials that cannot be
 * read, such as an envelope the Keychain can no longer decrypt, stay on disk
 * untouched: the App opens, the ledger stays readable, and the person clears
 * the Sign-in Details from Settings to enter them again.
 */
export function provisionCardIdentitySecretAtStartup(
  credentials: AutomationCredentialStore,
  verifierPath: string,
  log: (code: string, message: string) => void,
): void {
  try {
    provisionCardIdentitySecret(credentials, verifierPath);
  } catch (error) {
    log("automation-credentials-unreadable", error instanceof Error ? error.message : String(error));
  }
}
