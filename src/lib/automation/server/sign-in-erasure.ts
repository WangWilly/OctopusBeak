import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AutomationCredentialStore } from "./config-files.ts";
import { AUTOMATION_MANAGED_SECRET_KEYS } from "./tasks.ts";

/**
 * Sign-in Erasure (ADR 0062). Removes every source's Sign-in Details from the
 * credentials file, including TDCC's registered device and session and the
 * Cathay trusted-device user, then every source's retained cookies and
 * Chromium profiles. App-managed secrets stay: card identities derive from
 * them, so dropping one would split existing financial accounts.
 */
export function eraseSignInDetails({
  credentials,
  userDataDirectory,
}: Readonly<{
  credentials: AutomationCredentialStore;
  userDataDirectory: string;
}>) {
  const stored = credentials.read();
  const kept = AUTOMATION_MANAGED_SECRET_KEYS.flatMap((key) =>
    stored[key] ? [[key, stored[key]] as const] : []);
  credentials.write(Object.fromEntries(kept));
  for (const directory of ["browser-state", "browser-runtime"]) {
    rmSync(join(userDataDirectory, "data", "automation", directory), { recursive: true, force: true });
  }
}
