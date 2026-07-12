import assert from "node:assert/strict";
import {
  buildAccountOverview,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "../../shared-ledger/server/accounts.ts";
import { buildDailyHistoryByAccount } from "./daily-history.ts";

type AccountTransaction = LedgerQueryData["accountTransactions"][number];
type SourceFile = LedgerQueryData["sourceFiles"][number];
type CreditCardSnapshot = LedgerQueryData["creditCardSnapshots"][number];
type CreditCardStatementLine = LedgerQueryData["creditCardStatementLines"][number];

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
    contentHash: `content-${sourceRowIndex}`,
    bank: "demo",
    product: "statements",
    rawPayloadJson: "{}",
    importedAt: `${date}T10:00:00.000Z`,
    createdAt: `${date}T10:00:00.000Z`,
    accountName: "Demo account",
    accountNumber: "demo-account",
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

function cardSnapshot(
  snapshotId: string,
  capturedAt: string,
  totalAmount: number,
  asOfDate = capturedAt.slice(0, 10),
): CreditCardSnapshot {
  return {
    snapshotId,
    sourceFileId: snapshotId,
    bank: "esun",
    product: "credit-card-statements",
    cardKey: "8397",
    statementType: "unbilled",
    capturedAt,
    asOfDate,
    currency: "TWD",
    transactionCount: 9,
    totalAmount,
  };
}

function cardRow(sourceFileId: string, importedAt: string, twdAmount: number): CreditCardStatementLine {
  return {
    semanticKey: `semantic-${sourceFileId}`,
    statementRowId: `row-${sourceFileId}`,
    sourceFileId,
    importRunId: "run",
    sourceRelativePath: `${sourceFileId}.csv`,
    sourceRowIndex: 1,
    sourceHash: `source-${sourceFileId}`,
    contentHash: `content-${sourceFileId}`,
    bank: "esun",
    product: "credit-card-statements",
    rawPayloadJson: "{}",
    importedAt,
    createdAt: importedAt,
    statementType: "unbilled",
    statementPeriod: "2026-07",
    cardNumber: "************8397",
    cardLabel: "玉山 8397",
    consumeDate: importedAt.slice(0, 10),
    postingDate: null,
    description: "partial transaction source",
    countryCurrency: "TWD",
    foreignExchangeDate: null,
    foreignCurrency: null,
    foreignAmount: null,
    twdAmount,
    installmentAction: null,
    paymentStatus: null,
  };
}

const cardData = emptyLedgerQueryData();
cardData.creditCardSnapshots = [
  cardSnapshot("june-early", "2026-06-30T08:00:00.000Z", 4500),
  cardSnapshot("june-late", "2026-06-30T10:00:00.000Z", 4680),
  cardSnapshot("older-day-captured-later", "2026-07-04T08:00:00.000Z", 999, "2026-07-01"),
  cardSnapshot("july-complete", "2026-07-03T08:00:00.000Z", 6120),
  { ...cardSnapshot("billed-latest", "2026-07-12T07:00:00.000Z", 19000), statementType: "billed" },
  cardSnapshot("latest-imported", "2026-07-12T08:00:00.000Z", 14844),
];
cardData.sourceFiles = [
  sourceFile("june-partial", "2026-06-30"),
  sourceFile("july-partial", "2026-07-03"),
  sourceFile("latest-imported", "2026-07-12"),
];
cardData.creditCardStatementLines = [
  cardRow("june-partial", "2026-06-30T11:00:00.000Z", 160),
  cardRow("july-partial", "2026-07-03T09:00:00.000Z", 142),
  cardRow("latest-imported", "2026-07-12T09:00:00.000Z", 14844),
];

const cardAccount = buildAccountOverview(cardData).find((row) => row.kind === "credit-card");
assert.ok(cardAccount);
const cardHistory = buildDailyHistoryByAccount(cardData)[cardAccount.id] ?? [];
assert.deepEqual(cardHistory.map((row) => ({
  date: row.date,
  liabilities: row.liabilities,
})), [
  { date: "2026-07-12", liabilities: [{ currency: "TWD", value: 14844 }] },
]);
assert.equal(cardHistory.some((row) => [160, 142].includes(row.liabilities[0]?.value ?? 0)), false);
