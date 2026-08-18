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
  assert.equal(firstCommit.commitSequence, 1);
  const multiDb = openCanonicalDatabase(multiScopeDir, { readOnly: true });
  try {
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count, 1);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 1);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM capture_scopes").get()?.count, 2);
    assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM capture_scope_pages").get()?.count, 2);
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
  assert.equal((await withdrawnQuery.current({ kind: "current" })).transactions.length, 0);
  const historicalWithdrawn = await withdrawnQuery.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(withdrawn.commitSequence) } });
  assert.equal(historicalWithdrawn.transactions.length, 3);
  assert.equal(historicalWithdrawn.transactions[0]?.assertionSupportState, "withdrawn");
  const restored = await commitCathayDomesticDepositSync(lifecycleDir, {
    ...syncInput(),
    observedAt: "2026-08-19T00:00:00+08:00",
  });
  assert.equal((await withdrawnQuery.current({ kind: "current" })).transactions.length, 3);
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
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 4, `v${version} migration history`);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 1, `v${version} source row`);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM transaction_revisions").get()?.count, 1, `v${version} revision`);
      assert.equal(migrated.prepare("SELECT completeness_basis FROM source_captures").get()?.completeness_basis, "success-status-scope-count-details", `v${version} completeness`);
      assert.equal(migrated.prepare("SELECT cursor FROM source_sync_states").get()?.cursor, "legacy-cursor", `v${version} cursor preservation`);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM transaction_time_observations").get()?.count, 2, `v${version} time lineage`);
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
  v3Seed.exec("DROP TABLE assertion_lifecycle_events; DROP TABLE capture_scope_pages; DROP TABLE capture_scopes;");
  v3Seed.exec("DELETE FROM schema_migrations WHERE version = 4; PRAGMA user_version = 3;");
  v3Seed.close();
  const migratedV3 = openCanonicalDatabase(v3MigrationDir);
  try {
    assert.equal(Number(migratedV3.prepare("PRAGMA user_version").get()?.user_version), CANONICAL_SCHEMA_VERSION);
    assert.equal(migratedV3.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 3);
    assert.equal(migratedV3.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 1);
    assert.equal(migratedV3.prepare("SELECT 1 FROM sqlite_master WHERE name = 'capture_scopes'").get()?.["1"], 1);
  } finally { migratedV3.close(); }
  const v3RollbackDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-migration-v3-rollback-"));
  try {
    await commitCathayDomesticDeposit(v3RollbackDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    const downgrade = new DatabaseSync(canonicalSqlitePath(v3RollbackDir));
    downgrade.exec("DROP TABLE assertion_lifecycle_events; DROP TABLE capture_scope_pages; DROP TABLE capture_scopes; DELETE FROM schema_migrations WHERE version = 4; PRAGMA user_version = 3; CREATE VIEW capture_scopes AS SELECT 1 AS unusable;");
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

const corruptDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-corrupt-"));
try {
  await commitCathayDomesticDeposit(corruptDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const corruptDb = new DatabaseSync(canonicalSqlitePath(corruptDir));
  corruptDb.exec("PRAGMA foreign_keys = OFF");
  corruptDb.prepare("UPDATE current_transactions SET commit_id = ?").run(Buffer.alloc(16, 7));
  corruptDb.close();
  assert.throws(() => openCanonicalDatabase(corruptDir, { readOnly: true }), /foreign-key integrity/);
} finally { await rm(corruptDir, { recursive: true, force: true }); }

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
