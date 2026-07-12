import {
  buildAccountOverview,
  bucketToAmounts,
  latestImportedUnbilledSnapshots,
  totalsForAccounts,
  type LedgerQueryData,
} from "../../shared-ledger/server/accounts.ts";
import type { AccountRowDto, CurrencyAmountDto, DailyHistoryRowDto } from "../../shared-ledger/types.ts";

export function buildDailyHistory(data: LedgerQueryData): DailyHistoryRowDto[] {
  const rows = dailyHistoryDates(data);
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

export function buildDailyHistoryByAccount(data: LedgerQueryData): Record<string, DailyHistoryRowDto[]> {
  const histories: Record<string, DailyHistoryRowDto[]> = {};
  const previousByAccount = new Map<string, Record<string, number>>();

  for (const date of dailyHistoryDates(data)) {
    const accounts = buildAccountOverview(snapshotData(data, date));
    for (const account of accounts) {
      const balance = amountBucket(account.amountLines);
      const previous = previousByAccount.get(account.id);
      const dailyChange = previous ? subtractBuckets(balance, previous) : {};
      previousByAccount.set(account.id, balance);
      histories[account.id] = [...(histories[account.id] ?? []), accountHistoryRow(date, account, balance, dailyChange)];
    }
  }

  return histories;
}

function dailyHistoryDates(data: LedgerQueryData) {
  const dates = [
    ...new Set(
      data.sourceFiles
        .map((source) => sourceFileDate(source))
        .concat(latestImportedUnbilledSnapshots(data.creditCardSnapshots).map((snapshot) => snapshot.asOfDate))
        .concat(data.maicoinAccountSnapshots.map((snapshot) => snapshot.capturedAt.slice(0, 10)))
        .filter(Boolean)
        .sort(),
    ),
  ];
  return dates.length > 0 ? dates : [new Date().toISOString().slice(0, 10)];
}

function accountHistoryRow(
  date: string,
  account: AccountRowDto,
  balance: Record<string, number>,
  dailyChange: Record<string, number>,
): DailyHistoryRowDto {
  const amounts = bucketToAmounts(balance, { includeZero: true });
  return {
    date,
    netAssets: amounts,
    dailyChange: bucketToAmounts(dailyChange),
    assets: account.group === "liability" ? [] : amounts,
    liabilities: account.group === "liability" ? amounts : [],
    accountChanges: [account.label],
    positionCount: account.assetPositionCount,
  };
}

function amountBucket(amounts: CurrencyAmountDto[]) {
  const bucket: Record<string, number> = {};
  for (const amount of amounts) bucket[amount.currency] = amount.value;
  return bucket;
}

function sourceFileDate(source: LedgerQueryData["sourceFiles"][number]) {
  return (source.sourceFileModifiedAt || source.importedAt).slice(0, 10);
}

function snapshotData(data: LedgerQueryData, date: string): LedgerQueryData {
  const latestUnbilledSnapshots = latestImportedUnbilledSnapshots(data.creditCardSnapshots);
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
    creditCardSnapshots: latestUnbilledSnapshots.filter((row) => row.asOfDate <= date),
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
