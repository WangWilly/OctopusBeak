import {
  buildAccountOverview,
  bucketToAmounts,
  latestVerifiedCreditCardSnapshots,
  totalsForAccounts,
  type LedgerQueryData,
} from "../../shared-ledger/server/accounts.ts";
import { historyPointKey, type AccountRowDto, type CurrencyAmountDto, type DailyHistoryRowDto } from "../../shared-ledger/types.ts";

export function buildDailyHistory(data: LedgerQueryData): DailyHistoryRowDto[] {
  const rows = dailyHistoryPoints(data);
  let previousNet: Record<string, number> | null = null;

  return rows.map((point) => {
    const accounts = buildAccountOverview(snapshotData(data, point));
    const totals = totalsForAccounts(accounts);
    const dailyChange = previousNet ? subtractBuckets(totals.net, previousNet) : {};
    previousNet = totals.net;
    return {
      ...point,
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
  const captureDates = new Set(data.creditCardCaptures.map((capture) => capture.capturedAt.slice(0, 10)));

  for (const point of dailyHistoryPoints(data)) {
    const accounts = buildAccountOverview(snapshotData(data, point));
    for (const account of accounts) {
      if (point.captureId ? account.kind !== "credit-card" : captureDates.has(point.date) && account.kind === "credit-card") continue;
      const balance = amountBucket(account.amountLines);
      const previous = previousByAccount.get(account.id);
      const dailyChange = previous ? subtractBuckets(balance, previous) : {};
      previousByAccount.set(account.id, balance);
      histories[account.id] = [...(histories[account.id] ?? []), accountHistoryRow(point, account, balance, dailyChange)];
    }
  }

  return histories;
}

type HistoryPoint = Pick<DailyHistoryRowDto, "date" | "pointAt" | "captureId">;

function dailyHistoryPoints(data: LedgerQueryData): HistoryPoint[] {
  const captures = data.creditCardCaptures;
  const dates = data.sourceFiles
    .map((source) => sourceFileDate(source))
    .concat(latestVerifiedCreditCardSnapshots(data).map((snapshot) => snapshot.asOfDate))
    .concat(data.maicoinAccountSnapshots.map((snapshot) => snapshot.capturedAt.slice(0, 10)))
    .filter(Boolean);
  const points = [
    ...dates.map((date) => ({ date })),
    ...captures.map((capture) => ({
      date: capture.capturedAt.slice(0, 10),
      pointAt: capture.capturedAt,
      captureId: capture.captureId,
    })),
  ];
  const unique = new Map(points.map((point) => [historyPointKey(point), point]));
  return unique.size > 0
    ? [...unique.values()].sort((left, right) => historyPointKey(left).localeCompare(historyPointKey(right)))
    : [{ date: new Date().toISOString().slice(0, 10) }];
}

function accountHistoryRow(
  point: HistoryPoint,
  account: AccountRowDto,
  balance: Record<string, number>,
  dailyChange: Record<string, number>,
): DailyHistoryRowDto {
  const amounts = bucketToAmounts(balance, { includeZero: true });
  return {
    ...point,
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

function snapshotData(data: LedgerQueryData, point: HistoryPoint): LedgerQueryData {
  const pointKey = historyPointKey(point);
  const creditCardCaptures = data.creditCardCaptures.filter(
    (capture) => `${capture.capturedAt}|${capture.captureId}` <= pointKey,
  );
  const creditCardCaptureIds = new Set(creditCardCaptures.map((capture) => capture.captureId));
  const creditCardCaptureEntries = data.creditCardCaptureEntries.filter(
    (entry) => creditCardCaptureIds.has(entry.captureId),
  );
  const creditCardSnapshots = latestVerifiedCreditCardSnapshots({
    ...data,
    creditCardCaptures,
    creditCardCaptureEntries,
  }).filter((snapshot) => snapshot.asOfDate <= point.date);
  const sourceFileIds = new Set(
    data.sourceFiles
      .filter((source) => sourceFileDate(source) <= point.date)
      .map((source) => source.sourceFileId),
  );
  return {
    ...data,
    sourceFiles: data.sourceFiles.filter((source) => sourceFileIds.has(source.sourceFileId)),
    accountTransactions: data.accountTransactions.filter((row) => sourceFileIds.has(row.sourceFileId)),
    foreignCurrencyTransactions: data.foreignCurrencyTransactions.filter((row) => sourceFileIds.has(row.sourceFileId)),
    creditCardStatementLines: data.creditCardStatementLines.filter((row) => sourceFileIds.has(row.sourceFileId)),
    creditCardCaptures,
    creditCardCaptureEntries,
    creditCardSnapshots,
    loanTransactions: data.loanTransactions.filter((row) => sourceFileIds.has(row.sourceFileId)),
    fundHoldings: data.fundHoldings.filter((row) => sourceFileIds.has(row.sourceFileId)),
    brokerageHoldings: data.brokerageHoldings.filter((row) => sourceFileIds.has(row.sourceFileId)),
    maicoinAccountSnapshots: data.maicoinAccountSnapshots.filter((row) => row.capturedAt.slice(0, 10) <= point.date),
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
