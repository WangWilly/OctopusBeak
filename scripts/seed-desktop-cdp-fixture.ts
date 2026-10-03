import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteOperationalBaseline, createPgliteOperationalStore } from "../src/ledger/pglite/operational.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import {
  writeAutomationCredentialsFile,
  writeAutomationSettingsFile,
} from "../src/lib/automation/server/config-files.ts";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  automationCredentialKeyIsSecret,
} from "../src/lib/automation/server/tasks.ts";

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
      // Redaction describes how a value is displayed, not whether the
      // workflow needs it.  The CDP fixture must provide inert values for
      // every required secret, including password/API-key fields whose
      // catalog default is `redaction: none`.  Non-secret settings such as
      // MAX_SUB_ACCOUNT stay in the settings file.
      .filter((credentialField) => automationCredentialKeyIsSecret(credentialField.key))
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
  LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "deposit",
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
 * The operational task history lives in the same PGlite directory the app
 * will reopen at startup.
 */
export async function seedDesktopCdpFixture(
  userData: string,
  referenceDate = new Date(),
) {
  const root = assertDisposableFixtureRoot(userData);
  mkdirSync(root, { recursive: true });
  writeAutomationSettingsFile(join(root, "settings.json"), desktopCdpFixtureSettings);
  writeAutomationCredentialsFile(
    join(root, "credentials.json"),
    desktopCdpFixtureCredentials,
    null,
  );
  const dataDir = join(root, "data", "pglite");
  mkdirSync(join(root, "data"), { recursive: true });
  const database = await PGlite.create({ dataDir });
  try {
    const store = new PGliteStore(database);
    await applyPgliteOperationalBaseline(store);
    const automation = createPgliteOperationalStore(store);
    const day = referenceDate.toISOString().slice(0, 10);
    const fubonRun = await automation.createTaskRun({
      taskId: "fubon-all-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 2,
      startedAt: `${day}T08:00:00.000Z`,
    });
    await automation.transitionTaskRunToTerminal(fubonRun.taskRunId, {
      status: "partial",
      finishedAt: `${day}T08:02:00.000Z`,
      exitCode: 0,
      appWorkflowOutcome: {
        errorCode: null,
        summary: {
          status: "partial",
          counts: { rowCount: 1 },
          products: [
            { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
            {
              typeId: "credit_card",
              status: "failed",
              itemCount: 2,
              committedCount: 1,
              errorCode: "canonical-commit-failed",
            },
            {
              typeId: "loan",
              status: "skipped",
              itemCount: 0,
              committedCount: 0,
              skipReason: "not_selected",
            },
          ],
        },
      },
    });
    const esunRun = await automation.createTaskRun({
      taskId: "esun-credit-card-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 2,
      startedAt: `${day}T09:00:00.000Z`,
    });
    await automation.transitionTaskRunToTerminal(esunRun.taskRunId, {
      status: "failed",
      finishedAt: `${day}T09:02:00.000Z`,
      exitCode: 1,
      appWorkflowOutcome: {
        errorCode: "workflow-failed",
        summary: { status: "failed", counts: {} },
      },
    });
  } finally {
    await database.close();
  }
  return dataDir;
}

/** Remove only the named disposable fixture root. */
export function removeDesktopCdpFixture(userData: string) {
  rmSync(assertDisposableFixtureRoot(userData), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

async function main() {
  const userData = process.argv[2];
  if (!userData) throw new Error("Usage: seed-desktop-cdp-fixture <user-data-root>");
  removeDesktopCdpFixture(userData);
  console.log(`Desktop CDP fixture written to ${await seedDesktopCdpFixture(userData)}`);
}

const isCliEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) await main();
