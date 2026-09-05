import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";

export function ensureFubonCreditCardSchema(db: DatabaseSync): void {
  if (isValidatedCanonicalDatabase(db)) {
    try {
      validateFubonCreditCardSchema(db);
    } catch {
      runCanonicalSchemaRepair(db, "canonical/fubon-credit-card-extension/v1");
      validateFubonCreditCardSchema(db);
    }
    return;
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS fubon_credit_instrument_details (
  instrument_id BLOB PRIMARY KEY CHECK(length(instrument_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  instrument_key TEXT NOT NULL,
  card_mask TEXT CHECK(
    card_mask IS NULL OR
    (length(card_mask) = 8 AND substr(card_mask, 1, 4) = '****' AND
      substr(card_mask, 5) GLOB '[0-9][0-9][0-9][0-9]')
  ),
  role TEXT NOT NULL CHECK(role IN ('primary','supplementary','virtual','replacement')),
  lifecycle TEXT,
  UNIQUE(account_id, instrument_key)
);
CREATE TABLE IF NOT EXISTS fubon_credit_account_identity_details (
  account_id BLOB PRIMARY KEY REFERENCES financial_accounts(account_id),
  identity_method TEXT NOT NULL CHECK(identity_method IN ('human-attested','pan-hmac')),
  pan_fingerprint TEXT,
  pan_last4 TEXT CHECK(pan_last4 IS NULL OR pan_last4 GLOB '[0-9][0-9][0-9][0-9]'),
  pan_fingerprint_key_version TEXT,
  CHECK(
    (identity_method = 'pan-hmac' AND pan_fingerprint IS NOT NULL AND pan_last4 IS NOT NULL AND pan_fingerprint_key_version IS NOT NULL)
    OR
    (identity_method = 'human-attested' AND pan_fingerprint IS NULL AND pan_last4 IS NULL AND pan_fingerprint_key_version IS NULL)
  )
);
CREATE TABLE IF NOT EXISTS fubon_credit_instrument_role_evidence (
  instrument_id BLOB NOT NULL REFERENCES fubon_credit_instrument_details(instrument_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(instrument_id, capture_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS fubon_credit_transaction_details (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  instrument_id BLOB NOT NULL REFERENCES fubon_credit_instrument_details(instrument_id),
  billing_status TEXT NOT NULL CHECK(billing_status IN ('billed','unbilled')),
  statement_key TEXT,
  PRIMARY KEY(revision_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS fubon_credit_statement_details (
  statement_id BLOB PRIMARY KEY CHECK(length(statement_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  statement_key TEXT NOT NULL,
  UNIQUE(account_id, statement_key)
);
CREATE TABLE IF NOT EXISTS fubon_credit_statement_revision_details (
  statement_revision_id BLOB PRIMARY KEY CHECK(length(statement_revision_id) = 16),
  statement_id BLOB NOT NULL REFERENCES fubon_credit_statement_details(statement_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  revision_key TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  cycle_start TEXT NOT NULL, cycle_end TEXT NOT NULL,
  issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
  currency TEXT NOT NULL, balance_coefficient TEXT NOT NULL,
  balance_scale INTEGER NOT NULL, minimum_coefficient TEXT, minimum_scale INTEGER,
  evidence_source_record_key TEXT NOT NULL,
  UNIQUE(statement_id, revision_key)
);
CREATE TABLE IF NOT EXISTS fubon_credit_statement_membership_details (
  statement_revision_id BLOB NOT NULL REFERENCES fubon_credit_statement_revision_details(statement_revision_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  transaction_revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(statement_revision_id, transaction_id)
);
CREATE TABLE IF NOT EXISTS fubon_credit_statement_summary_evidence (
  statement_revision_id BLOB NOT NULL REFERENCES fubon_credit_statement_revision_details(statement_revision_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  evidence_key TEXT NOT NULL,
  evidence_source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(statement_revision_id, capture_id),
  UNIQUE(account_id, capture_id, evidence_key)
);
CREATE TABLE IF NOT EXISTS fubon_credit_relation_details (
  relation_id BLOB PRIMARY KEY CHECK(length(relation_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  relation_kind TEXT NOT NULL,
  from_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  to_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  evidence_source_record_key TEXT NOT NULL,
  UNIQUE(account_id, relation_kind, from_transaction_id, to_transaction_id)
);
  `);

  const instrumentColumns = db.prepare(
    "PRAGMA table_info(fubon_credit_instrument_details)",
  ).all() as Array<{ name?: string }>;
  if (!instrumentColumns.some((column) => column.name === "card_mask")) {
    db.exec(
      "ALTER TABLE fubon_credit_instrument_details ADD COLUMN card_mask TEXT",
    );
  }

  // Databases created before statement Source Record lineage was added have
  // valid summary rows but no evidence_source_record_id.  Keep those rows
  // intact and leave the new lineage column nullable for the legacy rows; the
  // replacement trigger below rejects any new row without a real Source
  // Record, so the compatibility exception cannot be used for new writes.
  const summaryColumns = db.prepare(
    "PRAGMA table_info(fubon_credit_statement_summary_evidence)",
  ).all() as Array<{ name?: string }>;
  if (!summaryColumns.some((column) => column.name === "evidence_source_record_id")) {
    db.exec(
      "ALTER TABLE fubon_credit_statement_summary_evidence " +
      "ADD COLUMN evidence_source_record_id BLOB REFERENCES source_records(source_record_id)",
    );
  }

  // CREATE TRIGGER IF NOT EXISTS would preserve the pre-lineage trigger on a
  // reused database. Drop and recreate both guards so upgrades are idempotent
  // and always enforce the current scope contract.
  db.exec(`
DROP TRIGGER IF EXISTS fubon_credit_role_evidence_scope_guard;
DROP TRIGGER IF EXISTS fubon_credit_summary_evidence_scope_guard;
CREATE TRIGGER fubon_credit_role_evidence_scope_guard
BEFORE INSERT ON fubon_credit_instrument_role_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM source_record_scopes scoped
  JOIN source_records source_record
    ON source_record.source_record_id = scoped.source_record_id
  JOIN fubon_credit_instrument_details instrument
    ON instrument.instrument_id = NEW.instrument_id
  WHERE scoped.source_record_id = NEW.source_record_id
    AND scoped.capture_id = NEW.capture_id
    AND scoped.account_id = NEW.account_id
    AND instrument.account_id = NEW.account_id
    AND json_extract(source_record.payload_json, '$.instrumentKey') = instrument.instrument_key
    AND (
      (instrument.card_mask IS NULL AND
        json_extract(source_record.payload_json, '$.cardMask') IS NULL)
      OR
      (instrument.card_mask IS NOT NULL AND
        json_extract(source_record.payload_json, '$.cardMask') = instrument.card_mask)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Fubon instrument role evidence crosses capture, account, or instrument scope (or has an inconsistent card mask)');
END;
CREATE TRIGGER fubon_credit_summary_evidence_scope_guard
BEFORE INSERT ON fubon_credit_statement_summary_evidence
WHEN NEW.evidence_source_record_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM capture_scopes scoped
  JOIN fubon_credit_statement_revision_details revision
    ON revision.statement_revision_id = NEW.statement_revision_id
  JOIN fubon_credit_statement_details statement
    ON statement.statement_id = revision.statement_id
  JOIN source_record_scopes evidence_scope
    ON evidence_scope.source_record_id = NEW.evidence_source_record_id
  JOIN source_records evidence_record
    ON evidence_record.source_record_id = evidence_scope.source_record_id
  JOIN source_subjects evidence_subject
    ON evidence_subject.source_subject_id = evidence_record.source_subject_id
  WHERE scoped.capture_id = NEW.capture_id
    AND scoped.account_id = NEW.account_id
    AND statement.account_id = NEW.account_id
    AND evidence_scope.capture_id = NEW.capture_id
    AND evidence_scope.account_id = NEW.account_id
    AND evidence_record.record_kind = 'fubon-credit-card-statement-summary'
    AND evidence_record.occurrence_key = NEW.evidence_key
    AND evidence_subject.source_connection_id = scoped.source_connection_id
    AND evidence_subject.identity_epoch_id = scoped.identity_epoch_id
    AND json_extract(evidence_record.payload_json, '$.statementKey') = statement.statement_key
)
BEGIN
  SELECT RAISE(ABORT, 'Fubon statement summary evidence crosses capture or account scope');
END;
  `);
}

export function validateFubonCreditCardSchema(db: DatabaseSync): void {
  const requiredColumns: Record<string, readonly string[]> = {
    fubon_credit_instrument_details: [
      "instrument_id",
      "account_id",
      "instrument_key",
      "card_mask",
      "role",
      "lifecycle",
    ],
    fubon_credit_account_identity_details: [
      "account_id",
      "identity_method",
      "pan_fingerprint",
      "pan_last4",
      "pan_fingerprint_key_version",
    ],
    fubon_credit_instrument_role_evidence: [
      "instrument_id",
      "account_id",
      "capture_id",
      "source_record_id",
    ],
    fubon_credit_transaction_details: [
      "transaction_id",
      "revision_id",
      "source_record_id",
      "capture_id",
      "instrument_id",
      "billing_status",
      "statement_key",
    ],
    fubon_credit_statement_details: [
      "statement_id",
      "account_id",
      "statement_key",
    ],
    fubon_credit_statement_revision_details: [
      "statement_revision_id",
      "statement_id",
      "capture_id",
      "revision_key",
      "revision_number",
      "cycle_start",
      "cycle_end",
      "issue_date",
      "due_date",
      "currency",
      "balance_coefficient",
      "balance_scale",
      "minimum_coefficient",
      "minimum_scale",
      "evidence_source_record_key",
    ],
    fubon_credit_statement_membership_details: [
      "statement_revision_id",
      "transaction_id",
      "transaction_revision_id",
      "source_record_id",
    ],
    fubon_credit_statement_summary_evidence: [
      "statement_revision_id",
      "account_id",
      "capture_id",
      "evidence_key",
      "evidence_source_record_id",
    ],
    fubon_credit_relation_details: [
      "relation_id",
      "account_id",
      "relation_kind",
      "from_transaction_id",
      "to_transaction_id",
      "evidence_source_record_key",
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table)
    )
      throw new Error(`Fubon credit-card table ${table} is missing.`);
    const actual = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).map(
        (column) => column.name,
      ),
    );
    for (const column of columns)
      if (!actual.has(column))
        throw new Error(`Fubon credit-card column ${table}.${column} is missing.`);
  }
  for (const trigger of [
    "fubon_credit_role_evidence_scope_guard",
    "fubon_credit_summary_evidence_scope_guard",
  ])
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(trigger)
    )
      throw new Error(`Fubon credit-card trigger ${trigger} is missing.`);
}
