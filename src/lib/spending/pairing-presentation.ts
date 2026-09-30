import type {
  SpendingMatchingMoney,
  SpendingPurchaseTransactionView,
  SpendingPurchaseOccurrence,
  SpendingPurchaseRecordView,
} from "./purchase-matching.ts";
import { transactionPurchaseDate } from "./purchase-matching.ts";

/**
 * The worker owns candidate lookup and ordering.  This small DTO is the only
 * shape the renderer needs to display and submit a pairing choice, so opening
 * the dialog never has to scan the complete Spending report.
 */
export type SpendingPairingCandidateView = Readonly<{
  purchaseId: string;
  transactionId: string;
  description: string | null;
  amount: SpendingMatchingMoney;
  occurrence: SpendingPurchaseOccurrence;
  stream: string;
  effectiveDateBasis: "consume-date" | "posting-date-fallback" | null;
}>;

export function createSpendingPairingCandidateView(
  record: SpendingPurchaseRecordView,
): SpendingPairingCandidateView {
  if (record.basis !== "bank-transaction" || !record.transaction || !record.amount)
    throw new Error("Spending pairing candidates must be unlinked bank transactions with an amount.");
  return Object.freeze({
    ...createSpendingPairingCandidateViewFromTransaction(record.transaction, record.purchaseId),
    occurrence: record.occurrence,
  });
}

/** Build the renderer DTO directly from the pairing-only canonical query. */
export function createSpendingPairingCandidateViewFromTransaction(
  transaction: SpendingPurchaseTransactionView,
  purchaseId = `transaction:${transaction.transactionId}`,
): SpendingPairingCandidateView {
  const purchaseDate = transactionPurchaseDate(transaction);
  return Object.freeze({
    purchaseId,
    transactionId: transaction.transactionId,
    description: transaction.description,
    amount: transaction.amount,
    occurrence: {
      value: purchaseDate.value,
      precision: "date" as const,
      timeZone: "unknown",
      basis: purchaseDate.basis === "consume-date"
        ? "purchase-date" as const
        : "posting-date-fallback" as const,
    },
    stream: transaction.stream,
    effectiveDateBasis: transaction.effectiveDateBasis ?? null,
  });
}
