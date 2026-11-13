import type { CashFlowTransaction } from "./cash-flow-inclusion.ts";
import { compareExact, sameCurrency } from "../../lib/shared-money/exact-money.ts";

/**
 * The rules every Cash-flow transfer link meets (ADR 0137), apart from the
 * pairing itself, so the renderer can check a manual pair with the same rule
 * the worker applies without loading inclusion or taxonomy code.
 */

/**
 * The most calendar days between the two sides' financial dates for a
 * candidate, and for "close dates" in an automatic link: a transfer made on a
 * Friday settles by Monday.
 */
export const CASH_FLOW_TRANSFER_WINDOW_DAYS = 3;

/** One side of a possible link. Only Cash flow rows can become one, so every side is in a counted, non-preview account. */
export type CashFlowTransferSide = Pick<
  CashFlowTransaction,
  "transactionId" | "source" | "accountId" | "date" | "amount" | "direction" | "kind"
>;

export type CashFlowTransferPair = Readonly<{ outflowTransactionId: string; inflowTransactionId: string }>;

/** What the decision history says about one pair. */
export type CashFlowTransferPairHistory = "denied" | "decided";

/** The rules every link must meet, whenever it is proposed, paired or applied. */
export type CashFlowTransferInvalidity =
  | "same_transaction"
  | "manual_account"
  | "direction"
  | "same_account"
  | "currency"
  | "amount";

export type CashFlowTransferRefusal = CashFlowTransferInvalidity | "too_far" | "linked" | "denied";

/** `candidate` is what the page proposes; `manual` is what the person may pair, without the date window. */
export type CashFlowTransferReach = "candidate" | "manual";

export type CashFlowTransferContext = Readonly<{
  /** Whether a transaction is in a current link other than this pair. */
  linkedElsewhere(transactionId: string, pair: CashFlowTransferPair): boolean;
  history(pair: CashFlowTransferPair): CashFlowTransferPairHistory | undefined;
}>;

export function transferLinkId(pair: CashFlowTransferPair): string {
  return `${pair.outflowTransactionId}/${pair.inflowTransactionId}`;
}

export function cashFlowTransferContext(
  links: readonly CashFlowTransferPair[],
  history: ReadonlyMap<string, CashFlowTransferPairHistory>,
): CashFlowTransferContext {
  const linkOf = new Map(links.flatMap((link) => {
    const linkId = transferLinkId(link);
    return [[link.outflowTransactionId, linkId], [link.inflowTransactionId, linkId]] as const;
  }));
  return {
    linkedElsewhere: (id, pair) => linkOf.has(id) && linkOf.get(id) !== transferLinkId(pair),
    history: (pair) => history.get(transferLinkId(pair)),
  };
}

export function dayGap(left: string, right: string): number {
  return Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;
}

/**
 * What two counted sides must be to form any link: candidate, manual pair or
 * stored link. Being counted already makes each side's account owned,
 * non-Preview and not covered; the date window is not a validity rule.
 */
export function cashFlowTransferInvalidity(outflow: CashFlowTransferSide, inflow: CashFlowTransferSide): CashFlowTransferInvalidity | null {
  if (outflow.transactionId === inflow.transactionId) return "same_transaction";
  // A Manual Account transfer already records both of its sides.
  if (outflow.source !== "canonical" || inflow.source !== "canonical") return "manual_account";
  if (outflow.direction !== "outflow" || inflow.direction !== "inflow") return "direction";
  if (outflow.accountId === inflow.accountId) return "same_account";
  if (!sameCurrency(outflow.amount, inflow.amount)) return "currency";
  if (compareExact(outflow.amount, inflow.amount) !== 0) return "amount";
  return null;
}

/** Every rule a pair must meet before it may be proposed or paired, in one place. */
export function cashFlowTransferRefusal(
  outflow: CashFlowTransferSide,
  inflow: CashFlowTransferSide,
  reach: CashFlowTransferReach,
  context: CashFlowTransferContext,
): CashFlowTransferRefusal | null {
  const invalidity = cashFlowTransferInvalidity(outflow, inflow);
  if (invalidity !== null) return invalidity;
  if (reach === "candidate" && dayGap(outflow.date, inflow.date) > CASH_FLOW_TRANSFER_WINDOW_DAYS) return "too_far";
  const pair = { outflowTransactionId: outflow.transactionId, inflowTransactionId: inflow.transactionId };
  if (context.linkedElsewhere(outflow.transactionId, pair) || context.linkedElsewhere(inflow.transactionId, pair)) return "linked";
  if (context.history(pair) === "denied") return "denied";
  return null;
}
