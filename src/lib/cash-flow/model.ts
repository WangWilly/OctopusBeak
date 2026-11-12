import type {
  CASH_FLOW_INCLUSION_POLICY,
  CashFlowAmount,
  CashFlowInflowGroup,
} from "../../ledger/canonical/cash-flow-inclusion.ts";
import type { CashFlowAccount, CashFlowReportTransaction } from "../../ledger/pglite/cash-flow.ts";
import type { SpendingCategoryGroup } from "../spending/category-groups.ts";
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
    groups: readonly (CashFlowAmount & Readonly<{ group: SpendingCategoryGroup | null; previous: ExactAmount }>)[];
  }>;
  kept: ExactAmount;
  keptRatio: number | null;
  unresolved: CashFlowAmount;
  /** Internal transfers, which are not counted. */
  transfers: CashFlowAmount;
  previous: CashFlowPeriodTotals;
}>;

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
