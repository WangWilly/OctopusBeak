import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CanonicalCreditCardAmount = {
  coefficient: string;
  scale: number;
};

export type CanonicalCreditCardPersistenceCapture = {
  integrationNamespace: string;
  /** The shared source_captures.capture_key produced by the canonical writer. */
  captureId: string;
  identity: {
    /** Opaque/HMAC-derived account identity. Raw PANs are forbidden. */
    accountNaturalKey: string;
    identityMethod: string;
  };
  instruments: readonly {
    instrumentKey: string;
    cardMask?: string;
    role: string;
    lifecycle?: string;
    evidence: { sourceRecordKey: string };
  }[];
  transactions: readonly {
    sourceRecordKey: string;
    sourceKey: string;
    instrumentKey: string;
    billingStatus: "billed" | "unbilled";
    statementKey?: string;
  }[];
  statements: readonly {
    statementKey: string;
    revisionKey: string;
    cycleStart: string;
    cycleEnd: string;
    issueDate: string;
    dueDate: string;
    currency: string;
    balance: CanonicalCreditCardAmount;
    minimumPayment: CanonicalCreditCardAmount | null;
    transactionSourceKeys: readonly string[];
    evidence: { sourceRecordKey: string; settled: true };
  }[];
  relations?: readonly {
    kind: string;
    fromSourceRecordKey: string;
    toSourceRecordKey: string;
    evidence: { sourceRecordKey: string };
  }[];
};

type ScopeRow = {
  capture_id: Uint8Array;
  account_id: Uint8Array;
  source_subject_id: Uint8Array;
  commit_id: Uint8Array;
  scope_id: Uint8Array;
};

type SharedTransaction = {
  transactionId: Uint8Array;
  revisionId: Uint8Array;
  sourceRecordId: Uint8Array;
};

export class CanonicalCreditCardPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalCreditCardPersistenceError";
  }
}

const id = (): Buffer => randomBytes(16);

const requiredText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "")
    throw new CanonicalCreditCardPersistenceError(`${label} is required.`);
  return value;
};

function isLikelyPan(value: string): boolean {
  const digits = value.replace(/[ -]/gu, "");
  if (!/^\d{13,19}$/u.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function rejectRawPan(value: unknown, path = "capture", seen = new Set<object>()): void {
  if (typeof value === "string") {
    if (isLikelyPan(value))
      throw new CanonicalCreditCardPersistenceError(
        `Raw PAN-like value is forbidden at ${path}.`,
      );
    return;
  }
  if (!value || typeof value !== "object" || value instanceof Uint8Array || seen.has(value))
    return;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:full|raw)?pan$/iu.test(key) && nested != null)
      throw new CanonicalCreditCardPersistenceError(`Raw PAN field is forbidden at ${path}.${key}.`);
    rejectRawPan(nested, `${path}.${key}`, seen);
  }
}

