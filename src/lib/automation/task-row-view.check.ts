import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { translations, type Locale } from "../i18n/i18n.ts";
import type { AutomationTaskRow } from "./types.ts";
import {
  countsOutsideTdccExclusions,
  presentTaskRow,
  tdccExclusionLines,
  verificationSolverExhausted,
  workflowEventFailureLabel,
  type TaskRowViewContext,
} from "./task-row-view.ts";

function row(overrides: Partial<AutomationTaskRow> = {}): AutomationTaskRow {
  return {
    id: "post-statements",
    runId: "run-1",
    label: "Post",
    displayName: { en: "Post", "zh-TW": "中華郵政" },
    kind: "crawler",
    integrationNamespaces: [],
    credentialKeys: ["POST_ID"],
    dependencies: [],
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    latestStartedAt: "2026-10-23T01:00:00.000Z",
    latestFinishedAt: null,
    workflowProgress: null,
    appWorkflowOutcome: null,
    events: [],
    progressPercent: null,
    humanSession: null,
    humanAssistanceContract: null,
    forceTerminateAvailable: false,
    isActive: true,
    ranToday: false,
    credentialsReady: true,
    setupRequired: false,
    primaryAction: "Cancel",
    canRun: true,
    ...overrides,
  };
}

function context(locale: Locale, overrides: Partial<TaskRowViewContext> = {}): TaskRowViewContext {
  return {
    dictionary: translations[locale],
    locale,
    timeZone: "Asia/Taipei",
    onboardingProgressTaskId: null,
    credentialState: () => "ready",
    ...overrides,
  };
}

const HAS_LATIN_WORD = /[A-Za-z]{3,}/u;

test("a running row's progress reads in the interface language before any percent arrives", () => {
  for (const status of ["preparing", "running", "waiting_for_human", "cancelling"] as const) {
    const label = presentTaskRow(row({ status }), context("zh-TW")).progressLabel;
    assert.doesNotMatch(label, HAS_LATIN_WORD, `${status}: ${label}`);
  }
  assert.equal(presentTaskRow(row(), context("zh-TW")).progressLabel, translations["zh-TW"].automation.progressRunning(1, 2));
});

test("a terminal row shows its progress only when it needs attention or onboarding follows it", () => {
  const completed = row({ status: "completed", isActive: false, progressPercent: 100 });
  assert.equal(presentTaskRow(completed, context("en")).showProgress, false);
  assert.equal(presentTaskRow(completed, context("en", { onboardingProgressTaskId: "post-statements" })).showProgress, true);
  assert.equal(presentTaskRow(row({ status: "failed", isActive: false }), context("en")).showProgress, true);
  assert.equal(presentTaskRow(row({ status: "queued", isActive: false }), context("en")).showProgress, false);
});

test("the sync line puts an active run first, then missing credentials, then the last run", () => {
  const missing = context("en", { credentialState: () => "missing" });
  assert.equal(presentTaskRow(row(), missing).syncStatus.tone, "active");
  assert.equal(presentTaskRow(row({ status: "completed", isActive: false }), missing).syncStatus.label, translations.en.automation.credentialSyncStatuses.missingCredentials);
  const finished = presentTaskRow(row({ status: "completed", isActive: false }), context("en"));
  assert.deepEqual(finished.syncStatus, finished.runStatus);
  assert.equal(finished.runStatus.tone, "good");
  assert.equal(presentTaskRow(row({ status: "completed", isActive: false, latestStartedAt: null }), context("en")).runStatus.label, translations.en.automation.credentialSyncStatuses.never);
});

test("collection progress names the activity and product, and a retry names the attempt", () => {
  const copy = translations.en.automation;
  const collecting = (params: Record<string, string | number | boolean>, overrides: Partial<AutomationTaskRow> = {}) =>
    presentTaskRow(row({
      workflowProgress: { phaseCode: "workflow-collection", completed: null, total: null, percent: null, attempt: 1, params },
      ...overrides,
    }), context("en")).progressLabel;
  const product = copy.statementTypeLabels.deposit ?? "deposit";
  assert.equal(collecting({ activity: "query", statementType: "deposit" }), copy.progressQueryingProduct(product));
  assert.equal(collecting({ activity: "query" }), copy.progressQuerying);
  assert.equal(collecting({ activity: "download", statementType: "deposit" }), copy.progressDownloadingProduct(product));
  assert.equal(collecting({}), copy.progressStages.collection);
  assert.equal(
    collecting({ retrying: true }, { attempt: 2, progressPercent: 30 }),
    copy.progressRetryingStage(copy.progressStagePercent(copy.progressStages.collection, 30), 2, 2),
  );
});

