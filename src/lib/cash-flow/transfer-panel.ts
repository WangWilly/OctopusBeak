import type { CashFlowClass } from "../../ledger/canonical/cash-flow-inclusion.ts";
import {
  CASH_FLOW_TRANSFER_WINDOW_DAYS,
  cashFlowTransferContext,
  cashFlowTransferRefusal,
  dayGap,
  isCurrencyExchange,
  type CashFlowTransferPairHistory,
  type CashFlowTransferRefusal,
} from "../../ledger/canonical/cash-flow-transfer-rules.ts";
import type { FinancialPageActionRequest } from "../financial/page-actions.ts";
import { absoluteExact, compareExact, equalMoney, normalizeCurrency, subtractExact, type ExactMoney } from "../shared-money/exact-money.ts";
import { impliedExchangeRate, type ImpliedExchangeRate } from "./exchange-rate.ts";
import { cashFlowDirection } from "./model.ts";
import type {
  CashFlowRow,
  CashFlowTransferCandidateView,
  CashFlowTransferLinkView,
  CashFlowTransferPanel,
  CashFlowTransferSide,
  CashFlowTransferSummary,
  CashFlowUnpairedTransferView,
} from "./model.ts";

/** A transfer decision the page sends as a Financial page action (ADR 0136). */
export type CashFlowTransferRequest = Extract<FinancialPageActionRequest, Readonly<{ kind: `transfer_${string}` }>>;
export type CashFlowTransferDecision = CashFlowTransferRequest["action"];

const KIND_OF: Readonly<Record<CashFlowTransferDecision, CashFlowTransferRequest["kind"]>> = {
  confirm: "transfer_confirm",
  deny: "transfer_deny",
  revoke: "transfer_revoke",
  pair: "transfer_pair",
};

export function transferRequest(
  action: CashFlowTransferDecision,
  pair: Readonly<{ outflowTransactionId: string; inflowTransactionId: string }>,
  dataVersion: number,
): CashFlowTransferRequest {
  return {
    action,
    kind: KIND_OF[action],
    outflowTransactionId: pair.outflowTransactionId,
    inflowTransactionId: pair.inflowTransactionId,
    dataVersion,
  } as CashFlowTransferRequest;
}

/**
 * Why the page shows two sides as a transfer, from facts the page holds and
 * nothing more: both amounts, the day gap, that both accounts are the
 * person's (every Cash flow side is in an owned, non-Preview account), and the
 * Kinds when both sides carry the same evidence-backed one. A currency
 * exchange (ADR 0143) states both amounts and the rate they imply instead of
 * one amount, and which of its sides carry a bank's exchange label.
 */
export type CashFlowTransferReason =
  | Readonly<{ kind: "amount"; amount: ExactMoney }>
  | Readonly<{ kind: "exchange"; outflow: ExactMoney; inflow: ExactMoney; rate: ImpliedExchangeRate | null }>
  /** `origin` says why a link beyond the window still applies: the person paired it by hand, or confirmed it before its dates moved apart. */
  | Readonly<{ kind: "days"; days: number; withinWindow: boolean; origin: CashFlowTransferLinkView["origin"] | null }>
  | Readonly<{ kind: "accounts" }>
  | Readonly<{ kind: "evidence"; code: "transfer.internal" | "payment.credit_card" }>
  /** `both` when each side carries the label; `sameInstitution` when both accounts are at one Institution. */
  | Readonly<{ kind: "exchange_label"; both: boolean; sameInstitution: boolean }>
  | Readonly<{ kind: "decided"; origin: "confirmed" | "manual" }>;

type ReasonSide = Pick<CashFlowTransferSide, "amount" | "kind" | "exchangeLabel"> & Readonly<{ details: Readonly<{ account: Pick<CashFlowTransferSide["details"]["account"], "institutionKey"> }> }>;

