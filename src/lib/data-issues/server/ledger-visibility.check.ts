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
  importScope,
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

function loan(
  statementRowId: string,
  sourceFileId: string,
  importRunId: string,
  accountNumber = "0420",
) {
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
    accountNumber,
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

function sourceFile(sourceFileId: string, importRunId: string) {
  return {
    sourceFileId,
    importRunId,
    sourceFile: null,
    sourceRelativePath: `${sourceFileId}-${importRunId}.csv`,
    sourceFileHash: `${sourceFileId}-${importRunId}-hash`,
    sourceFileBytes: 1,
    sourceFileModifiedAt: null,
    importedAt: "2026-07-20T00:00:00.000Z",
    bank: "example-bank",
    product: "loan-statements",
    rowCount: 1,
    status: "imported",
    recordJson: "{}",
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
  sourceFiles: [
    sourceFile("source-a", "run-a"),
    sourceFile("source-a", "run-b"),
    sourceFile("source-b", "run-a"),
  ],
  loanTransactions: [
    loan("loan-excluded", "source-a", "run-a"),
    loan("loan-active", "source-active", "run-active"),
    loan("loan-same-source", "source-a", "run-b"),
    loan("loan-same-run", "source-b", "run-a"),
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

assert.deepEqual(filtered.sourceFiles.map(importScope), ["source-a|run-b", "source-b|run-a"]);
assert.deepEqual(filtered.loanTransactions.map((row) => row.statementRowId), [
  "loan-active",
  "loan-same-source",
  "loan-same-run",
]);
assert.deepEqual(
  latestVerifiedCreditCardSnapshots(filtered).map((row) => row.captureId),
  ["capture-old"],
);

const expectedExcludedAccountId = buildAccountOverview({
  ...emptyLedgerQueryData(),
  loanTransactions: [data.loanTransactions[0]],
})[0]?.id;
assert.ok(expectedExcludedAccountId);
assert.equal(
  accountIdsForImportScope(data, "source-a|run-a").has(expectedExcludedAccountId),
  true,
);

const expectedCardAccountId = buildAccountOverview(data)
  .find((account) => account.kind === "credit-card")?.id;
assert.ok(expectedCardAccountId);
assert.equal(
  accountIdsForImportScope(data, "source-old-billed|run-old").has(expectedCardAccountId),
  true,
);
assert.equal(
  accountIdsForImportScope(data, "source-old-unbilled|run-old").has(expectedCardAccountId),
  true,
);

const rawUnavailableData = {
  ...emptyLedgerQueryData(),
  loanTransactions: [
    loan("reported-account", "source-a", "run-a"),
    loan("other-account", "source-a", "run-a", "0777"),
  ],
};
const rawUnavailableAccounts = buildAccountOverview(rawUnavailableData);
const reportedUnavailableAccount = rawUnavailableAccounts.find((account) => account.label.endsWith("0420"));
assert.ok(reportedUnavailableAccount);
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE disabled_import_sources (
    disabled_import_source_id TEXT NOT NULL,
    data_issue_id TEXT NOT NULL,
    source_file_id TEXT NOT NULL,
    import_run_id TEXT NOT NULL,
    state TEXT NOT NULL,
    disabled_at TEXT NOT NULL
  );
  CREATE TABLE data_issues (
    data_issue_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    account_label TEXT NOT NULL,
    account_context_json TEXT NOT NULL
  );
  CREATE TABLE data_issue_events (
    data_issue_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    outcome TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
db.prepare("INSERT INTO data_issues VALUES (?, ?, ?, ?)").run(
  "issue-a",
  reportedUnavailableAccount.id,
  reportedUnavailableAccount.label,
  JSON.stringify({
    institution: reportedUnavailableAccount.institution,
    product: reportedUnavailableAccount.product,
    group: reportedUnavailableAccount.group,
    kind: reportedUnavailableAccount.kind,
    typeLabel: reportedUnavailableAccount.typeLabel,
  }),
);
db.exec(`
  INSERT INTO disabled_import_sources VALUES ('disabled-a', 'issue-a', 'source-a', 'run-a', 'active', '2026-01-21T00:00:00.000Z');
  INSERT INTO disabled_import_sources VALUES ('disabled-restored', 'issue-a', 'source-restored', 'run-restored', 'restored', '2026-01-20T00:00:00.000Z');
`);
assert.deepEqual(loadActiveImportScopes(db), new Set(["source-a|run-a"]));
const unavailableIssues = loadUnavailableAccountIssues(db, rawUnavailableData);
assert.equal(unavailableIssues.length, 2);
assert.deepEqual(
  appendUnavailableAccounts([], unavailableIssues).map((account) => ({
    id: account.id,
    availability: account.valueAvailability,
    dataIssueId: account.dataIssueId,
  })),
  [
    { id: reportedUnavailableAccount.id, availability: "unavailable", dataIssueId: "issue-a" },
    {
      id: buildAccountOverview({
        ...emptyLedgerQueryData(),
        loanTransactions: [loan("other-account", "source-a", "run-a", "0777")],
      })[0]?.id,
      availability: "unavailable",
      dataIssueId: "issue-a",
    },
  ],
);
db.close();
