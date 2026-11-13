import type { CashFlowClass } from "../../ledger/canonical/cash-flow-inclusion.ts";
import {
  CASH_FLOW_TRANSFER_WINDOW_DAYS,
  cashFlowTransferContext,
  cashFlowTransferRefusal,
  type CashFlowTransferPairHistory,
  type CashFlowTransferRefusal,
} from "../../ledger/canonical/cash-flow-transfer-rules.ts";
import type { FinancialPageActionRequest } from "../financial/page-actions.ts";
import type { ExactMoney } from "../shared-money/exact-money.ts";
import type { CashFlowRow, CashFlowTransferCandidateView, CashFlowTransferLinkView, CashFlowTransferPanel, CashFlowTransferSide } from "./model.ts";

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
  | Readonly<{ kind: "days"; days: number; withinWindow: boolean }>
  | Readonly<{ kind: "accounts" }>
  | Readonly<{ kind: "evidence"; code: "transfer.internal" | "payment.credit_card" }>
  | Readonly<{ kind: "decided"; origin: "confirmed" | "manual" }>;

export function transferReasons(
  pair: Readonly<{ outflow: CashFlowTransferSide; inflow: CashFlowTransferSide; dayGap: number }>,
  origin: CashFlowTransferLinkView["origin"] | null,
): readonly CashFlowTransferReason[] {
  const reasons: CashFlowTransferReason[] = [
    { kind: "amount", amount: pair.outflow.amount },
    { kind: "days", days: pair.dayGap, withinWindow: pair.dayGap <= CASH_FLOW_TRANSFER_WINDOW_DAYS },
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

/**
 * Why the worker would refuse to pair `outflow` with `inflow` by hand, read
 * from the panel's links and denials with the worker's own rule. The worker
 * still checks again when the action runs.
 */
export function manualPairRefusal(
  outflow: CashFlowRow,
  inflow: CashFlowRow,
  panel: Pick<CashFlowTransferPanel, "links" | "deniedPairs">,
): CashFlowTransferRefusal | null {
  const links = panel.links.map((link) => ({ outflowTransactionId: link.outflow.transactionId, inflowTransactionId: link.inflow.transactionId }));
  const history = new Map<string, CashFlowTransferPairHistory>(panel.deniedPairs.map((pairId) => [pairId, "denied"]));
  return cashFlowTransferRefusal(outflow, inflow, "manual", cashFlowTransferContext(links, history));
}

const REFUSALS: ReadonlySet<string> = new Set<CashFlowTransferRefusal>([
  "same_transaction", "manual_account", "direction", "same_account", "currency", "amount", "too_far", "linked", "denied",
]);

/** The refusal a failed transfer action names, if it names one. */
export function refusalOf(error: unknown): CashFlowTransferRefusal | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = /Cash-flow transfer \w+ refused: ([a-z_]+)\./u.exec(message)?.[1];
  return code !== undefined && REFUSALS.has(code) ? code as CashFlowTransferRefusal : null;
}
