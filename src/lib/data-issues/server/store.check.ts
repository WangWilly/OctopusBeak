import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase, type LedgerDatabase } from "../../../ledger/db/client.ts";
import { buildAccountOverview, emptyLedgerQueryData } from "../../shared-ledger/server/accounts.ts";
import type { DataIssueCreateInput, SourceVersionId } from "../types.ts";
import { applyLedgerVisibility, loadActiveImportScopes } from "./ledger-visibility.ts";
import {
  confirmDataIssueExclusion,
  confirmDataIssueRestore,
  createDataIssue,
  listDataIssues,
  loadDataIssue,
  previewDataIssueExclusion,
  previewDataIssueRestore,
  startDataIssueDiagnosis,
} from "./store.ts";

const ledgerDirs: string[] = [];

afterEach(() => {
  for (const ledgerDir of ledgerDirs.splice(0)) rmSync(ledgerDir, { recursive: true, force: true });
});

function fixtureDir() {
  const ledgerDir = mkdtempSync(join(tmpdir(), "libretto-data-issue-"));
  ledgerDirs.push(ledgerDir);
  return ledgerDir;
}

function clock(start = "2026-07-20T00:00:00.000Z") {
  let tick = Date.parse(start);
  return () => new Date(tick++);
}

function seedSource(
  db: LedgerDatabase,
  source: SourceVersionId,
  options: { importedAt?: string; balances?: number[]; csvRows?: number; tradeDates?: string[] } = {},
) {
  const importedAt = options.importedAt ?? "2026-07-19T00:00:00.000Z";
  const balances = options.balances ?? [80_000, 81_250];
  const fileName = `${source.sourceFileId}-${source.importRunId}.csv`;
  db.prepare(`INSERT INTO source_file_imports (
    source_file_id, import_run_id, source_relative_path, source_file_hash,
    source_file_bytes, source_file_modified_at, imported_at, bank, product,
    row_count, status, record_json
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(
      source.sourceFileId,
      source.importRunId,
      `fictional-bank/statements/${fileName}`,
      `${source.sourceFileId}-${source.importRunId}-hash`,
      100,
      importedAt,
      "example-bank",
      "loan-statements",
      options.csvRows ?? balances.length + 1,
      "imported",
      "{}",
    );

  const insert = db.prepare(`INSERT INTO loan_transactions (
    statement_row_id, source_file_id, import_run_id, source_relative_path,
    source_row_index, source_hash, content_hash, bank, product, raw_payload_json,
    imported_at, created_at, account_number, trade_date, posting_date, item,
    interest_start_date, interest_end_date, amount, interest_rate, balance_after,
    overpayment, note
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, ?, NULL, NULL)`);
  balances.forEach((balance, index) => insert.run(
    `${source.sourceFileId}-${source.importRunId}-row-${index + 1}`,
    source.sourceFileId,
    source.importRunId,
    `fictional-bank/statements/${fileName}`,
    index + 1,
    `${source.sourceFileId}-${source.importRunId}-source-hash`,
    `${source.sourceFileId}-${source.importRunId}-content-${index + 1}`,
    "example-bank",
    "loan-statements",
    "{}",
    importedAt,
    importedAt,
    "0420",
    options.tradeDates?.[index] ?? `2026-07-${String(18 + index).padStart(2, "0")}`,
    "Synthetic principal",
    balance,
    balance,
  ));
}

function syntheticLoanRows(source: SourceVersionId, balances = [80_000, 81_250]) {
  return balances.map((balance, index) => ({
    statementRowId: `${source.sourceFileId}-${source.importRunId}-row-${index + 1}`,
    sourceFileId: source.sourceFileId,
    importRunId: source.importRunId,
    sourceRelativePath: `fictional-bank/statements/${source.sourceFileId}-${source.importRunId}.csv`,
    sourceRowIndex: index + 1,
    sourceHash: `${source.sourceFileId}-${source.importRunId}-source-hash`,
    contentHash: `${source.sourceFileId}-${source.importRunId}-content-${index + 1}`,
    bank: "example-bank",
    product: "loan-statements",
    rawPayloadJson: "{}",
    importedAt: "2026-07-19T00:00:00.000Z",
    createdAt: "2026-07-19T00:00:00.000Z",
    accountNumber: "0420",
    tradeDate: `2026-07-${String(18 + index).padStart(2, "0")}`,
    postingDate: null,
    item: "Synthetic principal",
    interestStartDate: null,
    interestEndDate: null,
    amount: balance,
    interestRate: null,
    balanceAfter: balance,
    overpayment: null,
    note: null,
  }));
}

type CardFixtureRow = {
  statementRowId: string;
  source: SourceVersionId;
  cardKey: string;
  statementType: "billed" | "unbilled";
  amount: number;
};

function cardFixtureData(captureId: string, capturedAt: string, rows: CardFixtureRow[]) {
  const statementRows = rows.map((row, index) => ({
    statementRowId: row.statementRowId,
    sourceFileId: row.source.sourceFileId,
    importRunId: row.source.importRunId,
    sourceRelativePath: `fictional-bank/cards/${row.source.sourceFileId}.csv`,
    sourceRowIndex: index + 1,
    sourceHash: `${row.statementRowId}-source`,
    contentHash: `${row.statementRowId}-content`,
    bank: "example-bank",
    product: "credit-card-statements",
    rawPayloadJson: "{}",
    importedAt: capturedAt,
    createdAt: capturedAt,
    semanticKey: row.statementRowId,
    contentKey: row.statementRowId,
    occurrenceIndex: 0,
    firstSeenAt: capturedAt,
    lastSeenAt: capturedAt,
    statementType: row.statementType,
    statementPeriod: capturedAt.slice(0, 7),
    cardNumber: `synthetic-card-${row.cardKey}`,
    cardLabel: `Example card ****${row.cardKey}`,
    consumeDate: capturedAt.slice(0, 10),
    postingDate: null,
    description: `Synthetic ${row.statementRowId}`,
    countryCurrency: "TWD",
    foreignExchangeDate: null,
    foreignCurrency: "TWD",
    foreignAmount: row.amount,
    twdAmount: row.amount,
    installmentAction: null,
    paymentStatus: "unpaid",
  }));
  const cards = [...new Set(rows.map((row) => row.cardKey))];
  return {
    data: {
      ...emptyLedgerQueryData(),
      creditCardStatementLines: statementRows,
      creditCardCaptures: [{
        captureId,
        bank: "example-bank",
        product: "credit-card-statements",
        capturedAt,
        completenessJson: "{}",
      }],
      creditCardCaptureEntries: rows.map((row, index) => ({
        captureId,
        statementRowId: row.statementRowId,
        sourceFileId: row.source.sourceFileId,
        sourceRowIndex: index + 1,
        bank: "example-bank",
        product: "credit-card-statements",
        cardKey: row.cardKey,
        statementType: row.statementType,
      })),
      creditCardSnapshots: cards.flatMap((cardKey) => (["billed", "unbilled"] as const).map((statementType) => ({
        snapshotId: `${captureId}-${cardKey}-${statementType}`,
        captureId,
        sourceFileId: rows.find((row) => row.cardKey === cardKey && row.statementType === statementType)?.source.sourceFileId ?? "source-synthetic",
        bank: "example-bank",
        product: "credit-card-statements",
        cardKey,
        statementType,
        capturedAt,
        asOfDate: capturedAt.slice(0, 10),
        currency: "TWD",
        transactionCount: 1,
        totalAmount: rows.find((row) => row.cardKey === cardKey && row.statementType === statementType)?.amount ?? 0,
      }))),
    },
    rows: statementRows,
  };
}

function persistCardFixture(
  db: LedgerDatabase,
  captureId: string,
  capturedAt: string,
  rows: CardFixtureRow[],
) {
  const fixture = cardFixtureData(captureId, capturedAt, rows);
  const sources = new Map<string, { source: SourceVersionId; rowCount: number }>();
  for (const row of rows) {
    const key = `${row.source.sourceFileId}|${row.source.importRunId}`;
    const source = sources.get(key) ?? { source: row.source, rowCount: 0 };
    source.rowCount += 1;
    sources.set(key, source);
  }
  for (const { source, rowCount } of sources.values()) {
    db.prepare(`INSERT INTO source_file_imports (
      source_file_id, import_run_id, source_relative_path, source_file_hash,
      source_file_bytes, source_file_modified_at, imported_at, bank, product,
      row_count, status, record_json
    ) VALUES (?, ?, ?, ?, 100, NULL, ?, 'example-bank',
      'credit-card-statements', ?, 'imported', '{}')`)
      .run(source.sourceFileId, source.importRunId,
        `fictional-bank/cards/${source.sourceFileId}.csv`, `${source.sourceFileId}-hash`,
        capturedAt, rowCount);
  }
  const insertLine = db.prepare(`INSERT INTO credit_card_statement_lines (
    statement_row_id, source_file_id, import_run_id, source_relative_path,
    source_row_index, source_hash, content_hash, bank, product, raw_payload_json,
    imported_at, created_at, semantic_key, content_key, occurrence_index,
    first_seen_at, last_seen_at, statement_type, statement_period, card_number,
    card_label, consume_date, description, country_currency, foreign_currency,
    foreign_amount, twd_amount, payment_status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of fixture.rows) {
    insertLine.run(
      row.statementRowId, row.sourceFileId, row.importRunId, row.sourceRelativePath,
      row.sourceRowIndex, row.sourceHash, row.contentHash, row.bank, row.product,
      row.rawPayloadJson, row.importedAt, row.createdAt, row.semanticKey,
      row.contentKey, row.occurrenceIndex, row.firstSeenAt, row.lastSeenAt,
      row.statementType, row.statementPeriod, row.cardNumber, row.cardLabel,
      row.consumeDate, row.description, row.countryCurrency, row.foreignCurrency,
      row.foreignAmount, row.twdAmount, row.paymentStatus,
    );
  }
  const capture = fixture.data.creditCardCaptures[0];
  db.prepare(`INSERT INTO credit_card_captures (
    capture_id, bank, product, captured_at, completeness_json
  ) VALUES (?, ?, ?, ?, ?)`)
    .run(capture.captureId, capture.bank, capture.product, capture.capturedAt, capture.completenessJson);
  const insertEntry = db.prepare(`INSERT INTO credit_card_capture_entries (
    capture_id, statement_row_id, source_file_id, source_row_index,
    bank, product, card_key, statement_type
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const entry of fixture.data.creditCardCaptureEntries) {
    insertEntry.run(entry.captureId, entry.statementRowId, entry.sourceFileId,
      entry.sourceRowIndex, entry.bank, entry.product, entry.cardKey, entry.statementType);
  }
  const insertSnapshot = db.prepare(`INSERT INTO credit_card_snapshots (
    snapshot_id, capture_id, source_file_id, bank, product, card_key,
    statement_type, captured_at, as_of_date, currency, transaction_count,
    total_amount
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const snapshot of fixture.data.creditCardSnapshots) {
    insertSnapshot.run(snapshot.snapshotId, snapshot.captureId, snapshot.sourceFileId,
      snapshot.bank, snapshot.product, snapshot.cardKey, snapshot.statementType,
      snapshot.capturedAt, snapshot.asOfDate, snapshot.currency,
      snapshot.transactionCount, snapshot.totalAmount);
  }
  return fixture.data;
}

function visibleLoanBalance(ledgerDir: string) {
  const db = openLedgerDatabase(ledgerDir);
  const row = db.prepare(`SELECT loan.balance_after
    FROM loan_transactions AS loan
    WHERE NOT EXISTS (
      SELECT 1 FROM disabled_import_sources AS disabled
      WHERE disabled.state = 'active'
        AND disabled.source_file_id = loan.source_file_id
        AND disabled.import_run_id = loan.import_run_id
    )
    ORDER BY loan.trade_date DESC, loan.imported_at DESC
    LIMIT 1`).get() as { balance_after: number } | undefined;
  db.close();
  return row?.balance_after;
}

function corruptFirstEvent(ledgerDir: string) {
  const db = openLedgerDatabase(ledgerDir);
  db.prepare("UPDATE data_issue_events SET details_json = '{' WHERE rowid = (SELECT MIN(rowid) FROM data_issue_events)").run();
  db.close();
}

async function setup() {
  const ledgerDir = fixtureDir();
  const sourceVersion = { sourceFileId: "source-a", importRunId: "run-a" };
  const db = openLedgerDatabase(ledgerDir);
  seedSource(db, sourceVersion);
  db.close();
  const account = buildAccountOverview({
    ...emptyLedgerQueryData(),
    loanTransactions: syntheticLoanRows(sourceVersion),
  })[0];
  assert.ok(account);
  const input: DataIssueCreateInput = {
    account: {
      id: account.id,
      label: account.label,
      institution: account.institution,
      product: account.product,
      group: account.group,
      kind: account.kind,
      typeLabel: account.typeLabel,
      amountLines: account.amountLines,
      lastUpdated: account.lastUpdated,
    },
    fieldKey: "balance",
    note: "Synthetic reported balance",
  };
  return { ledgerDir, sourceVersion, input };
}

function errorCode(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

test("creates, diagnoses, previews, and resolves a persistent issue", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const created = createDataIssue(input, ledgerDir, now);
  assert.equal(created.status, "pending");
  assert.equal(loadDataIssue(created.dataIssueId, ledgerDir).events.length, 1);
  assert.equal(listDataIssues(ledgerDir)[0]?.dataIssueId, created.dataIssueId);

  const diagnosing = startDataIssueDiagnosis(created.dataIssueId, ledgerDir, now);
  assert.equal(diagnosing.status, "investigating");
  assert.deepEqual(diagnosing.candidates.map(({ sourceFileId, importRunId }) => ({ sourceFileId, importRunId })), [sourceVersion]);

  const preview = previewDataIssueExclusion({ dataIssueId: created.dataIssueId, sourceVersion }, ledgerDir, now);
  assert.equal(preview.excludedRows, 2);
  assert.equal(preview.csvRows, 3);
  assert.equal(preview.duplicateRows, 0);
  assert.equal(preview.affectedAccounts[0]?.after.availability, "unavailable");

  const resolved = confirmDataIssueExclusion({
    dataIssueId: created.dataIssueId,
    sourceVersion: preview.sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: preview.previewToken,
  }, ledgerDir, now);
  assert.equal(resolved.status, "resolved");
  assert.equal(visibleLoanBalance(ledgerDir), undefined);
});

test("preview duplicate count uses active row lineage and counts cross-projection rows once", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const support = { sourceFileId: "source-support", importRunId: "run-support" };
  const excludedSupport = { sourceFileId: "source-excluded", importRunId: "run-excluded" };
  const db = openLedgerDatabase(ledgerDir);
  db.prepare("UPDATE source_file_imports SET row_count = 4 WHERE source_file_id = ? AND import_run_id = ?")
    .run(sourceVersion.sourceFileId, sourceVersion.importRunId);
  seedSource(db, support, {
    importedAt: "2026-01-18T00:00:00.000Z",
    balances: [63_900],
    csvRows: 1,
    tradeDates: ["2026-01-18"],
  });
  seedSource(db, excludedSupport, {
    importedAt: "2026-01-17T00:00:00.000Z",
    balances: [61_300],
    csvRows: 1,
    tradeDates: ["2026-01-17"],
  });
  db.prepare(`INSERT INTO unsupported_statement_rows (
    statement_row_id, source_file_id, import_run_id, source_relative_path,
    source_row_index, source_hash, content_hash, bank, product,
    raw_payload_json, imported_at, reason, headers_json
  ) VALUES (
    'support-projection', ?, ?, 'fictional-bank/support.csv', 1,
    'support-projection-source', 'support-projection-content', 'example-bank',
    'unknown-statements', '{}', '2026-01-18T00:00:00.000Z', 'Synthetic', '[]'
  )`).run(support.sourceFileId, support.importRunId);
  const insertLineage = db.prepare(`INSERT INTO source_row_lineage (
    source_file_id, import_run_id, source_row_index, projection_table,
    statement_row_id, outcome, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insertLineage.run(sourceVersion.sourceFileId, sourceVersion.importRunId, 3,
    "loan_transactions", `${support.sourceFileId}-${support.importRunId}-row-1`,
    "duplicate", "2026-07-19T00:00:00.000Z");
  insertLineage.run(sourceVersion.sourceFileId, sourceVersion.importRunId, 3,
    "unsupported_statement_rows", "support-projection", "duplicate",
    "2026-07-19T00:00:00.000Z");
  insertLineage.run(sourceVersion.sourceFileId, sourceVersion.importRunId, 4,
    "loan_transactions", `${excludedSupport.sourceFileId}-${excludedSupport.importRunId}-row-1`,
    "duplicate", "2026-07-19T00:00:00.000Z");
  db.prepare(`INSERT INTO disabled_import_sources (
    disabled_import_source_id, data_issue_id, source_file_id, import_run_id,
    reason, state, disabled_at, restored_at, preview_token
  ) VALUES ('excluded-support', 'synthetic-support-case', ?, ?, 'Synthetic',
    'active', '2026-07-19T12:00:00.000Z', NULL, 'synthetic-token')`)
    .run(excludedSupport.sourceFileId, excludedSupport.importRunId);
  db.close();

  const issue = createDataIssue(input, ledgerDir, clock());
  const preview = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, clock());
  assert.equal(preview.duplicateRows, 1);
});

test("credit-card impact includes same-value fallback accounts in restore gating", () => {
  const ledgerDir = fixtureDir();
  const selected = { sourceFileId: "source-selected", importRunId: "run-selected" };
  const companion = { sourceFileId: "source-companion", importRunId: "run-companion" };
  const older = { sourceFileId: "source-older", importRunId: "run-older" };
  const db = openLedgerDatabase(ledgerDir);
  persistCardFixture(db, "capture-older", "2026-01-19T08:00:00.000Z", [
    { statementRowId: "older-a-billed", source: older, cardKey: "1111", statementType: "billed", amount: 100 },
    { statementRowId: "older-a-unbilled", source: older, cardKey: "1111", statementType: "unbilled", amount: 300 },
    { statementRowId: "older-b-billed", source: older, cardKey: "2222", statementType: "billed", amount: 90 },
    { statementRowId: "older-b-unbilled", source: older, cardKey: "2222", statementType: "unbilled", amount: 470 },
  ]);
  const data = persistCardFixture(db, "capture-reported", "2026-01-20T08:00:00.000Z", [
    { statementRowId: "card-a-billed", source: selected, cardKey: "1111", statementType: "billed", amount: 120 },
    { statementRowId: "card-a-unbilled", source: companion, cardKey: "1111", statementType: "unbilled", amount: 310 },
    { statementRowId: "card-b-billed", source: companion, cardKey: "2222", statementType: "billed", amount: 90 },
    { statementRowId: "card-b-unbilled", source: companion, cardKey: "2222", statementType: "unbilled", amount: 470 },
  ]);
  db.close();
  const accounts = buildAccountOverview(data);
  const reported = accounts.find((account) => account.label.endsWith("1111"));
  const companionAccount = accounts.find((account) => account.label.endsWith("2222"));
  assert.ok(reported);
  assert.ok(companionAccount);
  const now = clock("2026-01-21T00:00:00.000Z");
  const issue = createDataIssue({
    account: {
      id: reported.id,
      label: reported.label,
      institution: reported.institution,
      product: reported.product,
      group: reported.group,
      kind: reported.kind,
      typeLabel: reported.typeLabel,
      amountLines: reported.amountLines,
      lastUpdated: reported.lastUpdated,
    },
    fieldKey: "balance",
    note: "Synthetic card capture mismatch",
  }, ledgerDir, now);
  const preview = previewDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion: selected,
  }, ledgerDir, now);
  assert.deepEqual(
    preview.affectedAccounts.map((account) => account.accountId).sort(),
    [reported.id, companionAccount.id].sort(),
  );
  const companionImpact = preview.affectedAccounts.find(
    (account) => account.accountId === companionAccount.id,
  );
  assert.deepEqual(companionImpact?.before, companionImpact?.after);
  confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion: selected,
    reason: "Synthetic incomplete capture",
    acknowledged: true,
    previewToken: preview.previewToken,
  }, ledgerDir, now);
  const eventDb = openLedgerDatabase(ledgerDir, { readOnly: true });
  const event = eventDb.prepare(`SELECT details_json FROM data_issue_events
    WHERE data_issue_id = ? AND event_type = 'exclusion' AND outcome = 'succeeded'`)
    .get(issue.dataIssueId) as { details_json: string };
  eventDb.close();
  const eventDetails = JSON.parse(event.details_json) as { affectedAccountIds: string[] };
  assert.deepEqual(
    eventDetails.affectedAccountIds.sort(),
    [reported.id, companionAccount.id].sort(),
  );

  const newer = { sourceFileId: "source-newer-card-b", importRunId: "run-newer-card-b" };
  const newerDb = openLedgerDatabase(ledgerDir);
  persistCardFixture(newerDb, "capture-newer-card-b", "2026-01-22T08:00:00.000Z", [
    { statementRowId: "newer-b-billed", source: newer, cardKey: "2222", statementType: "billed", amount: 80 },
    { statementRowId: "newer-b-unbilled", source: newer, cardKey: "2222", statementType: "unbilled", amount: 450 },
  ]);
  newerDb.close();
  const restore = previewDataIssueRestore(issue.dataIssueId, ledgerDir, now);
  assert.equal(restore.allowed, false);
  assert.deepEqual(restore.blockedBy, [{
    accountId: companionAccount.id,
    updatedAt: "2026-01-22T08:00:00.000Z",
  }]);
});

test("preview operations use one explicit snapshot transaction including their event", () => {
  const source = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  for (const functionName of ["previewDataIssueExclusion", "previewDataIssueRestore"]) {
    const start = source.indexOf(`export function ${functionName}`);
    const end = source.indexOf("\nexport function ", start + 1);
    const body = source.slice(start, end < 0 ? undefined : end);
    assert.match(body, /db\.exec\("BEGIN"\)/);
    assert.match(body, /appendEvent\([\s\S]*db\.exec\("COMMIT"\)/);
    assert.doesNotMatch(body, /BEGIN IMMEDIATE/);
  }
});

test("write transaction starts stay inside the stable service-error boundary", () => {
  const source = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  for (const functionName of [
    "createDataIssue",
    "startDataIssueDiagnosis",
    "confirmDataIssueExclusion",
    "confirmDataIssueRestore",
  ]) {
    const start = source.indexOf(`export function ${functionName}`);
    const end = source.indexOf("\nexport function ", start + 1);
    const body = source.slice(start, end < 0 ? undefined : end);
    assert.ok(body.indexOf("try {") < body.indexOf('db.exec("BEGIN IMMEDIATE")'));
    assert.match(body, /catch \(error\)[\s\S]*rollbackBestEffort\(db, transaction\)[\s\S]*stableError/);
  }
});

test("database-open failures expose only stable safe service errors", async () => {
  const { input, sourceVersion } = await setup();
  const parent = fixtureDir();
  const unavailableLedger = join(parent, "not-a-directory");
  writeFileSync(unavailableLedger, "synthetic blocker");
  const commands = [
    () => listDataIssues(unavailableLedger),
    () => loadDataIssue("issue-example", unavailableLedger),
    () => createDataIssue(input, unavailableLedger, clock()),
    () => startDataIssueDiagnosis("issue-example", unavailableLedger, clock()),
    () => previewDataIssueExclusion({ dataIssueId: "issue-example", sourceVersion }, unavailableLedger, clock()),
    () => confirmDataIssueExclusion({
      dataIssueId: "issue-example", sourceVersion, reason: "Synthetic", acknowledged: true,
      previewToken: "preview-example",
    }, unavailableLedger, clock()),
    () => previewDataIssueRestore("issue-example", unavailableLedger, clock()),
    () => confirmDataIssueRestore({ dataIssueId: "issue-example", previewToken: "preview-example" }, unavailableLedger, clock()),
  ];
  for (const command of commands) {
    assert.throws(command, (error: unknown) => {
      const serviceError = error as { code?: string; message?: string };
      assert.match(serviceError.code ?? "", /^LEDGER_(READ|WRITE)_FAILED$/);
      assert.equal(serviceError.message, serviceError.code);
      assert.doesNotMatch(serviceError.message ?? "", /not-a-directory|libretto-data-issue/);
      return true;
    });
  }
});

test("persists the complete exclusion journey across a database reopen", () => {
  const ledgerDir = fixtureDir();
  const correctedSource = { sourceFileId: "source-corrected", importRunId: "run-corrected" };
  const reportedSource = { sourceFileId: "source-reported", importRunId: "run-reported" };
  const db = openLedgerDatabase(ledgerDir);
  seedSource(db, correctedSource, {
    importedAt: "2025-01-18T08:00:00.000Z",
    balances: [63_900],
    csvRows: 1,
    tradeDates: ["2025-01-18"],
  });
  seedSource(db, reportedSource, {
    importedAt: "2025-01-20T08:00:00.000Z",
    balances: [81_250],
    csvRows: 1,
    tradeDates: ["2025-01-20"],
  });
  db.close();

  const correctedRows = syntheticLoanRows(correctedSource, [63_900]).map((row) => ({
    ...row,
    importedAt: "2025-01-18T08:00:00.000Z",
    createdAt: "2025-01-18T08:00:00.000Z",
    tradeDate: "2025-01-18",
  }));
  const reportedRows = syntheticLoanRows(reportedSource, [81_250]).map((row) => ({
    ...row,
    importedAt: "2025-01-20T08:00:00.000Z",
    createdAt: "2025-01-20T08:00:00.000Z",
    tradeDate: "2025-01-20",
  }));
  const ledgerData = { ...emptyLedgerQueryData(), loanTransactions: [...correctedRows, ...reportedRows] };
  const before = buildAccountOverview(ledgerData)[0];
  assert.ok(before);
  assert.equal(before.amountLines[0]?.value, 81_250);

  const now = clock("2025-01-21T00:00:00.000Z");
  const created = createDataIssue({
    account: {
      id: before.id,
      label: "Example Bank loan ****0420",
      institution: "Example Bank",
      product: before.product,
      group: before.group,
      kind: before.kind,
      typeLabel: before.typeLabel,
      amountLines: before.amountLines,
      lastUpdated: before.lastUpdated,
    },
    fieldKey: "balance",
    note: "Synthetic reported balance",
  }, ledgerDir, now);
  assert.equal(created.status, "pending");
  startDataIssueDiagnosis(created.dataIssueId, ledgerDir, now);
  const preview = previewDataIssueExclusion({
    dataIssueId: created.dataIssueId,
    sourceVersion: reportedSource,
  }, ledgerDir, now);
  confirmDataIssueExclusion({
    dataIssueId: created.dataIssueId,
    sourceVersion: reportedSource,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: preview.previewToken,
  }, ledgerDir, now);

  openLedgerDatabase(ledgerDir).close();
  const reopenedDb = openLedgerDatabase(ledgerDir);
  const activeExclusions = loadActiveImportScopes(reopenedDb);
  reopenedDb.close();
  const after = buildAccountOverview(applyLedgerVisibility(ledgerData, activeExclusions))[0];
  const reopened = loadDataIssue(created.dataIssueId, ledgerDir);

  assert.equal(after?.amountLines[0]?.value, 63_900);
  assert.equal(reopened.status, "resolved");
  assert.equal(reopened.events.at(-1)?.outcome, "succeeded");
});

test("persists only the validated account context fields", async () => {
  const { ledgerDir, input } = await setup();
  createDataIssue(input, ledgerDir, clock());
  const db = openLedgerDatabase(ledgerDir);
  const row = db.prepare("SELECT account_context_json FROM data_issues").get() as { account_context_json: string };
  db.close();
  assert.deepEqual(JSON.parse(row.account_context_json), {
    institution: input.account.institution,
    product: input.account.product,
    group: input.account.group,
    kind: input.account.kind,
    typeLabel: input.account.typeLabel,
  });
});

test("rejects a stale preview without changing visibility", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const preview = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  const db = openLedgerDatabase(ledgerDir);
  db.prepare("UPDATE loan_transactions SET imported_at = ? WHERE statement_row_id = ?")
    .run("2026-07-19T01:00:00.000Z", "source-a-run-a-row-2");
  db.close();
  assert.throws(() => confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: preview.previewToken,
  }, ledgerDir, now), errorCode("STALE_PREVIEW"));
  assert.equal(visibleLoanBalance(ledgerDir), 81_250);
  assert.equal(loadDataIssue(issue.dataIssueId, ledgerDir).events.at(-1)?.outcome, "blocked");
});

test("double confirmation is idempotent", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const preview = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  const command = {
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true as const,
    previewToken: preview.previewToken,
  };
  confirmDataIssueExclusion(command, ledgerDir, now);
  confirmDataIssueExclusion(command, ledgerDir, now);
  const db = openLedgerDatabase(ledgerDir);
  const exclusions = db.prepare("SELECT COUNT(*) AS count FROM disabled_import_sources").get() as { count: number };
  const events = db.prepare("SELECT COUNT(*) AS count FROM data_issue_events WHERE event_type = 'exclusion' AND outcome = 'succeeded'").get() as { count: number };
  db.close();
  assert.equal(exclusions.count, 1);
  assert.equal(events.count, 1);
});

test("rolls back a failed confirmation and persists a safe failed event", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const preview = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  const db = openLedgerDatabase(ledgerDir);
  db.exec(`CREATE TRIGGER synthetic_exclusion_failure
    BEFORE INSERT ON data_issue_events
    WHEN NEW.event_type = 'exclusion' AND NEW.outcome = 'succeeded'
    BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
  db.close();
  assert.throws(() => confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: preview.previewToken,
  }, ledgerDir, now), errorCode("LEDGER_WRITE_FAILED"));
  const after = openLedgerDatabase(ledgerDir);
  assert.equal((after.prepare("SELECT COUNT(*) AS count FROM disabled_import_sources").get() as { count: number }).count, 0);
  assert.equal((after.prepare("SELECT status FROM data_issues").get() as { status: string }).status, "pending");
  const failed = after.prepare("SELECT outcome, details_json FROM data_issue_events ORDER BY rowid DESC LIMIT 1").get() as { outcome: string; details_json: string };
  const failedEvents = after.prepare("SELECT COUNT(*) AS count FROM data_issue_events WHERE outcome = 'failed'").get() as { count: number };
  after.close();
  assert.equal(failed.outcome, "failed");
  assert.equal(failedEvents.count, 1);
  assert.equal(JSON.parse(failed.details_json).code, "LEDGER_WRITE_FAILED");
  assert.equal(visibleLoanBalance(ledgerDir), 81_250);
});

