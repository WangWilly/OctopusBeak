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
  loadActiveLedgerSupport,
  loadActiveImportScopes,
  loadUnavailableAccountIssues,
} from "./ledger-visibility.ts";
import type { LedgerDatabase } from "../../../ledger/db/client.ts";

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
    sourceVersionKey: `${sourceFileId}|${importRunId}`,
    sourceRelativePath: `${sourceFileId}-${importRunId}.csv`,
    sourceFileHash: `${sourceFileId}-${importRunId}-hash`,
    sourceFileBytes: 1,
    sourceFileModifiedAt: null,
    importedAt: "2026-07-20T00:00:00.000Z",
    bank: "example-bank",
    product: "loan-statements",
    firstSeenAt: "2026-07-20T00:00:00.000Z",
    lastSeenAt: "2026-07-20T00:00:00.000Z",
    observationCount: 1,
    rowCount: 1,
    status: "imported",
    recordJson: "{}",
  };
}

const lineageDb = new DatabaseSync(":memory:");
lineageDb.exec(`
  CREATE TABLE source_row_lineage (
    projection_table TEXT NOT NULL,
    statement_row_id TEXT NOT NULL,
    source_version_key TEXT NOT NULL
  );
  CREATE INDEX source_row_lineage_active_support_idx
    ON source_row_lineage(projection_table, statement_row_id, source_version_key);
  CREATE TABLE source_file_imports (
    source_version_key TEXT NOT NULL,
    source_file_id TEXT NOT NULL,
    source_file_modified_at TEXT,
    imported_at TEXT NOT NULL
  );
  CREATE TABLE disabled_import_sources (
    source_file_id TEXT NOT NULL,
    import_run_id TEXT NOT NULL,
    source_version_key TEXT NOT NULL,
    state TEXT NOT NULL
  );
  CREATE INDEX disabled_import_sources_version_state_idx
    ON disabled_import_sources(source_version_key, state);
`);
lineageDb.prepare("INSERT INTO source_row_lineage VALUES (?, ?, ?)")
  .run("loan_transactions", "synthetic-valid", "source-version-a");
lineageDb.prepare("INSERT INTO source_row_lineage VALUES (?, ?, ?)")
  .run("loan_transactions", "synthetic-valid", "source-version-b");
lineageDb.prepare("INSERT INTO source_file_imports VALUES (?, ?, NULL, ?)")
  .run("source-version-a", "synthetic-source", "2026-07-19T00:00:00.000Z");
lineageDb.prepare("INSERT INTO source_file_imports VALUES (?, ?, NULL, ?)")
  .run("source-version-b", "active-source", "2026-07-20T00:00:00.000Z");
lineageDb.prepare("INSERT INTO disabled_import_sources VALUES (?, ?, ?, ?)")
  .run("synthetic-source", "run-a", "source-version-a", "active");

let prepareCount = 0;
let supportSql = "";
const countedDb = {
  prepare(sql: string) {
    prepareCount += 1;
    supportSql = sql;
    return lineageDb.prepare(sql);
  },
} as LedgerDatabase;
const lineageData: LedgerQueryData = {
  ...emptyLedgerQueryData(),
  loanTransactions: [loan("synthetic-valid", "synthetic-source", "run-a")],
};
const support = loadActiveLedgerSupport(countedDb);
assert.equal(prepareCount, 1);
assert.deepEqual(
  applyLedgerVisibility(lineageData, support as never).loanTransactions.map((row) => row.statementRowId),
  ["synthetic-valid"],
);
assert.equal(support.statementKeys.has("loan_transactions|synthetic-valid"), true);
assert.equal(support.sourceVersionKeys.has("source-version-b"), true);
const supportPlan = lineageDb.prepare(`EXPLAIN QUERY PLAN ${supportSql}`).all() as Array<{
  detail: string;
}>;
assert.equal(
  supportPlan.some((row) => row.detail.includes("source_row_lineage_active_support_idx")),
  true,
);
assert.equal(
  supportPlan.some((row) => row.detail.includes("disabled_import_sources_version_state_idx")),
  true,
);
assert.deepEqual(
  applyLedgerVisibility(
    lineageData,
    loadActiveLedgerSupport(lineageDb, new Set(["source-version-b"])),
  ).loanTransactions,
  [],
);
lineageDb.prepare("INSERT INTO disabled_import_sources VALUES (?, ?, ?, ?)")
  .run("synthetic-source", "run-b", "source-version-b", "active");
assert.deepEqual(
  applyLedgerVisibility(lineageData, loadActiveLedgerSupport(lineageDb)).loanTransactions,
  [],
);
lineageDb.close();

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
const filtered = applyLedgerVisibility(data, {
  statementKeys: new Set([
    ...data.loanTransactions.filter((row) => importScope(row) !== "source-a|run-a")
      .map((row) => `loan_transactions|${row.statementRowId}`),
    ...data.creditCardStatementLines.filter((row) => importScope(row) !== "source-a|run-a")
      .map((row) => `credit_card_statement_lines|${row.statementRowId}`),
  ]),
  sourceVersionKeys: new Set(
    data.sourceFiles.filter((row) => importScope(row) !== "source-a|run-a")
      .map((row) => row.sourceVersionKey),
  ),
});

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
    loan("reported-account", "source-owner", "run-owner"),
    loan("other-account", "source-owner", "run-owner", "0777"),
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
    source_version_key TEXT NOT NULL,
    state TEXT NOT NULL,
    disabled_at TEXT NOT NULL
  );
  CREATE TABLE source_row_lineage (
    source_version_key TEXT NOT NULL,
    projection_table TEXT NOT NULL,
    statement_row_id TEXT NOT NULL
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
  INSERT INTO disabled_import_sources VALUES ('disabled-a', 'issue-a', 'source-a', 'run-a', 'version-a', 'active', '2026-01-21T00:00:00.000Z');
  INSERT INTO disabled_import_sources VALUES ('disabled-restored', 'issue-a', 'source-restored', 'run-restored', 'version-restored', 'restored', '2026-01-20T00:00:00.000Z');
  INSERT INTO source_row_lineage VALUES ('version-a', 'loan_transactions', 'reported-account');
  INSERT INTO source_row_lineage VALUES ('version-a', 'loan_transactions', 'other-account');
`);
assert.deepEqual(loadActiveImportScopes(db), new Set(["source-a|run-a"]));
const unavailableIssues = loadUnavailableAccountIssues(db, rawUnavailableData, {
  statementKeys: new Set(),
  sourceVersionKeys: new Set(),
});
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
        loanTransactions: [loan("other-account", "source-owner", "run-owner", "0777")],
      })[0]?.id,
      availability: "unavailable",
      dataIssueId: "issue-a",
    },
  ],
);
db.close();
