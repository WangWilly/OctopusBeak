import assert from "node:assert/strict";
import {
  buildAccountOverview,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "./accounts.ts";

type ForeignCurrencyTransaction = LedgerQueryData["foreignCurrencyTransactions"][number];
type CreditCardStatementLine = LedgerQueryData["creditCardStatementLines"][number];
type LoanTransaction = LedgerQueryData["loanTransactions"][number];

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
    rawRowHash: `raw-${sourceRowIndex}`,
    contentHash: `content-${sourceRowIndex}`,
    bank: "yuanta",
    product: "foreign-currency-statements",
    dedupeStatus: "unique",
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
    rawRowHash: `card-raw-${sourceRowIndex}`,
    contentHash: `card-content-${sourceRowIndex}`,
    bank: "fubon",
    product: "credit-card-statements",
    dedupeStatus: "duplicate",
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

assert.equal(buildAccountOverview(settledCardData).some((row) => row.kind === "credit-card"), false);

function loanRow(sourceRowIndex: number, item: string, balanceAfter: number): LoanTransaction {
  return {
    statementRowId: `loan-${sourceRowIndex}`,
    sourceFileId: "source",
    importRunId: "run",
    sourceRelativePath: "fubon-loan-statements/example.csv",
    sourceRowIndex,
    sourceHash: "source-hash",
    rawRowHash: `loan-raw-${sourceRowIndex}`,
    contentHash: `loan-content-${sourceRowIndex}`,
    bank: "fubon",
    product: "loan-statements",
    dedupeStatus: "unique",
    rawPayloadJson: "{}",
    importedAt: "2026-06-27T09:45:09.910Z",
    createdAt: "2026-06-27T09:45:09.910Z",
    accountNumber: "TEST-LOAN-9498",
    tradeDate: "2026-06-16",
    postingDate: null,
    item,
    interestStartDate: "2026-05-16",
    interestEndDate: "2026-06-16",
    amount: null,
    interestRate: "3.100000",
    balanceAfter,
    overpayment: null,
    note: null,
  };
}

const loanData = emptyLedgerQueryData();
loanData.loanTransactions = [
  loanRow(2, "本金", 651587),
  loanRow(3, "利息", 657459),
];

const loanAccount = buildAccountOverview(loanData).find((row) => row.kind === "loan");

assert.ok(loanAccount);
assert.deepEqual(loanAccount.amountLines, [{ currency: "TWD", value: 651587 }]);