test("restores an excluded source when no newer active account data exists", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const exclusion = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: exclusion.previewToken,
  }, ledgerDir, now);
  const preview = previewDataIssueRestore(issue.dataIssueId, ledgerDir, now);
  assert.equal(preview.allowed, true);
  const restored = confirmDataIssueRestore({ dataIssueId: issue.dataIssueId, previewToken: preview.previewToken }, ledgerDir, now);
  assert.equal(restored.status, "restored");
  assert.equal(visibleLoanBalance(ledgerDir), 81_250);
});

test("blocks restore after newer active data exists", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const exclusion = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: exclusion.previewToken,
  }, ledgerDir, now);
  const db = openLedgerDatabase(ledgerDir);
  seedSource(db, { sourceFileId: "source-b", importRunId: "run-b" }, {
    importedAt: "2026-07-21T00:00:00.000Z",
    balances: [63_900],
    csvRows: 1,
    tradeDates: ["2026-07-21"],
  });
  db.close();
  const preview = previewDataIssueRestore(issue.dataIssueId, ledgerDir, now);
  assert.equal(preview.allowed, false);
  assert.equal(preview.blockedBy[0]?.updatedAt, "2026-07-21T00:00:00.000Z");
  assert.throws(
    () => confirmDataIssueRestore({ dataIssueId: issue.dataIssueId, previewToken: preview.previewToken }, ledgerDir, now),
    errorCode("RESTORE_NEWER_DATA"),
  );
  assert.equal(loadDataIssue(issue.dataIssueId, ledgerDir).status, "resolved");
  assert.equal(loadDataIssue(issue.dataIssueId, ledgerDir).events.at(-1)?.outcome, "blocked");
});

