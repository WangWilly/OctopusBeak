import assert from "node:assert/strict";
import {
  buildAccountOverview,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "../../shared-ledger/server/accounts.ts";
import { buildDailyHistoryByAccount } from "./daily-history.ts";

type AccountTransaction = LedgerQueryData["accountTransactions"][number];
type SourceFile = LedgerQueryData["sourceFiles"][number];

function sourceFile(sourceFileId: string, date: string): SourceFile {
  return {
    sourceFileId,
    importRunId: "run",
    sourceFile: `downloads/${sourceFileId}.csv`,
    sourceRelativePath: `${sourceFileId}.csv`,
    sourceFileHash: `hash-${sourceFileId}`,
    sourceFileBytes: 256,
    sourceFileModifiedAt: `${date}T09:00:00.000Z`,
    importedAt: `${date}T10:00:00.000Z`,
    bank: "demo",
    product: "statements",
    rowCount: 1,
    status: "imported",
    recordJson: "{}",
  };
}

function bankRow(sourceFileId: string, sourceRowIndex: number, date: string, balanceAfter: number): AccountTransaction {
  return {
    statementRowId: `row-${sourceRowIndex}`,
    sourceFileId,
    importRunId: "run",
    sourceRelativePath: `${sourceFileId}.csv`,
    sourceRowIndex,
    sourceHash: `source-${sourceFileId}`,
    rawRowHash: `raw-${sourceRowIndex}`,
    contentHash: `content-${sourceRowIndex}`,
    bank: "demo",
    product: "statements",
    dedupeStatus: "unique",
    rawPayloadJson: "{}",
    importedAt: `${date}T10:00:00.000Z`,
    createdAt: `${date}T10:00:00.000Z`,
    accountName: "Demo account",
    accountNumber: "1234567890",
    currency: "TWD",
    accountingDate: date,
    transactionDate: date,
    transactionTime: "09:30:00",
    description: "balance",
    withdrawalAmount: null,
    depositAmount: null,
    balanceAfter,
    note: null,
    fxRate: null,
  };
}

const data = emptyLedgerQueryData();
data.sourceFiles = [sourceFile("day-1", "2026-06-01"), sourceFile("day-2", "2026-06-02")];
data.accountTransactions = [
  bankRow("day-1", 1, "2026-06-01", 0),
  bankRow("day-2", 2, "2026-06-02", 150),
];

const account = buildAccountOverview(data)[0];
assert.ok(account);

assert.deepEqual(buildDailyHistoryByAccount(data)[account.id], [
  {
    date: "2026-06-01",
    netAssets: [{ currency: "TWD", value: 0 }],
    dailyChange: [],
    assets: [{ currency: "TWD", value: 0 }],
    liabilities: [],
    accountChanges: [account.label],
    positionCount: 0,
  },
  {
    date: "2026-06-02",
    netAssets: [{ currency: "TWD", value: 150 }],
    dailyChange: [{ currency: "TWD", value: 150 }],
    assets: [{ currency: "TWD", value: 150 }],
    liabilities: [],
    accountChanges: [account.label],
    positionCount: 0,
  },
]);