test("each finished status has its own tone on the run line, and a source that needs setup says so", () => {
  const tone = (status: AutomationTaskRow["status"]) =>
    presentTaskRow(row({ status, isActive: false }), context("en")).runStatus.tone;
  assert.equal(tone("completed"), "good");
  assert.equal(tone("partial"), "warn");
  assert.equal(tone("failed"), "bad");
  assert.equal(tone("locked"), "bad");
  assert.equal(tone("cancelled"), "muted");
  assert.deepEqual(
    presentTaskRow(row({ status: "needs_setup", isActive: false }), context("en")).syncStatus,
    { tone: "warn", label: translations.en.automation.needsSetup, time: "" },
  );
});

test("statement results come from the first product reported for each type", () => {
  const outcome = {
    summary: {
      products: [
        { typeId: "deposit", status: "success", committedCount: 3 },
        { typeId: "loan", status: "failed", committedCount: 0 },
        { typeId: "card", status: "skipped", committedCount: 0 },
        { typeId: "card", status: "success", committedCount: 1 },
      ],
      counts: {},
    },
  } as unknown as AutomationTaskRow["appWorkflowOutcome"];
  const view = presentTaskRow(row({ status: "partial", isActive: false, appWorkflowOutcome: outcome }), context("en"));
  assert.deepEqual(view.statementResults, {
    deposit: { tone: "good", text: translations.en.automation.statementLastSuccess(3) },
    loan: { tone: "bad", text: translations.en.automation.statementLastFailed },
  });
});

test("a solver-exhausted authentication event is the one labelled verification failure", () => {
  const exhausted = [{ stage: "authentication", code: "verification-solver-exhausted" }] as const;
  assert.equal(verificationSolverExhausted(exhausted), true);
  assert.equal(workflowEventFailureLabel(exhausted[0], translations.en), translations.en.automation.verificationSolverExhausted);
  assert.equal(verificationSolverExhausted([{ stage: "authentication", code: "device-registration-required" }]), false);
  assert.equal(verificationSolverExhausted([{ stage: "collection", code: "verification-solver-exhausted" }]), false);
  for (const dictionary of [translations.en.automation, translations["zh-TW"].automation]) {
    assert.ok(dictionary.verificationSolverExhausted);
    assert.doesNotMatch(dictionary.statusLabels.waiting_for_human, /human|人工/i);
    assert.doesNotMatch(dictionary.progressAutomaticVerification, /human|人工/i);
  }
  assert.equal(translations.en.automation.statusLabels.waiting_for_human, "verifying");
  assert.equal(translations["zh-TW"].automation.statusLabels.waiting_for_human, "驗證中");
});

test("the dashboard no longer offers manual verification", () => {
  const dashboard = readFileSync(new URL("./AutomationDashboard.svelte", import.meta.url), "utf8");
  assert.doesNotMatch(dashboard, /shouldOfferManualVerification|verificationActorsByCredentialGroup|openHumanViewer/);
  const page = readFileSync(new URL("../../routes/+page.svelte", import.meta.url), "utf8");
  assert.doesNotMatch(page, /verificationActorsByCredentialGroup/);
});

test("TDCC exclusions read as plain counts and leave out what the run did not report", () => {
  const counts = {
    excludedUnknownInstitutionCount: 2,
    excludedNonIsoCurrencyCount: 0,
    excludedTimeDepositCount: 3,
    hiddenAccountCount: 1,
    excludedBankNotUpdatedCount: 1,
    excludedEmptyNonIsoCurrencyCount: 1,
    rowCount: 40,
  };
  assert.deepEqual(tdccExclusionLines(counts, translations["zh-TW"]), [
    "2 個帳戶的銀行或券商代碼尚未收錄。",
    "3 筆定期存款目前不匯入。",
    "1 個帳戶在集保e手掌握 App 中設為隱藏。",
    "1 家銀行這次未能從集保更新，它的交割帳戶沒有匯入，請稍後再同步。",
    "1 個交割帳戶的幣別不明且餘額為 0，不匯入。",
  ]);
  assert.deepEqual(tdccExclusionLines(counts, translations.en), [
    "2 accounts are at a bank or broker code OctopusBeak does not know yet.",
    "3 time deposits are not imported yet.",
    "1 account is hidden in the TDCC e-Passbook phone App.",
    "TDCC could not update 1 bank this time, so its settlement accounts were not imported. Sync again later.",
    "1 settlement account has no standard currency code and a zero balance, so it is not imported.",
  ]);
  assert.deepEqual(tdccExclusionLines({ rowCount: 40 }, translations.en), []);
  assert.deepEqual(countsOutsideTdccExclusions(counts), [["rowCount", 40]], "exclusions are not repeated as raw counts");
});