test("keeps a different import run active for the same source file", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const db = openLedgerDatabase(ledgerDir);
  seedSource(db, { sourceFileId: "source-a", importRunId: "run-b" }, {
    importedAt: "2026-07-19T12:00:00.000Z",
    balances: [63_900],
    csvRows: 1,
    tradeDates: ["2026-07-20"],
  });
  db.close();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const preview = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: preview.previewToken,
  }, ledgerDir, now);
  assert.equal(visibleLoanBalance(ledgerDir), 63_900);
});

test("records a blocked event for a missing exact source version", async () => {
  const { ledgerDir, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  assert.throws(() => previewDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion: { sourceFileId: "missing-source", importRunId: "missing-run" },
  }, ledgerDir, now), errorCode("SOURCE_VERSION_NOT_FOUND"));
  assert.equal(loadDataIssue(issue.dataIssueId, ledgerDir).events.at(-1)?.outcome, "blocked");
});

test("rejects a second source exclusion after the case is resolved", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const secondSource = { sourceFileId: "source-b", importRunId: "run-b" };
  const db = openLedgerDatabase(ledgerDir);
  seedSource(db, secondSource, {
    importedAt: "2026-07-19T12:00:00.000Z",
    balances: [63_900],
    csvRows: 1,
    tradeDates: ["2026-07-20"],
  });
  db.close();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const first = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: first.previewToken,
  }, ledgerDir, now);
  const second = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion: secondSource }, ledgerDir, now);
  assert.throws(() => confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion: secondSource,
    reason: "Second synthetic mismatch",
    acknowledged: true,
    previewToken: second.previewToken,
  }, ledgerDir, now), errorCode("INVALID_CASE_STATUS"));
  const after = openLedgerDatabase(ledgerDir);
  assert.equal((after.prepare("SELECT COUNT(*) AS count FROM disabled_import_sources WHERE state = 'active'").get() as { count: number }).count, 1);
  assert.equal((after.prepare("SELECT outcome FROM data_issue_events ORDER BY rowid DESC LIMIT 1").get() as { outcome: string }).outcome, "blocked");
  after.close();
});

