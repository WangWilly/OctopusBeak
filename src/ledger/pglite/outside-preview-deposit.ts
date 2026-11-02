import type { AccountRowDto } from "../../lib/shared-ledger/types.ts";
import {
  amountLine,
  byPreviewAccount,
  exactFromDecimal,
  pointsByDate,
  PREVIEW_INSTITUTION_NAMES as INSTITUTION_NAMES,
  previewRowId,
  type BalanceSeries,
} from "./outside-row.ts";
import type { OutsideFinancialData, OutsideReader } from "./outside-financial-data.ts";
import {
  readPreviewAccounts,
  readPreviewBalanceHistory,
  readPreviewTransactions,
  type PreviewAccountView,
  type PreviewBalanceHistory,
  type PreviewTransactionView,
  type PreviewVisibility,
} from "./preview-financial-data.ts";

/** Preview deposit, time deposit and foreign currency accounts, each an asset row with its dated balances. */
export async function readPreviewDepositOutside(reader: OutsideReader, visibility: PreviewVisibility): Promise<OutsideFinancialData> {
  const views = await readPreviewAccounts(reader, visibility);
  if (views.length === 0) return { accounts: [], series: [] };
  const transactions = byPreviewAccount(await readPreviewTransactions(reader, visibility, views.map((view) => view.previewAccountId)));
  return {
    accounts: views.map((view) => previewAccountRow(view, transactions(view.previewAccountId))),
    series: previewBalanceSeries(await readPreviewBalanceHistory(reader, visibility)),
  };
}

export function previewAccountRow(
  view: PreviewAccountView,
  transactions: readonly PreviewTransactionView[],
): AccountRowDto {
  const foreign = view.currency !== "TWD";
  const closed = view.timeDeposit?.closedAt !== null && view.timeDeposit?.closedAt !== undefined;
  const balance = closed ? null : view.latestBalance;
  const timeDeposit = view.product === "time_deposit";
  return {
    id: previewRowId(view.previewAccountId),
    label: view.displayLabel,
    institution: INSTITUTION_NAMES[view.institution],
    institutionKey: view.institution,
    product: timeDeposit ? "Time deposit" : foreign ? "Foreign currency account" : "Bank account",
    group: "asset",
    kind: foreign ? "foreign" : "bank",
    amountLines: balance ? [amountLine(balance.currency, exactFromDecimal(balance.amount))] : [],
    transactionCount: transactions.length,
    assetPositionCount: 0,
    lastUpdated: balance ? balance.observedAt.at.slice(0, 10) : null,
    valueAvailability: balance ? "available" : closed ? "unavailable" : "awaiting",
    preview: {
      sourceId: view.sourceId,
      product: view.product,
      lastCollectedAt: view.lastCollectedAt,
      balanceTime: balance ? { ...balance.observedAt } : null,
      transactions: transactions.map((row) => ({
        amount: row.amount,
        currency: row.currency,
        direction: row.direction,
        postedAt: { ...row.postedAt },
        description: row.description,
      })),
      ...(view.timeDeposit ? { timeDeposit: { ...view.timeDeposit } } : {}),
    },
  };
}

export function previewBalanceSeries(histories: readonly PreviewBalanceHistory[]): BalanceSeries[] {
  return histories.map((history) => {
    const current = history.observations.filter((observation) => observation.kind === "current");
    return {
      accountId: previewRowId(history.previewAccountId),
      label: history.displayLabel,
      side: "asset",
      marker: "preview",
      closedOn: history.closedAt === null ? null : history.closedAt.slice(0, 10),
      points: pointsByDate(current.length > 0 ? current : history.observations),
    };
  });
}

