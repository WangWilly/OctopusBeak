import {
  bucketToAmounts,
  totalsForAccounts,
  type LedgerQueryData,
} from "$lib/shared-ledger/server/accounts.ts";
import type { AccountRowDto, DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

export function buildDailyHistory(
  data: LedgerQueryData,
  accounts: AccountRowDto[],
): DailyHistoryRowDto[] {
  const dates = [
    ...new Set(
      data.sourceFiles
        .map((source) => source.importedAt.slice(0, 10))
        .filter(Boolean)
        .sort(),
    ),
  ];
  const totals = totalsForAccounts(accounts);
  const rows = dates.length > 0 ? dates : [new Date().toISOString().slice(0, 10)];
  let previousNet: Record<string, number> | null = null;

  // ponytail: import-day rows reuse current totals; carry forward per-account snapshots when multi-run history matters.
  return rows.map((date) => {
    const dailyChange = previousNet ? subtractBuckets(totals.net, previousNet) : {};
    previousNet = totals.net;
    return {
      date,
      netAssets: bucketToAmounts(totals.net),
      dailyChange: bucketToAmounts(dailyChange),
      assets: bucketToAmounts(addBuckets(totals.assets, totals.investments)),
      liabilities: bucketToAmounts(totals.liabilities),
      accountChanges: accounts.slice(0, 6).map((account) => account.label),
      positionCount: accounts.reduce((total, account) => total + account.assetPositionCount, 0),
    };
  });
}

function addBuckets(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const bucket = { ...left };
  for (const [currency, value] of Object.entries(right)) {
    bucket[currency] = (bucket[currency] ?? 0) + value;
  }
  return bucket;
}

function subtractBuckets(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const bucket = { ...left };
  for (const [currency, value] of Object.entries(right)) {
    bucket[currency] = (bucket[currency] ?? 0) - value;
  }
  return bucket;
}