export function ensureCanonicalCreditCardSchema(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS canonical_credit_card_account_identities (
  integration_namespace TEXT NOT NULL,
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  opaque_identity_key TEXT NOT NULL,
  identity_method TEXT NOT NULL,
  created_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  PRIMARY KEY(integration_namespace, account_id)
);
CREATE TABLE IF NOT EXISTS canonical_credit_card_instruments (
  instrument_id BLOB PRIMARY KEY CHECK(length(instrument_id) = 16),
  integration_namespace TEXT NOT NULL,
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  instrument_key TEXT NOT NULL,
  card_mask TEXT CHECK(card_mask IS NULL OR card_mask GLOB '****[0-9][0-9][0-9][0-9]'),
  role TEXT NOT NULL,
  lifecycle TEXT,
  UNIQUE(integration_namespace, account_id, instrument_key)
);
CREATE TABLE IF NOT EXISTS canonical_credit_card_instrument_evidence (
  instrument_id BLOB NOT NULL REFERENCES canonical_credit_card_instruments(instrument_id),
  integration_namespace TEXT NOT NULL,
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(instrument_id, capture_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS canonical_credit_card_transaction_details (
  integration_namespace TEXT NOT NULL,
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  instrument_id BLOB NOT NULL REFERENCES canonical_credit_card_instruments(instrument_id),
  billing_status TEXT NOT NULL CHECK(billing_status IN ('billed','unbilled')),
  statement_key TEXT,
  PRIMARY KEY(revision_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS canonical_credit_card_statements (
  statement_id BLOB PRIMARY KEY CHECK(length(statement_id) = 16),
  integration_namespace TEXT NOT NULL,
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  statement_key TEXT NOT NULL,
  UNIQUE(integration_namespace, account_id, statement_key)
);
CREATE TABLE IF NOT EXISTS canonical_credit_card_statement_revisions (
  statement_revision_id BLOB PRIMARY KEY CHECK(length(statement_revision_id) = 16),
  statement_id BLOB NOT NULL REFERENCES canonical_credit_card_statements(statement_id),
  revision_key TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  created_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  cycle_start TEXT NOT NULL,
  cycle_end TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance_coefficient TEXT NOT NULL,
  balance_scale INTEGER NOT NULL CHECK(balance_scale >= 0),
  minimum_coefficient TEXT,
  minimum_scale INTEGER CHECK(minimum_scale IS NULL OR minimum_scale >= 0),
  evidence_source_record_key TEXT NOT NULL,
  UNIQUE(statement_id, revision_key)
);
CREATE TABLE IF NOT EXISTS canonical_credit_card_statement_memberships (
  statement_revision_id BLOB NOT NULL REFERENCES canonical_credit_card_statement_revisions(statement_revision_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  transaction_revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(statement_revision_id, transaction_id)
);
CREATE TABLE IF NOT EXISTS canonical_credit_card_statement_summary_evidence (
  statement_revision_id BLOB NOT NULL REFERENCES canonical_credit_card_statement_revisions(statement_revision_id),
  integration_namespace TEXT NOT NULL,
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  evidence_key TEXT NOT NULL,
  evidence_source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(statement_revision_id, capture_id, evidence_source_record_id)
);
CREATE TABLE IF NOT EXISTS canonical_credit_card_relations (
  relation_id BLOB PRIMARY KEY CHECK(length(relation_id) = 16),
  integration_namespace TEXT NOT NULL,
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  relation_kind TEXT NOT NULL,
  from_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  to_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  evidence_source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  UNIQUE(integration_namespace, account_id, relation_kind, from_transaction_id,
         to_transaction_id, capture_id, evidence_source_record_id)
);
  `);
}

function captureScope(
  db: DatabaseSync,
  capture: CanonicalCreditCardPersistenceCapture,
): ScopeRow {
  const row = db.prepare(`
    SELECT scoped.capture_id, scoped.account_id, capture.source_subject_id,
           capture.commit_id, scoped.scope_id
    FROM capture_scopes scoped
    JOIN source_captures capture ON capture.capture_id = scoped.capture_id
    JOIN source_connections connection
      ON connection.source_connection_id = scoped.source_connection_id
    JOIN financial_accounts account ON account.account_id = scoped.account_id
    WHERE capture.capture_key = ?
      AND connection.integration_namespace = ?
      AND account.source_connection_id = scoped.source_connection_id
      AND account.identity_epoch_id = scoped.identity_epoch_id
      AND account.account_type = 'credit'
  `).get(capture.captureId, capture.integrationNamespace) as ScopeRow | undefined;
  if (!row?.capture_id || !row.account_id || !row.source_subject_id ||
      !row.commit_id || !row.scope_id)
    throw new CanonicalCreditCardPersistenceError(
      "Shared canonical credit-card capture is missing or crosses integration/account scope.",
    );
  return row;
}

function statementEvidenceRecord(
  db: DatabaseSync,
  scope: ScopeRow,
  namespace: string,
  statement: CanonicalCreditCardPersistenceCapture["statements"][number],
): Uint8Array {
  try {
    return sourceRecord(db, scope, statement.evidence.sourceRecordKey);
  } catch (error) {
    if (!(error instanceof CanonicalCreditCardPersistenceError)) throw error;
  }
  const sourceRecordId = id();
  const payload = JSON.stringify({
    statementKey: statement.statementKey,
    revisionKey: statement.revisionKey,
    cycleStart: statement.cycleStart,
    cycleEnd: statement.cycleEnd,
    issueDate: statement.issueDate,
    dueDate: statement.dueDate,
    currency: statement.currency,
    balance: statement.balance,
    minimumPayment: statement.minimumPayment,
  });
  const sequence = `statement-summary:${statement.statementKey}`;
  db.prepare(`INSERT INTO source_records(
    source_record_id, capture_id, source_subject_id, commit_id, record_kind,
    sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key,
    description, payload_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sourceRecordId, scope.capture_id, scope.source_subject_id, scope.commit_id,
    `${namespace}-credit-card-statement-summary`, sequence,
    "human-attested:no-provider-key",
    `sha256:${createHash("sha256").update(payload).digest("hex")}`,
    statement.evidence.sourceRecordKey, statement.evidence.sourceRecordKey, null, payload,
  );
  db.prepare(`INSERT INTO source_record_scopes(
    source_record_id, scope_id, capture_id, account_id, source_subject_id,
    sequence_lexeme, occurrence_key, commit_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sourceRecordId, scope.scope_id, scope.capture_id, scope.account_id,
    scope.source_subject_id, sequence, statement.evidence.sourceRecordKey, scope.commit_id,
  );
  return sourceRecordId;
}

function sourceRecord(
  db: DatabaseSync,
  scope: ScopeRow,
  sourceRecordKey: string,
): Uint8Array {
  const row = db.prepare(`
    SELECT record.source_record_id
    FROM source_records record
    JOIN source_record_scopes scoped ON scoped.source_record_id = record.source_record_id
    WHERE record.capture_id = ? AND scoped.capture_id = ? AND scoped.account_id = ?
      AND record.occurrence_key = ?
  `).get(scope.capture_id, scope.capture_id, scope.account_id, sourceRecordKey) as
    | { source_record_id?: Uint8Array }
    | undefined;
  if (!row?.source_record_id)
    throw new CanonicalCreditCardPersistenceError(
      `Shared source record is missing in capture/account scope: ${sourceRecordKey}`,
    );
  return row.source_record_id;
}

function sameBlob(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function persistCapture(
  db: DatabaseSync,
  capture: CanonicalCreditCardPersistenceCapture,
): void {
  rejectRawPan(capture);
  const namespace = requiredText(capture.integrationNamespace, "integrationNamespace");
  const scope = captureScope(db, capture);
  const identityKey = requiredText(capture.identity.accountNaturalKey, "identity.accountNaturalKey");
  const identityMethod = requiredText(capture.identity.identityMethod, "identity.identityMethod");
  const existingIdentity = db.prepare(`
    SELECT opaque_identity_key, identity_method
    FROM canonical_credit_card_account_identities
    WHERE integration_namespace = ? AND account_id = ?
  `).get(namespace, scope.account_id) as
    | { opaque_identity_key?: string; identity_method?: string }
    | undefined;
  if (existingIdentity &&
      (existingIdentity.opaque_identity_key !== identityKey || existingIdentity.identity_method !== identityMethod))
    throw new CanonicalCreditCardPersistenceError(
      "Credit-card account identity changed inside one integration/account authority scope.",
    );
  if (!existingIdentity)
    db.prepare(`INSERT INTO canonical_credit_card_account_identities(
      integration_namespace, account_id, opaque_identity_key, identity_method, created_capture_id
    ) VALUES (?, ?, ?, ?, ?)`).run(namespace, scope.account_id, identityKey, identityMethod, scope.capture_id);

  const sharedTransactions = new Map<string, SharedTransaction>();
  for (const transaction of capture.transactions) {
    const row = db.prepare(`
      SELECT financial.transaction_id, revision.revision_id, record.source_record_id
      FROM source_records record
      JOIN transaction_revisions revision ON revision.source_record_id = record.source_record_id
      JOIN financial_transactions financial ON financial.transaction_id = revision.transaction_id
      WHERE record.capture_id = ? AND financial.account_id = ?
        AND record.occurrence_key = ? AND financial.source_sequence = ?
    `).get(scope.capture_id, scope.account_id, transaction.sourceRecordKey, transaction.sourceKey) as
      | { transaction_id?: Uint8Array; revision_id?: Uint8Array; source_record_id?: Uint8Array }
      | undefined;
    if (!row?.transaction_id || !row.revision_id || !row.source_record_id)
      throw new CanonicalCreditCardPersistenceError(
        `Shared canonical transaction is missing: ${transaction.sourceRecordKey}`,
      );
    sharedTransactions.set(transaction.sourceRecordKey, {
      transactionId: row.transaction_id,
      revisionId: row.revision_id,
      sourceRecordId: row.source_record_id,
    });
  }

  const instruments = new Map<string, Uint8Array>();
  for (const instrument of capture.instruments) {
    const evidenceId = sourceRecord(db, scope, instrument.evidence.sourceRecordKey);
    const existing = db.prepare(`
      SELECT instrument_id, card_mask, role, lifecycle
      FROM canonical_credit_card_instruments
      WHERE integration_namespace = ? AND account_id = ? AND instrument_key = ?
    `).get(namespace, scope.account_id, instrument.instrumentKey) as
      | { instrument_id?: Uint8Array; card_mask?: string | null; role?: string; lifecycle?: string | null }
      | undefined;
    const cardMask = instrument.cardMask ?? null;
    const lifecycle = instrument.lifecycle ?? null;
    if (existing && ((existing.card_mask ?? null) !== cardMask || existing.role !== instrument.role ||
        (existing.lifecycle ?? null) !== lifecycle))
      throw new CanonicalCreditCardPersistenceError(
        "Credit-card instrument key was reused with changed authority data.",
      );
    const instrumentId = existing?.instrument_id ?? id();
    if (!existing)
      db.prepare(`INSERT INTO canonical_credit_card_instruments(
        instrument_id, integration_namespace, account_id, instrument_key, card_mask, role, lifecycle
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        instrumentId, namespace, scope.account_id, instrument.instrumentKey, cardMask,
        requiredText(instrument.role, "instrument.role"), lifecycle,
      );
    db.prepare(`INSERT OR IGNORE INTO canonical_credit_card_instrument_evidence(
      instrument_id, integration_namespace, account_id, capture_id, source_record_id
    ) VALUES (?, ?, ?, ?, ?)`).run(
      instrumentId, namespace, scope.account_id, scope.capture_id, evidenceId,
    );
    instruments.set(instrument.instrumentKey, instrumentId);
  }

  for (const transaction of capture.transactions) {
    const shared = sharedTransactions.get(transaction.sourceRecordKey)!;
    const instrumentId = instruments.get(transaction.instrumentKey);
    if (!instrumentId)
      throw new CanonicalCreditCardPersistenceError("Transaction references an unknown card instrument.");
    const existing = db.prepare(`
      SELECT integration_namespace, account_id, transaction_id, instrument_id,
             billing_status, statement_key
      FROM canonical_credit_card_transaction_details WHERE revision_id = ? LIMIT 1
    `).get(shared.revisionId) as
      | { integration_namespace?: string; account_id?: Uint8Array; transaction_id?: Uint8Array;
          instrument_id?: Uint8Array; billing_status?: string; statement_key?: string | null }
      | undefined;
    if (existing && (existing.integration_namespace !== namespace || !existing.account_id ||
        !sameBlob(existing.account_id, scope.account_id) || !existing.transaction_id ||
        !sameBlob(existing.transaction_id, shared.transactionId) || !existing.instrument_id ||
        !sameBlob(existing.instrument_id, instrumentId) || existing.billing_status !== transaction.billingStatus ||
        (existing.statement_key ?? null) !== (transaction.statementKey ?? null)))
      throw new CanonicalCreditCardPersistenceError(
        "Transaction revision was reused with changed credit-card authority data.",
      );
    db.prepare(`INSERT OR IGNORE INTO canonical_credit_card_transaction_details(
      integration_namespace, account_id, transaction_id, revision_id, source_record_id,
      capture_id, instrument_id, billing_status, statement_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      namespace, scope.account_id, shared.transactionId, shared.revisionId, shared.sourceRecordId,
      scope.capture_id, instrumentId, transaction.billingStatus, transaction.statementKey ?? null,
    );
  }

  for (const statement of capture.statements) {
    const evidenceId = statementEvidenceRecord(db, scope, namespace, statement);
    let statementId = (db.prepare(`SELECT statement_id FROM canonical_credit_card_statements
      WHERE integration_namespace = ? AND account_id = ? AND statement_key = ?`).get(
        namespace, scope.account_id, statement.statementKey,
      ) as { statement_id?: Uint8Array } | undefined)?.statement_id;
    if (!statementId) {
      statementId = id();
      db.prepare(`INSERT INTO canonical_credit_card_statements(
        statement_id, integration_namespace, account_id, statement_key
      ) VALUES (?, ?, ?, ?)`).run(statementId, namespace, scope.account_id, statement.statementKey);
    }
    const existing = db.prepare(`SELECT * FROM canonical_credit_card_statement_revisions
      WHERE statement_id = ? AND revision_key = ?`).get(statementId, statement.revisionKey) as
      | Record<string, unknown>
      | undefined;
    const desiredMembers = statement.transactionSourceKeys.map((key) => {
      const transaction = sharedTransactions.get(key);
      if (!transaction)
        throw new CanonicalCreditCardPersistenceError("Statement membership transaction is missing.");
      return transaction;
    });
    let revisionId: Uint8Array;
    if (existing) {
      revisionId = existing.statement_revision_id as Uint8Array;
      const same = existing.cycle_start === statement.cycleStart && existing.cycle_end === statement.cycleEnd &&
        existing.issue_date === statement.issueDate && existing.due_date === statement.dueDate &&
        existing.currency === statement.currency && existing.balance_coefficient === statement.balance.coefficient &&
        existing.balance_scale === statement.balance.scale &&
        (existing.minimum_coefficient ?? null) === (statement.minimumPayment?.coefficient ?? null) &&
        (existing.minimum_scale ?? null) === (statement.minimumPayment?.scale ?? null) &&
        existing.evidence_source_record_key === statement.evidence.sourceRecordKey;
      const stored = db.prepare(`SELECT transaction_id, transaction_revision_id
        FROM canonical_credit_card_statement_memberships WHERE statement_revision_id = ?`).all(revisionId) as
        Array<{ transaction_id: Uint8Array; transaction_revision_id: Uint8Array }>;
      const memberKey = (transactionId: Uint8Array, transactionRevisionId: Uint8Array) =>
        `${Buffer.from(transactionId).toString("hex")}:${Buffer.from(transactionRevisionId).toString("hex")}`;
      const storedKeys = stored.map((row) => memberKey(row.transaction_id, row.transaction_revision_id)).sort();
      const desiredKeys = desiredMembers.map((row) => memberKey(row.transactionId, row.revisionId)).sort();
      if (!same || JSON.stringify(storedKeys) !== JSON.stringify(desiredKeys))
        throw new CanonicalCreditCardPersistenceError(
          "Statement revision key was reused with changed summary or pinned membership.",
        );
    } else {
      revisionId = id();
      const revisionNumber = Number((db.prepare(`SELECT COALESCE(MAX(revision_number), 0) AS n
        FROM canonical_credit_card_statement_revisions WHERE statement_id = ?`).get(statementId) as { n?: number }).n ?? 0) + 1;
      db.prepare(`INSERT INTO canonical_credit_card_statement_revisions(
        statement_revision_id, statement_id, revision_key, revision_number, created_capture_id,
        cycle_start, cycle_end, issue_date, due_date, currency, balance_coefficient,
        balance_scale, minimum_coefficient, minimum_scale, evidence_source_record_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        revisionId, statementId, statement.revisionKey, revisionNumber, scope.capture_id,
        statement.cycleStart, statement.cycleEnd, statement.issueDate, statement.dueDate,
        statement.currency, statement.balance.coefficient, statement.balance.scale,
        statement.minimumPayment?.coefficient ?? null, statement.minimumPayment?.scale ?? null,
        statement.evidence.sourceRecordKey,
      );
      for (const transaction of desiredMembers)
        db.prepare(`INSERT INTO canonical_credit_card_statement_memberships(
          statement_revision_id, transaction_id, transaction_revision_id, source_record_id
        ) VALUES (?, ?, ?, ?)`).run(
          revisionId, transaction.transactionId, transaction.revisionId, transaction.sourceRecordId,
        );
    }
    db.prepare(`INSERT OR IGNORE INTO canonical_credit_card_statement_summary_evidence(
      statement_revision_id, integration_namespace, account_id, capture_id, evidence_key,
      evidence_source_record_id
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      revisionId, namespace, scope.account_id, scope.capture_id,
      statement.evidence.sourceRecordKey, evidenceId,
    );
  }

  for (const relation of capture.relations ?? []) {
    const from = sharedTransactions.get(relation.fromSourceRecordKey);
    const to = sharedTransactions.get(relation.toSourceRecordKey);
    if (!from || !to)
      throw new CanonicalCreditCardPersistenceError("Relation endpoint is missing.");
    const evidenceId = sourceRecord(db, scope, relation.evidence.sourceRecordKey);
    db.prepare(`INSERT OR IGNORE INTO canonical_credit_card_relations(
      relation_id, integration_namespace, account_id, relation_kind, from_transaction_id,
      to_transaction_id, capture_id, evidence_source_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id(), namespace, scope.account_id, requiredText(relation.kind, "relation.kind"),
      from.transactionId, to.transactionId, scope.capture_id, evidenceId,
    );
  }
}

/**
 * Persist provider-neutral credit-card extensions after the shared canonical
 * writer has materialized captures, scopes, source records and revisions.
 * A savepoint makes this safe both as a writer callback and as a standalone
 * extension step: any validation/constraint failure removes all extension rows.
 */
export function persistCanonicalCreditCardExtensions(
  db: DatabaseSync,
  captures: readonly CanonicalCreditCardPersistenceCapture[],
): void {
  db.exec("SAVEPOINT canonical_credit_card_extensions");
  try {
    ensureCanonicalCreditCardSchema(db);
    for (const capture of captures) persistCapture(db, capture);
    db.exec("RELEASE SAVEPOINT canonical_credit_card_extensions");
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT canonical_credit_card_extensions");
    db.exec("RELEASE SAVEPOINT canonical_credit_card_extensions");
    throw error;
  }
}
