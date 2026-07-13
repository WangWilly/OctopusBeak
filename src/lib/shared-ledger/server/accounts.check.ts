import assert from "node:assert/strict";
import {
  buildAccountOverview,
  buildPositionsByAccount,
  buildTransactionsByAccount,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "./accounts.ts";
import { buildDailyHistoryByAccount } from "../../overview/server/daily-history.ts";

type ForeignCurrencyTransaction = LedgerQueryData["foreignCurrencyTransactions"][number];
type CreditCardStatementLine = LedgerQueryData["creditCardStatementLines"][number];
type CreditCardSnapshot = LedgerQueryData["creditCardSnapshots"][number];
type LoanTransaction = LedgerQueryData["loanTransactions"][number];
type MaicoinAccountSnapshot = LedgerQueryData["maicoinAccountSnapshots"][number];
type MaicoinStatementRow = LedgerQueryData["maicoinStatementRows"][number];

function foreignRow(
  sourceRowIndex: number,
  transactionTime: string,
  balanceAfter: number,
): ForeignCurrencyTransaction {
  return {
    statementRowId: `row-${sourceRowIndex}`,
    sourceFileId: "source",
    importRunId: "run",
    sourceRelativePath: "yuanta-foreign-currency-statements/example.csv",
    sourceRowIndex,
    sourceHash: "source-hash",
    contentHash: `content-${sourceRowIndex}`,
    bank: "yuanta",
    product: "foreign-currency-statements",
    rawPayloadJson: "{}",
    importedAt: "2026-06-26T08:38:03.683Z",
    createdAt: "2026-06-26T08:38:03.683Z",
    accountName: "秀朗 - 綜活存 - *********0652",
    accountNumber: "TEST-USD-0652",
    queryCurrency: "USD",
    currency: "USD",
    accountingDate: "2026-06-02",
    transactionDate: "2026-06-02",
    transactionTime,
    description: "test",
    withdrawalAmount: null,
    depositAmount: null,
    balanceAfter,
    note: null,
    fxRate: null,
  };
}

const data = emptyLedgerQueryData();
data.foreignCurrencyTransactions = [
  foreignRow(14, "17:27:58", 0),
  foreignRow(16, "12:39:36", 5255.12),
];

const account = buildAccountOverview(data).find((row) => row.kind === "foreign");

assert.ok(account);
assert.deepEqual(account.amountLines, [{ currency: "USD", value: 0 }]);

function creditCardRow(
  sourceRowIndex: number,
  statementType: "billed" | "unbilled",
  cardNumber: string,
  importedAt: string,
  twdAmount: number,
): CreditCardStatementLine {
  return {
    semanticKey: null,
    contentKey: null,
    occurrenceIndex: null,
    firstSeenAt: null,
    lastSeenAt: null,
    statementRowId: `card-${sourceRowIndex}`,
    sourceFileId: "source",
    importRunId: "run",
    sourceRelativePath: `fubon-credit-card-statements/${statementType}.csv`,
    sourceRowIndex,
    sourceHash: "source-hash",
    contentHash: `card-content-${sourceRowIndex}`,
    bank: "fubon",
    product: "credit-card-statements",
    rawPayloadJson: "{}",
    importedAt,
    createdAt: importedAt,
    statementType,
    statementPeriod: "2026-06",
    cardNumber,
    cardLabel: cardNumber,
    consumeDate: "2026-06-24",
    postingDate: null,
    description: "test",
    countryCurrency: "TWD",
    foreignExchangeDate: null,
    foreignCurrency: null,
    foreignAmount: null,
    twdAmount,
    installmentAction: null,
    paymentStatus: null,
  };
}

function creditCardSnapshot(
  snapshotId: string,
  statementType: "billed" | "unbilled",
  capturedAt: string,
  totalAmount: number,
  asOfDate = capturedAt.slice(0, 10),
): CreditCardSnapshot {
  return {
    snapshotId,
    captureId: null,
    sourceFileId: snapshotId,
    bank: "fubon",
    product: "credit-card-statements",
    cardKey: "4281",
    statementType,
    capturedAt,
    asOfDate,
    currency: "TWD",
    transactionCount: 1,
    totalAmount,
  };
}

function creditCardCapture(captureId: string, capturedAt: string) {
  return {
    captureId,
    bank: "fubon",
    product: "credit-card-statements",
    capturedAt,
    completenessJson: "{}",
  };
}

function creditCardCaptureEntry(captureId: string, row: CreditCardStatementLine, cardKey: string) {
  return {
    captureId,
    statementRowId: row.statementRowId,
    sourceFileId: row.sourceFileId,
    sourceRowIndex: row.sourceRowIndex,
    bank: row.bank,
    product: row.product,
    cardKey,
    statementType: row.statementType,
  };
}

const oldCaptureId = "capture-old";
const latestCaptureId = "capture-latest";
const otherCardCaptureId = "capture-other-card";
const legacyUnbilled = creditCardRow(1, "unbilled", "4281", "2026-06-01T10:00:00.000Z", 111);
const oldCaptureUnbilled = creditCardRow(2, "unbilled", "4281", "2026-06-02T10:00:00.000Z", 222);
const latestCaptureBilled = {
  ...creditCardRow(3, "billed", "4281", "2026-06-03T10:00:00.000Z", 333),
  cardLabel: "Latest card",
};
const latestCaptureBilledDuplicate = {
  ...creditCardRow(4, "billed", "4281", "2026-06-03T10:00:00.000Z", 333),
  cardLabel: "Latest card",
};
const otherCardBilled = {
  ...creditCardRow(5, "billed", "9999", "2026-06-03T10:00:00.000Z", 444),
  cardLabel: "Other card",
};
const verifiedCardData = emptyLedgerQueryData();
verifiedCardData.creditCardStatementLines = [
  legacyUnbilled,
  oldCaptureUnbilled,
  latestCaptureBilled,
  latestCaptureBilledDuplicate,
  otherCardBilled,
];
verifiedCardData.creditCardCaptures = [
  creditCardCapture(oldCaptureId, "2026-06-02T10:00:00.000Z"),
  creditCardCapture(latestCaptureId, "2026-06-03T10:00:00.000Z"),
  creditCardCapture(otherCardCaptureId, "2026-06-03T10:00:00.000Z"),
];
verifiedCardData.creditCardCaptureEntries = [
  creditCardCaptureEntry(oldCaptureId, oldCaptureUnbilled, "4281"),
  creditCardCaptureEntry(latestCaptureId, latestCaptureBilled, "4281"),
  creditCardCaptureEntry(latestCaptureId, latestCaptureBilledDuplicate, "4281"),
  creditCardCaptureEntry(otherCardCaptureId, otherCardBilled, "9999"),
];
verifiedCardData.creditCardSnapshots = [
  { ...creditCardSnapshot("legacy-snapshot", "unbilled", "2026-06-04T10:00:00.000Z", 999), captureId: null },
  { ...creditCardSnapshot("old-unbilled", "unbilled", "2026-06-02T10:00:00.000Z", 222), captureId: oldCaptureId },
  { ...creditCardSnapshot("latest-billed", "billed", "2026-06-03T10:00:00.000Z", 666), captureId: latestCaptureId },
  { ...creditCardSnapshot("latest-unbilled", "unbilled", "2026-06-03T10:00:00.000Z", 0), captureId: latestCaptureId },
  { ...creditCardSnapshot("other-billed", "billed", "2026-06-03T10:00:00.000Z", 444), captureId: otherCardCaptureId, cardKey: "9999" },
  { ...creditCardSnapshot("other-unbilled", "unbilled", "2026-06-03T10:00:00.000Z", 75), captureId: otherCardCaptureId, cardKey: "9999" },
];

const verifiedCards = buildAccountOverview(verifiedCardData).filter((row) => row.kind === "credit-card");
const latestCard = verifiedCards.find((row) => row.label === "Latest card");
const otherCard = verifiedCards.find((row) => row.label === "Other card");

assert.equal(verifiedCards.length, 2);
assert.ok(latestCard);
assert.deepEqual(latestCard.amountLines, [{ currency: "TWD", value: 0 }]);
assert.deepEqual(buildTransactionsByAccount(verifiedCardData)[latestCard.id]?.map((row) => row.type), ["billed", "billed"]);
assert.ok(otherCard);
assert.deepEqual(otherCard.amountLines, [{ currency: "TWD", value: 75 }]);
assert.deepEqual(buildTransactionsByAccount(verifiedCardData)[otherCard.id]?.map((row) => row.type), ["billed"]);

const legacyOnlyCardData = emptyLedgerQueryData();
legacyOnlyCardData.creditCardStatementLines = [creditCardRow(6, "unbilled", "0000", "2026-06-04T10:00:00.000Z", 123)];
legacyOnlyCardData.creditCardSnapshots = [creditCardSnapshot("legacy-only", "unbilled", "2026-06-04T10:00:00.000Z", 123)];

assert.equal(buildAccountOverview(legacyOnlyCardData).find((row) => row.kind === "credit-card"), undefined);
assert.deepEqual(buildTransactionsByAccount(legacyOnlyCardData), {});

function loanRow(sourceRowIndex: number, item: string, amount: number, balanceAfter: number): LoanTransaction {
  return {
    statementRowId: `loan-${sourceRowIndex}`,
    sourceFileId: "source",
    importRunId: "run",
    sourceRelativePath: "fubon-loan-statements/example.csv",
    sourceRowIndex,
    sourceHash: "source-hash",
    contentHash: `loan-content-${sourceRowIndex}`,
    bank: "fubon",
    product: "loan-statements",
    rawPayloadJson: "{}",
    importedAt: "2026-06-27T09:45:09.910Z",
    createdAt: "2026-06-27T09:45:09.910Z",
    accountNumber: "TEST-LOAN-9498",
    tradeDate: "2026-06-16",
    postingDate: null,
    item,
    interestStartDate: "2026-05-16",
    interestEndDate: "2026-06-16",
    amount,
    interestRate: "3.100000",
    balanceAfter,
    overpayment: null,
    note: null,
  };
}

const loanData = emptyLedgerQueryData();
loanData.loanTransactions = [
  loanRow(2, "本金", 5872, 651587),
  loanRow(3, "利息", 1731, 657459),
];

const loanAccount = buildAccountOverview(loanData).find((row) => row.kind === "loan");

assert.ok(loanAccount);
assert.deepEqual(loanAccount.amountLines, [{ currency: "TWD", value: 651587 }]);
assert.equal(buildTransactionsByAccount(loanData)[loanAccount.id]?.[0]?.amount, -5872);

function maicoinSnapshot(): MaicoinAccountSnapshot {
  return {
    snapshotId: "max-btc",
    syncRunId: "run",
    capturedAt: "2026-06-27T12:00:00.000Z",
    subAccount: "main",
    walletType: "m",
    currency: "btc",
    balance: 1,
    locked: 1,
    staked: null,
    principal: 0.5,
    interest: 0.25,
    totalQuantity: 2,
    priceMarket: "btctwd",
    priceCurrency: "TWD",
    price: 100,
    valueTwd: 200,
    priceAt: "2026-06-27T12:00:00.000Z",
    rawAccountJson: "{}",
    rawPriceJson: "{}",
    createdAt: "2026-06-27T12:00:00.000Z",
  };
}

function maicoinSpotSnapshot(): MaicoinAccountSnapshot {
  return {
    ...maicoinSnapshot(),
    snapshotId: "max-spot-btc",
    walletType: "spot",
    balance: 0.1,
    locked: 0,
    principal: null,
    interest: null,
    totalQuantity: 0.1,
    valueTwd: 10,
  };
}

const maicoinData = emptyLedgerQueryData();
maicoinData.maicoinAccountSnapshots = [maicoinSnapshot()];
maicoinData.maicoinStatementRows = [{
  statementId: "max-trade",
  syncRunId: "run",
  capturedAt: "2026-06-27T12:00:00.000Z",
  endpoint: "/api/v3/wallet/spot/trades",
  walletType: "m",
  rowType: "trade",
  externalId: "trade-1",
  occurredAt: "2026-06-27T11:00:00.000Z",
  currency: null,
  amount: 2,
  fee: null,
  feeCurrency: null,
  market: "btctwd",
  side: "bid",
  price: 50,
  valueTwd: 100,
  rawPayloadJson: JSON.stringify({
    id: 1,
    market: "btctwd",
    side: "bid",
    volume: "2",
    funds: "100",
    price: "50",
    created_at: 1792926000000,
  }),
  createdAt: "2026-06-27T12:00:00.000Z",
  updatedAt: "2026-06-27T12:00:00.000Z",
} satisfies MaicoinStatementRow];
const maicoinAccounts = buildAccountOverview(maicoinData);
const maicoinAsset = maicoinAccounts.find((row) => row.kind === "crypto" && row.group === "investment");
const maicoinLiability = maicoinAccounts.find((row) => row.kind === "crypto" && row.group === "liability");

assert.ok(maicoinAsset);
assert.deepEqual(maicoinAsset.amountLines, [{ currency: "TWD", value: 200 }]);
assert.ok(maicoinLiability);
assert.deepEqual(maicoinLiability.amountLines, [{ currency: "TWD", value: 75 }]);

const maicoinPosition = buildPositionsByAccount(maicoinData)[maicoinAsset.id]?.[0];
assert.equal(maicoinPosition?.metricLabel, "Return");
assert.equal(maicoinPosition?.change, "100.00%");

const latestMaicoinData = emptyLedgerQueryData();
latestMaicoinData.maicoinAccountSnapshots = [
  maicoinSnapshot(),
  {
    ...maicoinSpotSnapshot(),
    capturedAt: "2026-06-28T12:00:00.000Z",
    createdAt: "2026-06-28T12:00:00.000Z",
    priceAt: "2026-06-28T12:00:00.000Z",
  },
];
const latestMaicoinAccounts = buildAccountOverview(latestMaicoinData)
  .filter((row) => row.kind === "crypto" && row.group === "investment");
const inactiveMaicoinAccount = latestMaicoinAccounts.find((row) => row.product === "M-wallet");
assert.ok(inactiveMaicoinAccount);
assert.deepEqual(inactiveMaicoinAccount.amountLines, [{ currency: "TWD", value: 0 }]);
assert.equal(inactiveMaicoinAccount.lastUpdated, "2026-06-28");
assert.deepEqual(
  buildDailyHistoryByAccount(latestMaicoinData)[inactiveMaicoinAccount.id]
    ?.map((row) => [row.date, row.assets[0]?.value]),
  [["2026-06-27", 200], ["2026-06-28", 0]],
);

const maicoinHistoricalTradeData = emptyLedgerQueryData();
maicoinHistoricalTradeData.maicoinAccountSnapshots = [
  {
    ...maicoinSpotSnapshot(),
    snapshotId: "max-spot-btc-usdt-quote",
    currency: "btc",
    balance: 1,
    totalQuantity: 1,
    price: 4000,
    valueTwd: 4000,
  },
  {
    ...maicoinSpotSnapshot(),
    snapshotId: "max-spot-usdt",
    currency: "usdt",
    balance: 100,
    totalQuantity: 100,
    price: 40,
    valueTwd: 4000,
  },
];
maicoinHistoricalTradeData.maicoinStatementRows = [{
  statementId: "max-trade-usdt-quote",
  syncRunId: "run",
  capturedAt: "2026-06-27T12:00:00.000Z",
  endpoint: "/api/v3/wallet/spot/trades",
  walletType: "spot",
  rowType: "trade",
  externalId: "trade-2",
  occurredAt: "2026-06-27T11:00:00.000Z",
  currency: null,
  amount: 1,
  fee: null,
  feeCurrency: null,
  market: "btcusdt",
  side: "bid",
  price: 100,
  valueTwd: 3000,
  rawPayloadJson: JSON.stringify({
    id: 2,
    market: "btcusdt",
    side: "bid",
    volume: "1",
    funds: "100",
    price: "100",
    created_at: 1792926000000,
  }),
  createdAt: "2026-06-27T12:00:00.000Z",
  updatedAt: "2026-06-27T12:00:00.000Z",
} satisfies MaicoinStatementRow];
const historicalTradePosition = Object.values(buildPositionsByAccount(maicoinHistoricalTradeData))
  .flat()
  .find((row) => row.symbol === "BTC" && row.name === "BTC Spot wallet");
assert.equal(historicalTradePosition?.change, "33.33%");

const maicoinRewardData = emptyLedgerQueryData();
maicoinRewardData.maicoinAccountSnapshots = [maicoinSnapshot(), maicoinSpotSnapshot()];
maicoinRewardData.maicoinStatementRows = [{
  statementId: "max-reward",
  syncRunId: "run",
  capturedAt: "2026-06-27T12:00:00.000Z",
  endpoint: "/api/v3/rewards",
  walletType: null,
  rowType: "reward",
  externalId: "reward-1",
  occurredAt: "2026-06-27T11:00:00.000Z",
  currency: "btc",
  amount: 0.1,
  fee: null,
  feeCurrency: null,
  market: null,
  side: null,
  price: null,
  valueTwd: 5,
  rawPayloadJson: JSON.stringify({
    id: 1,
    currency: "btc",
    amount: "0.1",
    created_at: 1792926000000,
  }),
  createdAt: "2026-06-27T12:00:00.000Z",
  updatedAt: "2026-06-27T12:00:00.000Z",
} satisfies MaicoinStatementRow];

const maicoinRewardAccount = buildAccountOverview(maicoinRewardData).find((row) => (
  row.kind === "crypto" && row.group === "investment" && row.product === "Spot wallet"
));
assert.equal(maicoinRewardAccount?.transactionCount, 1);
