import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteOperationalBaseline, createPgliteOperationalStore } from "../src/ledger/pglite/operational.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { applyPgliteBaseline } from "../src/ledger/pglite/baseline.ts";
import type { TypedWorkflowOutcome } from "../src/lib/automation/server/typed-workflow-outcome.ts";
import {
  commitCathay,
  commitTdccSettlement,
  commitTdccYuantaBroker,
  commitYuantaTrade,
} from "../src/ledger/pglite/direct-source-precedence-fixture.ts";
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

/** The latest sync-tdcc outcome the TDCC fixture shows. */
export const desktopCdpTdccOutcomes = ["device-registration-required", "provider-protocol-outdated", "exclusions"] as const;
export type DesktopCdpTdccOutcome = (typeof desktopCdpTdccOutcomes)[number];

export type DesktopCdpFixtureOptions = Readonly<{
  includeCathayVerificationFailure?: boolean;
  /**
   * Enable TDCC with inert sign-in details and no registered device, seed
   * one sync-tdcc run with this outcome, and commit Cathay, Yuanta Trade,
   * and TDCC accounts so Assets lists covered TDCC accounts.
   */
  tdccOutcome?: DesktopCdpTdccOutcome;
}>;

const tdccFixtureCredentials = Object.fromEntries(
  fixtureCredentialGroup("tdcc").credentialFields.map((credentialField, index) =>
    [credentialField.key, `fixture-cdp-tdcc-${index + 1}`] as const),
);

function tdccRunOutcome(outcome: DesktopCdpTdccOutcome): Readonly<{
  status: "partial" | "failed";
  appWorkflowOutcome: TypedWorkflowOutcome;
}> {
  if (outcome === "exclusions") {
    return {
      status: "partial",
      appWorkflowOutcome: {
        errorCode: null,
        summary: {
          status: "partial",
          counts: {
            excludedUnknownInstitutionCount: 1,
            excludedNonIsoCurrencyCount: 1,
            excludedTimeDepositCount: 2,
            hiddenAccountCount: 1,
          },
          products: [
            { typeId: "securities", status: "success", itemCount: 2, committedCount: 2 },
            { typeId: "fund", status: "success", itemCount: 1, committedCount: 1 },
            { typeId: "settlement", status: "failed", itemCount: 1, committedCount: 0, errorCode: "source-collection-failed" },
          ],
        },
      },
    };
  }
  return {
    status: "failed",
    appWorkflowOutcome: { errorCode: outcome, summary: { status: "failed", counts: {} } },
  };
}

/**
 * Keep the base fixture small: one partially completed bank source, one
 * failed provider row, and one credential-group sync source for onboarding.
 * The opt-in verification fixture adds a safe Cathay Gmail setup reason.
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
  options: DesktopCdpFixtureOptions = {},
) {
  const root = assertDisposableFixtureRoot(userData);
  mkdirSync(root, { recursive: true });
  const fixtureSettings = {
    ...desktopCdpFixtureSettings,
    ...(options.includeCathayVerificationFailure ? { LIBRETTO_CLOUD_CATHAY_ENABLED: true } : {}),
    ...(options.tdccOutcome
      ? { LIBRETTO_CLOUD_TDCC_ENABLED: true, LIBRETTO_CLOUD_TDCC_STATEMENT_TYPES: "securities,fund,settlement" }
      : {}),
  };
  writeAutomationSettingsFile(join(root, "settings.json"), fixtureSettings);
  writeAutomationCredentialsFile(
    join(root, "credentials.json"),
    options.tdccOutcome ? { ...desktopCdpFixtureCredentials, ...tdccFixtureCredentials } : desktopCdpFixtureCredentials,
    null,
  );
  const dataDir = join(root, "data", "pglite");
  mkdirSync(join(root, "data"), { recursive: true });
  const database = await PGlite.create({ dataDir });
  try {
    const store = new PGliteStore(database);
    if (options.tdccOutcome) {
      await applyPgliteBaseline(database);
      await commitCathay(store);
      await commitTdccSettlement(store, "013");
      await commitTdccSettlement(store, "812");
      await commitYuantaTrade(store);
      await commitTdccYuantaBroker(store);
    }
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
    if (options.includeCathayVerificationFailure) {
      const cathayRun = await automation.createTaskRun({
        taskId: "cathay-all-statements",
        kind: "crawler",
        status: "running",
        attempt: 1,
        maxAttempts: 2,
        startedAt: `${day}T10:00:00.000Z`,
      });
      await automation.appendRunEvent({
        runId: cathayRun.taskRunId,
        stage: "authentication",
        code: "cathay-email-otp-gmail-needs-authorization",
        occurredAt: `${day}T10:01:00.000Z`,
      });
      await automation.transitionTaskRunToTerminal(cathayRun.taskRunId, {
        status: "failed",
        finishedAt: `${day}T10:02:00.000Z`,
        exitCode: 1,
        appWorkflowOutcome: {
          errorCode: "verification-configuration-failed",
          summary: { status: "failed", counts: {} },
        },
      });
    }
    if (options.tdccOutcome) {
      const tdccRun = await automation.createTaskRun({
        taskId: "sync-tdcc",
        kind: "sync",
        status: "running",
        attempt: 1,
        maxAttempts: 1,
        startedAt: `${day}T11:00:00.000Z`,
      });
      const { status, appWorkflowOutcome } = tdccRunOutcome(options.tdccOutcome);
      await automation.transitionTaskRunToTerminal(tdccRun.taskRunId, {
        status,
        finishedAt: `${day}T11:01:00.000Z`,
        exitCode: status === "failed" ? 1 : 0,
        appWorkflowOutcome,
      });
    }
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
  const tdccOutcome = desktopCdpTdccOutcomes.find((outcome) => outcome === process.env.OCTOPUSBEAK_CDP_TDCC_OUTCOME);
  console.log(`Desktop CDP fixture written to ${await seedDesktopCdpFixture(userData, new Date(), {
    includeCathayVerificationFailure: process.env.OCTOPUSBEAK_CDP_VERIFICATION_FIXTURE === "1",
    ...(tdccOutcome ? { tdccOutcome } : {}),
  })}`);
}

const isCliEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) await main();
