import assert from "node:assert/strict";
import {
  buildAccountOverview,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "./accounts.ts";

type ForeignCurrencyTransaction = LedgerQueryData["foreignCurrencyTransactions"][number];
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
    accountNumber: "1733280010652",
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
    accountNumber: "85040000049498",
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
