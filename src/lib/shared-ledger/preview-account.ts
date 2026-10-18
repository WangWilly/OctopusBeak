import type {
  AccountRowDto,
  PreviewPurchaseRowDto,
  PreviewStatementRowDto,
  PreviewTimeDepositDto,
} from "./types.ts";

/** Whether a preview liability row's balance is unknown, so any total holding it is incomplete. */
export const previewBalanceUnknown = (account: AccountRowDto): boolean =>
  account.preview !== undefined && account.group === "liability" && account.valueAvailability === "unavailable";

/** A total over these accounts is not a figure while any of them owes an unknown amount. */
export const totalIncomplete = (accounts: readonly AccountRowDto[]): boolean => accounts.some(previewBalanceUnknown);

/** What a preview row shows in its balance cell. */
export type PreviewRowValue =
  | Readonly<{ kind: "amount" }>
  | Readonly<{ kind: "awaiting" }>
  | Readonly<{ kind: "credit-unknown" }>
  | Readonly<{ kind: "closed"; closedOn: string }>;

export function previewRowValue(account: AccountRowDto): PreviewRowValue | null {
  const preview = account.preview;
  if (!preview) return null;
  const closedAt = preview.timeDeposit?.closedAt;
  if (closedAt) return { kind: "closed", closedOn: closedAt.slice(0, 10) };
  if (previewBalanceUnknown(account)) return { kind: "credit-unknown" };
  return account.amountLines.length > 0 ? { kind: "amount" } : { kind: "awaiting" };
}

export type TimeDepositTerm =
  | Readonly<{ kind: "maturity"; date: string }>
  | Readonly<{ kind: "principal"; amount: string }>
  | Readonly<{ kind: "rate"; percent: string }>;

/** The terms the source reported, in reading order; an unknown term is left out, never shown as zero. */
export function timeDepositTerms(deposit: PreviewTimeDepositDto): TimeDepositTerm[] {
  return [
    ...(deposit.maturityDate ? [{ kind: "maturity", date: deposit.maturityDate } as const] : []),
    ...(deposit.principal ? [{ kind: "principal", amount: deposit.principal } as const] : []),
    ...(deposit.interestRate ? [{ kind: "rate", percent: deposit.interestRate } as const] : []),
  ];
}

export type PurchaseState = "pending" | "unbilled" | "billed";

export function purchaseState(row: PreviewPurchaseRowDto): PurchaseState {
  return row.posting.status === "pending" ? "pending" : row.posting.billing;
}

/** A source local time at the precision it was given: `2026-10-04` or `2026-10-04 09:30`. */
export function localTime(value: Readonly<{ value: string }>): string {
  return value.value.replace("T", " ");
}

export type StatementPayment = "paid" | "partially-paid" | "unpaid" | "no-payment-needed";

/** Groups the integer digits of an exact decimal lexeme without converting it to a number. */
export function groupDigits(amount: string): string {
  const match = /^([+-]?)(\d+)(\.\d+)?$/u.exec(amount);
  if (!match) return amount;
  const [, sign, whole, fraction = ""] = match;
  return `${sign}${whole!.replace(/\B(?=(\d{3})+$)/gu, ",")}${fraction}`;
}

/** The payment state when the source reported one; `null` when it is unknown. */
export function statementPayment(statement: PreviewStatementRowDto): StatementPayment | null {
  if (statement.noPaymentNeeded === true) return "no-payment-needed";
  if (statement.paid === true) return "paid";
  if (statement.paid === false)
    return statement.paidAmount !== null && Number(statement.paidAmount) > 0 ? "partially-paid" : "unpaid";
  return null;
}
