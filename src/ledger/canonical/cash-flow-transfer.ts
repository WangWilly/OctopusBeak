import type { CashFlowClass, CashFlowKind, CashFlowTransaction } from "./cash-flow-inclusion.ts";
import { compareExact, normalizeCurrency, normalizeExact, sameCurrency } from "../../lib/shared-money/exact-money.ts";

/**
 * Cash-flow transfer links (ADR 0137): a report-level, revocable association
 * of one outflow and one inflow in two of a person's counted accounts. A link
 * never becomes a Transaction Relation and never touches a canonical fact.
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

/** `evidence` is derived on read from both sides' Kinds; the other two are the person's stored decisions. */
export type CashFlowTransferLinkOrigin =
  | Readonly<{ kind: "evidence" }>
  | Readonly<{ kind: "confirmed" | "manual"; eventId: string; decidedAtKnowledge: number }>;

export type CashFlowTransferLink = CashFlowTransferPair & Readonly<{
  /** Stable while the link is current: a transaction is in at most one current link. */
  linkId: string;
  origin: CashFlowTransferLinkOrigin;
}>;

export type CashFlowTransferCandidate = CashFlowTransferPair & Readonly<{ dayGap: number }>;

export type CashFlowTransferPairing = Readonly<{
  links: readonly CashFlowTransferLink[];
  /** Ranked: closest dates first, then by outflow date and the two ids. */
  candidates: readonly CashFlowTransferCandidate[];
}>;

/** What the decision history says about one pair. */
export type CashFlowTransferPairHistory = "denied" | "decided";

export type CashFlowTransferRefusal =
  | "same_transaction"
  | "manual_account"
  | "direction"
  | "same_account"
  | "currency"
  | "amount"
  | "too_far"
  | "linked"
  | "denied";

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

/** Every rule a pair must meet before it may be proposed or paired, in one place. */
export function cashFlowTransferRefusal(
  outflow: CashFlowTransferSide,
  inflow: CashFlowTransferSide,
  reach: CashFlowTransferReach,
  context: CashFlowTransferContext,
): CashFlowTransferRefusal | null {
  if (outflow.transactionId === inflow.transactionId) return "same_transaction";
  // A Manual Account transfer already records both of its sides.
  if (outflow.source !== "canonical" || inflow.source !== "canonical") return "manual_account";
  if (outflow.direction !== "outflow" || inflow.direction !== "inflow") return "direction";
  if (outflow.accountId === inflow.accountId) return "same_account";
  if (!sameCurrency(outflow.amount, inflow.amount)) return "currency";
  if (compareExact(outflow.amount, inflow.amount) !== 0) return "amount";
  if (reach === "candidate" && dayGap(outflow.date, inflow.date) > CASH_FLOW_TRANSFER_WINDOW_DAYS) return "too_far";
  const pair = { outflowTransactionId: outflow.transactionId, inflowTransactionId: inflow.transactionId };
  if (context.linkedElsewhere(outflow.transactionId, pair) || context.linkedElsewhere(inflow.transactionId, pair)) return "linked";
  if (context.history(pair) === "denied") return "denied";
  return null;
}

/**
 * Kinds that prove a side is a move between the person's own accounts. A
 * bank-side `payment.credit_card` has no evidence-backed card-side Kind to
 * meet yet: card inflows get theirs from direction alone (issue #467).
 */
const EVIDENCED_TRANSFER_KINDS: ReadonlySet<string> = new Set(["transfer.internal"]);

function evidencesTransfer(kind: CashFlowKind | null): boolean {
  return kind !== null && kind.basis === "evidence" && EVIDENCED_TRANSFER_KINDS.has(kind.code);
}

export type StoredCashFlowTransferLink = CashFlowTransferPair & Readonly<{
  origin: Extract<CashFlowTransferLinkOrigin, { kind: "confirmed" | "manual" }>;
}>;

const amountKey = (side: CashFlowTransferSide) => {
  const amount = normalizeExact(side.amount);
  return `${normalizeCurrency(side.amount.currency)}|${amount.coefficient}|${amount.scale}`;
};

