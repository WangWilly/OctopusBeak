import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ensureCanonicalCreditCardSchema,
  persistCanonicalCreditCardExtensions,
  persistCanonicalCreditCardExtensionsForIsolatedSetup,
  type CanonicalCreditCardPersistenceCapture,
} from "./canonical-credit-card-persistence.ts";

const blob = (value: number): Buffer => Buffer.alloc(16, value);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE source_connections(
      source_connection_id BLOB PRIMARY KEY,
      integration_namespace TEXT NOT NULL
    );
    CREATE TABLE financial_accounts(
      account_id BLOB PRIMARY KEY,
      source_connection_id BLOB NOT NULL,
      identity_epoch_id BLOB NOT NULL,
      account_type TEXT NOT NULL
    );
    CREATE TABLE source_captures(
      capture_id BLOB PRIMARY KEY,
      capture_key TEXT UNIQUE,
      source_connection_id BLOB NOT NULL,
      source_subject_id BLOB NOT NULL,
      commit_id BLOB NOT NULL
    );
    CREATE TABLE capture_scopes(
      scope_id BLOB PRIMARY KEY,
      capture_id BLOB NOT NULL,
      source_connection_id BLOB NOT NULL,
      identity_epoch_id BLOB NOT NULL,
      account_id BLOB NOT NULL
    );
    CREATE TABLE source_records(
      source_record_id BLOB PRIMARY KEY,
      capture_id BLOB NOT NULL,
      source_subject_id BLOB NOT NULL,
      commit_id BLOB NOT NULL,
      record_kind TEXT NOT NULL,
      sequence_lexeme TEXT NOT NULL,
      provider_key TEXT,
      content_hash TEXT,
      occurrence_key TEXT NOT NULL,
      collision_key TEXT,
      description TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE source_record_scopes(
      source_record_id BLOB NOT NULL,
      scope_id BLOB NOT NULL,
      capture_id BLOB NOT NULL,
      account_id BLOB NOT NULL,
      source_subject_id BLOB NOT NULL,
      sequence_lexeme TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      commit_id BLOB NOT NULL
    );
    CREATE TABLE financial_transactions(
      transaction_id BLOB PRIMARY KEY,
      account_id BLOB NOT NULL,
      source_sequence TEXT NOT NULL
    );
    CREATE TABLE transaction_revisions(
      revision_id BLOB PRIMARY KEY,
      transaction_id BLOB NOT NULL,
      source_record_id BLOB NOT NULL,
      revision_number INTEGER NOT NULL DEFAULT 1
    );
  `);
  db.prepare("INSERT INTO source_connections VALUES (?, ?)").run(blob(1), "esun");
  db.prepare("INSERT INTO financial_accounts VALUES (?, ?, ?, ?)").run(
    blob(2), blob(1), blob(3), "credit",
  );
  ensureCanonicalCreditCardSchema(db);
  return db;
}

type SharedRow = { occurrence: string; sourceKey: string };

function addSharedCapture(
  db: DatabaseSync,
  ordinal: number,
  captureKey: string,
  rows: readonly SharedRow[],
  withRevisions = true,
): void {
  const captureId = blob(10 + ordinal);
  db.prepare("INSERT INTO source_captures VALUES (?, ?, ?, ?, ?)").run(
    captureId, captureKey, blob(1), blob(4), blob(5),
  );
  db.prepare("INSERT INTO capture_scopes VALUES (?, ?, ?, ?, ?)").run(
    blob(20 + ordinal), captureId, blob(1), blob(3), blob(2),
  );
  rows.forEach((row, index) => {
    const sourceRecordId = blob(30 + ordinal * 10 + index);
    const transactionId = blob(60 + index);
    const revisionId = blob(90 + ordinal * 10 + index);
    db.prepare(`INSERT INTO source_records VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`).run(
      sourceRecordId, captureId, blob(4), blob(5), "esun-credit-card-transaction",
      row.occurrence, null, `sha256:${row.occurrence}`, row.occurrence,
      row.occurrence, null, "{}",
    );
    db.prepare("INSERT INTO source_record_scopes VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      sourceRecordId, blob(20 + ordinal), captureId, blob(2), blob(4),
      row.occurrence, row.occurrence, blob(5),
    );
    db.prepare("INSERT OR IGNORE INTO financial_transactions VALUES (?, ?, ?)").run(
      transactionId, blob(2), row.sourceKey,
    );
    if (withRevisions)
      db.prepare("INSERT INTO transaction_revisions(revision_id, transaction_id, source_record_id) VALUES (?, ?, ?)").run(
        revisionId, transactionId, sourceRecordId,
      );
  });
  const suffix = captureKey.slice(captureKey.lastIndexOf("-") + 1);
  const statementRecordId = blob(55 + ordinal);
  db.prepare(`INSERT INTO source_records VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )`).run(
    statementRecordId, captureId, blob(4), blob(5),
    "esun-credit-card-statement-summary", `statement-summary:statement-1`,
    "human-attested:no-provider-key", `sha256:summary-${suffix}`,
    `summary-${suffix}`, `summary-${suffix}`, null, "{}",
  );
  db.prepare("INSERT INTO source_record_scopes VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    statementRecordId, blob(20 + ordinal), captureId, blob(2), blob(4),
    `statement-summary:statement-1`, `summary-${suffix}`, blob(5),
  );
}

function capture(
  captureId: string,
  suffix = "a",
): CanonicalCreditCardPersistenceCapture {
  const first = `row-${suffix}-1`;
  const second = `row-${suffix}-2`;
  return {
    integrationNamespace: "esun",
    captureId,
    identity: {
      accountNaturalKey: "sha256:opaque-account-key",
      identityMethod: "human-attested",
    },
    instruments: [{
      instrumentKey: "opaque-instrument-key",
      cardMask: "****1234",
      role: "primary",
      lifecycle: "active",
      evidence: { sourceRecordKey: first },
    }],
    transactions: [
      {
        sourceRecordKey: first,
        sourceKey: "source-1",
        instrumentKey: "opaque-instrument-key",
        billingStatus: "billed",
        statementKey: "statement-1",
      },
      {
        sourceRecordKey: second,
        sourceKey: "source-2",
        instrumentKey: "opaque-instrument-key",
        billingStatus: "billed",
        statementKey: "statement-1",
      },
    ],
    statements: [{
      statementKey: "statement-1",
      revisionKey: `revision-${suffix}`,
      cycleStart: "2026-07-01",
      cycleEnd: "2026-07-31",
      issueDate: "2026-08-01",
      dueDate: "2026-08-20",
      currency: "TWD",
      balance: { coefficient: "3000", scale: 2 },
      minimumPayment: { coefficient: "300", scale: 2 },
      transactionSourceKeys: [first, second],
      evidence: { sourceRecordKey: `summary-${suffix}`, settled: true },
    }],
    relations: [{
      kind: "refund_of",
      fromSourceRecordKey: second,
      toSourceRecordKey: first,
      evidence: { sourceRecordKey: second },
    }],
  };
}

const count = (db: DatabaseSync, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

test("persists neutral credit-card authority and shared-ID provenance", () => {
  const db = database();
  addSharedCapture(db, 0, "capture-a", [
    { occurrence: "row-a-1", sourceKey: "source-1" },
    { occurrence: "row-a-2", sourceKey: "source-2" },
  ]);
  persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [capture("capture-a")]);

  assert.equal(count(db, "canonical_credit_card_account_identities"), 1);
  assert.equal(count(db, "canonical_credit_card_instruments"), 1);
  assert.equal(count(db, "canonical_credit_card_transaction_details"), 2);
  assert.equal(count(db, "canonical_credit_card_statement_revisions"), 1);
  assert.equal(count(db, "canonical_credit_card_statement_memberships"), 2);
  assert.equal(count(db, "canonical_credit_card_statement_summary_evidence"), 1);
  assert.equal(count(db, "canonical_credit_card_relations"), 1);
  const linked = db.prepare(`SELECT COUNT(*) AS n
    FROM canonical_credit_card_transaction_details detail
    JOIN financial_transactions tx ON tx.transaction_id = detail.transaction_id
    JOIN transaction_revisions revision ON revision.revision_id = detail.revision_id
    JOIN source_records record ON record.source_record_id = detail.source_record_id`).get() as { n: number };
  assert.equal(linked.n, 2);
  assert.equal(
    (db.prepare("SELECT opaque_identity_key AS value FROM canonical_credit_card_account_identities").get() as { value: string }).value,
    "sha256:opaque-account-key",
  );
  db.close();
});

test("repeated capture adds provenance without rewriting authority", () => {
  const db = database();
  addSharedCapture(db, 0, "capture-a", [
    { occurrence: "row-a-1", sourceKey: "source-1" },
    { occurrence: "row-a-2", sourceKey: "source-2" },
  ]);
  persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [capture("capture-a")]);
  addSharedCapture(db, 1, "capture-b", [
    { occurrence: "row-b-1", sourceKey: "source-1" },
    { occurrence: "row-b-2", sourceKey: "source-2" },
  ]);
  const repeated = capture("capture-b", "b");
  repeated.statements = [];
  repeated.relations = [];
  persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [repeated]);
  assert.equal(count(db, "canonical_credit_card_instruments"), 1);
  assert.equal(count(db, "canonical_credit_card_instrument_evidence"), 2);
  assert.equal(count(db, "canonical_credit_card_transaction_details"), 4);
  db.close();
});

test("replaying the same capture is idempotent for lifecycle evidence", () => {
  const db = database();
  addSharedCapture(db, 0, "capture-a", [
    { occurrence: "row-a-1", sourceKey: "source-1" },
    { occurrence: "row-a-2", sourceKey: "source-2" },
  ]);
  const replayed = capture("capture-a");
  persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [replayed]);
  persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [replayed]);

  assert.equal(count(db, "canonical_credit_card_transaction_lifecycle"), 2);
  assert.equal(count(db, "canonical_credit_card_transaction_details"), 2);
  assert.equal(count(db, "canonical_credit_card_statement_summary_evidence"), 1);
  assert.equal(count(db, "canonical_credit_card_relations"), 1);

  const conflicting = structuredClone(replayed);
  conflicting.transactions = conflicting.transactions.map((transaction, index) =>
    index === 0
      ? { ...transaction, billingStatus: "unbilled", statementKey: undefined }
      : transaction,
  );
  assert.throws(
    () => persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [conflicting]),
    /lifecycle observation key.*changed evidence/i,
  );
  assert.equal(count(db, "canonical_credit_card_transaction_lifecycle"), 2);
  db.close();
});

test("billing lifecycle appends status evidence without changing the transaction authority", () => {
  const db = database();
  addSharedCapture(db, 0, "capture-a", [
    { occurrence: "row-a-1", sourceKey: "source-1" },
    { occurrence: "row-a-2", sourceKey: "source-2" },
  ]);
  persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [capture("capture-a")]);

  addSharedCapture(db, 1, "capture-b", [
    { occurrence: "row-b-1", sourceKey: "source-1" },
    { occurrence: "row-b-2", sourceKey: "source-2" },
  ], false);
  const transitioned = capture("capture-b", "b");
  transitioned.transactions = transitioned.transactions.map((transaction, index) =>
    index === 0
      ? { ...transaction, billingStatus: "unbilled", statementKey: undefined }
      : transaction,
  );
  transitioned.statements = [];
  persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [transitioned]);

  assert.equal(count(db, "canonical_credit_card_transaction_details"), 2);
  assert.equal(count(db, "canonical_credit_card_transaction_lifecycle"), 4);
  const lifecycle = db.prepare(`
    SELECT billing_status, statement_key
    FROM canonical_credit_card_transaction_lifecycle
    WHERE transaction_id = (SELECT transaction_id FROM financial_transactions WHERE source_sequence = 'source-1')
    ORDER BY rowid
  `).all() as Array<{ billing_status?: string; statement_key?: string | null }>;
  assert.deepEqual(lifecycle.map(({ billing_status, statement_key }) => ({
    billing_status,
    statement_key,
  })), [
    { billing_status: "billed", statement_key: "statement-1" },
    { billing_status: "unbilled", statement_key: null },
  ]);
  db.close();
});

test("immutable revision reuse fails and rolls the callback savepoint back", () => {
  const db = database();
  addSharedCapture(db, 0, "capture-a", [
    { occurrence: "row-a-1", sourceKey: "source-1" },
    { occurrence: "row-a-2", sourceKey: "source-2" },
  ]);
  persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [capture("capture-a")]);
  addSharedCapture(db, 1, "capture-b", [
    { occurrence: "row-b-1", sourceKey: "source-1" },
    { occurrence: "row-b-2", sourceKey: "source-2" },
  ]);
  const beforeEvidence = count(db, "canonical_credit_card_instrument_evidence");
  const changed = structuredClone(capture("capture-b", "b"));
  changed.statements[0]!.revisionKey = "revision-a";
  changed.statements[0]!.balance.coefficient = "9999";
  assert.throws(
    () => persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [changed]),
    /revision key.*changed/i,
  );
  assert.equal(count(db, "canonical_credit_card_instrument_evidence"), beforeEvidence);
  assert.equal(count(db, "canonical_credit_card_transaction_details"), 2);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM source_records WHERE occurrence_key = 'summary-b'").get() as { n: number }).n,
    1,
  );
  assert.equal(
    (db.prepare("SELECT balance_coefficient AS value FROM canonical_credit_card_statement_revisions").get() as { value: string }).value,
    "3000",
  );
  db.close();
});

test("raw PAN is rejected before extension data can be stored", () => {
  const db = database();
  addSharedCapture(db, 0, "capture-a", [
    { occurrence: "row-a-1", sourceKey: "source-1" },
    { occurrence: "row-a-2", sourceKey: "source-2" },
  ]);
  const unsafe = capture("capture-a") as CanonicalCreditCardPersistenceCapture & { rawPan: string };
  unsafe.rawPan = "4111111111111111";
  assert.throws(
    () => persistCanonicalCreditCardExtensionsForIsolatedSetup(db, [unsafe]),
    /raw PAN/i,
  );
  assert.equal(count(db, "canonical_credit_card_account_identities"), 0);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_schema
      WHERE sql LIKE '%4111111111111111%'`).get() as { n: number }).n,
    0,
  );
  db.close();
});

test("production credit-card persistence rejects a raw DatabaseSync adapter", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    assert.throws(
      () => persistCanonicalCreditCardExtensions(raw, []),
      /canonical database capability|lifecycle/i,
    );
  } finally {
    raw.close();
  }
});
