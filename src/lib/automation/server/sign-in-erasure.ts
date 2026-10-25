import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  readAutomationCredentialsFile,
  writeAutomationCredentialsFile,
  type AutomationCredentialCodec,
} from "./config-files.ts";
import { AUTOMATION_MANAGED_SECRET_KEYS } from "./tasks.ts";

/**
 * Sign-in Erasure (ADR 0062). Removes every source's Sign-in Details from the
 * credentials file, including TDCC's registered device and session and the
 * Cathay trusted-device user, then every source's retained cookies and
 * Chromium profiles. App-managed secrets stay: card identities derive from
 * them, so dropping one would split existing financial accounts.
 */
export function eraseSignInDetails({
  credentialsPath,
  userDataDirectory,
  codec,
}: Readonly<{
  credentialsPath: string;
  userDataDirectory: string;
  codec: AutomationCredentialCodec | null;
}>) {
  const credentials = readAutomationCredentialsFile(credentialsPath, codec);
  const kept = AUTOMATION_MANAGED_SECRET_KEYS.flatMap((key) =>
    credentials[key] ? [[key, credentials[key]] as const] : []);
  writeAutomationCredentialsFile(credentialsPath, Object.fromEntries(kept), codec);
  for (const directory of ["browser-state", "browser-runtime"]) {
    rmSync(join(userDataDirectory, "data", "automation", directory), { recursive: true, force: true });
  }
}
