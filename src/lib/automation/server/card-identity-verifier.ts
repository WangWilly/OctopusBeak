import { readFileSync } from "node:fs";
import {
  CARD_IDENTITY_SECRET_VERIFIER,
  cardIdentitySecretVerifier,
  type CardIdentitySecret,
} from "../../shared-identity/card-identity-secret.ts";
import {
  atomicWriteFile,
  CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY,
  ensureAutomationManagedSecrets,
  migrateAutomationCredentialsFileEncryption,
  type AutomationCredentialStore,
} from "./config-files.ts";

/** Beside credentials.json; the PGlite worker reads it, so it never holds the secret (ADR 0149). */
export const CARD_IDENTITY_VERIFIER_FILE = "card-identity-verifier.json";

/**
 * The recorded secret, or undefined when none is recorded or the record is
 * damaged; the ledger then leaves its own records as they are. Provisioning
 * writes the file again from the credentials.
 */
export function readCardIdentityVerifier(path: string): CardIdentitySecret | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { verifier?: unknown; created?: unknown } | null;
    if (typeof parsed?.verifier !== "string" || !CARD_IDENTITY_SECRET_VERIFIER.test(parsed.verifier)) return undefined;
    if (typeof parsed.created !== "boolean") return undefined;
    return { verifier: parsed.verifier, created: parsed.created };
  } catch {
    return undefined;
  }
}

/**
 * Gives the credentials file its Card identity secret, creating one when it
 * has none, and records the secret's verifier for the ledger. The record says
 * whether this install created the secret, which the ledger needs when a
 * namespace with card accounts has no record of its own yet: a created secret
 * cannot be the one those accounts came from. Throws when the credentials
 * cannot be read.
 */
export function provisionCardIdentitySecret(
  credentials: AutomationCredentialStore,
  verifierPath: string,
): void {
  migrateAutomationCredentialsFileEncryption(credentials.path, credentials.codec);
  const { created } = ensureAutomationManagedSecrets({ credentialsPath: credentials.path, codec: credentials.codec });
  const secret = credentials.read()[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  if (!secret) throw new Error("The Card identity secret is missing after provisioning.");
  const verifier = cardIdentitySecretVerifier(secret);
  const recorded = readCardIdentityVerifier(verifierPath);
  const next: CardIdentitySecret = {
    verifier,
    created: created || (recorded?.verifier === verifier && recorded.created),
  };
  if (recorded?.verifier === next.verifier && recorded.created === next.created) return;
  atomicWriteFile(verifierPath, `${JSON.stringify(next)}\n`);
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
    log("automation-card-identity-secret-unprovisioned", error instanceof Error ? error.message : String(error));
  }
}