test("restore changes only the exact exclusion selected by its preview", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const exclusion = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: exclusion.previewToken,
  }, ledgerDir, now);
  const db = openLedgerDatabase(ledgerDir);
  seedSource(db, { sourceFileId: "source-b", importRunId: "run-b" }, {
    importedAt: "2026-07-19T12:00:00.000Z",
    balances: [63_900],
    csvRows: 1,
    tradeDates: ["2026-07-20"],
  });
  db.prepare(`INSERT INTO disabled_import_sources (
    disabled_import_source_id, data_issue_id, source_file_id, import_run_id,
    reason, state, disabled_at, restored_at, preview_token
  ) VALUES ('legacy-second', ?, 'source-b', 'run-b', 'Legacy synthetic row',
    'active', '2026-07-20T01:00:00.000Z', NULL, 'legacy-token')`).run(issue.dataIssueId);
  db.close();
  const preview = previewDataIssueRestore(issue.dataIssueId, ledgerDir, now);
  const restored = confirmDataIssueRestore({ dataIssueId: issue.dataIssueId, previewToken: preview.previewToken }, ledgerDir, now);
  const after = openLedgerDatabase(ledgerDir);
  const states = after.prepare(`SELECT state, COUNT(*) AS count
    FROM disabled_import_sources WHERE data_issue_id = ? GROUP BY state ORDER BY state`)
    .all(issue.dataIssueId) as Array<{ state: string; count: number }>;
  after.close();
  assert.deepEqual(states.map((row) => ({ ...row })), [{ state: "active", count: 1 }, { state: "restored", count: 1 }]);
  assert.equal(restored.status, "resolved");
});

