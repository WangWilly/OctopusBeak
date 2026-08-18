import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  CANONICAL_SCHEMA_VERSION,
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  CATHAY_POSTING_MAPPING,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_PROVENANCE,
  commitCathayDomesticDeposit,
  commitCathayDomesticDepositSync,
  commitCathayDerivedImportRun,
  runCathayDerivedImportRun,
  commitCathayUserAssertion,
  canonicalSqlitePath,
  createCathayCanonicalFinancialQuery,
  openCanonicalDatabase,
  parseExactDecimalLexeme,
  type CathayStagedCapturePage,
} from "./cathay-domestic-deposit.ts";
import { createCathayCanonicalFinancialQuery as createBoundaryCanonicalQuery } from "../../lib/shared-ledger/server/financial-query.ts";

const syncPage = (accountNo = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, rawResponse = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse): CathayStagedCapturePage => ({
  accountNo,
  currency: "TWD" as const,
  scope: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope,
  pageOrdinal: 0,
  requestPageToken: null,
  nextPageToken: null,
  rawResponse,
  contractFingerprint: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  preflightFingerprint: "synthetic-preflight-v1",
  absenceAuthority: "comparable-complete-range" as const,
});

const syncInput = (pages = [syncPage()]) => ({
  sourceConnectionId: "synthetic-sync-connection",
  identityEpoch: "synthetic-sync-epoch",
  authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
  observedAt: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.observedAt,
  syncState: { cursor: null },
  pages,
});

assert.deepEqual(parseExactDecimalLexeme("123.4500"), {
  coefficient: 1234500n,
  scale: 4,
});
assert.throws(() => parseExactDecimalLexeme("1e3"), /exact decimal/);
assert.equal(CATHAY_DOMESTIC_DEPOSIT_PROVENANCE.values, "synthetic");
assert.equal(CATHAY_DOMESTIC_DEPOSIT_PROVENANCE.liveResponseRetained, false);

const workflowSource = readFileSync(new URL("../../workflows/cathay-statements.ts", import.meta.url), "utf8");
assert.match(workflowSource, /fetchTransferDetailsRaw/);
assert.match(workflowSource, /response\.text\(\)/);
assert.match(workflowSource, /fetchTransferDetailsRaw[\s\S]*JSON\.parse/);

