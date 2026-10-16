import type { AutomationTaskHistoryRow } from "../automation/types.ts";
import type { SupersededAccountIdentity } from "../automation/server/typed-workflow-outcome.ts";
import type {
  SupersededAccountPurgePreview as LedgerPurgePreview,
  SupersededAccountPurgeRefusal as LedgerPurgeRefusal,
  SupersededAccountPurgeResult as LedgerPurgeResult,
} from "../../ledger/pglite/superseded-account-purge.ts";

export type { SupersededAccountIdentity };

export const FUBON_ALL_STATEMENTS_TASK_ID = "fubon-all-statements";

export type SupersededAccountPurgeRefusalReason = LedgerPurgeRefusal["refused"];

export type SupersededAccountPurgePreviewDto =
  | Readonly<{
    status: "ready";
    transactionCount: number;
    captureCount: number;
    balanceObservationCount: number;
  }>
  | Readonly<{ status: "refused"; reason: SupersededAccountPurgeRefusalReason }>;

export type SupersededAccountPurgeOutcomeDto =
  | Readonly<{ status: "purged"; deletedRowCount: number }>
  | Readonly<{ status: "refused"; reason: SupersededAccountPurgeRefusalReason }>;

export function latestFubonSupersededAccountIdentities(
  rows: readonly AutomationTaskHistoryRow[],
): readonly SupersededAccountIdentity[] {
  const latest = rows
    .filter((row) => row.taskId === FUBON_ALL_STATEMENTS_TASK_ID && row.appWorkflowOutcome?.summary)
    .reduce<AutomationTaskHistoryRow | null>(
      (newest, row) => (newest && newest.startedAt >= row.startedAt ? newest : row),
      null,
    );
  return latest?.appWorkflowOutcome?.summary?.supersededAccountIdentities ?? [];
}

export function isListedSupersededAccountIdentity(
  listed: readonly SupersededAccountIdentity[],
  candidate: unknown,
): candidate is SupersededAccountIdentity {
  if (!candidate || typeof candidate !== "object") return false;
  const { supersededSourceAccountKey, successorSourceAccountKey } = candidate as Record<string, unknown>;
  return listed.some((identity) =>
    identity.supersededSourceAccountKey === supersededSourceAccountKey
    && identity.successorSourceAccountKey === successorSourceAccountKey);
}

export function fubonDepositPurgeRequest(identity: SupersededAccountIdentity) {
  return {
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    supersededSourceAccountKey: identity.supersededSourceAccountKey,
    successorSourceAccountKey: identity.successorSourceAccountKey,
  } as const;
}

export function supersededAccountPurgePreviewDto(
  result: LedgerPurgePreview | LedgerPurgeRefusal,
): SupersededAccountPurgePreviewDto {
  if ("refused" in result) return { status: "refused", reason: result.refused };
  return {
    status: "ready",
    transactionCount: result.transactionCount,
    captureCount: result.captureCount,
    balanceObservationCount: result.balanceObservationCount,
  };
}

export function supersededAccountPurgeOutcomeDto(
  result: LedgerPurgeResult | LedgerPurgeRefusal,
): SupersededAccountPurgeOutcomeDto {
  if ("refused" in result) return { status: "refused", reason: result.refused };
  return { status: "purged", deletedRowCount: result.deletedRowCount };
}

export type SupersededAccountPurgeRowState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; preview: Extract<SupersededAccountPurgePreviewDto, { status: "ready" }>; confirming: boolean }>
  | Readonly<{ kind: "purging"; preview: Extract<SupersededAccountPurgePreviewDto, { status: "ready" }> }>
  | Readonly<{ kind: "purged" }>
  | Readonly<{ kind: "refused"; reason: SupersededAccountPurgeRefusalReason }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "failed" }>;

export function rowStateAfterPreview(
  preview: SupersededAccountPurgePreviewDto,
  purgedThisSession: boolean,
): SupersededAccountPurgeRowState {
  if (preview.status === "ready") return { kind: "ready", preview, confirming: false };
  if (preview.reason === "superseded-account-missing")
    return purgedThisSession ? { kind: "purged" } : { kind: "missing" };
  return { kind: "refused", reason: preview.reason };
}

export function rowIsVisible(state: SupersededAccountPurgeRowState): boolean {
  return state.kind !== "loading" && state.kind !== "missing";
}