export function transferReasons(
  pair: Readonly<{ outflow: ReasonSide; inflow: ReasonSide; dayGap: number }>,
  origin: CashFlowTransferLinkView["origin"] | null,
): readonly CashFlowTransferReason[] {
  const exchange = isCurrencyExchange(pair.outflow, pair.inflow);
  const reasons: CashFlowTransferReason[] = [
    exchange
      ? { kind: "exchange", outflow: pair.outflow.amount, inflow: pair.inflow.amount, rate: impliedExchangeRate(pair.outflow.amount, pair.inflow.amount) }
      : { kind: "amount", amount: pair.outflow.amount },
    { kind: "days", days: pair.dayGap, withinWindow: pair.dayGap <= CASH_FLOW_TRANSFER_WINDOW_DAYS, origin },
    { kind: "accounts" },
  ];
  const outflowKind = pair.outflow.kind;
  if (exchange) {
    const institution = pair.outflow.details.account.institutionKey;
    if (pair.outflow.exchangeLabel || pair.inflow.exchangeLabel)
      reasons.push({
        kind: "exchange_label",
        both: pair.outflow.exchangeLabel && pair.inflow.exchangeLabel,
        sameInstitution: institution !== null && institution === pair.inflow.details.account.institutionKey,
      });
  } else if (origin === "evidence" && outflowKind?.basis === "evidence" && pair.inflow.kind?.basis === "evidence"
    && outflowKind.code === pair.inflow.kind.code
    && (outflowKind.code === "transfer.internal" || outflowKind.code === "payment.credit_card"))
    reasons.push({ kind: "evidence", code: outflowKind.code });
  if (origin === "confirmed" || origin === "manual") reasons.push({ kind: "decided", origin });
  return reasons;
}

/** The rate a pair's two amounts imply, or null for a pair in one currency. */
export function pairExchangeRate(pair: Readonly<{ outflow: Pick<CashFlowTransferSide, "amount">; inflow: Pick<CashFlowTransferSide, "amount"> }>): ImpliedExchangeRate | null {
  return isCurrencyExchange(pair.outflow, pair.inflow) ? impliedExchangeRate(pair.outflow.amount, pair.inflow.amount) : null;
}

/** The period's Unpaired internal transfers in one currency, as the panel lists them. */
export function unpairedTransfers(
  panel: Pick<CashFlowTransferPanel, "unpaired">,
  currency: string,
): readonly CashFlowUnpairedTransferView[] {
  const own = normalizeCurrency(currency);
  return panel.unpaired.filter((entry) => normalizeCurrency(entry.row.amount.currency) === own);
}

const counted = (flow: CashFlowClass) => flow.class === "inflow" || flow.class === "outflow" || flow.class === "refund";

/** Which sides a decision moves into or out of the totals; both false means it changes no total. */
export type CashFlowTransferEffect = Readonly<{ outflow: boolean; inflow: boolean }>;

/** The sides that count again once `link` is revoked: those the link alone keeps out. */
export function revokeEffect(link: Pick<CashFlowTransferLinkView, "outflow" | "inflow">): CashFlowTransferEffect {
  const returns = (side: CashFlowTransferSide) => !counted(side.cashFlow) && counted(side.ownCashFlow);
  return { outflow: returns(link.outflow), inflow: returns(link.inflow) };
}

/** The sides that leave the totals once a candidate is confirmed. */
export function linkEffect(candidate: Pick<CashFlowTransferCandidateView, "outflow" | "inflow" | "ifLinked">): CashFlowTransferEffect {
  return {
    outflow: counted(candidate.outflow.ownCashFlow) && !counted(candidate.ifLinked.outflow),
    inflow: counted(candidate.inflow.ownCashFlow) && !counted(candidate.ifLinked.inflow),
  };
}

/** The period's rows a person may pick for a manual pair: canonical rows booked and counted in one direction. */
export function pairableRows(rows: readonly CashFlowRow[], direction: CashFlowRow["direction"]): readonly CashFlowRow[] {
  return rows.filter((row) => row.source === "canonical" && row.direction === direction && cashFlowDirection(row) === direction);
}

/** What the page holds that a transfer decision is checked against: the period's rows and the panel's lists. */
export type CashFlowTransferPageData = Readonly<{
  rows: readonly CashFlowRow[];
  panel: Pick<CashFlowTransferPanel, "links" | "candidates" | "suspended" | "deniedPairs">;
}>;

type Pair = Readonly<{ outflowTransactionId: string; inflowTransactionId: string }>;

/**
 * Why the worker refuses `action` on `pair`, by the worker's own rule over
 * the page's current links and denials: a confirm or deny is checked as a
 * candidate, a pair by hand without the date window. The worker's errors
 * do not cross IPC, so after a failed action the page is read again and
 * this names the reason from that page. Null when no rule refuses, or when
 * the page no longer holds one of the sides: then only a generic failure
 * can be said.
 */
