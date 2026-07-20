import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildAccountOverview,
  emptyLedgerQueryData,
  latestVerifiedCreditCardSnapshots,
  type LedgerQueryData,
} from "../../shared-ledger/server/accounts.ts";
import {
  accountIdsForImportScope,
  appendUnavailableAccounts,
  applyLedgerVisibility,
  loadActiveImportScopes,
  loadUnavailableAccountIssues,
} from "./ledger-visibility.ts";

type CardRow = LedgerQueryData["creditCardStatementLines"][number];

function cardRow(
  statementRowId: string,
  sourceFileId: string,
  importRunId: string,
  statementType: "billed" | "unbilled",
): CardRow {
  return {
    statementRowId,
    sourceFileId,
    importRunId,
    sourceRelativePath: `${statementRowId}.csv`,
    sourceRowIndex: 1,
    sourceHash: `${statementRowId}-source`,
    contentHash: `${statementRowId}-content`,
    bank: "example-bank",
    product: "credit-card-statements",
    rawPayloadJson: "{}",
    importedAt: "2026-07-20T00:00:00.000Z",
    createdAt: "2026-07-20T00:00:00.000Z",
    semanticKey: null,
    contentKey: null,
    occurrenceIndex: null,
    firstSeenAt: null,
    lastSeenAt: null,
    statementType,
    statementPeriod: "2026-07",
    cardNumber: "1111",
    cardLabel: "Example card",
    consumeDate: "2026-07-20",
    postingDate: null,
    description: "Example purchase",
    countryCurrency: "TWD",
    foreignExchangeDate: null,
    foreignCurrency: null,
    foreignAmount: null,
    twdAmount: 1,
    installmentAction: null,
    paymentStatus: null,
  };
}

function captureEntry(captureId: string, row: CardRow) {
  return {
    captureId,
    statementRowId: row.statementRowId,
    sourceFileId: row.sourceFileId,
    sourceRowIndex: row.sourceRowIndex,
    bank: row.bank,
    product: row.product,
    cardKey: "1111",
    statementType: row.statementType,
  };
}

function capture(captureId: string) {
  return {
    captureId,
    bank: "example-bank",
    product: "credit-card-statements",
    capturedAt: "2026-07-20T00:00:00.000Z",
    completenessJson: "{}",
  };
}

function snapshot(captureId: string, statementType: "billed" | "unbilled") {
  return {
    snapshotId: `${captureId}-${statementType}`,
    captureId,
    sourceFileId: `${captureId}-${statementType}`,
    bank: "example-bank",
    product: "credit-card-statements",
    cardKey: "1111",
    statementType,
    capturedAt: "2026-07-20T00:00:00.000Z",
    asOfDate: "2026-07-20",
    currency: "TWD",
    transactionCount: 1,
    totalAmount: statementType === "billed" ? 1 : 2,
  };
}

function loan(statementRowId: string, sourceFileId: string, importRunId: string) {
  return {
    statementRowId,
    sourceFileId,
    importRunId,
    sourceRelativePath: `${statementRowId}.csv`,
    sourceRowIndex: 1,
    sourceHash: `${statementRowId}-source`,
    contentHash: `${statementRowId}-content`,
    bank: "example-bank",
    product: "loan-statements",
    rawPayloadJson: "{}",
    importedAt: "2026-07-20T00:00:00.000Z",
    createdAt: "2026-07-20T00:00:00.000Z",
    accountNumber: "0420",
    tradeDate: "2026-07-20",
    postingDate: null,
    item: "Principal",
    interestStartDate: null,
    interestEndDate: null,
    amount: 1,
    interestRate: null,
    balanceAfter: 10,
    overpayment: null,
    note: null,
  };
}

const oldBilled = cardRow("old-billed", "source-old-billed", "run-old", "billed");
const oldUnbilled = cardRow("old-unbilled", "source-old-unbilled", "run-old", "unbilled");
const excludedCardRow = cardRow("excluded-billed", "source-a", "run-a", "billed");
const activeCardRow = cardRow("active-unbilled", "source-active", "run-active", "unbilled");
const oldCapture = capture("capture-old");
const excludedCapture = capture("capture-excluded");

const data: LedgerQueryData = {
  ...emptyLedgerQueryData(),
  loanTransactions: [
    loan("loan-excluded", "source-a", "run-a"),
    loan("loan-active", "source-active", "run-active"),
  ],
  creditCardStatementLines: [oldBilled, oldUnbilled, excludedCardRow, activeCardRow],
  creditCardCaptureEntries: [
    captureEntry(oldCapture.captureId, oldBilled),
    captureEntry(oldCapture.captureId, oldUnbilled),
    captureEntry(excludedCapture.captureId, excludedCardRow),
    captureEntry(excludedCapture.captureId, activeCardRow),
  ],
  creditCardCaptures: [oldCapture, excludedCapture],
  creditCardSnapshots: [
    snapshot(oldCapture.captureId, "unbilled"),
    snapshot(excludedCapture.captureId, "billed"),
    snapshot(excludedCapture.captureId, "unbilled"),
  ],
};
const filtered = applyLedgerVisibility(data, new Set(["source-a|run-a"]));

assert.deepEqual(filtered.loanTransactions.map((row) => row.statementRowId), ["loan-active"]);
assert.deepEqual(
  latestVerifiedCreditCardSnapshots(filtered).map((row) => row.captureId),
  ["capture-old"],
);

const expectedExcludedAccountId = buildAccountOverview({
  ...emptyLedgerQueryData(),
  loanTransactions: [data.loanTransactions[0]],
})[0]?.id;
assert.ok(expectedExcludedAccountId);
assert.deepEqual(
  accountIdsForImportScope(data, "source-a|run-a"),
  new Set([expectedExcludedAccountId]),
);

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE disabled_import_sources (
    data_issue_id TEXT NOT NULL,
    source_file_id TEXT NOT NULL,
    import_run_id TEXT NOT NULL,
    state TEXT NOT NULL
  );
  CREATE TABLE data_issues (
    data_issue_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    account_label TEXT NOT NULL,
    account_context_json TEXT NOT NULL
  );
  INSERT INTO data_issues VALUES (
    'issue-a',
    'loan-example-0420',
    'Example Bank loan ****0420',
    '{"institution":"Example Bank","product":"loan-statements","group":"liability","kind":"loan","typeLabel":"Loan"}'
  );
  INSERT INTO disabled_import_sources VALUES ('issue-a', 'source-a', 'run-a', 'active');
  INSERT INTO disabled_import_sources VALUES ('issue-a', 'source-restored', 'run-restored', 'restored');
`);
assert.deepEqual(loadActiveImportScopes(db), new Set(["source-a|run-a"]));
const unavailableIssues = loadUnavailableAccountIssues(db);
assert.equal(unavailableIssues.length, 1);
assert.deepEqual(
  appendUnavailableAccounts([], unavailableIssues).map((account) => ({
    id: account.id,
    availability: account.valueAvailability,
  })),
  [{ id: "loan-example-0420", availability: "unavailable" }],
);
db.close();