// These fixtures intentionally model the two on-disk shapes that preceded the
// current schema. Keeping one populated row and its full foreign-key lineage
// makes migration tests catch accidental target-shape creation and data loss.
const LEGACY_V1_SCHEMA = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc_us INTEGER NOT NULL);
CREATE TABLE canonical_commits (
  commit_id BLOB PRIMARY KEY CHECK(length(commit_id) = 16), commit_sequence INTEGER NOT NULL UNIQUE,
  recorded_at_utc_us INTEGER NOT NULL, authority_route TEXT NOT NULL
);
CREATE TABLE source_authority_routes (
  authority_route TEXT PRIMARY KEY, integration_namespace TEXT NOT NULL, stream TEXT NOT NULL,
  contract_version TEXT NOT NULL, created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE source_connections (
  source_connection_id BLOB PRIMARY KEY CHECK(length(source_connection_id) = 16), integration_namespace TEXT NOT NULL,
  source_connection_key TEXT NOT NULL, created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(integration_namespace, source_connection_key)
);
CREATE TABLE identity_epochs (
  identity_epoch_id BLOB PRIMARY KEY CHECK(length(identity_epoch_id) = 16), source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  epoch_key TEXT NOT NULL, created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(source_connection_id, epoch_key)
);
CREATE TABLE source_captures (
  capture_id BLOB PRIMARY KEY CHECK(length(capture_id) = 16), source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id), authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
  stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE source_records (
  source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), sequence_lexeme TEXT NOT NULL, payload_json TEXT NOT NULL,
  UNIQUE(capture_id, sequence_lexeme)
);
CREATE TABLE financial_accounts (
  account_id BLOB PRIMARY KEY CHECK(length(account_id) = 16), source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id), stream TEXT NOT NULL, account_no TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('depository','credit','loan','investment','other')), currency TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(source_connection_id, identity_epoch_id, stream, account_no)
);
CREATE TABLE financial_transactions (
  transaction_id BLOB PRIMARY KEY CHECK(length(transaction_id) = 16), account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  source_sequence TEXT NOT NULL, created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(account_id, source_sequence)
);
CREATE TABLE transaction_revisions (
  revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), revision_number INTEGER NOT NULL,
  amount_coefficient TEXT NOT NULL, amount_scale INTEGER NOT NULL CHECK(amount_scale >= 0), currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow','outflow')), posting_status TEXT NOT NULL CHECK(posting_status IN ('pending','posted')),
  effective_on TEXT NOT NULL, transaction_date_time_local TEXT NOT NULL, time_zone TEXT NOT NULL,
  time_precision TEXT NOT NULL CHECK(time_precision = 'second'), time_origin TEXT NOT NULL CHECK(time_origin = 'source_reported'),
  utc_instant_utc_us INTEGER NOT NULL, UNIQUE(transaction_id, revision_number)
);
CREATE TABLE source_assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id), source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(transaction_id, revision_id)
);
CREATE TABLE assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES source_assertions(assertion_id), source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), PRIMARY KEY(assertion_id, source_record_id)
);
CREATE TABLE source_sync_states (
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT NOT NULL,
  last_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(source_connection_id, account_id, stream)
);
CREATE TABLE current_transactions (
  transaction_id BLOB PRIMARY KEY REFERENCES financial_transactions(transaction_id), revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
`;

const legacyId = (value: number): Buffer => Buffer.alloc(16, value);

function seedLegacyDatabase(directory: string, version: 1 | 2): void {
  const db = new DatabaseSync(canonicalSqlitePath(directory));
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(LEGACY_V1_SCHEMA);
  const commitId = legacyId(1);
  const route = "cathay/domestic-deposit/v1";
  const connectionId = legacyId(2);
  const epochId = legacyId(3);
  const captureId = legacyId(4);
  const recordId = legacyId(5);
  const accountId = legacyId(6);
  const transactionId = legacyId(7);
  const revisionId = legacyId(8);
  const assertionId = legacyId(9);
  const observedAt = "2026-07-01T00:00:00Z";
  db.prepare("INSERT INTO schema_migrations(version, applied_at_utc_us) VALUES (1, ?)").run(1782864000000000);
  db.prepare("INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route) VALUES (?, ?, ?, ?)").run(commitId, 1, 1782864000000000, route);
  db.prepare("INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?)").run(route, "cathay", "domestic-deposit", "v1", commitId);
  db.prepare("INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES (?, ?, ?, ?)").run(connectionId, "cathay", "synthetic-legacy-connection", commitId);
  db.prepare("INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES (?, ?, ?, ?)").run(epochId, connectionId, "synthetic-legacy-epoch", commitId);
  db.prepare("INSERT INTO source_captures(capture_id, source_connection_id, identity_epoch_id, authority_route, stream, account_no, observed_at, scope_start, scope_end, completeness, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(captureId, connectionId, epochId, route, "domestic-deposit", "SYNTHETIC-LEGACY-001", observedAt, "2026-07-01", "2026-07-01", "complete-range", commitId);
  db.prepare("INSERT INTO source_records(source_record_id, capture_id, commit_id, sequence_lexeme, payload_json) VALUES (?, ?, ?, ?, ?)").run(recordId, captureId, commitId, "1", '{"synthetic":true}');
  db.prepare("INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, account_no, account_type, currency, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(accountId, connectionId, epochId, "domestic-deposit", "SYNTHETIC-LEGACY-001", "depository", "TWD", commitId);
  db.prepare("INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)").run(transactionId, accountId, "1", commitId);
  db.prepare("INSERT INTO transaction_revisions(revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number, amount_coefficient, amount_scale, currency, direction, posting_status, effective_on, transaction_date_time_local, time_zone, time_precision, time_origin, utc_instant_utc_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(revisionId, transactionId, recordId, captureId, commitId, 1, "12500", 0, "TWD", "inflow", "posted", "2026-07-01", "2026-07-01T09:00:00", "Asia/Taipei", "second", "source_reported", 1782867600000000);
  db.prepare("INSERT INTO source_assertions(assertion_id, transaction_id, revision_id, source_record_id, commit_id) VALUES (?, ?, ?, ?, ?)").run(assertionId, transactionId, revisionId, recordId, commitId);
  db.prepare("INSERT INTO assertion_provenance(assertion_id, source_record_id, commit_id) VALUES (?, ?, ?)").run(assertionId, recordId, commitId);
  db.prepare("INSERT INTO source_sync_states(source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(connectionId, accountId, "domestic-deposit", "2026-07-01", "2026-07-01", "legacy-cursor", captureId, commitId);
  db.prepare("INSERT INTO current_transactions(transaction_id, revision_id, commit_id) VALUES (?, ?, ?)").run(transactionId, revisionId, commitId);
  if (version === 2) {
    db.exec("ALTER TABLE canonical_commits ADD COLUMN commit_kind TEXT NOT NULL DEFAULT 'source_capture' CHECK(commit_kind = 'source_capture')");
    db.exec("ALTER TABLE source_records ADD COLUMN description TEXT");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN posting_origin TEXT NOT NULL DEFAULT 'provider_booked_history' CHECK(posting_origin = 'provider_booked_history')");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN posting_basis TEXT NOT NULL DEFAULT 'query-status-success-with-accounting-date' CHECK(posting_basis = 'query-status-success-with-accounting-date')");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN posting_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN description TEXT");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN effective_time_basis TEXT NOT NULL DEFAULT 'accounting' CHECK(effective_time_basis = 'accounting')");
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN effective_time_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')");
    db.exec(`CREATE TABLE transaction_time_observations (
      observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
      revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id), source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), role TEXT NOT NULL CHECK(role IN ('accounting','occurred')),
      local_value TEXT NOT NULL, time_zone TEXT NOT NULL CHECK(time_zone = 'Asia/Taipei'), time_precision TEXT NOT NULL CHECK(time_precision IN ('date','second')),
      time_origin TEXT NOT NULL CHECK(time_origin = 'source_reported'), utc_instant_utc_us INTEGER NOT NULL, UNIQUE(revision_id, role)
    )`);
    db.exec("CREATE TABLE current_projection_state (generation INTEGER PRIMARY KEY CHECK(generation = 1), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id))");
    db.prepare("INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?)").run(commitId);
    db.prepare("INSERT INTO transaction_time_observations(observation_id, transaction_id, revision_id, source_record_id, commit_id, role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(legacyId(10), transactionId, revisionId, recordId, commitId, "accounting", "2026-07-01", "Asia/Taipei", "date", "source_reported", 1782835200000000);
    db.prepare("INSERT INTO transaction_time_observations(observation_id, transaction_id, revision_id, source_record_id, commit_id, role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(legacyId(11), transactionId, revisionId, recordId, commitId, "occurred", "2026-07-01T09:00:00", "Asia/Taipei", "second", "source_reported", 1782867600000000);
    db.prepare("INSERT INTO schema_migrations(version, applied_at_utc_us) VALUES (2, ?)").run(1782864000000001);
  }
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
}

function restoreLegacySyncState(db: DatabaseSync): void {
  db.exec(`CREATE TABLE source_sync_states (
    source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
    stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT NOT NULL,
    last_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
    PRIMARY KEY(source_connection_id, account_id, stream)
  )`);
  db.prepare("INSERT INTO source_sync_states(source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(legacyId(2), legacyId(6), "domestic-deposit", "2026-07-01", "2026-07-01", "legacy-cursor", legacyId(4), legacyId(1));
}

const ledgerDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-"));
try {
  const first = await commitCathayDomesticDeposit(ledgerDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  assert.equal(first.transactions.length, 3);
  assert.equal(first.accountIds.length, 1);
  assert.equal(first.transactions[0]?.direction, "inflow");
  assert.deepEqual(first.transactions[0]?.amount, { coefficient: "12500", scale: 0 });

  const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    for (const [table, expected] of [
      ["canonical_commits", 1],
      ["source_connections", 1],
      ["identity_epochs", 1],
      ["source_captures", 1],
      ["source_records", 3],
      ["financial_accounts", 1],
      ["financial_transactions", 3],
      ["transaction_revisions", 3],
      ["source_assertions", 3],
      ["source_sync_states", 1],
      ["current_transactions", 3],
    ] as const) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, expected, table);
    }
    const commitRow = db.prepare("SELECT commit_id, recorded_at_utc_us FROM canonical_commits").get() as Record<string, unknown>;
    assert.equal(commitRow.commit_id instanceof Uint8Array, true);
    assert.equal((commitRow.commit_id as Uint8Array).byteLength, 16);
    assert.equal(typeof commitRow.recorded_at_utc_us, "number");
    assert.equal(Number.isInteger(commitRow.recorded_at_utc_us), true);
    assert.equal(db.prepare("SELECT commit_kind FROM canonical_commits").get()?.commit_kind, "source_capture");
    const captureRow = db.prepare("SELECT capture_id, commit_id FROM source_captures").get() as Record<string, unknown>;
    assert.equal(captureRow.capture_id instanceof Uint8Array, true);
    assert.equal(captureRow.commit_id instanceof Uint8Array, true);
    const revisionColumns = db.prepare("PRAGMA table_info(transaction_revisions)").all() as Array<{ name?: string }>;
    assert.equal(revisionColumns.some((column) => column.name === "balance_coefficient"), false);
    assert.equal(revisionColumns.some((column) => column.name === "balance_scale"), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM current_transactions WHERE commit_id IS NOT NULL").get()?.count, 3);
    assert.equal(db.prepare("SELECT cursor FROM source_sync_states").get()?.cursor, null);
    assert.deepEqual({ ...(db.prepare("SELECT completeness, completeness_basis, completeness_rule_version FROM source_captures").get() as Record<string, unknown>) }, {
      completeness: "complete-range",
      completeness_basis: "success-status-scope-count-details",
      completeness_rule_version: "cathay/domestic-deposit/v1",
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transaction_time_observations").get()?.count, 6);
    assert.deepEqual((db.prepare("SELECT role, local_value, time_precision, time_origin FROM transaction_time_observations ORDER BY role, local_value LIMIT 2").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })), [
      { role: "accounting", local_value: "2026-07-01", time_precision: "date", time_origin: "source_reported" },
      { role: "accounting", local_value: "2026-07-02", time_precision: "date", time_origin: "source_reported" },
    ]);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name?: string }>).map((row) => row.name);
    for (const index of ["idx_transaction_revisions_financial_time", "idx_transaction_revisions_knowledge_time", "idx_current_transactions_revision", "idx_transaction_revisions_lineage", "idx_assertion_provenance_record"]) {
      assert.equal(indexes.includes(index), true, index);
    }
  } finally {
    db.close();
  }

  const query = createCathayCanonicalFinancialQuery(ledgerDir);
  const current = await query.current({ kind: "current" });
  assert.equal(current.transactions.length, 3);
  assert.equal(current.transactions[0]?.currency, "TWD");
  assert.equal(current.transactions[0]?.postingStatus, "posted");
  assert.equal(current.transactions[0]?.postingOrigin, CATHAY_POSTING_MAPPING.origin);
  assert.equal(current.transactions[0]?.postingBasis, CATHAY_POSTING_MAPPING.basis);
  assert.equal(current.transactions[0]?.postingRuleVersion, CATHAY_POSTING_MAPPING.ruleVersion);
  assert.equal(current.transactions[0]?.displayLabel, "Synthetic Cathay deposit description");
  assert.equal(current.transactions[0]?.effectiveTimeBasis, "accounting");
  assert.equal(current.transactions[0]?.timeZone, "Asia/Taipei");
  assert.equal(current.transactions[0]?.timePrecision, "second");
  assert.equal(current.transactions[0]?.timeOrigin, "source_reported");
  assert.equal(current.transactions[0]?.utcInstantUtcUs, new Date("2026-07-01T09:00:00+08:00").getTime() * 1000);
  assert.equal("balance" in (current.transactions[0] ?? {}), false);
  assert.equal(current.transactions[0]?.effectiveOn, "2026-07-01");
  assert.equal(current.transactions[0]?.id, first.transactions[0]?.transactionId);

  const historicalBeforeCommit = await query.historical({
    kind: "historical",
    cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(first.commitSequence - 1) },
  });
  assert.equal(historicalBeforeCommit.transactions.length, 0);
  const historical = await query.historical({
    kind: "historical",
    cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(first.commitSequence) },
  });
  assert.equal(historical.transactions.length, 3);
  assert.equal(historical.transactions[0]?.id, current.transactions[0]?.id);

  const lineage = await query.lineage({
    kind: "lineage",
    subject: { kind: "transaction", id: current.transactions[0]!.id },
  });
  assert.equal(lineage.entries.length, 1);
  assert.equal(lineage.entries[0]?.revision.transactionId, current.transactions[0]?.id);
  assert.equal(lineage.entries[0]?.assertion.revisionId, lineage.entries[0]?.revision.id);
  assert.equal(lineage.entries[0]?.sourceRecord.captureId, lineage.entries[0]?.capture.id);
  assert.equal(lineage.entries[0]?.capture.authorityRoute, CATHAY_DOMESTIC_DEPOSIT_FIXTURE.authorityRoute);
  assert.equal(lineage.entries[0]?.sourceRecord.description, "Synthetic Cathay deposit description");
  assert.equal(lineage.entries[0]?.sourceRecord.scopeProof.accountNo, CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo);
  assert.equal(lineage.entries[0]?.sourceRecord.scopeProof.completeness, "complete-range");

  const repeated = await commitCathayDomesticDeposit(ledgerDir, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    observedAt: "2026-08-18T00:00:00+08:00",
  });
  assert.equal(repeated.transactions.filter((transaction) => transaction.revisionCreated).length, 0);
  const repeatDb = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 2);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 6);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM financial_transactions").get()?.count, 3);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM transaction_revisions").get()?.count, 3);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM source_assertions").get()?.count, 3);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count, 6);
  } finally {
    repeatDb.close();
  }
  const boundaryQuery = createBoundaryCanonicalQuery(ledgerDir);
  assert.equal((await boundaryQuery.current({ kind: "current" })).commitSequence, repeated.commitSequence);

  assert.equal((await boundaryQuery.current({ kind: "current" })).transactions.length, 3);
  assert.equal((await boundaryQuery.historical({
    kind: "historical",
    cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(repeated.commitSequence) },
  })).transactions.length, 3);
  assert.equal((await boundaryQuery.lineage({
    kind: "lineage",
    subject: { kind: "transaction", id: first.transactions[0]!.transactionId },
  })).entries.length, 1);
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}

const multiScopeDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-sync-scopes-"));
try {
  const secondAccount = "SYNTHETIC-ACCOUNT-002";
  const secondRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace("SYNTHETIC-ACCOUNT-001", secondAccount);
  const firstCommit = await commitCathayDomesticDepositSync(multiScopeDir, syncInput([
    syncPage(),
    syncPage(secondAccount, secondRaw),
  ]));
  assert.equal(firstCommit.scopes.length, 2);
  assert.equal(firstCommit.accountIds.length, 2);
  assert.equal(firstCommit.commitSequence, 1);
  const multiDb = openCanonicalDatabase(multiScopeDir, { readOnly: true });
  try {
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count, 1);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 1);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM capture_scopes").get()?.count, 2);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM capture_scope_pages").get()?.count, 2);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM source_record_scopes").get()?.count, 6);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM source_record_scopes WHERE sequence_lexeme IN ('1', '2', '3')").get()?.count, 6);
    assert.equal(multiDb.prepare("SELECT account_no FROM source_captures").get()?.account_no, null);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM source_records WHERE sequence_lexeme LIKE '%:%'").get()?.count, 0);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 2);
    assert.equal(multiDb.prepare("SELECT COUNT(DISTINCT commit_id) AS count FROM source_sync_states").get()?.count, 1);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM source_sync_states WHERE cursor IS NOT NULL").get()?.count, 0);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM financial_transactions").get()?.count, 6);
    assert.equal(multiDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'transport_checkpoints'").get(), undefined);
  } finally { multiDb.close(); }

  const repeated = await commitCathayDomesticDepositSync(multiScopeDir, {
    ...syncInput([syncPage(), syncPage(secondAccount, secondRaw)]),
    observedAt: "2026-08-18T00:00:00+08:00",
  });
  assert.equal(repeated.commitSequence, 2);
  const repeatedDb = openCanonicalDatabase(multiScopeDir, { readOnly: true });
  try {
    assert.equal(repeatedDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 2);
    assert.equal(repeatedDb.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 12);
    assert.equal(repeatedDb.prepare("SELECT COUNT(*) AS count FROM financial_transactions").get()?.count, 6);
    assert.equal(repeatedDb.prepare("SELECT COUNT(*) AS count FROM transaction_revisions").get()?.count, 6);
    assert.equal(repeatedDb.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count, 12);
  } finally { repeatedDb.close(); }
} finally { await rm(multiScopeDir, { recursive: true, force: true }); }

const populatedV4ScopeMigrationDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-migration-v4-scopes-"));
try {
  const secondAccount = "SYNTHETIC-ACCOUNT-002";
  const secondRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace("SYNTHETIC-ACCOUNT-001", secondAccount);
  await commitCathayDomesticDepositSync(populatedV4ScopeMigrationDir, syncInput([syncPage(), syncPage(secondAccount, secondRaw)]));
  const v4Seed = openCanonicalDatabase(populatedV4ScopeMigrationDir);
  v4Seed.exec("UPDATE source_records SET sequence_lexeme = (SELECT scope.account_no || ':' || source_records.sequence_lexeme FROM source_record_scopes record_scope JOIN capture_scopes scope ON scope.scope_id = record_scope.scope_id WHERE record_scope.source_record_id = source_records.source_record_id); DROP TABLE source_record_scopes; DELETE FROM schema_migrations WHERE version = 5; PRAGMA user_version = 4;");
  v4Seed.close();
  const migratedV4Writer = openCanonicalDatabase(populatedV4ScopeMigrationDir);
  migratedV4Writer.close();
  const migratedV4 = openCanonicalDatabase(populatedV4ScopeMigrationDir, { readOnly: true });
  try {
    assert.equal(Number(migratedV4.prepare("PRAGMA user_version").get()?.user_version), CANONICAL_SCHEMA_VERSION);
    assert.equal(migratedV4.prepare("SELECT COUNT(*) AS count FROM source_records WHERE sequence_lexeme LIKE '%:%'").get()?.count, 0);
    assert.equal(migratedV4.prepare("SELECT COUNT(*) AS count FROM source_record_scopes").get()?.count, 6);
    assert.equal(migratedV4.prepare("SELECT COUNT(DISTINCT sequence_lexeme) AS count FROM source_records").get()?.count, 3);
  } finally { migratedV4.close(); }
} finally { await rm(populatedV4ScopeMigrationDir, { recursive: true, force: true }); }

const provenanceOnlyV4MigrationDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-migration-v4-provenance-only-"));
try {
  await commitCathayDomesticDepositSync(provenanceOnlyV4MigrationDir, syncInput());
  await commitCathayDomesticDepositSync(provenanceOnlyV4MigrationDir, { ...syncInput(), observedAt: "2026-08-18T00:00:00+08:00" });
  const provenanceOnlyV4Seed = openCanonicalDatabase(provenanceOnlyV4MigrationDir);
  provenanceOnlyV4Seed.exec("DROP TABLE source_record_scopes; DELETE FROM schema_migrations WHERE version = 5; PRAGMA user_version = 4;");
  provenanceOnlyV4Seed.close();
  const provenanceOnlyV4Writer = openCanonicalDatabase(provenanceOnlyV4MigrationDir);
  provenanceOnlyV4Writer.close();
  const provenanceOnlyV4Migrated = openCanonicalDatabase(provenanceOnlyV4MigrationDir, { readOnly: true });
  try {
    assert.equal(provenanceOnlyV4Migrated.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 6);
    assert.equal(provenanceOnlyV4Migrated.prepare("SELECT COUNT(*) AS count FROM source_record_scopes").get()?.count, 6);
    assert.equal(provenanceOnlyV4Migrated.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count, 6);
    assert.equal(provenanceOnlyV4Migrated.prepare("SELECT COUNT(*) AS count FROM source_assertions").get()?.count, 3);
  } finally { provenanceOnlyV4Migrated.close(); }
} finally { await rm(provenanceOnlyV4MigrationDir, { recursive: true, force: true }); }

const restorationV4MigrationDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-migration-v4-restoration-"));
try {
  await commitCathayDomesticDepositSync(restorationV4MigrationDir, syncInput());
  const emptyRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(/"count":3,"startDate":"2025-08-17","endDate":"2026-08-17","details":\[[\s\S]*?\]\}/, '"count":0,"startDate":"2025-08-17","endDate":"2026-08-17","details":[]}');
  await commitCathayDomesticDepositSync(restorationV4MigrationDir, { ...syncInput([syncPage(CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, emptyRaw)]), observedAt: "2026-08-18T00:00:00+08:00" });
  const restoration = await commitCathayDomesticDepositSync(restorationV4MigrationDir, { ...syncInput(), observedAt: "2026-08-19T00:00:00+08:00" });
  const restorationV4Seed = openCanonicalDatabase(restorationV4MigrationDir);
  restorationV4Seed.exec("UPDATE current_transactions SET commit_id = revision_commit_id; DROP TABLE source_record_scopes; DELETE FROM schema_migrations WHERE version = 5; PRAGMA user_version = 4;");
  restorationV4Seed.close();
  assert.throws(() => openCanonicalDatabase(restorationV4MigrationDir, { injectMigrationFailure: "v4-v5-after-record-copy" }), /Injected v4-v5 migration failure/);
  const failedV4 = new DatabaseSync(canonicalSqlitePath(restorationV4MigrationDir));
  try {
    assert.equal(Number(failedV4.prepare("PRAGMA user_version").get()?.user_version), 4);
    assert.equal(failedV4.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 6);
    assert.equal(failedV4.prepare("SELECT 1 FROM sqlite_master WHERE name = 'source_record_scopes'").get(), undefined);
  } finally { failedV4.close(); }
  const restoredMigrationWriter = openCanonicalDatabase(restorationV4MigrationDir);
  restoredMigrationWriter.close();
  const restoredMigrationDb = openCanonicalDatabase(restorationV4MigrationDir, { readOnly: true });
  try {
    const migratedProjection = restoredMigrationDb.prepare("SELECT commit_id, projection_commit_id, revision_commit_id FROM current_transactions LIMIT 1").get() as Record<string, unknown>;
    const migratedState = restoredMigrationDb.prepare("SELECT commit_id FROM current_projection_state WHERE generation = 1").get() as Record<string, unknown>;
    assert.deepEqual(Buffer.from(migratedProjection.projection_commit_id as Uint8Array), Buffer.from(migratedState.commit_id as Uint8Array));
    assert.notDeepEqual(Buffer.from(migratedProjection.revision_commit_id as Uint8Array), Buffer.from(migratedProjection.projection_commit_id as Uint8Array));
    assert.equal(restoration.commitSequence, 3);
  } finally { restoredMigrationDb.close(); }
} finally { await rm(restorationV4MigrationDir, { recursive: true, force: true }); }

const tombstoneDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-tombstone-") );
try {
  assert.throws(() => commitCathayDomesticDepositSync(tombstoneDir, syncInput([{
    ...syncPage(),
    absenceAuthority: "tombstone" as never,
  }])), /tombstone.*unsupported|tombstone.*validated/i);
  const tombstoneDb = openCanonicalDatabase(tombstoneDir);
  try { assert.equal(tombstoneDb.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count, 0); } finally { tombstoneDb.close(); }
} finally { await rm(tombstoneDir, { recursive: true, force: true }); }

const incomparableDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-incomparable-") );
try {
  await commitCathayDomesticDepositSync(incomparableDir, syncInput());
  const emptyRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(/"count":3,"startDate":"2025-08-17","endDate":"2026-08-17","details":\[[\s\S]*?\]\}/, '"count":0,"startDate":"2025-08-17","endDate":"2026-08-17","details":[]}');
  await commitCathayDomesticDepositSync(incomparableDir, {
    ...syncInput([{
      ...syncPage(CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, emptyRaw),
      preflightFingerprint: "synthetic-non-comparable-preflight-v2",
    }]),
    observedAt: "2026-08-19T00:00:00+08:00",
  });
  const incomparableQuery = createCathayCanonicalFinancialQuery(incomparableDir);
  assert.equal((await incomparableQuery.current({ kind: "current" })).transactions.length, 3);
} finally { await rm(incomparableDir, { recursive: true, force: true }); }

for (const [label, pages, expected] of [
  ["duplicate page ordinal", [{ ...syncPage(), pageOrdinal: 0 }, { ...syncPage(), pageOrdinal: 0 }] as const, /duplicate ordinals/],
  ["missing terminal page", [{ ...syncPage(), nextPageToken: "synthetic-next-token" }] as const, /end before the terminal/],
  ["contract fingerprint drift", [{ ...syncPage() }, { ...syncPage("SYNTHETIC-ACCOUNT-002", CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace("SYNTHETIC-ACCOUNT-001", "SYNTHETIC-ACCOUNT-002")), contractFingerprint: "synthetic-drift" }] as const, /unsupported|contract or preflight fingerprint drifted across scopes/],
] as const) {
  const rejectedSyncDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-sync-reject-"));
  try {
    assert.throws(() => commitCathayDomesticDepositSync(rejectedSyncDir, syncInput([...pages])), expected, label);
    const rejectedSyncDb = openCanonicalDatabase(rejectedSyncDir);
    try {
      assert.equal(rejectedSyncDb.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count, 0, label);
      assert.equal(rejectedSyncDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 0, label);
    } finally { rejectedSyncDb.close(); }
  } finally { await rm(rejectedSyncDir, { recursive: true, force: true }); }
}

const lifecycleDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-lifecycle-"));
try {
  const first = await commitCathayDomesticDepositSync(lifecycleDir, syncInput());
  const emptyRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(/"count":3,"startDate":"2025-08-17","endDate":"2026-08-17","details":\[[\s\S]*?\]\}/, '"count":0,"startDate":"2025-08-17","endDate":"2026-08-17","details":[]}');
  const withdrawn = await commitCathayDomesticDepositSync(lifecycleDir, {
    ...syncInput([syncPage(CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, emptyRaw)]),
    observedAt: "2026-08-18T00:00:00+08:00",
  });
  const withdrawnQuery = createCathayCanonicalFinancialQuery(lifecycleDir);
  const withdrawnCurrent = await withdrawnQuery.current({ kind: "current" });
  assert.equal(withdrawnCurrent.transactions.length, 0);
  assert.equal(withdrawnCurrent.commitSequence, withdrawn.commitSequence);
  const historicalWithdrawn = await withdrawnQuery.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(withdrawn.commitSequence) } });
  assert.equal(historicalWithdrawn.transactions.length, 3);
  assert.equal(historicalWithdrawn.transactions[0]?.assertionSupportState, "withdrawn");
  const restored = await commitCathayDomesticDepositSync(lifecycleDir, {
    ...syncInput(),
    observedAt: "2026-08-19T00:00:00+08:00",
  });
  assert.equal((await withdrawnQuery.current({ kind: "current" })).transactions.length, 3);
  assert.equal((await withdrawnQuery.current({ kind: "current" })).commitSequence, restored.commitSequence);
  const restoredProjectionDb = openCanonicalDatabase(lifecycleDir, { readOnly: true });
  try {
    const projection = restoredProjectionDb.prepare("SELECT commit_id, projection_commit_id, revision_commit_id FROM current_transactions LIMIT 1").get() as Record<string, unknown>;
    const projectionState = restoredProjectionDb.prepare("SELECT commit_id FROM current_projection_state WHERE generation = 1").get() as Record<string, unknown>;
    assert.deepEqual(Buffer.from(projection.commit_id as Uint8Array), Buffer.from(projection.projection_commit_id as Uint8Array));
    assert.deepEqual(Buffer.from(projection.commit_id as Uint8Array), Buffer.from(projectionState.commit_id as Uint8Array));
    assert.notDeepEqual(Buffer.from(projection.revision_commit_id as Uint8Array), Buffer.from(projection.projection_commit_id as Uint8Array));
  } finally { restoredProjectionDb.close(); }
  assert.equal((await withdrawnQuery.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(restored.commitSequence) } })).transactions[0]?.assertionSupportState, "supported");
  const restoredLineage = await withdrawnQuery.lineage({ kind: "lineage", subject: { kind: "transaction", id: first.transactions[0]!.transactionId } });
  const lifecycleKinds = restoredLineage.entries.flatMap((entry) => entry.lifecycleEvents.map((event) => event.kind));
  assert.equal(lifecycleKinds.includes("withdrawn"), true);
  assert.equal(lifecycleKinds.includes("restored"), true);
  assert.equal(lifecycleKinds.includes("observed"), true);
  assert.equal(restoredLineage.entries[0]?.revision.economicStatus, "normal");
  assert.equal(restoredLineage.entries[0]?.revision.administrativeState, "active");

  const incompleteRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace('"count":3', '"count":2');
  assert.throws(() => commitCathayDomesticDepositSync(lifecycleDir, {
    ...syncInput([syncPage(CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, incompleteRaw)]),
    observedAt: "2026-08-20T00:00:00+08:00",
  }), /count does not match/);
  assert.equal((await withdrawnQuery.current({ kind: "current" })).transactions.length, 3);

  const changedRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace('"incomeAmt":12500', '"incomeAmt":13000').replace('"balance":12500', '"balance":13000');
  const changed = await commitCathayDomesticDepositSync(lifecycleDir, {
    ...syncInput([syncPage(CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, changedRaw)]),
    observedAt: "2026-08-21T00:00:00+08:00",
  });
  assert.equal(changed.transactions.some((transaction) => transaction.revisionCreated), true);
  const changedDb = openCanonicalDatabase(lifecycleDir, { readOnly: true });
  try {
    assert.equal(changedDb.prepare("SELECT COUNT(*) AS count FROM transaction_revisions").get()?.count, 4);
    assert.equal(changedDb.prepare("SELECT COUNT(*) AS count FROM assertion_lifecycle_events WHERE event_kind = 'superseded'").get()?.count, 1);
  } finally { changedDb.close(); }
} finally { await rm(lifecycleDir, { recursive: true, force: true }); }

const semanticDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-semantics-") );
try {
  const seeded = await commitCathayDomesticDepositSync(semanticDir, syncInput());
  const semanticDb = openCanonicalDatabase(semanticDir);
  semanticDb.prepare("UPDATE transaction_revisions SET economic_status = 'refund', administrative_state = 'deleted', semantic_rule_version = ? WHERE revision_number = 1").run(CATHAY_DOMESTIC_DEPOSIT_AUTHORITY);
  semanticDb.close();
  const semanticQuery = createCathayCanonicalFinancialQuery(semanticDir);
  const currentSemantic = (await semanticQuery.current({ kind: "current" })).transactions[0]!;
  assert.equal(currentSemantic.economicStatus, "refund");
  assert.equal(currentSemantic.administrativeState, "deleted");
  assert.equal(currentSemantic.assertionSupportState, "supported");
  const semanticLineage = await semanticQuery.lineage({ kind: "lineage", subject: { kind: "transaction", id: seeded.transactions[0]!.transactionId } });
  assert.equal(semanticLineage.entries[0]?.revision.economicStatus, "refund");
  assert.equal(semanticLineage.entries[0]?.revision.administrativeState, "deleted");
  const emptyRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(/"count":3,"startDate":"2025-08-17","endDate":"2026-08-17","details":\[[\s\S]*?\]\}/, '"count":0,"startDate":"2025-08-17","endDate":"2026-08-17","details":[]}');
  const withdrawnSemantic = await commitCathayDomesticDepositSync(semanticDir, {
    ...syncInput([syncPage(CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, emptyRaw)]),
    observedAt: "2026-08-19T00:00:00+08:00",
  });
  const withdrawnSemanticRow = (await semanticQuery.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(withdrawnSemantic.commitSequence) } })).transactions[0]!;
  assert.equal(withdrawnSemanticRow.assertionSupportState, "withdrawn");
  assert.equal(withdrawnSemanticRow.economicStatus, "refund");
  assert.equal(withdrawnSemanticRow.administrativeState, "deleted");
  await commitCathayDomesticDepositSync(semanticDir, { ...syncInput(), observedAt: "2026-08-20T00:00:00+08:00" });
  const restoredSemantic = (await semanticQuery.current({ kind: "current" })).transactions[0]!;
  assert.equal(restoredSemantic.assertionSupportState, "supported");
  assert.equal(restoredSemantic.economicStatus, "refund");
  assert.equal(restoredSemantic.administrativeState, "deleted");
  assert.equal(seeded.transactions.length, 3);
} finally { await rm(semanticDir, { recursive: true, force: true }); }

// Issue #130: a complete derived run owns an explicit coordinate matrix. Its
// output lifecycle is independent from Source Assertions and User Assertions.
const derivedDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-derived-v6-"));
try {
  const source = await commitCathayDomesticDeposit(derivedDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const transactionId = source.transactions[0]!.transactionId;
  const derivedInput = {
    sourceConnectionId: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.sourceConnectionId,
    identityEpoch: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.identityEpoch,
    authorityRoute: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.authorityRoute,
    stream: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.stream,
    producerId: "synthetic-enricher-v1",
    ruleLineage: "synthetic-rule-v1",
    scope: [{ transactionId, field: "display_name" as const, state: "supported" as const, value: "Derived label" }, { transactionId, field: "note" as const, state: "unsupported" as const }],
  };
  const firstDerived = await commitCathayDerivedImportRun(derivedDir, derivedInput);
  const currentDerived = (await createCathayCanonicalFinancialQuery(derivedDir).current({ kind: "current" })).transactions[0]!;
  assert.equal(currentDerived.displayLabel, "Derived label");
  assert.equal(currentDerived.displayLabelOrigin, "derived");
  assert.equal(currentDerived.note, null);
  assert.equal(currentDerived.displayLabelCommitSequence, firstDerived.commitSequence);
  const sharedSpineAfterFirst = openCanonicalDatabase(derivedDir, { readOnly: true });
  try {
    assert.equal(sharedSpineAfterFirst.prepare("SELECT COUNT(*) AS count FROM assertions WHERE origin = 'source'").get()?.count, source.transactions.length);
    assert.equal(sharedSpineAfterFirst.prepare("SELECT COUNT(*) AS count FROM assertions WHERE origin = 'derived'").get()?.count, 1);
    assert.equal(sharedSpineAfterFirst.prepare("SELECT COUNT(*) AS count FROM assertion_transitions WHERE event_kind = 'observed'").get()?.count, source.transactions.length + 1);
    assert.equal(sharedSpineAfterFirst.prepare("SELECT COUNT(*) AS count FROM assertion_provenance WHERE run_id IS NOT NULL").get()?.count, 1);
  } finally { sharedSpineAfterFirst.close(); }

  const sharedSpineBeforeUnchanged = openCanonicalDatabase(derivedDir, { readOnly: true });
  const sharedSpineBeforeUnchangedCounts = {
    transitions: sharedSpineBeforeUnchanged.prepare("SELECT COUNT(*) AS count FROM assertion_transitions").get()?.count,
    provenance: sharedSpineBeforeUnchanged.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count,
  };
  sharedSpineBeforeUnchanged.close();
  const unchanged = await commitCathayDerivedImportRun(derivedDir, derivedInput);
  const sharedSpineAfterUnchanged = openCanonicalDatabase(derivedDir, { readOnly: true });
  try {
    assert.equal(sharedSpineAfterUnchanged.prepare("SELECT COUNT(*) AS count FROM assertion_transitions").get()?.count, sharedSpineBeforeUnchangedCounts.transitions);
    assert.equal(sharedSpineAfterUnchanged.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count, Number(sharedSpineBeforeUnchangedCounts.provenance) + 1);
  } finally { sharedSpineAfterUnchanged.close(); }
  const changed = await commitCathayDerivedImportRun(derivedDir, { ...derivedInput, scope: [{ transactionId, field: "display_name" as const, state: "supported" as const, value: "Changed label" }, { transactionId, field: "note" as const, state: "supported" as const, value: "Derived note" }] });
  const beforeRuleLineage = openCanonicalDatabase(derivedDir, { readOnly: true });
  const beforeRuleLineageCounts = {
    commits: beforeRuleLineage.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count,
    runs: beforeRuleLineage.prepare("SELECT COUNT(*) AS count FROM derived_import_runs").get()?.count,
    assertions: beforeRuleLineage.prepare("SELECT COUNT(*) AS count FROM derived_assertions").get()?.count,
    provenance: beforeRuleLineage.prepare("SELECT COUNT(*) AS count FROM derived_assertion_provenance").get()?.count,
    current: beforeRuleLineage.prepare("SELECT value_text, projection_commit_id FROM current_transaction_fields WHERE transaction_id = ? AND field_name = 'display_name'").get(Buffer.from(transactionId.replaceAll("-", ""), "hex")),
  };
  beforeRuleLineage.close();
  const ruleLineageDiagnostic = await runCathayDerivedImportRun(derivedDir, { ...derivedInput, ruleLineage: "synthetic-rule-v2", scope: [{ transactionId, field: "display_name" as const, state: "supported" as const, value: "Rule v2 label" }] });
  assert.equal(ruleLineageDiagnostic.status, "diagnostic");
  const afterRuleLineage = openCanonicalDatabase(derivedDir, { readOnly: true });
  try {
    assert.equal(afterRuleLineage.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count, beforeRuleLineageCounts.commits);
    assert.equal(afterRuleLineage.prepare("SELECT COUNT(*) AS count FROM derived_import_runs").get()?.count, beforeRuleLineageCounts.runs);
    assert.equal(afterRuleLineage.prepare("SELECT COUNT(*) AS count FROM derived_assertions").get()?.count, beforeRuleLineageCounts.assertions);
    assert.equal(afterRuleLineage.prepare("SELECT COUNT(*) AS count FROM derived_assertion_provenance").get()?.count, beforeRuleLineageCounts.provenance);
    assert.deepEqual(afterRuleLineage.prepare("SELECT value_text, projection_commit_id FROM current_transaction_fields WHERE transaction_id = ? AND field_name = 'display_name'").get(Buffer.from(transactionId.replaceAll("-", ""), "hex")), beforeRuleLineageCounts.current);
  } finally { afterRuleLineage.close(); }
  const producerDiagnostic = await runCathayDerivedImportRun(derivedDir, { ...derivedInput, producerId: "other-producer", scope: [{ transactionId, field: "display_name" as const, state: "supported" as const, value: "Other label" }] });
  assert.equal(producerDiagnostic.status, "diagnostic");
  const withdrawn = await commitCathayDerivedImportRun(derivedDir, { ...derivedInput, scope: [{ transactionId, field: "display_name" as const, state: "unsupported" as const }, { transactionId, field: "note" as const, state: "unsupported" as const }] });
  const historicalLineageBefore = openCanonicalDatabase(derivedDir, { readOnly: true });
  const historicalLineageSnapshot = {
    commits: historicalLineageBefore.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count,
    runs: historicalLineageBefore.prepare("SELECT COUNT(*) AS count FROM derived_import_runs").get()?.count,
    assertions: historicalLineageBefore.prepare("SELECT COUNT(*) AS count FROM derived_assertions").get()?.count,
    provenance: historicalLineageBefore.prepare("SELECT COUNT(*) AS count FROM derived_assertion_provenance").get()?.count,
    lifecycle: historicalLineageBefore.prepare("SELECT COUNT(*) AS count FROM derived_assertion_lifecycle_events").get()?.count,
    current: historicalLineageBefore.prepare("SELECT value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM current_transaction_fields WHERE transaction_id = ? AND field_name = 'display_name'").get(Buffer.from(transactionId.replaceAll("-", ""), "hex")),
    projection: historicalLineageBefore.prepare("SELECT generation, commit_id FROM current_projection_state").all(),
  };
  historicalLineageBefore.close();
  for (const mismatch of [
    { ruleLineage: "synthetic-rule-v2" },
    { producerId: "other-producer" },
    { origin: "other-origin" },
  ] as const) {
    const historicalLineageDiagnostic = await runCathayDerivedImportRun(derivedDir, { ...derivedInput, ...mismatch, scope: [{ transactionId, field: "display_name" as const, state: "supported" as const, value: "Historical mismatch label" }] });
    assert.equal(historicalLineageDiagnostic.status, "diagnostic");
    const historicalLineageAfter = openCanonicalDatabase(derivedDir, { readOnly: true });
    try {
      assert.deepEqual({
        commits: historicalLineageAfter.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count,
        runs: historicalLineageAfter.prepare("SELECT COUNT(*) AS count FROM derived_import_runs").get()?.count,
        assertions: historicalLineageAfter.prepare("SELECT COUNT(*) AS count FROM derived_assertions").get()?.count,
        provenance: historicalLineageAfter.prepare("SELECT COUNT(*) AS count FROM derived_assertion_provenance").get()?.count,
        lifecycle: historicalLineageAfter.prepare("SELECT COUNT(*) AS count FROM derived_assertion_lifecycle_events").get()?.count,
        current: historicalLineageAfter.prepare("SELECT value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM current_transaction_fields WHERE transaction_id = ? AND field_name = 'display_name'").get(Buffer.from(transactionId.replaceAll("-", ""), "hex")),
        projection: historicalLineageAfter.prepare("SELECT generation, commit_id FROM current_projection_state").all(),
      }, historicalLineageSnapshot);
    } finally { historicalLineageAfter.close(); }
  }
  const query = createCathayCanonicalFinancialQuery(derivedDir);
  assert.equal((await query.current({ kind: "current" })).transactions[0]?.displayLabel, CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.includes("Synthetic Cathay deposit description") ? "Synthetic Cathay deposit description" : null);
  const historicalChanged = await query.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(changed.commitSequence) } });
  assert.equal(historicalChanged.transactions[0]?.displayLabel, "Changed label");
  const lineage = await query.lineage({ kind: "lineage", subject: { kind: "transaction", id: transactionId } });
  const derivedKinds = lineage.entries.flatMap((entry) => entry.derivedAssertions.map((assertion) => assertion.state));
  assert.equal(derivedKinds.includes("withdrawn"), true);
  assert.equal(lineage.entries[0]?.derivedAssertions.some((assertion) => assertion.value === "Changed label"), true);
  const db = openCanonicalDatabase(derivedDir, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM derived_import_runs").get()?.count, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM derived_assertion_provenance").get()?.count, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM derived_assertion_lifecycle_events WHERE event_kind = 'withdrawn'").get()?.count, 2);
  } finally { db.close(); }

  const user = await commitCathayUserAssertion(derivedDir, { transactionId, field: "display_name", value: "User label" });
  const userCurrent = (await query.current({ kind: "current" })).transactions[0]!;
  assert.equal(userCurrent.displayLabel, "User label");
  assert.equal(userCurrent.displayLabelOrigin, "user");
  assert.equal(userCurrent.displayLabelCommitSequence, user.commitSequence);
  await commitCathayUserAssertion(derivedDir, { transactionId, field: "display_name", value: null });
  assert.equal((await query.current({ kind: "current" })).transactions[0]?.displayLabel, CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.includes("Synthetic Cathay deposit description") ? "Synthetic Cathay deposit description" : null);
  const authorityDb = openCanonicalDatabase(derivedDir, { readOnly: true });
  try {
    for (const compatibility of ["assertion_lifecycle_events", "derived_assertion_lifecycle_events", "user_assertion_lifecycle_events", "derived_assertion_provenance", "user_assertion_provenance"]) {
      assert.equal(authorityDb.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(compatibility)?.type, "view", compatibility);
    }
    const sharedEventIds = (authorityDb.prepare("SELECT event_id FROM assertion_transitions ORDER BY event_id").all() as Array<Record<string, unknown>>).map((row) => Buffer.from(row.event_id as Uint8Array).toString("hex"));
    const compatibilityEventIds = (authorityDb.prepare(`SELECT event_id FROM assertion_lifecycle_events
      UNION SELECT event_id FROM derived_assertion_lifecycle_events
      UNION SELECT event_id FROM user_assertion_lifecycle_events ORDER BY event_id`).all() as Array<Record<string, unknown>>).map((row) => Buffer.from(row.event_id as Uint8Array).toString("hex"));
    assert.deepEqual(compatibilityEventIds, sharedEventIds);
    assert.equal(authorityDb.prepare("SELECT COUNT(*) AS count FROM assertion_transitions").get()?.count, new Set(sharedEventIds).size);
  } finally { authorityDb.close(); }
  const userLineage = await query.lineage({ kind: "lineage", subject: { kind: "transaction", id: transactionId } });
  assert.equal(userLineage.entries[0]?.userAssertions.some((assertion) => assertion.state === "withdrawn"), true);

  const emptyScopeBefore = openCanonicalDatabase(derivedDir, { readOnly: true });
  const emptyScopeSnapshot = {
    commits: emptyScopeBefore.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count,
    runs: emptyScopeBefore.prepare("SELECT COUNT(*) AS count FROM derived_import_runs").get()?.count,
    assertions: emptyScopeBefore.prepare("SELECT COUNT(*) AS count FROM assertions").get()?.count,
    transitions: emptyScopeBefore.prepare("SELECT COUNT(*) AS count FROM assertion_transitions").get()?.count,
    provenance: emptyScopeBefore.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count,
    projection: emptyScopeBefore.prepare("SELECT generation, commit_id FROM current_projection_state").all(),
  };
  emptyScopeBefore.close();
  const diagnostic = await runCathayDerivedImportRun(derivedDir, { ...derivedInput, scope: [] });
  assert.equal(diagnostic.status, "diagnostic");
  const diagnosticDb = openCanonicalDatabase(derivedDir, { readOnly: true });
  try {
    assert.deepEqual({
      commits: diagnosticDb.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count,
      runs: diagnosticDb.prepare("SELECT COUNT(*) AS count FROM derived_import_runs").get()?.count,
      assertions: diagnosticDb.prepare("SELECT COUNT(*) AS count FROM assertions").get()?.count,
      transitions: diagnosticDb.prepare("SELECT COUNT(*) AS count FROM assertion_transitions").get()?.count,
      provenance: diagnosticDb.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count,
      projection: diagnosticDb.prepare("SELECT generation, commit_id FROM current_projection_state").all(),
    }, emptyScopeSnapshot);
  } finally { diagnosticDb.close(); }
  await assert.rejects(() => commitCathayUserAssertion(derivedDir, { target: { kind: "balance", field: "note", id: transactionId }, value: "forbidden" }), /transaction targets only/);
  await assert.rejects(() => commitCathayUserAssertion(derivedDir, { transactionId, field: "amount", value: "999" } as never), /only display_name or note/);
} finally { await rm(derivedDir, { recursive: true, force: true }); }

const blockStart = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.indexOf('{"queryStatus"');
const blockEnd = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.lastIndexOf("}]}}") + 1;
const singleResultBlock = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.slice(blockStart, blockEnd);
for (const [label, rawResponse] of [
  ["zero result blocks", CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(`[${singleResultBlock}]`, "[]")],
  ["multiple result blocks", CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(`[${singleResultBlock}]`, `[${singleResultBlock},${singleResultBlock}]`)],
] as const) {
  const rejectedDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-result-block-"));
  try {
    assert.throws(() => commitCathayDomesticDeposit(rejectedDir, { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse }), /exactly one transfer result/, label);
    const rejectedDb = openCanonicalDatabase(rejectedDir);
    try {
      assert.equal(rejectedDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 0, label);
      assert.equal(rejectedDb.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 0, label);
    } finally { rejectedDb.close(); }
  } finally { await rm(rejectedDir, { recursive: true, force: true }); }
}

const emptyDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-empty-"));
try {
  const emptyRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(/"count":3,"startDate":"2025-08-17","endDate":"2026-08-17","details":\[[\s\S]*?\]\}/, '"count":0,"startDate":"2025-08-17","endDate":"2026-08-17","details":[]}');
  const empty = await commitCathayDomesticDeposit(emptyDir, { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: emptyRaw });
  assert.equal(empty.transactions.length, 0);
  const emptyDb = openCanonicalDatabase(emptyDir, { readOnly: true });
  try {
    assert.equal(emptyDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 1);
    assert.equal(emptyDb.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 1);
    assert.equal(emptyDb.prepare("SELECT COUNT(*) AS count FROM current_projection_state").get()?.count, 1);
    for (const table of ["source_records", "financial_transactions", "transaction_revisions", "source_assertions", "current_transactions"]) {
      assert.equal(emptyDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0, table);
    }
  } finally { emptyDb.close(); }
} finally { await rm(emptyDir, { recursive: true, force: true }); }

const completenessDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-completeness-"));
try {
  const result = await commitCathayDomesticDeposit(completenessDir, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    scope: { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope, complete: false },
  });
  assert.equal(result.transactions.length, 3);
  const completenessDb = openCanonicalDatabase(completenessDir, { readOnly: true });
  try {
    assert.equal(completenessDb.prepare("SELECT completeness FROM source_captures").get()?.completeness, "complete-range");
  } finally { completenessDb.close(); }
} finally { await rm(completenessDir, { recursive: true, force: true }); }

const backfillDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-backfill-"));
try {
  const backfill = await commitCathayDomesticDeposit(backfillDir, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    observedAt: "2020-01-01T00:00:00Z",
  }, { clock: () => "2026-08-20T12:00:00.123456Z" });
  const backfillDb = openCanonicalDatabase(backfillDir, { readOnly: true });
  try {
    const knowledge = backfillDb.prepare("SELECT recorded_at_utc_us FROM canonical_commits").get()?.recorded_at_utc_us as number;
    assert.equal(knowledge > new Date("2020-01-01T00:00:00Z").getTime() * 1000, true);
    assert.equal(backfillDb.prepare("SELECT recorded_at_utc_us FROM canonical_commits").get()?.recorded_at_utc_us, 1787227200123456);
  } finally { backfillDb.close(); }
  const backfillQuery = createCathayCanonicalFinancialQuery(backfillDir);
  assert.equal((await backfillQuery.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: "0" } })).transactions.length, 0);
  assert.equal((await backfillQuery.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(backfill.commitSequence) } })).transactions.length, 3);
} finally { await rm(backfillDir, { recursive: true, force: true }); }

const contendedDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-writer-"));
try {
  await Promise.all([
    commitCathayDomesticDeposit(contendedDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE),
    commitCathayDomesticDeposit(contendedDir, { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, observedAt: "2026-08-18T00:00:00+08:00" }),
  ]);
  const contendedDb = openCanonicalDatabase(contendedDir, { readOnly: true });
  try {
    assert.equal(contendedDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 2);
    assert.equal(contendedDb.prepare("SELECT COUNT(*) AS count FROM transaction_revisions").get()?.count, 3);
    assert.equal(contendedDb.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count, 6);
  } finally { contendedDb.close(); }
} finally { await rm(contendedDir, { recursive: true, force: true }); }

const newerSchemaDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-schema-"));
try {
  const schemaDb = openCanonicalDatabase(newerSchemaDir);
  schemaDb.exec(`PRAGMA user_version = ${CANONICAL_SCHEMA_VERSION + 1}`);
  schemaDb.close();
  assert.throws(() => openCanonicalDatabase(newerSchemaDir), /newer than supported/);
} finally { await rm(newerSchemaDir, { recursive: true, force: true }); }

for (const version of [1, 2] as const) {
  const migrationDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", `cathay-canonical-migration-v${version}-`));
  try {
    seedLegacyDatabase(migrationDir, version);
    const migrated = openCanonicalDatabase(migrationDir);
    try {
      assert.equal(Number(migrated.prepare("PRAGMA user_version").get()?.user_version), CANONICAL_SCHEMA_VERSION, `v${version} final version`);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 6, `v${version} migration history`);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 1, `v${version} source row`);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM transaction_revisions").get()?.count, 1, `v${version} revision`);
      assert.equal(migrated.prepare("SELECT completeness_basis FROM source_captures").get()?.completeness_basis, "success-status-scope-count-details", `v${version} completeness`);
      assert.equal(migrated.prepare("SELECT cursor FROM source_sync_states").get()?.cursor, "legacy-cursor", `v${version} cursor preservation`);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM transaction_time_observations").get()?.count, 2, `v${version} time lineage`);
      assert.equal(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_canonical_commits_sequence'").get()?.["1"], 1, `v${version} commit sequence index`);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM assertions WHERE origin = 'source'").get()?.count, 1, `v${version} shared source spine`);
    } finally { migrated.close(); }

    const reopened = openCanonicalDatabase(migrationDir);
    try {
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 1, `v${version} repeated reopen`);
    } finally { reopened.close(); }
    const migratedQuery = createCathayCanonicalFinancialQuery(migrationDir);
    assert.equal((await migratedQuery.current({ kind: "current" })).transactions.length, 1, `v${version} current query`);
    assert.equal((await migratedQuery.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: "1" } })).transactions.length, 1, `v${version} historical query`);
    const migratedLineage = await migratedQuery.lineage({ kind: "lineage", subject: { kind: "transaction", id: "07070707-0707-0707-0707-070707070707" } });
    assert.equal(migratedLineage.entries.length, 1, `v${version} lineage query`);
  } finally { await rm(migrationDir, { recursive: true, force: true }); }
}

// A v1 migration must commit its exact v2 shape before v2->v3 begins. A
// deliberately broken sync relation forces the second migration to roll back;
// the v2 metadata and columns must remain, and a repaired relation must retry.
const v1RollbackDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-migration-v1-rollback-"));
try {
  seedLegacyDatabase(v1RollbackDir, 1);
  const brokenV1 = new DatabaseSync(canonicalSqlitePath(v1RollbackDir));
  brokenV1.exec("DROP TABLE source_sync_states");
  brokenV1.exec("CREATE VIEW source_sync_states AS SELECT 1 AS unusable");
  brokenV1.close();
  assert.throws(() => openCanonicalDatabase(v1RollbackDir), /source_sync_states/);
  const afterV1Failure = new DatabaseSync(canonicalSqlitePath(v1RollbackDir));
  try {
    assert.equal(Number(afterV1Failure.prepare("PRAGMA user_version").get()?.user_version), 2);
    assert.equal(afterV1Failure.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get()?.["1"], 1);
    const v2CaptureColumns = afterV1Failure.prepare("PRAGMA table_info(source_captures)").all() as Array<{ name?: string }>;
    assert.equal(v2CaptureColumns.some((column) => column.name === "completeness_basis"), false);
    afterV1Failure.exec("DROP VIEW source_sync_states");
    restoreLegacySyncState(afterV1Failure);
  } finally { afterV1Failure.close(); }
  const retriedV1 = openCanonicalDatabase(v1RollbackDir);
  try {
    assert.equal(Number(retriedV1.prepare("PRAGMA user_version").get()?.user_version), CANONICAL_SCHEMA_VERSION);
    assert.equal(retriedV1.prepare("SELECT COUNT(*) AS count FROM transaction_revisions").get()?.count, 1);
  } finally { retriedV1.close(); }
} finally { await rm(v1RollbackDir, { recursive: true, force: true }); }

// The same atomicity guarantee applies when starting from an already committed
// v2 database: a failed v2->v3 attempt leaves v2 intact and retryable.
const v2RollbackDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-migration-v2-rollback-"));
try {
  seedLegacyDatabase(v2RollbackDir, 2);
  const brokenV2 = new DatabaseSync(canonicalSqlitePath(v2RollbackDir));
  brokenV2.exec("DROP TABLE source_sync_states");
  brokenV2.close();
  assert.throws(() => openCanonicalDatabase(v2RollbackDir), /source_sync_states/);
  const afterV2Failure = new DatabaseSync(canonicalSqlitePath(v2RollbackDir));
  try {
    assert.equal(Number(afterV2Failure.prepare("PRAGMA user_version").get()?.user_version), 2);
    assert.equal(afterV2Failure.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get()?.["1"], 1);
    const v2CaptureColumns = afterV2Failure.prepare("PRAGMA table_info(source_captures)").all() as Array<{ name?: string }>;
    assert.equal(v2CaptureColumns.some((column) => column.name === "completeness_basis"), false);
    restoreLegacySyncState(afterV2Failure);
  } finally { afterV2Failure.close(); }
  const retriedV2 = openCanonicalDatabase(v2RollbackDir);
  try {
    assert.equal(Number(retriedV2.prepare("PRAGMA user_version").get()?.user_version), CANONICAL_SCHEMA_VERSION);
    assert.equal(retriedV2.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 1);
  } finally { retriedV2.close(); }
} finally { await rm(v2RollbackDir, { recursive: true, force: true }); }

const v3MigrationDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-migration-v3-"));
try {
  await commitCathayDomesticDeposit(v3MigrationDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const v3Seed = new DatabaseSync(canonicalSqlitePath(v3MigrationDir));
  v3Seed.exec("DROP VIEW assertion_lifecycle_events; DROP TABLE source_record_scopes; DROP TABLE capture_scope_pages; DROP TABLE capture_scopes;");
  v3Seed.exec("DELETE FROM schema_migrations WHERE version IN (4, 5); PRAGMA user_version = 3;");
  v3Seed.close();
  const migratedV3 = openCanonicalDatabase(v3MigrationDir);
  try {
    assert.equal(Number(migratedV3.prepare("PRAGMA user_version").get()?.user_version), CANONICAL_SCHEMA_VERSION);
    assert.equal(migratedV3.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 3);
    assert.equal(migratedV3.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 3);
    assert.equal(migratedV3.prepare("SELECT 1 FROM sqlite_master WHERE name = 'capture_scopes'").get()?.["1"], 1);
  } finally { migratedV3.close(); }
  const v3RollbackDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-migration-v3-rollback-"));
  try {
    await commitCathayDomesticDeposit(v3RollbackDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    const downgrade = new DatabaseSync(canonicalSqlitePath(v3RollbackDir));
    downgrade.exec("DROP VIEW assertion_lifecycle_events; DROP TABLE source_record_scopes; DROP TABLE capture_scope_pages; DROP TABLE capture_scopes; DELETE FROM schema_migrations WHERE version IN (4, 5); PRAGMA user_version = 3; CREATE VIEW capture_scopes AS SELECT 1 AS unusable;");
    downgrade.close();
    assert.throws(() => openCanonicalDatabase(v3RollbackDir), /capture_scopes|views may not be indexed/);
    const afterFailure = new DatabaseSync(canonicalSqlitePath(v3RollbackDir));
    try {
      assert.equal(Number(afterFailure.prepare("PRAGMA user_version").get()?.user_version), 3);
      assert.equal(afterFailure.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get(), undefined);
      afterFailure.exec("DROP VIEW capture_scopes");
    } finally { afterFailure.close(); }
    const retried = openCanonicalDatabase(v3RollbackDir);
    try { assert.equal(Number(retried.prepare("PRAGMA user_version").get()?.user_version), CANONICAL_SCHEMA_VERSION); } finally { retried.close(); }
  } finally { await rm(v3RollbackDir, { recursive: true, force: true }); }
} finally { await rm(v3MigrationDir, { recursive: true, force: true }); }

const populatedV5MigrationDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-migration-populated-v5-"));
try {
  await commitCathayDomesticDeposit(populatedV5MigrationDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const downgrade = new DatabaseSync(canonicalSqlitePath(populatedV5MigrationDir));
  downgrade.exec("DROP TABLE current_transaction_fields; DROP VIEW user_assertion_provenance; DROP VIEW user_assertion_lifecycle_events; DROP TABLE user_assertions; DROP VIEW derived_assertion_lifecycle_events; DROP VIEW derived_assertion_provenance; DROP TABLE derived_assertions; DROP TABLE derived_scope_coordinates; DROP TABLE derived_import_runs; DELETE FROM schema_migrations WHERE version = 6; PRAGMA user_version = 5;");
  downgrade.close();
  assert.throws(() => openCanonicalDatabase(populatedV5MigrationDir, { injectMigrationFailure: "v5-v6-after-derived-schema" }), /Injected v5-v6 migration failure/);
  const failedPopulatedV5 = new DatabaseSync(canonicalSqlitePath(populatedV5MigrationDir));
  try {
    assert.equal(Number(failedPopulatedV5.prepare("PRAGMA user_version").get()?.user_version), 5);
    assert.equal(failedPopulatedV5.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 3);
    assert.equal(failedPopulatedV5.prepare("SELECT COUNT(*) AS count FROM current_transactions").get()?.count, 3);
    assert.equal(failedPopulatedV5.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_canonical_commits_sequence'").get()?.["1"], 1);
  } finally { failedPopulatedV5.close(); }
  const retriedPopulatedV5 = openCanonicalDatabase(populatedV5MigrationDir);
  try {
    assert.equal(Number(retriedPopulatedV5.prepare("PRAGMA user_version").get()?.user_version), CANONICAL_SCHEMA_VERSION);
    assert.equal(retriedPopulatedV5.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 3);
    assert.equal(retriedPopulatedV5.prepare("SELECT COUNT(*) AS count FROM assertions WHERE origin = 'source'").get()?.count, 3);
  } finally { retriedPopulatedV5.close(); }
} finally { await rm(populatedV5MigrationDir, { recursive: true, force: true }); }

const corruptDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-corrupt-"));
try {
  await commitCathayDomesticDeposit(corruptDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const corruptDb = new DatabaseSync(canonicalSqlitePath(corruptDir));
  corruptDb.exec("PRAGMA foreign_keys = OFF");
  corruptDb.prepare("UPDATE current_transactions SET commit_id = ?").run(Buffer.alloc(16, 7));
  corruptDb.close();
  assert.throws(() => openCanonicalDatabase(corruptDir, { readOnly: true }), /foreign-key integrity/);
} finally { await rm(corruptDir, { recursive: true, force: true }); }

const malformedV5Dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-malformed-v5-"));
try {
  await commitCathayDomesticDeposit(malformedV5Dir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const malformedV5 = new DatabaseSync(canonicalSqlitePath(malformedV5Dir));
  malformedV5.exec("DROP INDEX idx_source_record_scopes_scope_sequence");
  malformedV5.close();
  assert.throws(() => openCanonicalDatabase(malformedV5Dir, { readOnly: true }), /schema v6 index idx_source_record_scopes_scope_sequence is missing/);
} finally { await rm(malformedV5Dir, { recursive: true, force: true }); }

const malformedV6SpineDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-malformed-v6-spine-"));
try {
  await commitCathayDomesticDeposit(malformedV6SpineDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const malformedV6Spine = new DatabaseSync(canonicalSqlitePath(malformedV6SpineDir));
  malformedV6Spine.exec("DROP INDEX idx_assertions_lineage");
  malformedV6Spine.close();
  assert.throws(() => openCanonicalDatabase(malformedV6SpineDir, { readOnly: true }), /schema v6 index idx_assertions_lineage is missing/);
} finally { await rm(malformedV6SpineDir, { recursive: true, force: true }); }

for (const [label, capture] of [
  ["wrong currency", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, currency: "USD" }],
  ["legacy return code", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"returnCode":"0000"', '"returnCode":"000"') }],
  ["count mismatch", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"count":3', '"count":2') }],
  ["query failure", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"queryStatus":"Success"', '"queryStatus":"Failed"') }],
  ["duplicate sequence", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"sequenceNumber":2', '"sequenceNumber":1') }],
  ["missing sequence", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"sequenceNumber":1,', '') }],
  ["ambiguous direction", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"incomeAmt":null', '"incomeAmt":100') }],
  ["missing date", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"accountDate":"2026-07-01"', '"accountDate":null') }],
  ["invalid local date time", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"txnDateTime":"2026-07-01T09:00:00"', '"txnDateTime":"2026-02-30T09:00:00"') }],
  ["scope mismatch", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, scope: { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope, endDate: "2026-08-16" } }],
  ["invalid authority", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, authorityRoute: "cathay/domestic-deposit/other" }],
  ["non-exact amount", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"incomeAmt":12500', '"incomeAmt":1.25e4') }],
  ["unsupported posting fields", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"description":"Synthetic Cathay deposit description"', '"status":"pending","description":"Synthetic Cathay deposit description"') }],
  ["invalid description type", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"description":"Synthetic Cathay deposit description"', '"description":123') }],
  ["oversized description", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"description":"Synthetic Cathay deposit description"', `"description":"${"x".repeat(513)}"`) }],
  ["timezone-less observedAt", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, observedAt: "2026-08-17T12:00:00" }],
  ["unsafe timestamp microseconds", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, observedAt: "3000-08-17T12:00:00Z" }],
] as const) {
  const rejectedDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-reject-"));
  try {
    assert.throws(() => commitCathayDomesticDeposit(rejectedDir, capture), /./, label);
    const rejectedDb = openCanonicalDatabase(rejectedDir);
    try {
      assert.equal(rejectedDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 0, label);
      assert.equal(rejectedDb.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 0, label);
    } finally {
      rejectedDb.close();
    }
  } finally {
    await rm(rejectedDir, { recursive: true, force: true });
  }
}
