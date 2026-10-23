import type { Locale, Translation } from "../i18n/i18n.ts";
import type { AutomationCredentialStatus } from "../desktop/api.ts";
import type { AutomationTaskRow } from "./types.ts";
import type { WorkflowRunEvent } from "./workflow-executor.ts";
import type { TypedWorkflowOutcome } from "./server/typed-workflow-outcome.ts";
import { TDCC_EXCLUSION_COUNT_NAMES } from "./tdcc-collection-summary.ts";
import { isTerminalAutomationStatus } from "./task-row.ts";
import { workflowFailureExplanation } from "./workflow-failures.ts";

/**
 * Everything the Automation page writes about one task row, in the person's
 * language.  Pure: the same row and context always give the same view.
 */

export type TaskRowViewContext = Readonly<{
  dictionary: Translation;
  locale: Locale;
  timeZone: string;
  /** The task onboarding is following while its progress step is shown, if any. */
  onboardingProgressTaskId: string | null;
  credentialState(key: string): AutomationCredentialStatus;
}>;

export type TaskRowTone = "good" | "warn" | "bad" | "muted" | "active";
export type TaskRowStatusLine = Readonly<{ tone: TaskRowTone; label: string; time: string }>;

export type TaskRowView = Readonly<{
  statusLabel: string;
  /** The latest run's outcome with its time, or "never" without one. */
  runStatus: TaskRowStatusLine;
  /** The source's sync line on the credentials rail. */
  syncStatus: TaskRowStatusLine;
  lastSyncSummary: string;
  /** The last result of each statement type the latest run reported. */
  statementResults: Readonly<Record<string, Readonly<{ tone: TaskRowTone; text: string }>>>;
  progressLabel: string;
  progressWorking: boolean;
  showProgress: boolean;
  showProgressStatus: boolean;
  isOnboardingProgress: boolean;
}>;

const WORKFLOW_PROGRESS_STAGES = [
  "preparation",
  "authentication",
  "collection",
  "decoding",
  "validation",
  "commit",
  "finalization",
];

export function presentTaskRow(row: AutomationTaskRow, context: TaskRowViewContext): TaskRowView {
  const { dictionary } = context;
  const statusLabel = taskStatusLabel(row, dictionary);
  const runStatus = taskRunStatus(row, context);
  const progressWorking = workflowProgressIsWorking(row);
  const isOnboardingProgress = row.id === context.onboardingProgressTaskId;
  return {
    statusLabel,
    runStatus,
    syncStatus: syncStatus(row, runStatus, context),
    lastSyncSummary: lastSyncSummary(row, context),
    statementResults: statementResults(row, dictionary),
    progressLabel: progressLabel(row, dictionary, statusLabel),
    progressWorking,
    showProgress: progressWorking
      || (row.isActive && row.status === "waiting_for_human")
      || (isTerminalAutomationStatus(row.status) && (row.status !== "completed" || isOnboardingProgress)),
    showProgressStatus: row.status === "waiting_for_human" || row.status === "cancelling",
    isOnboardingProgress,
  };
}

/** A failure label for one run event, when the event names a known failure. */
export function workflowEventFailureLabel(event: Pick<WorkflowRunEvent, "stage" | "code">, dictionary: Translation): string | null {
  return isVerificationSolverExhaustedEvent(event) ? dictionary.automation.verificationSolverExhausted : null;
}

export function verificationSolverExhausted(
  events: readonly Pick<WorkflowRunEvent, "stage" | "code">[] | null | undefined,
): boolean {
  return events?.some(isVerificationSolverExhaustedEvent) ?? false;
}

function isVerificationSolverExhaustedEvent(event: Pick<WorkflowRunEvent, "stage" | "code">): boolean {
  return event.stage === "authentication" && event.code === "verification-solver-exhausted";
}

type OutcomeCounts = NonNullable<TypedWorkflowOutcome["summary"]>["counts"];

const TDCC_EXCLUSION_NAMES: ReadonlySet<string> = new Set(TDCC_EXCLUSION_COUNT_NAMES);