export function transferRefusal(
  action: CashFlowTransferDecision,
  pair: Pair,
  data: CashFlowTransferPageData,
): CashFlowTransferRefusal | null {
  if (action === "revoke") return null;
  const sides = new Map<string, CashFlowTransferSide | CashFlowRow>();
  const panel = data.panel;
  for (const entry of [...panel.links, ...panel.candidates, ...panel.suspended])
    for (const side of [entry.outflow, entry.inflow]) if (side) sides.set(side.transactionId, side);
  for (const row of data.rows) sides.set(row.transactionId, row);
  const outflow = sides.get(pair.outflowTransactionId);
  const inflow = sides.get(pair.inflowTransactionId);
  if (!outflow || !inflow) return null;
  return cashFlowTransferRefusal(outflow, inflow, action === "pair" ? "manual" : "candidate", pageContext(panel));
}

function pageContext(panel: CashFlowTransferPageData["panel"]) {
  const links = panel.links.map((link) => ({ outflowTransactionId: link.outflow.transactionId, inflowTransactionId: link.inflow.transactionId }));
  const history = new Map<string, CashFlowTransferPairHistory>(panel.deniedPairs.map((pairId) => [pairId, "denied"]));
  return cashFlowTransferContext(links, history);
}

/** The rows a manual pair may start from: pairable, and not already a side of a link. */
export function manualPairAnchors(direction: CashFlowRow["direction"], data: CashFlowTransferPageData): readonly CashFlowRow[] {
  const linked = new Set(data.panel.links.flatMap((link) => [link.outflow.transactionId, link.inflow.transactionId]));
  return pairableRows(data.rows, direction).filter((row) => !linked.has(row.transactionId));
}

export function pairableByHand(row: CashFlowRow, data: CashFlowTransferPageData): boolean {
  return manualPairAnchors(row.direction, data).some((anchor) => anchor.transactionId === row.transactionId);
}

/** A refusal worth showing on a suggestion; the others describe rows that are no answer at all. */
export type ManualPairRefusal = Extract<CashFlowTransferRefusal, "amount" | "same_account" | "linked" | "denied">;

/** One row the other side of a manual pair could be, and how well it fits the anchor. */
export type ManualPairSuggestion =
  | Readonly<{ kind: "same_amount"; row: CashFlowRow; days: number }>
  | Readonly<{ kind: "exchange"; row: CashFlowRow; days: number; rate: ImpliedExchangeRate | null }>
  /** `difference` is how far apart the amounts are, for an `amount` refusal only. */
  | Readonly<{ kind: "refused"; row: CashFlowRow; days: number; refusal: ManualPairRefusal; difference: ExactMoney | null }>;

const TIER = { same_amount: 0, exchange: 1, refused: 2 } satisfies Record<ManualPairSuggestion["kind"], number>;

/**
 * The opposite-direction rows `anchor` could pair with, best fit first: equal
 * amounts, then exchanges, then refused rows whose refusal explains a near
 * miss (an amount refusal after the others, by its difference). Within a
 * tier, the fewer days apart, then the later date.
 */
export function manualPairSuggestions(anchor: CashFlowRow, data: CashFlowTransferPageData): readonly ManualPairSuggestion[] {
  const context = pageContext(data.panel);
  const suggestions: ManualPairSuggestion[] = [];
  for (const row of pairableRows(data.rows, anchor.direction === "outflow" ? "inflow" : "outflow")) {
    if (row.transactionId === anchor.transactionId) continue;
    const [outflow, inflow] = anchor.direction === "outflow" ? [anchor, row] : [row, anchor];
    const days = dayGap(anchor.date, row.date);
    const refusal = cashFlowTransferRefusal(outflow, inflow, "manual", context);
    switch (refusal) {
      case null:
        suggestions.push(isCurrencyExchange(outflow, inflow)
          ? { kind: "exchange", row, days, rate: pairExchangeRate({ outflow, inflow }) }
          : { kind: "same_amount", row, days });
        break;
      case "amount":
        suggestions.push({
          kind: "refused", row, days, refusal,
          difference: { ...absoluteExact(subtractExact(outflow.amount, inflow.amount)), currency: outflow.amount.currency },
        });
        break;
      case "same_account":
        // Every row booked into the anchor's own account lands here; only an equal amount makes one a near miss.
        if (equalMoney(outflow.amount, inflow.amount)) suggestions.push({ kind: "refused", row, days, refusal, difference: null });
        break;
      case "linked":
      case "denied":
        suggestions.push({ kind: "refused", row, days, refusal, difference: null });
        break;
    }
  }
  return suggestions.sort(compareSuggestions);
}