test("create rolls back when response hydration fails", async () => {
  const { ledgerDir, input } = await setup();
  const db = openLedgerDatabase(ledgerDir);
  db.exec(`CREATE TRIGGER corrupt_created_response
    AFTER INSERT ON data_issue_events
    WHEN NEW.event_type = 'created'
    BEGIN
      INSERT INTO data_issue_events (
        data_issue_event_id, data_issue_id, event_type, stage, outcome,
        summary, details_json, created_at
      ) VALUES ('corrupt-created-event', NEW.data_issue_id, 'synthetic', 'report',
        'succeeded', 'Synthetic corrupt response', '{', NEW.created_at);
    END`);
  db.close();
  assert.throws(() => createDataIssue(input, ledgerDir, clock()), errorCode("LEDGER_WRITE_FAILED"));
  const after = openLedgerDatabase(ledgerDir);
  assert.equal((after.prepare("SELECT COUNT(*) AS count FROM data_issues").get() as { count: number }).count, 0);
  assert.equal((after.prepare("SELECT COUNT(*) AS count FROM data_issue_events").get() as { count: number }).count, 0);
  after.close();
});

test("diagnosis rolls back when response hydration fails", async () => {
  const { ledgerDir, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  corruptFirstEvent(ledgerDir);
  assert.throws(() => startDataIssueDiagnosis(issue.dataIssueId, ledgerDir, now), errorCode("LEDGER_WRITE_FAILED"));
  const db = openLedgerDatabase(ledgerDir);
  assert.equal((db.prepare("SELECT status FROM data_issues WHERE data_issue_id = ?").get(issue.dataIssueId) as { status: string }).status, "pending");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM data_issue_events WHERE event_type = 'diagnosis' AND outcome = 'succeeded'").get() as { count: number }).count, 0);
  db.close();
});

test("exclusion rolls back when response hydration fails", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const preview = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  corruptFirstEvent(ledgerDir);
  assert.throws(() => confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: preview.previewToken,
  }, ledgerDir, now), errorCode("LEDGER_WRITE_FAILED"));
  const db = openLedgerDatabase(ledgerDir);
  assert.equal((db.prepare("SELECT status FROM data_issues WHERE data_issue_id = ?").get(issue.dataIssueId) as { status: string }).status, "pending");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM disabled_import_sources").get() as { count: number }).count, 0);
  db.close();
});

