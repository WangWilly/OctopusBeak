import type {
  CASH_FLOW_INCLUSION_POLICY,
  CashFlowAmount,
  CashFlowClass,
  CashFlowInflowGroup,
  CashFlowOutflowGroup,
} from "../../ledger/canonical/cash-flow-inclusion.ts";
import type { CashFlowTransferLinkOrigin, CashFlowTransferSuspension } from "../../ledger/canonical/cash-flow-transfer.ts";
import type { CashFlowAccount, CashFlowReportTransaction, CashFlowTransferSideRow } from "../../ledger/pglite/cash-flow.ts";
import type { ExactAmount } from "../shared-money/exact-money.ts";

export type { CashFlowAccount, CashFlowReportTransaction as CashFlowRow, CashFlowTransferSideRow };

/** The Cash flow live view's parameters; both dates are inclusive. */
export type CashFlowPageRequest = Readonly<{ startDate: string; endDate: string; query?: string }>;

export const CASH_FLOW_SEARCH_FIELDS = ["description", "counterparty", "category", "account", "amount", "note"] as const;
export type CashFlowSearchField = (typeof CASH_FLOW_SEARCH_FIELDS)[number];

export type CashFlowPeriod = Readonly<{ startDate: string; endDate: string; days: number }>;

export type CashFlowPeriodTotals = Readonly<{
  inflow: ExactAmount;
  outflow: ExactAmount;
  kept: ExactAmount;
  /** Kept over inflow; null without inflow. */
  keptRatio: number | null;
}>;

export type CashFlowCurrencySummary = Readonly<{
  currency: string;
  /** Groups largest first. */
  inflow: CashFlowAmount & Readonly<{ groups: readonly (CashFlowAmount & Readonly<{ group: CashFlowInflowGroup }>)[] }>;
  /** Net of refunds; `previous` is the group's outflow in the previous period. */
  outflow: CashFlowAmount & Readonly<{
    groups: readonly (CashFlowAmount & Readonly<{ group: CashFlowOutflowGroup; previous: ExactAmount }>)[];
  }>;
  kept: ExactAmount;
  keptRatio: number | null;
  unresolved: CashFlowAmount;
  transfers: CashFlowTransferSummary;
  previous: CashFlowPeriodTotals;
}>;

/** The period's uncounted transfers in one currency. */
export type CashFlowTransferSummary = Readonly<{
  /** Each Cash-flow transfer link that is a pair, with a side in the period, once, at its outflow amount. */
  pairs: CashFlowAmount & Readonly<{ origins: Readonly<Record<CashFlowTransferLinkOrigin["kind"], number>> }>;
  /** Internal-transfer rows not in a pair: no current link, or one that leaves its other side counted. */
  unpaired: CashFlowAmount;
}>;

/** How a not-counted transfer row reads: one side of a link, or an unpaired internal transfer. */
export type CashFlowTransferRole = "paired" | "internal";

export function cashFlowTransferRole(row: Pick<CashFlowReportTransaction, "cashFlow" | "transferLinkId">): CashFlowTransferRole | null {
  if (row.cashFlow.class !== "not_counted" || row.cashFlow.reason !== "transfer") return null;
  return row.transferLinkId !== null ? "paired" : "internal";
}

/** An account's signed change over the period, transfers included. */
export type CashFlowAccountChange = Readonly<{
  account: CashFlowAccount;
  currency: string;
  amount: ExactAmount;
  count: number;
}>;

export type CashFlowSearchResult = Readonly<{
  query: string;
  /** In-period matches per field; one row may match several fields. */
  fields: Readonly<Record<CashFlowSearchField, number>>;
  /** Every matching row in every period, future-dated ones included; the dates are the period filter's own dates. */
  allPeriods: Readonly<{ matches: number; firstDate: string | null; lastDate: string | null }>;
}>;

/** One side of a transfer the panel lists, as a row shows it; `inPeriod` is false for a side dated outside the period. */
export type CashFlowTransferSide = CashFlowTransferSideRow & Readonly<{ inPeriod: boolean }>;

/** A current Cash-flow transfer link with a side in the period. */
export type CashFlowTransferLinkView = Readonly<{
  linkId: string;
  origin: CashFlowTransferLinkOrigin["kind"];
  outflow: CashFlowTransferSide;
  inflow: CashFlowTransferSide;
  /** Calendar days between the two sides' dates. */
  dayGap: number;
  /** Neither side stays counted, so the transfer note counts it as a pair. */
  paired: boolean;
}>;

/** A similar pair the person may confirm or deny; `pairId` is the link id it would get. */
export type CashFlowTransferCandidateView = Readonly<{
  pairId: string;
  outflow: CashFlowTransferSide;
  inflow: CashFlowTransferSide;
  dayGap: number;
  /** The class each side would take once confirmed, by the rule a link applies. */
  ifLinked: Readonly<{ outflow: CashFlowClass; inflow: CashFlowClass }>;
}>;

/** A stored link that does not apply now; a side Cash flow no longer counts is null. */
export type CashFlowSuspendedTransferView = Readonly<{
  linkId: string;
  origin: Exclude<CashFlowTransferLinkOrigin["kind"], "evidence">;
  outflowTransactionId: string;
  inflowTransactionId: string;
  outflow: CashFlowTransferSide | null;
  inflow: CashFlowTransferSide | null;
  suspension: CashFlowTransferSuspension;
}>;

/** What the transfer pairing panel lists for the period, every currency together. */
export type CashFlowTransferPanel = Readonly<{
  /** Newest outflow date first. */
  links: readonly CashFlowTransferLinkView[];
  /** Closest dates first. */
  candidates: readonly CashFlowTransferCandidateView[];
  suspended: readonly CashFlowSuspendedTransferView[];
  /** Denied pairs, by link id, that touch the period: they are never proposed again or paired by hand. */
  deniedPairs: readonly string[];
}>;

/** One complete Cash flow page for a period, optionally narrowed by a search. */
export type CashFlowPageDto = Readonly<{
  policy: typeof CASH_FLOW_INCLUSION_POLICY;
  knowledgeAt: number;
  period: CashFlowPeriod;
  previousPeriod: CashFlowPeriod;
  /** TWD first, then by currency code. */
  currencies: readonly CashFlowCurrencySummary[];
  /** Every account that moved in the period, whatever the search. */
  accounts: readonly CashFlowAccountChange[];
  /** The period's transactions, or only the matching ones under a search; newest first. */
  transactions: readonly CashFlowReportTransaction[];
  /** In-period transaction count before any search. */
  transactionCount: number;
  /** Every in-period transaction, newest first, when a search narrowed `transactions`; null without a search. */
  periodTransactions: readonly CashFlowReportTransaction[] | null;
  search: CashFlowSearchResult | null;
  transferPanel: CashFlowTransferPanel;
}>;
