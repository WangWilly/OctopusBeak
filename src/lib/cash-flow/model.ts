import type {
  CASH_FLOW_INCLUSION_POLICY,
  CashFlowAmount,
  CashFlowInflowGroup,
  CashFlowOutflowGroup,
} from "../../ledger/canonical/cash-flow-inclusion.ts";
import type { CashFlowTransferLinkOrigin } from "../../ledger/canonical/cash-flow-transfer.ts";
import type { CashFlowAccount, CashFlowReportTransaction } from "../../ledger/pglite/cash-flow.ts";
import type { ExactAmount } from "../shared-money/exact-money.ts";

export type { CashFlowAccount, CashFlowReportTransaction as CashFlowRow };

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
  /** Each Cash-flow transfer link with a side in the period, once, at its outflow amount. */
  pairs: CashFlowAmount & Readonly<{ origins: Readonly<Record<CashFlowTransferLinkOrigin["kind"], number>> }>;
  /** Internal-transfer rows without a current link. */
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
  search: CashFlowSearchResult | null;
}>;
