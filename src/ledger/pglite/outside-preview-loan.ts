import type { AccountRowDto } from "../../lib/shared-ledger/types.ts";
import {
  amountLine,
  exactFromDecimal,
  pointsByDate,
  PREVIEW_INSTITUTION_NAMES as INSTITUTION_NAMES,
  previewRowId,
  type BalanceSeries,
} from "./outside-row.ts";
import type { OutsideFinancialData, OutsideReader } from "./outside-financial-data.ts";
import type { PreviewVisibility } from "./preview-financial-data.ts";
import {
  readPreviewLoanAccounts,
  readPreviewLoanBalanceHistory,
  type PreviewLoanAccountView,
  type PreviewLoanBalanceHistory,
} from "./preview-loan.ts";

/** Preview loans, each a liability row with its dated amount owed. */
export async function readPreviewLoanOutside(reader: OutsideReader, visibility: PreviewVisibility): Promise<OutsideFinancialData> {
  const views = await readPreviewLoanAccounts(reader, visibility);
  if (views.length === 0) return { accounts: [], series: [] };
  return {
    accounts: views.map(previewLoanAccountRow),
    series: previewLoanSeries(await readPreviewLoanBalanceHistory(reader, visibility)),
  };
}

/** A preview loan is a liability that always carries its amount owed, until a complete list closes it. */
export function previewLoanAccountRow(view: PreviewLoanAccountView): AccountRowDto {
  const closed = view.loan.closedAt !== null;
  const balance = closed ? null : view.latestBalance;
  return {
    id: previewRowId(view.previewAccountId),
    label: view.displayLabel,
    institution: INSTITUTION_NAMES[view.institution],
    institutionKey: view.institution,
    product: "Loan",
    group: "liability",
    kind: "loan",
    amountLines: balance ? [amountLine(balance.currency, exactFromDecimal(balance.amount))] : [],
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: balance ? balance.observedAt.at.slice(0, 10) : null,
    valueAvailability: balance ? "available" : "unavailable",
    preview: {
      sourceId: view.sourceId,
      product: "loan",
      lastCollectedAt: view.lastCollectedAt,
      balanceTime: balance ? { ...balance.observedAt } : null,
      transactions: [],
      loan: { currency: view.currency, ...view.loan },
    },
  };
}

export function previewLoanSeries(histories: readonly PreviewLoanBalanceHistory[]): BalanceSeries[] {
  return histories.map((history) => ({
    accountId: previewRowId(history.previewAccountId),
    label: history.displayLabel,
    side: "liability",
    marker: "preview",
    closedOn: history.closedAt === null ? null : history.closedAt.slice(0, 10),
    points: pointsByDate(history.observations),
  }));
}