/** The run's other counts, which the generic summary row still lists. */
export function countsOutsideTdccExclusions(counts: OutcomeCounts): [string, number | undefined][] {
  return Object.entries(counts).filter(([name]) => !TDCC_EXCLUSION_NAMES.has(name));
}

/** Plain-words lines for the TDCC accounts a run reported but did not admit (ADR 0042), counts only. */
export function tdccExclusionLines(counts: OutcomeCounts, dictionary: Translation): string[] {
  const copy = dictionary.automation.tdccExclusions;
  const lines: ReadonlyArray<readonly [number | undefined, (count: number) => string]> = [
    [counts.excludedUnknownInstitutionCount, copy.unknownInstitution],
    [counts.excludedNonIsoCurrencyCount, copy.nonIsoCurrency],
    [counts.excludedNonNumericAccountCount, copy.nonNumericAccount],
    [counts.excludedTimeDepositCount, copy.timeDeposits],
    [counts.hiddenAccountCount, copy.hiddenAccounts],
    [counts.excludedBankNotUpdatedCount, copy.bankNotUpdated],
    [counts.excludedEmptyNonIsoCurrencyCount, copy.emptyNonIsoCurrency],
  ];
  return lines.flatMap(([count, line]) => count !== undefined && count > 0 ? [line(count)] : []);
}

function taskStatusLabel(row: AutomationTaskRow, dictionary: Translation) {
  if (row.status === "waiting_for_human") return dictionary.automation.progressAutomaticVerification;
  return dictionary.automation.statusLabels[row.status];
}

function formatShortTime(value: string | null, context: TaskRowViewContext) {
  if (!value) return "";
  return new Intl.DateTimeFormat(context.locale, {
    timeZone: context.timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value)).replace(",", "");
}

function taskRunStatus(row: AutomationTaskRow, context: TaskRowViewContext): TaskRowStatusLine {
  const { dictionary } = context;
  const labels = dictionary.automation.credentialSyncStatuses;
  const time = formatShortTime(row.latestFinishedAt ?? row.latestStartedAt, context);
  if (!time) return { tone: "muted", label: labels.never, time: "" };
  if (row.status === "completed") return { tone: "good", label: labels.completed, time };
  if (row.status === "partial") return { tone: "warn", label: labels.partial, time };
  if (row.status === "failed" || row.status === "locked") return { tone: "bad", label: labels.failed, time };
  if (row.status === "cancelled") return { tone: "muted", label: labels.cancelled, time };
  if (row.status === "interrupted") return { tone: "muted", label: labels.interrupted, time };
  return { tone: "muted", label: dictionary.automation.statusLabels[row.status], time };
}

function syncStatus(row: AutomationTaskRow, runStatus: TaskRowStatusLine, context: TaskRowViewContext): TaskRowStatusLine {
  const { dictionary } = context;
  const labels = dictionary.automation.credentialSyncStatuses;
  if (row.isActive) return { tone: "active", label: labels.running, time: "" };
  if (row.credentialKeys.some((key) => context.credentialState(key) === "missing")) {
    return { tone: "warn", label: labels.missingCredentials, time: "" };
  }
  if (row.status === "needs_setup") return { tone: "warn", label: dictionary.automation.needsSetup, time: "" };
  return runStatus;
}

function lastSyncSummary(row: AutomationTaskRow, context: TaskRowViewContext) {
  const { dictionary } = context;
  const outcome = row.appWorkflowOutcome;
  const products = (outcome?.summary?.products ?? []).filter((product) => product.status !== "skipped");
  if (products.length) {
    return products.map((product) => {
      const label = dictionary.automation.statementTypeLabels[product.typeId] ?? product.typeId;
      const summary = product.status === "success"
        ? dictionary.automation.productCommittedSummary(label, product.committedCount)
        : dictionary.automation.productStatusSummary(label, dictionary.automation.productOutcomeStatuses[product.status]);
      const collectionStatus = product.collection?.status;
      return collectionStatus && collectionStatus !== "complete"
        ? `${summary}${dictionary.automation.summarySeparator}${dictionary.automation.tdccCollectionStatuses[collectionStatus]}`
        : summary;
    }).join(dictionary.automation.summarySeparator);
  }
  if (outcome?.errorCode) return workflowFailureExplanation(outcome.errorCode, context.locale) ?? outcome.errorCode;
  return "";
}

