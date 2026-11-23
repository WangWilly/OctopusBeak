import { rmSync } from "node:fs";
import { join } from "node:path";
import { CARD_IDENTITY_VERIFIER_FILE, provisionCardIdentitySecret } from "./card-identity-verifier.ts";
import type { AutomationCredentialStore, AutomationCredentialsFile } from "./config-files.ts";
import { AUTOMATION_MANAGED_SECRET_KEYS } from "./tasks.ts";

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
  let stored: AutomationCredentialsFile;
  try {
    stored = credentials.read();
  } catch {
    stored = {};
  }
  const kept = AUTOMATION_MANAGED_SECRET_KEYS.flatMap((key) =>
    stored[key] ? [[key, stored[key]] as const] : []);
  credentials.write(Object.fromEntries(kept));
  provisionCardIdentitySecret(credentials, join(userDataDirectory, CARD_IDENTITY_VERIFIER_FILE));
  for (const directory of ["browser-state", "browser-runtime"]) {
    rmSync(join(userDataDirectory, "data", "automation", directory), { recursive: true, force: true });
  }
}
