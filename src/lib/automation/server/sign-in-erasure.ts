import { rmSync } from "node:fs";
import { join } from "node:path";
import { CARD_IDENTITY_VERIFIER_FILE, provisionCardIdentitySecret } from "./card-identity-verifier.ts";
import {
  CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY,
  removeAutomationCredentialsFromEnvFile,
  type AutomationCredentialStore,
  type AutomationCredentialsFile,
} from "./config-files.ts";
import { AUTOMATION_MANAGED_SECRET_KEYS } from "./tasks.ts";

/**
 * What Sign-in Erasure would find in credentials.json. A file that cannot be
 * reached (a filesystem error) is not one that cannot be decoded: erasure
 * fails on it and keeps it, rather than replacing it.
 */
// Its kind is the `credentials` of SignInDataStatus in desktop/api.ts.
export type SignInDetailsStanding =
  | Readonly<{ kind: "readable"; stored: AutomationCredentialsFile }>
  | Readonly<{ kind: "undecodable" }>
  | Readonly<{ kind: "unreachable"; error: unknown }>;

export function readSignInDetailsStanding(credentials: Pick<AutomationCredentialStore, "read">): SignInDetailsStanding {
  try {
    return { kind: "readable", stored: credentials.read() };
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException | null)?.code === "string") return { kind: "unreachable", error };
    return { kind: "undecodable" };
  }
}

/**
 * Whether erasing now would leave credentials.json without its Card identity
 * secret, so the next one is created and card accounts from the old one wait
 * for a Canonical Reset (ADR 0149).
 */
export function erasureReplacesCardIdentitySecret(standing: SignInDetailsStanding): boolean {
  if (standing.kind === "unreachable") return false;
  return standing.kind === "undecodable" || !standing.stored[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
}

/**
 * Sign-in Erasure (ADR 0062). Removes every source's Sign-in Details from the
 * credentials file, including TDCC's registered device and session and the
 * Cathay trusted-device user, then every source's retained cookies and
 * Chromium profiles. App-managed secrets stay: card identities derive from
 * them, so dropping one would split existing financial accounts.
 *
 * Credentials that cannot be read are replaced, and their secrets with them:
 * this is how a person recovers sign-in details the Keychain can no longer
 * decrypt. The new Card identity secret is provisioned at once, and the
 * ledger asks for a Canonical Reset if it holds card accounts from the old
 * one (ADR 0149).
 */
export function eraseSignInDetails({
  credentials,
  userDataDirectory,
}: Readonly<{
  credentials: AutomationCredentialStore;
  userDataDirectory: string;
}>) {
  const standing = readSignInDetailsStanding(credentials);
  if (standing.kind === "unreachable") throw standing.error;
  const stored: AutomationCredentialsFile = standing.kind === "readable" ? standing.stored : {};
  const kept = AUTOMATION_MANAGED_SECRET_KEYS.flatMap((key) =>
    stored[key] ? [[key, stored[key]] as const] : []);
  credentials.write(Object.fromEntries(kept));
  // Credential lines a legacy .env still holds would migrate back at the next start.
  removeAutomationCredentialsFromEnvFile(join(userDataDirectory, ".env"));
  provisionCardIdentitySecret(credentials, join(userDataDirectory, CARD_IDENTITY_VERIFIER_FILE));
  for (const directory of ["browser-state", "browser-runtime"]) {
    rmSync(join(userDataDirectory, "data", "automation", directory), { recursive: true, force: true });
  }
}
