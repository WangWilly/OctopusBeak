import { manualBalancePoints } from "../../lib/manual-assets/manual-assets.ts";
import type { AccountRowDto, SummaryMetricDto } from "../../lib/shared-ledger/types.ts";
import { exactToNumber } from "../../lib/shared-money/exact-money.ts";
import { addDays } from "../../lib/shared-ledger/twd-valuation.ts";
import type { ManualAssetView } from "./manual-assets.ts";
import type { BalanceSeries } from "./preview-overview.ts";

export function manualRowId(assetId: string): string {
  return `manual:${assetId}`;
}

function points(view: ManualAssetView) {
  return manualBalancePoints(view.asset.category, view.valuations, view.transactions);
}

/**
 * A Manual Asset is an asset row with a manual marker. Its value is the
 * latest dated change. It still counts on its end date, a sale price
 * included; after that day it keeps its history but shows no amount, so no
 * total counts it.
 */
export function manualAssetRow(view: ManualAssetView, today: string): AccountRowDto {
  const { asset } = view;
  const latest = points(view).at(-1) ?? null;
  const balance = latest
    ? { asOf: latest.date, amount: { currency: asset.currency, value: exactToNumber(latest.exact), exact: { ...latest.exact } } }
    : null;
  const ended = asset.endedOn !== null && today > asset.endedOn;
  return {
    id: manualRowId(asset.id),
    label: asset.name,
    institution: "Manual",
    product: asset.category,
    group: "asset",
    kind: "manual",
    amountLines: balance && !ended ? [balance.amount] : [],
    transactionCount: view.transactions.length,
    assetPositionCount: 0,
    lastUpdated: balance?.asOf ?? null,
    valueAvailability: ended ? "unavailable" : balance ? "available" : "awaiting",
    manual: {
      assetId: asset.id,
      category: asset.category,
      currency: asset.currency,
      endedOn: asset.endedOn,
      valuations: view.valuations,
      transactions: view.transactions,
      balance,
    },
  };
}

export function manualAssetSeries(view: ManualAssetView): BalanceSeries {
  return {
    accountId: manualRowId(view.asset.id),
    label: view.asset.name,
    side: "asset",
    marker: "manual",
    // It counts through its end date and toward nothing from the next day.
    closedOn: view.asset.endedOn === null ? null : addDays(view.asset.endedOn, 1),
    points: points(view).map((point) => ({ date: point.date, currency: view.asset.currency, exact: point.exact })),
  };
}

/** Whether any counted asset row is manual, for the summary's manual marker. */
export function manualSummaryMarker(accounts: readonly AccountRowDto[]): Pick<SummaryMetricDto, "includesManual"> {
  return accounts.some((account) => account.manual && account.amountLines.length > 0) ? { includesManual: true } : {};
}
