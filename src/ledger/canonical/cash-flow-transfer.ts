import { linkExcludable, type CashFlowClass, type CashFlowKind, type CashFlowTransaction } from "./cash-flow-inclusion.ts";
import {
  CASH_FLOW_TRANSFER_WINDOW_DAYS,
  cashFlowTransferContext,
  cashFlowTransferInvalidity,
  cashFlowTransferRefusal,
  dayGap,
  isCurrencyExchange,
  transferLinkId,
  type CashFlowTransferInvalidity,
  type CashFlowTransferPair,
  type CashFlowTransferPairHistory,
  type CashFlowTransferSide,
} from "./cash-flow-transfer-rules.ts";
import { normalizeCurrency, normalizeExact } from "../../lib/shared-money/exact-money.ts";
/**
 * Cash-flow transfer links (ADR 0137): a report-level, revocable association
 * of one outflow and one inflow in two of a person's counted accounts. A link
 * never becomes a Transaction Relation and never touches a canonical fact.
 */


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

/**
 * Why a stored link does not apply now. `not_counted` names the sides Cash
 * flow no longer counts: covered, canceled, deleted, pending or gone.
 */
export type CashFlowTransferSuspension =
  | Readonly<{ reason: "not_counted"; transactionIds: readonly string[] }>
  | Readonly<{ reason: CashFlowTransferInvalidity }>;

/** A stored link whose sides no longer meet its rules. It changes nothing until they do again. */
export type CashFlowTransferSuspendedLink = CashFlowTransferLink & Readonly<{ suspension: CashFlowTransferSuspension }>;

export type CashFlowTransferPairing = Readonly<{
  /** The links that apply: every evidence link and every valid stored link. */
  links: readonly CashFlowTransferLink[];
  suspended: readonly CashFlowTransferSuspendedLink[];
  /** Ranked: closest dates first, then by outflow date and the two ids. */
  candidates: readonly CashFlowTransferCandidate[];
}>;


/**
 * Kinds that prove a side is a move between the person's own accounts. Both
 * sides of an evidence link carry the same one: two internal transfers, or a
 * card bill payment whose bank debit and card credit both name it.
 */
const EVIDENCED_TRANSFER_KINDS: ReadonlySet<string> = new Set(["transfer.internal", "payment.credit_card"]);

function evidencesTransfer(outflow: CashFlowKind | null, inflow: CashFlowKind | null): boolean {
  return outflow !== null && inflow !== null && outflow.basis === "evidence" && inflow.basis === "evidence"
    && outflow.code === inflow.code && EVIDENCED_TRANSFER_KINDS.has(outflow.code);
}

const internalTransfer = (kind: CashFlowKind | null) => kind?.basis === "evidence" && kind.code === "transfer.internal";

/**
 * A side as pairing reads it: `institutionKey` is the Institution of its
 * account, which a currency exchange link's evidence compares (ADR 0143).
 */
export type CashFlowTransferPairingSide = CashFlowTransferSide & Readonly<{ institutionKey: string | null; stream: string | null }>;

/** Exchanges happen between deposit accounts; a card or investment row is never an exchange side. */
const EXCHANGE_STREAMS: ReadonlySet<string> = new Set(["domestic-deposit", "foreign-currency-deposit"]);

/**
 * Whether a side may be proposed as one end of an exchange (ADR 0143): a
 * deposit row whose own evidence does not already decide it as something other
 * than an internal transfer, so a salary or an evidenced payment is never offered.
 */
function exchangeSideEligible(side: CashFlowTransferPairingSide): boolean {
  if (side.stream === null || !EXCHANGE_STREAMS.has(side.stream)) return false;
  return side.kind === null || side.kind.basis !== "evidence" || side.kind.code === "transfer.internal";
}

/**
 * What proves a currency exchange (ADR 0143): both sides carry a bank's
 * exchange label and an evidence-backed internal transfer, at the same
 * Institution, on the same date. The amounts never match, so they prove nothing.
 */
function evidencesExchange(outflow: CashFlowTransferPairingSide, inflow: CashFlowTransferPairingSide): boolean {
  return outflow.exchangeLabel && inflow.exchangeLabel
    && internalTransfer(outflow.kind) && internalTransfer(inflow.kind)
    && outflow.institutionKey !== null && outflow.institutionKey === inflow.institutionKey
    && outflow.date === inflow.date;
}

export type StoredCashFlowTransferLink = CashFlowTransferPair & Readonly<{
  origin: Extract<CashFlowTransferLinkOrigin, { kind: "confirmed" | "manual" }>;
}>;

const pairOf = (pair: CashFlowTransferPair): CashFlowTransferPair =>
  ({ outflowTransactionId: pair.outflowTransactionId, inflowTransactionId: pair.inflowTransactionId });

