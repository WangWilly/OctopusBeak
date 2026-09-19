import type { Locale } from "../i18n/i18n.ts";
import type { Translation } from "../i18n/i18n.ts";
import { exactToNumber } from "../shared-money/exact.ts";
import { formatMoney } from "../shared-money/money.ts";
import type { SpendingPurchaseRecordView } from "./purchase-matching.ts";

type SpendingAmount = SpendingPurchaseRecordView["amount"];

export type SpendingDisplayLabels = Pick<
  Translation["spending"],
  | "amountUnavailable"
  | "merchantUnavailable"
  | "linkedPurchase"
  | "eInvoicePurchase"
  | "refund"
  | "creditCardPurchase"
  | "bankTransaction"
>;

/**
 * Keep purchase amounts, record labels, and source-basis labels consistent
 * between the full spending view and its read-only secondary fallback.
 */
export function spendingAmountText(
  amount: SpendingAmount,
  locale: Locale,
  labels: SpendingDisplayLabels,
  signed = false,
): string {
  if (!amount) return labels.amountUnavailable;
  return formatMoney(
    {
      currency: amount.currency,
      value: exactToNumber(amount),
      exact: amount,
    },
    { locale, signed },
  );
}

export function spendingRecordLabel(
  record: SpendingPurchaseRecordView,
  labels: SpendingDisplayLabels,
  unavailableLabel = labels.merchantUnavailable,
): string {
  return record.description
    ?? record.invoice?.revision.seller.name
    ?? record.transaction?.description
    ?? unavailableLabel;
}

export function spendingBasisLabel(
  record: Pick<SpendingPurchaseRecordView, "basis" | "transaction">,
  labels: SpendingDisplayLabels,
): string {
  if (record.basis === "linked") return labels.linkedPurchase;
  if (record.basis === "invoice") return labels.eInvoicePurchase;
  if (record.basis === "refund") return labels.refund;
  const isCreditCard = record.transaction?.stream === "credit-card";
  return isCreditCard ? labels.creditCardPurchase : labels.bankTransaction;
}
