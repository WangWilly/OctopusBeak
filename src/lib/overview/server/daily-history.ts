import {
  buildAccountOverview,
  bucketToAmounts,
  totalsForAccounts,
  type LedgerQueryData,
} from "$lib/shared-ledger/server/accounts.ts";
import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

export function buildDailyHistory(data: LedgerQueryData): DailyHistoryRowDto[] {
  const dates = [
    ...new Set(
      data.sourceFiles
        .map((source) => sourceFileDate(source))
        .concat(data.maicoinAccountSnapshots.map((snapshot) => snapshot.capturedAt.slice(0, 10)))
        .filter(Boolean)
        .sort(),
    ),
  ];
  const rows = dates.length > 0 ? dates : [new Date().toISOString().slice(0, 10)];
  let previousNet: Record<string, number> | null = null;

  return rows.map((date) => {
    const accounts = buildAccountOverview(snapshotData(data, date));
    const totals = totalsForAccounts(accounts);
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

function sourceFileDate(source: LedgerQueryData["sourceFiles"][number]) {
  return (source.sourceFileModifiedAt || source.importedAt).slice(0, 10);
}

function snapshotData(data: LedgerQueryData, date: string): LedgerQueryData {
  const sourceFileIds = new Set(
    data.sourceFiles
      .filter((source) => sourceFileDate(source) <= date)
      .map((source) => source.sourceFileId),
  );
  return {
    ...data,
    sourceFiles: data.sourceFiles.filter((source) => sourceFileIds.has(source.sourceFileId)),
    accountTransactions: data.accountTransactions.filter((row) => sourceFileIds.has(row.sourceFileId)),
    foreignCurrencyTransactions: data.foreignCurrencyTransactions.filter((row) => sourceFileIds.has(row.sourceFileId)),
    creditCardStatementLines: data.creditCardStatementLines.filter((row) => sourceFileIds.has(row.sourceFileId)),
    loanTransactions: data.loanTransactions.filter((row) => sourceFileIds.has(row.sourceFileId)),
    fundHoldings: data.fundHoldings.filter((row) => sourceFileIds.has(row.sourceFileId)),
    brokerageHoldings: data.brokerageHoldings.filter((row) => sourceFileIds.has(row.sourceFileId)),
    maicoinAccountSnapshots: data.maicoinAccountSnapshots.filter((row) => row.capturedAt.slice(0, 10) <= date),
  };
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