const amountKey = (side: CashFlowTransferSide) => {
  const amount = normalizeExact(side.amount);
  return `${normalizeCurrency(side.amount.currency)}|${amount.coefficient}|${amount.scale}`;
};

const ranked = (left: CashFlowTransferCandidate, right: CashFlowTransferCandidate, dateOf: (id: string) => string) =>
  left.dayGap - right.dayGap
  || dateOf(left.outflowTransactionId).localeCompare(dateOf(right.outflowTransactionId))
  || left.outflowTransactionId.localeCompare(right.outflowTransactionId)
  || left.inflowTransactionId.localeCompare(right.inflowTransactionId);

/** Why a stored link does not apply among `sides`, or null when it does. */
export function cashFlowTransferSuspension(
  link: CashFlowTransferPair,
  sideOf: ReadonlyMap<string, CashFlowTransferSide>,
): CashFlowTransferSuspension | null {
  const outflow = sideOf.get(link.outflowTransactionId);
  const inflow = sideOf.get(link.inflowTransactionId);
  if (!outflow || !inflow) {
    const transactionIds = [link.outflowTransactionId, link.inflowTransactionId].filter((id) => !sideOf.has(id));
    return { reason: "not_counted", transactionIds };
  }
  const invalidity = cashFlowTransferInvalidity(outflow, inflow);
  return invalidity === null ? null : { reason: invalidity };
}

/**
 * The current links, suspended links and candidates among `sides`. A stored
 * link applies only while both sides are among `sides` and still valid; a
 * suspended one blocks nothing and applies again once its sides are valid.
 * Evidence links a pair only when both sides carry the same evidence-backed
 * `transfer.internal` or `payment.credit_card` Kind, the pair is each side's only candidate, and the
 * person has never decided on it; anything ambiguous stays a candidate. A pair
 * across currencies is a currency exchange (ADR 0143): evidence links it only
 * as `evidencesExchange` says, when it is each side's only such candidate.
 */
export function pairCashFlowTransfers(
  sides: readonly CashFlowTransferPairingSide[],
  stored: readonly StoredCashFlowTransferLink[],
  history: ReadonlyMap<string, CashFlowTransferPairHistory>,
): CashFlowTransferPairing {
  const linked = new Set<string>();
  const links: CashFlowTransferLink[] = [];
  const link = (pair: CashFlowTransferPair, origin: CashFlowTransferLinkOrigin) => {
    linked.add(pair.outflowTransactionId).add(pair.inflowTransactionId);
    links.push({ linkId: transferLinkId(pair), ...pairOf(pair), origin });
  };
  const sideOf = new Map(sides.map((side) => [side.transactionId, side]));
  const suspended: CashFlowTransferSuspendedLink[] = [];
  for (const entry of stored) {
    const suspension = cashFlowTransferSuspension(entry, sideOf);
    if (suspension === null) link(entry, entry.origin);
    else suspended.push({ ...pairOf(entry), linkId: transferLinkId(entry), origin: entry.origin, suspension });
  }

  const context = cashFlowTransferContext(links, history);
  type Pair = { outflow: CashFlowTransferPairingSide; inflow: CashFlowTransferPairingSide };
  const inflows = new Map<string, CashFlowTransferPairingSide[]>();
  for (const side of sides) {
    if (side.direction !== "inflow") continue;
    const key = amountKey(side);
    inflows.set(key, [...inflows.get(key) ?? [], side]);
  }
  const pairs: Pair[] = [];
  for (const outflow of sides) {
    if (outflow.direction !== "outflow") continue;
    for (const inflow of inflows.get(amountKey(outflow)) ?? []) {
      if (cashFlowTransferRefusal(outflow, inflow, "candidate", context) === null) pairs.push({ outflow, inflow });
    }
  }
  const exchanges = exchangeCandidates(sides, context);
  const counterparts = (found: readonly Pair[]) => {
    const counts = new Map<string, number>();
    for (const { outflow, inflow } of found) {
      counts.set(outflow.transactionId, (counts.get(outflow.transactionId) ?? 0) + 1);
      counts.set(inflow.transactionId, (counts.get(inflow.transactionId) ?? 0) + 1);
    }
    return (id: string) => counts.get(id) ?? 0;
  };
  // Same-currency evidence counts same-currency candidates only, so an exchange nearby never unlinks a transfer.
  const sameCurrencyCount = counterparts(pairs);
  for (const { outflow, inflow } of pairs) {
    const pair = { outflowTransactionId: outflow.transactionId, inflowTransactionId: inflow.transactionId };
    if (evidencesTransfer(outflow.kind, inflow.kind)
      && sameCurrencyCount(outflow.transactionId) === 1 && sameCurrencyCount(inflow.transactionId) === 1
      && context.history(pair) === undefined)
      link(pair, { kind: "evidence" });
  }
  // An exchange's sides must be each other's only candidate that evidence would link: a
  // labelled side is also a candidate for other-currency rows nearby, such as a purchase.
  const evidenced = exchanges.filter(({ outflow, inflow }) => evidencesExchange(outflow, inflow));
  const exchangeCount = counterparts(evidenced);
  for (const { outflow, inflow } of evidenced) {
    const pair = { outflowTransactionId: outflow.transactionId, inflowTransactionId: inflow.transactionId };
    if (exchangeCount(outflow.transactionId) === 1 && exchangeCount(inflow.transactionId) === 1
      && !linked.has(outflow.transactionId) && !linked.has(inflow.transactionId)
      && context.history(pair) === undefined)
      link(pair, { kind: "evidence" });
  }
  const candidates = [...pairs, ...exchanges]
    .filter(({ outflow, inflow }) => !linked.has(outflow.transactionId) && !linked.has(inflow.transactionId))
    .map(({ outflow, inflow }) => ({
      outflowTransactionId: outflow.transactionId,
      inflowTransactionId: inflow.transactionId,
      dayGap: dayGap(outflow.date, inflow.date),
    }))
    .sort((left, right) => ranked(left, right, (id) => sideOf.get(id)?.date ?? ""));
  return { links, suspended, candidates };
}