const ranked = (left: CashFlowTransferCandidate, right: CashFlowTransferCandidate, dateOf: (id: string) => string) =>
  left.dayGap - right.dayGap
  || dateOf(left.outflowTransactionId).localeCompare(dateOf(right.outflowTransactionId))
  || left.outflowTransactionId.localeCompare(right.outflowTransactionId)
  || left.inflowTransactionId.localeCompare(right.inflowTransactionId);

/**
 * The current links and candidates among `sides`. Stored links come first.
 * Evidence links a pair only when both sides carry an evidence-backed
 * internal-transfer Kind, the pair is each side's only candidate, and the
 * person has never decided on it; anything ambiguous stays a candidate.
 */
export function pairCashFlowTransfers(
  sides: readonly CashFlowTransferSide[],
  stored: readonly StoredCashFlowTransferLink[],
  history: ReadonlyMap<string, CashFlowTransferPairHistory>,
): CashFlowTransferPairing {
  const linked = new Set<string>();
  const links: CashFlowTransferLink[] = [];
  const link = (pair: CashFlowTransferPair, origin: CashFlowTransferLinkOrigin) => {
    linked.add(pair.outflowTransactionId).add(pair.inflowTransactionId);
    links.push({ linkId: transferLinkId(pair), outflowTransactionId: pair.outflowTransactionId, inflowTransactionId: pair.inflowTransactionId, origin });
  };
  for (const entry of stored) link(entry, entry.origin);

  const context = cashFlowTransferContext(stored, history);
  const inflows = new Map<string, CashFlowTransferSide[]>();
  for (const side of sides) {
    if (side.direction !== "inflow") continue;
    const key = amountKey(side);
    inflows.set(key, [...inflows.get(key) ?? [], side]);
  }
  const pairs: { outflow: CashFlowTransferSide; inflow: CashFlowTransferSide }[] = [];
  for (const outflow of sides) {
    if (outflow.direction !== "outflow") continue;
    for (const inflow of inflows.get(amountKey(outflow)) ?? []) {
      if (cashFlowTransferRefusal(outflow, inflow, "candidate", context) === null) pairs.push({ outflow, inflow });
    }
  }
  const counterparts = new Map<string, number>();
  for (const { outflow, inflow } of pairs) {
    counterparts.set(outflow.transactionId, (counterparts.get(outflow.transactionId) ?? 0) + 1);
    counterparts.set(inflow.transactionId, (counterparts.get(inflow.transactionId) ?? 0) + 1);
  }
  for (const { outflow, inflow } of pairs) {
    const pair = { outflowTransactionId: outflow.transactionId, inflowTransactionId: inflow.transactionId };
    if (evidencesTransfer(outflow.kind) && evidencesTransfer(inflow.kind)
      && counterparts.get(outflow.transactionId) === 1 && counterparts.get(inflow.transactionId) === 1
      && context.history(pair) === undefined)
      link(pair, { kind: "evidence" });
  }
  const dates = new Map(sides.map((side) => [side.transactionId, side.date]));
  const candidates = pairs
    .filter(({ outflow, inflow }) => !linked.has(outflow.transactionId) && !linked.has(inflow.transactionId))
    .map(({ outflow, inflow }) => ({
      outflowTransactionId: outflow.transactionId,
      inflowTransactionId: inflow.transactionId,
      dayGap: dayGap(outflow.date, inflow.date),
    }))
    .sort((left, right) => ranked(left, right, (id) => dates.get(id) ?? ""));
  return { links, candidates };
}

const LINKED_TRANSFER: CashFlowClass = Object.freeze({ class: "not_counted", reason: "transfer" });

/**
 * A linked side's cash-flow class. The link decides only where no evidence
 * does: both sides must carry nothing but a fallback Kind. An evidence-backed
 * Kind, or a missing one, keeps the side's own class.
 */
export function linkedCashFlowClass(
  side: Pick<CashFlowTransaction, "kind" | "cashFlow">,
  counterpart: Pick<CashFlowTransaction, "kind">,
): CashFlowClass {
  return side.kind?.basis === "fallback" && counterpart.kind?.basis === "fallback" ? LINKED_TRANSFER : side.cashFlow;
}
