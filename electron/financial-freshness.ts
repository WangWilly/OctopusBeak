import type { CanonicalFinancialCommitReceipt } from "../src/ledger/canonical/canonical-financial-commit-receipt.ts";

export const FINANCIAL_FRESHNESS_CHANGED_CHANNEL =
  "financialFreshness:changed" as const;
export const FINANCIAL_FRESHNESS_LATEST_CHANNEL =
  "financialFreshness:latestKnowledgePoint" as const;

export type FinancialFreshnessEvent = Readonly<{
  knowledgePoint: number;
}>;

export type FinancialFreshnessWindow = {
  isDestroyed(): boolean;
  webContents: {
    send(channel: typeof FINANCIAL_FRESHNESS_CHANGED_CHANNEL, event: FinancialFreshnessEvent): void;
  };
};

export type FinancialFreshnessBroadcaster = Readonly<{
  publish(receipt: Pick<CanonicalFinancialCommitReceipt, "commitSequence">): boolean;
  latestKnowledgePoint(): number;
}>;

export function createFinancialFreshnessBroadcaster(options: {
  getWindows: () => readonly FinancialFreshnessWindow[];
  warn?: (message: string) => void;
}): FinancialFreshnessBroadcaster {
  let latest = 0;
  const warn = options.warn ?? ((message) => console.warn(message));

  return Object.freeze({
    publish(receipt) {
      const knowledgePoint = receipt.commitSequence;
      if (!Number.isSafeInteger(knowledgePoint) || knowledgePoint <= latest) {
        return false;
      }
      latest = knowledgePoint;
      const event = Object.freeze({ knowledgePoint });
      for (const window of options.getWindows()) {
        if (window.isDestroyed()) continue;
        try {
          window.webContents.send(FINANCIAL_FRESHNESS_CHANGED_CHANNEL, event);
        } catch {
          warn("financial-freshness-delivery-failed");
        }
      }
      return true;
    },
    latestKnowledgePoint() {
      return latest;
    },
  });
}

/** Read only the operational knowledge point; no financial payload crosses IPC. */
export function latestKnowledgePointFromDatabase(database: {
  prepare(sql: string): { get(): unknown };
}): number {
  const row = database
    .prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits")
    .get();
  const value =
    row && typeof row === "object" && !Array.isArray(row)
      ? (row as Record<string, unknown>).value
      : undefined;
  const knowledgePoint = Number(value ?? 0);
  if (!Number.isSafeInteger(knowledgePoint) || knowledgePoint < 0) {
    throw new Error("Canonical knowledge point is invalid.");
  }
  return knowledgePoint;
}