/**
 * Candidates across currencies (ADR 0143): only a side carrying an exchange
 * label proposes one, so each labelled side is compared with the opposite
 * direction's sides in other currencies within the window.
 */
function exchangeCandidates(
  sides: readonly CashFlowTransferPairingSide[],
  context: ReturnType<typeof cashFlowTransferContext>,
): { outflow: CashFlowTransferPairingSide; inflow: CashFlowTransferPairingSide }[] {
  const byDate = new Map<string, CashFlowTransferPairingSide[]>();
  for (const side of sides) byDate.set(side.date, [...byDate.get(side.date) ?? [], side]);
  const found = new Map<string, { outflow: CashFlowTransferPairingSide; inflow: CashFlowTransferPairingSide }>();
  for (const labelled of sides) {
    if (!labelled.exchangeLabel || !exchangeSideEligible(labelled)) continue;
    const start = Date.parse(`${labelled.date}T00:00:00Z`);
    for (let offset = -CASH_FLOW_TRANSFER_WINDOW_DAYS; offset <= CASH_FLOW_TRANSFER_WINDOW_DAYS; offset += 1) {
      const date = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
      for (const other of byDate.get(date) ?? []) {
        if (other.direction === labelled.direction || !isCurrencyExchange(labelled, other) || !exchangeSideEligible(other)) continue;
        const [outflow, inflow] = labelled.direction === "outflow" ? [labelled, other] : [other, labelled];
        const pair = { outflowTransactionId: outflow.transactionId, inflowTransactionId: inflow.transactionId };
        if (!found.has(transferLinkId(pair)) && cashFlowTransferRefusal(outflow, inflow, "candidate", context) === null)
          found.set(transferLinkId(pair), { outflow, inflow });
      }
    }
  }
  return [...found.values()];
}

const LINKED_TRANSFER: CashFlowClass = Object.freeze({ class: "not_counted", reason: "transfer" });

type LinkedSide = Pick<CashFlowTransaction, "kind" | "cashFlow">;

/**
 * Whether a link takes `side` out of the totals (ADR 0137). The link decides
 * only where no evidence does: `side` must carry a weak or fallback Kind, and
 * its counterpart a weak or fallback Kind or an evidence-backed internal
 * transfer. Any other evidence-backed Kind, or a missing one, on either side
 * keeps `side` in its own class. A card bill payment does not prove the move
 * for its counterpart: a link cannot tell whether that side is on the card.
 */
function linkExcludes(side: CashFlowKind | null, counterpart: CashFlowKind | null): boolean {
  return linkExcludable(side) && (linkExcludable(counterpart) || (counterpart?.basis === "evidence" && counterpart.code === "transfer.internal"));
}

/**
 * A linked side's cash-flow class, and whether the link is a pair: neither
 * side stays in a total or the unresolved bucket. A link that leaves a side
 * counted changes nothing, so it is no pair for the transfer note.
 */
export function linkedCashFlow(side: LinkedSide, counterpart: LinkedSide): Readonly<{ cashFlow: CashFlowClass; paired: boolean }> {
  const cashFlow = linkExcludes(side.kind, counterpart.kind) ? LINKED_TRANSFER : side.cashFlow;
  const other = linkExcludes(counterpart.kind, side.kind) ? LINKED_TRANSFER : counterpart.cashFlow;
  return { cashFlow, paired: cashFlow.class === "not_counted" && other.class === "not_counted" };
}