const difference = (suggestion: ManualPairSuggestion) => suggestion.kind === "refused" ? suggestion.difference : null;
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function compareSuggestions(left: ManualPairSuggestion, right: ManualPairSuggestion): number {
  const leftDifference = difference(left);
  const rightDifference = difference(right);
  return TIER[left.kind] - TIER[right.kind]
    || (leftDifference && rightDifference
      ? compareExact(leftDifference, rightDifference)
      : Number(leftDifference !== null) - Number(rightDifference !== null))
    || left.days - right.days
    || compareText(right.row.date, left.row.date)
    || compareText(left.row.transactionId, right.row.transactionId);
}

/** Where the transfer panel opens: on the unpaired list, or on the manual pair section with `row` as its anchor. */
export type CashFlowTransferPanelStart = Readonly<{ kind: "unpaired" }> | Readonly<{ kind: "pair"; row: CashFlowRow }>;

/**
 * What the transfer note under one currency says, or null when it shows
 * nothing. `summary` counts pairs and unpaired transfers; `pending` holds
 * only candidates; `links` is for a period whose only links the note does
 * not count, such as card bill payments, or whose links are suspended.
 */
export type CashFlowTransferNote =
  | Readonly<{ kind: "summary"; pending: number }>
  | Readonly<{ kind: "pending"; pending: number }>
  | Readonly<{ kind: "links"; count: number }>;

export function transferNote(
  currency: string,
  transfers: CashFlowTransferSummary | null,
  panel: Pick<CashFlowTransferPanel, "links" | "candidates" | "suspended">,
): CashFlowTransferNote | null {
  const own = normalizeCurrency(currency);
  const inCurrency = (side: CashFlowTransferSide | null) => side !== null && normalizeCurrency(side.amount.currency) === own;
  // A currency exchange touches two currencies, so it shows under both.
  const touches = (entry: Readonly<{ outflow: CashFlowTransferSide | null; inflow: CashFlowTransferSide | null }>) =>
    inCurrency(entry.outflow) || inCurrency(entry.inflow);
  const pending = panel.candidates.filter(touches).length;
  if (transfers && (transfers.pairs.count > 0 || transfers.exchanges.count > 0 || transfers.unpaired.count > 0)) return { kind: "summary", pending };
  if (pending > 0) return { kind: "pending", pending };
  const count = panel.links.filter(touches).length + panel.suspended.filter(touches).length;
  return count > 0 ? { kind: "links", count } : null;
}

/**
 * Where a failed decision's message shows. A failed confirm or deny whose
 * candidate is gone from the reloaded page, or a failed revoke whose link is
 * gone, has no row left to show it under, so it shows at the top of the
 * candidates or links section instead.
 */
export function transferErrorKey(
  key: string,
  action: CashFlowTransferDecision,
  pair: Pair,
  panel: Pick<CashFlowTransferPanel, "links" | "candidates" | "suspended">,
): string {
  const same = (outflowTransactionId: string, inflowTransactionId: string) =>
    outflowTransactionId === pair.outflowTransactionId && inflowTransactionId === pair.inflowTransactionId;
  const sides = (entry: Readonly<{ outflow: CashFlowTransferSide; inflow: CashFlowTransferSide }>) =>
    same(entry.outflow.transactionId, entry.inflow.transactionId);
  switch (action) {
    case "confirm":
    case "deny":
      return panel.candidates.some(sides) ? key : "candidates";
    case "revoke":
      // A suspended link may have lost a side the page no longer counts, so it is matched by its ids.
      return panel.links.some(sides) || panel.suspended.some((entry) => same(entry.outflowTransactionId, entry.inflowTransactionId))
        ? key
        : "links";
    case "pair":
      return key;
  }
}
