import type { CashFlowClass } from "../../ledger/canonical/cash-flow-inclusion.ts";
import {
  CASH_FLOW_TRANSFER_WINDOW_DAYS,
  cashFlowTransferContext,
  cashFlowTransferRefusal,
  type CashFlowTransferPairHistory,
  type CashFlowTransferRefusal,
} from "../../ledger/canonical/cash-flow-transfer-rules.ts";
import type { FinancialPageActionRequest } from "../financial/page-actions.ts";
import { normalizeCurrency, type ExactMoney } from "../shared-money/exact-money.ts";
import type {
  CashFlowRow,
  CashFlowTransferCandidateView,
  CashFlowTransferLinkView,
  CashFlowTransferPanel,
  CashFlowTransferSide,
  CashFlowTransferSummary,
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
 * Kinds when both sides carry the same evidence-backed one.
 */
export type CashFlowTransferReason =
  | Readonly<{ kind: "amount"; amount: ExactMoney }>
  /** `origin` says why a link beyond the window still applies: the person paired it by hand, or confirmed it before its dates moved apart. */
  | Readonly<{ kind: "days"; days: number; withinWindow: boolean; origin: CashFlowTransferLinkView["origin"] | null }>
  | Readonly<{ kind: "accounts" }>
  | Readonly<{ kind: "evidence"; code: "transfer.internal" | "payment.credit_card" }>
  | Readonly<{ kind: "decided"; origin: "confirmed" | "manual" }>;

export function transferReasons(
  pair: Readonly<{ outflow: CashFlowTransferSide; inflow: CashFlowTransferSide; dayGap: number }>,
  origin: CashFlowTransferLinkView["origin"] | null,
): readonly CashFlowTransferReason[] {
  const reasons: CashFlowTransferReason[] = [
    { kind: "amount", amount: pair.outflow.amount },
    { kind: "days", days: pair.dayGap, withinWindow: pair.dayGap <= CASH_FLOW_TRANSFER_WINDOW_DAYS, origin },
    { kind: "accounts" },
  ];
  const outflowKind = pair.outflow.kind;
  if (origin === "evidence" && outflowKind?.basis === "evidence" && pair.inflow.kind?.basis === "evidence"
    && outflowKind.code === pair.inflow.kind.code
    && (outflowKind.code === "transfer.internal" || outflowKind.code === "payment.credit_card"))
    reasons.push({ kind: "evidence", code: outflowKind.code });
  if (origin === "confirmed" || origin === "manual") reasons.push({ kind: "decided", origin });
  return reasons;
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

/** The period's rows a person may pick for a manual pair: canonical rows in one direction. */
export function pairableRows(rows: readonly CashFlowRow[], direction: CashFlowRow["direction"]): readonly CashFlowRow[] {
  return rows.filter((row) => row.source === "canonical" && row.direction === direction);
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
  const links = panel.links.map((link) => ({ outflowTransactionId: link.outflow.transactionId, inflowTransactionId: link.inflow.transactionId }));
  const history = new Map<string, CashFlowTransferPairHistory>(panel.deniedPairs.map((pairId) => [pairId, "denied"]));
  return cashFlowTransferRefusal(outflow, inflow, action === "pair" ? "manual" : "candidate", cashFlowTransferContext(links, history));
}

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
  const pending = panel.candidates.filter((candidate) => inCurrency(candidate.outflow)).length;
  if (transfers && (transfers.pairs.count > 0 || transfers.unpaired.count > 0)) return { kind: "summary", pending };
  if (pending > 0) return { kind: "pending", pending };
  const count = panel.links.filter((link) => inCurrency(link.outflow)).length
    + panel.suspended.filter((link) => inCurrency(link.outflow ?? link.inflow)).length;
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
  const same = (entry: Readonly<{ outflow: CashFlowTransferSide | null; inflow: CashFlowTransferSide | null }>) =>
    entry.outflow?.transactionId === pair.outflowTransactionId && entry.inflow?.transactionId === pair.inflowTransactionId;
  switch (action) {
    case "confirm":
    case "deny":
      return panel.candidates.some(same) ? key : "candidates";
    case "revoke":
      return [...panel.links, ...panel.suspended].some(same) ? key : "links";
    case "pair":
      return key;
  }
}
