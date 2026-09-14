import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { initializeCanonicalRuntime } from "../electron/canonical-reset.ts";
import {
  writeAutomationCredentialsFile,
  writeAutomationSettingsFile,
} from "../src/lib/automation/server/config-files.ts";
import { AUTOMATION_CREDENTIAL_GROUPS } from "../src/lib/automation/server/tasks.ts";
import { seedMockLedger } from "../src/ledger/seed-mock-ledger-db.ts";

export const desktopCdpFixtureCredentialGroupIds = [
  "fubon",
  "esun",
  "maicoin",
] as const;

function fixtureCredentialGroup(groupId: string) {
  const group = AUTOMATION_CREDENTIAL_GROUPS.find(
    (candidate) => candidate.id === groupId,
  );
  if (!group) throw new Error(`Unknown CDP fixture credential group: ${groupId}`);
  return group;
}

/**
 * Derive the credential shape from the task catalog so this fixture cannot
 * accidentally drift from the fields shown by the desktop setup UI. The
 * values are inert, deterministic placeholders and never provider secrets.
 */
export const desktopCdpFixtureCredentials = Object.fromEntries(
  desktopCdpFixtureCredentialGroupIds.flatMap((groupId) => {
    const group = fixtureCredentialGroup(groupId);
    return group.credentialFields
      .filter((credentialField) => credentialField.redaction !== "none")
      .map((credentialField, index) => [
        credentialField.key,
        `fixture-cdp-${group.id}-${index + 1}`,
      ] as const);
  }),
) as Record<string, string>;

/**
 * Keep the fixture small: one completed bank source, one failed bank source,
 * and one credential-group sync source for the onboarding path.
 */
export const desktopCdpFixtureSettings = {
  AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
  EXCHANGE_RATE_UPDATE_TIME: "23:59",
  LIBRETTO_CLOUD_FUBON_ENABLED: true,
  LIBRETTO_CLOUD_ESUN_ENABLED: true,
  LIBRETTO_CLOUD_YUANTA_ENABLED: false,
  LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED: false,
  LIBRETTO_CLOUD_CATHAY_ENABLED: false,
  LIBRETTO_CLOUD_HNCB_ENABLED: false,
  LIBRETTO_CLOUD_CTBC_ENABLED: false,
  LIBRETTO_CLOUD_POST_ENABLED: false,
  LIBRETTO_CLOUD_SINOPAC_ENABLED: false,
  LIBRETTO_CLOUD_LINEBANK_ENABLED: false,
  LIBRETTO_CLOUD_EINVOICE_ENABLED: false,
  MAX_ENABLED: true,
  MAX_SUB_ACCOUNT: "main",
} as const;

function assertDisposableFixtureRoot(userData: string) {
  const root = resolve(userData);
  const allowedRoots = ["/tmp", resolve(tmpdir())];
  if (allowedRoots.some((allowedRoot) => root.startsWith(`${allowedRoot}${sep}`))) return root;
  throw new Error(`CDP fixture user-data must be inside a temporary directory: ${root}`);
}

/**
 * Prepare a disposable user-data root before Electron starts.
 *
 * Canonical reset must complete before the mock legacy operational ledger is
 * written. This preserves the fixture's task history while ensuring the app
 * still opens a canonical database during startup.
 */
export function seedDesktopCdpFixture(
  userData: string,
  referenceDate = new Date(),
) {
  const root = assertDisposableFixtureRoot(userData);
  mkdirSync(root, { recursive: true });
  initializeCanonicalRuntime({ userData: root });
  writeAutomationSettingsFile(join(root, "settings.json"), desktopCdpFixtureSettings);
  writeAutomationCredentialsFile(
    join(root, "credentials.json"),
    desktopCdpFixtureCredentials,
    null,
  );
  return seedMockLedger(join(root, "data", "ledger"), referenceDate);
}

/** Remove only the named disposable fixture root. */
export function removeDesktopCdpFixture(userData: string) {
  rmSync(assertDisposableFixtureRoot(userData), { recursive: true, force: true });
}

function main() {
  const userData = process.argv[2];
  if (!userData) throw new Error("Usage: seed-desktop-cdp-fixture <user-data-root>");
  removeDesktopCdpFixture(userData);
  console.log(`Desktop CDP fixture written to ${seedDesktopCdpFixture(userData)}`);
}

const isCliEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) main();