function statementResults(row: AutomationTaskRow, dictionary: Translation): TaskRowView["statementResults"] {
  const results: Record<string, { tone: TaskRowTone; text: string }> = {};
  const seen = new Set<string>();
  for (const product of row.appWorkflowOutcome?.summary?.products ?? []) {
    // The first product reported for a type is its result, even when skipped.
    if (seen.has(product.typeId)) continue;
    seen.add(product.typeId);
    if (product.status === "skipped") continue;
    if (product.status === "success") {
      const text = dictionary.automation.statementLastSuccess(product.committedCount);
      results[product.typeId] = {
        tone: product.collection?.status === "incomplete" ? "warn" : "good",
        text: product.collection?.status && product.collection.status !== "complete"
          ? `${text} · ${dictionary.automation.tdccCollectionStatuses[product.collection.status]}`
          : text,
      };
    } else if (product.status === "failed") {
      results[product.typeId] = { tone: "bad", text: dictionary.automation.statementLastFailed };
    } else {
      results[product.typeId] = { tone: "muted", text: dictionary.automation.productOutcomeStatuses[product.status] };
    }
  }
  return results;
}

function workflowProgressStageLabel(row: AutomationTaskRow, dictionary: Translation): string | null {
  const phaseCode = row.workflowProgress?.phaseCode;
  if (!phaseCode?.startsWith("workflow-")) return null;
  const stage = phaseCode.slice("workflow-".length);
  if (!WORKFLOW_PROGRESS_STAGES.includes(stage)) return null;

  const statementType = row.workflowProgress?.params?.statementType;
  const product = typeof statementType === "string"
    ? dictionary.automation.statementTypeLabels[statementType] ?? statementType
    : null;
  if (stage === "collection") {
    const activity = row.workflowProgress?.params?.activity;
    if (activity === "query") {
      return product
        ? dictionary.automation.progressQueryingProduct(product)
        : dictionary.automation.progressQuerying;
    }
    if (activity === "download") {
      return product
        ? dictionary.automation.progressDownloadingProduct(product)
        : dictionary.automation.progressDownloading;
    }
    return product
      ? dictionary.automation.progressStageProduct(dictionary.automation.progressStages[stage], product)
      : dictionary.automation.progressStages[stage] ?? null;
  }

  const stageLabel = dictionary.automation.progressStages[stage];
  return product && stageLabel
    ? dictionary.automation.progressStageProduct(stageLabel, product)
    : stageLabel ?? null;
}

function workflowProgressIsWorking(row: AutomationTaskRow) {
  if (row.status === "waiting_for_human") return row.isActive;
  return row.isActive && (row.status === "preparing" || row.status === "running" || row.status === "cancelling");
}

function progressLabel(row: AutomationTaskRow, dictionary: Translation, statusLabel: string) {
  const copy = dictionary.automation;
  if (row.status === "waiting_for_human") {
    const waiting = copy.progressAutomaticVerification;
    return row.progressPercent === null
      ? waiting
      : copy.progressWaitingWithPercent(waiting, row.progressPercent);
  }
  if (isTerminalAutomationStatus(row.status)) {
    return row.progressPercent === null
      ? statusLabel
      : copy.progressTerminalWithPercent(statusLabel, row.progressPercent);
  }
  const stage = workflowProgressStageLabel(row, dictionary);
  if (stage) {
    const stageWithProgress = row.progressPercent === null
      ? stage
      : copy.progressStagePercent(stage, row.progressPercent);
    return row.workflowProgress?.params?.retrying === true
      ? copy.progressRetryingStage(stageWithProgress, row.attempt || 1, row.maxAttempts)
      : stageWithProgress;
  }
  if (row.status === "preparing") {
    return copy.progressStagePercent(copy.progressStages.preparation, row.progressPercent ?? 0);
  }
  if (row.progressPercent !== null) return `${row.progressPercent}%`;
  if (row.status === "running") return copy.progressRunning(row.attempt || 1, row.maxAttempts);
  if (row.status === "needs_setup") return copy.progressNeedsSetup;
  return copy.progressQueued;
}
