import assert from "node:assert/strict";
import {
  buildAccountOverview,
  buildPositionsByAccount,
  buildTransactionsByAccount,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "./accounts.ts";

type ForeignCurrencyTransaction = LedgerQueryData["foreignCurrencyTransactions"][number];
type CreditCardStatementLine = LedgerQueryData["creditCardStatementLines"][number];
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

const currentCardData = emptyLedgerQueryData();
currentCardData.creditCardStatementLines = [
  creditCardRow(1, "billed", "4281", "2026-06-27T09:45:09.910Z", 4005),
  creditCardRow(2, "unbilled", "356969******4281", "2026-06-27T09:45:09.910Z", 4005),
];

const currentCard = buildAccountOverview(currentCardData).find((row) => row.kind === "credit-card");

assert.ok(currentCard);
assert.deepEqual(currentCard.amountLines, [{ currency: "TWD", value: 4005 }]);
assert.equal(currentCard.transactionCount, 2);

const reimportedCardData = emptyLedgerQueryData();
reimportedCardData.creditCardStatementLines = [
  creditCardRow(1, "unbilled", "356969******4281", "2026-06-26T09:45:09.910Z", 1000),
  creditCardRow(2, "unbilled", "356969******4281", "2026-06-27T09:45:09.910Z", 4005),
];

const reimportedCard = buildAccountOverview(reimportedCardData).find((row) => row.kind === "credit-card");

assert.ok(reimportedCard);
assert.deepEqual(reimportedCard.amountLines, [{ currency: "TWD", value: 4005 }]);
assert.equal(reimportedCard.transactionCount, 1);

const settledCardData = emptyLedgerQueryData();
settledCardData.creditCardStatementLines = [
  creditCardRow(1, "unbilled", "356969******4281", "2026-06-26T09:45:09.910Z", 4005),
  creditCardRow(2, "billed", "4281", "2026-06-27T09:45:09.910Z", 4005),
];

const settledCard = buildAccountOverview(settledCardData).find((row) => row.kind === "credit-card");

assert.ok(settledCard);
assert.deepEqual(settledCard.amountLines, [{ currency: "TWD", value: 0 }]);
assert.equal(settledCard.transactionCount, 2);

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
