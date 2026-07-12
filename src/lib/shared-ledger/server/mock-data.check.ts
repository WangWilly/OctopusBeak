import assert from "node:assert/strict";
import { buildDailyHistory } from "../../overview/server/daily-history.ts";
import { emptyLedgerQueryData } from "./accounts.ts";
import { mockLedgerQueryData } from "./mock-data.ts";

const launchDate = new Date("2026-07-11T04:00:00.000Z");
const data = mockLedgerQueryData(launchDate);

assert.ok(data.accountTransactions.length >= 6);
assert.ok(data.foreignCurrencyTransactions.length >= 5);
assert.ok(data.creditCardStatementLines.length >= 8);
assert.ok(data.creditCardSnapshots.length >= 6);
assert.ok(data.loanTransactions.length >= 3);
assert.ok(data.fundHoldings.length >= 4);
assert.ok(data.fundBuyTransactions.length >= 3);
assert.ok(data.fundRedemptionTransactions.length >= 2);
assert.ok(data.fundCashDividends.length >= 2);
assert.ok(data.fundConversionTransactions.length >= 2);
assert.ok(data.brokerageHoldings.length >= 5);
assert.ok(data.brokerageTradeTransactions.length >= 6);
assert.ok(data.maicoinAccountSnapshots.length >= 4);
assert.ok(data.maicoinStatementRows.length >= 6);

assert.equal(
  Math.max(...data.sourceFiles.map((row) => Date.parse(row.sourceFileModifiedAt ?? ""))),
  Date.parse("2026-07-11T09:00:00.000Z"),
);
assert.ok(data.accountTransactions.every((row) => !row.accountName?.includes("Mock")));
assert.ok(data.accountTransactions.some((row) => row.description === "薪資入帳" && row.depositAmount === 88000));
assert.equal(
  data.brokerageHoldings.reduce((sum, row) => sum + (row.marketValueTwd ?? 0), 0),
  858000,
);

assert.ok(distinct(data.accountTransactions.map((row) => row.accountingDate)).length >= 3);
assert.ok(distinct(data.foreignCurrencyTransactions.map((row) => row.accountingDate)).length >= 3);
assert.ok(distinct(data.creditCardStatementLines.map((row) => row.consumeDate)).length >= 4);
assert.ok(distinct(data.loanTransactions.map((row) => row.tradeDate)).length >= 3);
assert.ok(distinct(data.fundHoldings.map((row) => row.queryPeriod)).length >= 2);
assert.ok(distinct(data.fundBuyTransactions.map((row) => row.investmentDate)).length >= 3);
assert.ok(distinct(data.brokerageHoldings.map((row) => row.asOfDate)).length >= 3);
assert.ok(distinct(data.brokerageTradeTransactions.map((row) => row.tradeDate)).length >= 4);
assert.ok(distinct(data.maicoinAccountSnapshots.map((row) => row.capturedAt.slice(0, 10))).length >= 3);
assert.ok(distinct(data.maicoinStatementRows.map((row) => row.occurredAt?.slice(0, 10))).length >= 4);
assert.ok(distinct(data.sourceFiles.map((row) => row.sourceFileModifiedAt?.slice(0, 10))).length >= 5);

const liabilityHistory = buildDailyHistory({
  ...emptyLedgerQueryData(),
  sourceFiles: data.sourceFiles,
  creditCardStatementLines: data.creditCardStatementLines,
  creditCardSnapshots: data.creditCardSnapshots,
  loanTransactions: data.loanTransactions,
  maicoinAccountSnapshots: data.maicoinAccountSnapshots,
}).filter((row) => row.liabilities.length > 0);
assert.ok(liabilityHistory.length >= 5);
assert.ok(distinct(liabilityHistory.map((row) => JSON.stringify(row.liabilities))).length >= 5);

const rowsBySource = new Map<string, number>();
for (const table of [
  data.accountTransactions,
  data.foreignCurrencyTransactions,
  data.creditCardStatementLines,
  data.loanTransactions,
  data.fundHoldings,
  data.fundBuyTransactions,
  data.fundRedemptionTransactions,
  data.fundCashDividends,
  data.fundConversionTransactions,
  data.brokerageHoldings,
  data.brokerageTradeTransactions,
]) {
  for (const row of table) {
    rowsBySource.set(row.sourceFileId, (rowsBySource.get(row.sourceFileId) ?? 0) + 1);
  }
}

for (const sourceFile of data.sourceFiles) {
  if (sourceFile.product === "unknown-export") continue;
  assert.equal(sourceFile.rowCount, rowsBySource.get(sourceFile.sourceFileId));
}

function distinct(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
