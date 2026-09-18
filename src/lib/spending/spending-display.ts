import type { Locale } from "../i18n/i18n.ts";
import { exactToNumber } from "../shared-money/exact.ts";
import { formatMoney } from "../shared-money/money.ts";
import type { SpendingPurchaseRecordView } from "./purchase-matching.ts";

type SpendingAmount = SpendingPurchaseRecordView["amount"];

/**
 * Keep purchase amounts, record labels, and source-basis labels consistent
 * between the full spending view and its read-only secondary fallback.
 */
export function spendingAmountText(
  amount: SpendingAmount,
  locale: Locale,
  signed = false,
): string {
  if (!amount) return locale === "zh-TW" ? "金額未提供" : "Amount unavailable";
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
  locale: Locale,
  unavailableLabel = locale === "zh-TW" ? "未提供商家名稱" : "Merchant unavailable",
): string {
  return record.description
    ?? record.invoice?.revision.seller.name
    ?? record.transaction?.description
    ?? unavailableLabel;
}

export function spendingBasisLabel(
  record: Pick<SpendingPurchaseRecordView, "basis" | "transaction">,
  locale: Locale,
): string {
  if (record.basis === "linked") return locale === "zh-TW" ? "已配對購買" : "Linked purchase";
  if (record.basis === "invoice") return locale === "zh-TW" ? "電子發票購買" : "E-Invoice purchase";
  if (record.basis === "refund") return locale === "zh-TW" ? "退款" : "Refund";
  const isCreditCard = record.transaction?.stream === "credit-card";
  return isCreditCard
    ? (locale === "zh-TW" ? "信用卡消費" : "Credit-card purchase")
    : (locale === "zh-TW" ? "銀行交易" : "Bank transaction");
}