test("restore rolls back when response hydration fails", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  const exclusion = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: exclusion.previewToken,
  }, ledgerDir, now);
  const preview = previewDataIssueRestore(issue.dataIssueId, ledgerDir, now);
  corruptFirstEvent(ledgerDir);
  assert.throws(
    () => confirmDataIssueRestore({ dataIssueId: issue.dataIssueId, previewToken: preview.previewToken }, ledgerDir, now),
    errorCode("LEDGER_WRITE_FAILED"),
  );
  const db = openLedgerDatabase(ledgerDir);
  assert.equal((db.prepare("SELECT status FROM data_issues WHERE data_issue_id = ?").get(issue.dataIssueId) as { status: string }).status, "resolved");
  assert.equal((db.prepare("SELECT state FROM disabled_import_sources WHERE data_issue_id = ?").get(issue.dataIssueId) as { state: string }).state, "active");
  db.close();
});

test("diagnosis replay is idempotent but terminal cases are blocked and audited", async () => {
  const { ledgerDir, sourceVersion, input } = await setup();
  const now = clock();
  const issue = createDataIssue(input, ledgerDir, now);
  startDataIssueDiagnosis(issue.dataIssueId, ledgerDir, now);
  startDataIssueDiagnosis(issue.dataIssueId, ledgerDir, now);
  const preview = previewDataIssueExclusion({ dataIssueId: issue.dataIssueId, sourceVersion }, ledgerDir, now);
  confirmDataIssueExclusion({
    dataIssueId: issue.dataIssueId,
    sourceVersion,
    reason: "Synthetic source mismatch",
    acknowledged: true,
    previewToken: preview.previewToken,
  }, ledgerDir, now);
  assert.throws(() => startDataIssueDiagnosis(issue.dataIssueId, ledgerDir, now), errorCode("INVALID_CASE_STATUS"));
  const db = openLedgerDatabase(ledgerDir);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM data_issue_events WHERE event_type = 'diagnosis' AND outcome = 'succeeded'").get() as { count: number }).count, 1);
  const last = db.prepare("SELECT event_type, outcome FROM data_issue_events ORDER BY rowid DESC LIMIT 1").get() as { event_type: string; outcome: string };
  db.close();
  assert.deepEqual({ ...last }, { event_type: "diagnosis", outcome: "blocked" });
});
