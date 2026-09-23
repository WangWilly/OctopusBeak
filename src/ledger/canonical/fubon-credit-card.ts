import { createHash, randomBytes } from "node:crypto";
import type { ValidatedCanonicalDatabase as DatabaseSync } from "./canonical-database.ts";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import {
  ensureFubonCreditCardSchema,
  validateFubonCreditCardSchema,
} from "./fubon-credit-card-schema.ts";
export {
  ensureFubonCreditCardSchema,
  validateFubonCreditCardSchema,
} from "./fubon-credit-card-schema.ts";
import {
  commitCanonicalFinancialDepositCaptureBatchInTransaction,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositValidatedCapture,
} from "./canonical-financial-deposit-writer.ts";
import {
  withCanonicalSourceCaptureAdmissionTransaction,
  type CanonicalSourceCaptureAdmissionTransactionCapability,
} from "./canonical-source-capture-admission.ts";
import { commitCanonicalCreditCardDirectionEnrichmentForCapturesInTransaction } from "./credit-card-direction-enrichment.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import {
  isFubonCreditCardHumanAttestationV2DurablyActive,
  peekFubonCreditCardHumanAttestationStatus,
  recordInitialFubonCreditCardHumanAttestationV2IfMissing,
} from "./fubon-credit-card-human-attestation.ts";
import {
  fubonCreditCardPanFingerprint,
  type FubonCreditCardPanFingerprintKey,
  type FubonCreditCardPanIdentityMetadata,
} from "./fubon-credit-card-pan.ts";

import * as fubonCreditCardAdmission from "./fubon-credit-card-admission.ts";
export * from "./fubon-credit-card-admission.ts";

const {
  FubonCreditCardAdmissionError,
  isAdmittedFubonCreditCardCapture,
  fubonCanonicalSpineCapture,
} = fubonCreditCardAdmission;
type FubonCreditCardInstrumentInput =
  fubonCreditCardAdmission.FubonCreditCardInstrumentInput;
type FubonCreditCardValidatedCapture =
  fubonCreditCardAdmission.FubonCreditCardValidatedCapture;

export type FubonCreditCardWriterStore = Pick<
  CanonicalSourceStore,
  "db" | "commitClock" | "withWriter"
> & {
  readonly beforeFubonCreditExtensionCommit?: (db: DatabaseSync) => void;
};

function canonicalId(): Buffer {
  return randomBytes(16);
}

function validateFubonInstrumentEvidencePayload(
  db: DatabaseSync,
  sourceRecordId: Uint8Array,
  instrument: FubonCreditCardInstrumentInput,
): void {
  const row = db.prepare(
    "SELECT payload_json FROM source_records WHERE source_record_id = ?",
  ).get(sourceRecordId) as { payload_json?: string } | undefined;
  if (!row?.payload_json)
    throw new FubonCreditCardAdmissionError(
      "Fubon instrument role evidence source record is missing.",
    );
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    throw new FubonCreditCardAdmissionError(
      "Fubon instrument role evidence source payload is not valid JSON.",
    );
  }
  const cardMask = payload.cardMask === undefined ? null : payload.cardMask;
  if (
    payload.instrumentKey !== instrument.instrumentKey ||
    cardMask !== (instrument.cardMask ?? null) ||
    (cardMask !== null &&
      (typeof cardMask !== "string" || !/^\*{4}\d{4}$/u.test(cardMask))) ||
    Object.hasOwn(payload, "fullPan") ||
    Object.hasOwn(payload, "cardNumber") ||
    Object.hasOwn(payload, "sourceLabel")
  )
    throw new FubonCreditCardAdmissionError(
      "Fubon instrument role evidence source payload is inconsistent with the instrument.",
    );
}

export type FubonCreditCardCommitResult = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  captureId: string;
  accountId: string;
  commitSequence: number;
  transactionCount: number;
  statementCount: number;
  relationCount: number;
  provenanceCount: number;
};

function hasValidatedCapture(
  capture: unknown,
): capture is FubonCreditCardValidatedCapture {
  return isAdmittedFubonCreditCardCapture(capture);
}

export async function commitFubonCreditCardCapture(
  store: FubonCreditCardWriterStore,
  capture: FubonCreditCardValidatedCapture,
): Promise<FubonCreditCardCommitResult> {
  return (await commitFubonCreditCardCaptureBatch(store, [capture]))[0]!;
}

function opaqueFubonSpineToken(label: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([label, value]))
    .digest("base64url")}`;
}

type FubonTransactionPersistenceIdentity = Readonly<{
  occurrenceKey: string;
  compactJson: string;
  contentHash: string;
}>;

type FubonTransactionPersistenceIdentityMap = ReadonlyMap<
  string,
  FubonTransactionPersistenceIdentity
>;

/**
 * Resolve the safe identity transitions that the Fubon page can expose:
 * an already observed unbilled occurrence becoming billed, followed by a
 * billed recurrence. Statement keys remain part of the provider evidence and
 * of the public source key contract; they are only reconciled at this
 * persistence seam when all economic fields and the scoped occurrence ordinal
 * identify exactly one prior observation.
 */
function resolveFubonTransactionPersistenceIdentities(
  db: DatabaseSync,
  capture: FubonCreditCardValidatedCapture,
): Map<string, FubonTransactionPersistenceIdentity> {
  const account = db.prepare(
    `SELECT account.account_id
       FROM financial_accounts account
       JOIN source_connections connection_scope
         ON connection_scope.source_connection_id = account.source_connection_id
       JOIN identity_epochs epoch
         ON epoch.identity_epoch_id = account.identity_epoch_id
      WHERE connection_scope.integration_namespace = 'fubon'
        AND connection_scope.source_connection_key = ?
        AND epoch.epoch_key = ?
        AND account.stream = 'credit-card'
        AND account.source_account_key = ?
      LIMIT 1`,
  ).get(
    capture.identity.sourceConnectionKey,
    opaqueFubonSpineToken("fubon-credit-epoch-v2", capture.identity.identityEpochKey),
    capture.identity.accountNaturalKey,
  ) as { account_id?: Uint8Array } | undefined;
  if (!account?.account_id) return new Map();

  const instrumentKeys = new Set(
    capture.instruments.map((instrument) => instrument.instrumentKey),
  );
  const resolveCandidate = db.prepare(
    `SELECT financial_transaction.source_sequence,
            source_record.content_hash, source_record.payload_json,
            detail.billing_status, detail.statement_key,
            json_extract(source_record.payload_json, '$.sourceScopeKey') AS source_scope_key
       FROM fubon_credit_transaction_details detail
       JOIN financial_transactions financial_transaction
         ON financial_transaction.transaction_id = detail.transaction_id
       JOIN transaction_revisions revision
         ON revision.revision_id = detail.revision_id
       LEFT JOIN transaction_conversion_evidence conversion
         ON conversion.transaction_id = detail.transaction_id
        AND conversion.revision_id = detail.revision_id
       JOIN source_records source_record
         ON source_record.source_record_id = detail.source_record_id
       JOIN fubon_credit_instrument_details instrument
         ON instrument.instrument_id = detail.instrument_id
      WHERE financial_transaction.account_id = ?
        AND instrument.instrument_key = ?
        AND detail.consume_date IS ?
        AND detail.posting_date IS ?
        AND revision.amount_coefficient = ?
        AND revision.amount_scale = ?
        AND revision.currency = ?
        AND revision.direction = ?
        AND revision.description = ?
        AND conversion.original_amount_coefficient IS ?
        AND conversion.original_amount_scale IS ?
        AND conversion.original_currency IS ?
        AND CAST(json_extract(source_record.payload_json, '$.occurrenceIndex') AS INTEGER) = ?
        AND detail.rowid = (
          SELECT latest.rowid
            FROM fubon_credit_transaction_details latest
            JOIN source_captures latest_capture
              ON latest_capture.capture_id = latest.capture_id
            JOIN canonical_commits latest_commit
              ON latest_commit.commit_id = latest_capture.commit_id
           WHERE latest.transaction_id = detail.transaction_id
           ORDER BY latest_commit.commit_sequence DESC, latest.rowid DESC
           LIMIT 1
        )
      ORDER BY financial_transaction.source_sequence`,
  );
  const resolved = new Map<string, FubonTransactionPersistenceIdentity>();
  for (const transaction of capture.transactions) {
    if (!instrumentKeys.has(transaction.instrumentKey)) continue;
    const instrumentKey = transaction.instrumentKey;
    const candidates = resolveCandidate.all(
      account.account_id,
      instrumentKey,
      transaction.consumeDate,
      transaction.postingDate,
      transaction.bookedAmount.coefficient,
      transaction.bookedAmount.scale,
      transaction.bookedCurrency,
      transaction.direction,
      transaction.description,
      transaction.foreignAmount?.coefficient ?? null,
      transaction.foreignAmount?.scale ?? null,
      transaction.foreignCurrency ?? null,
      transaction.occurrenceIndex,
    ) as Array<{
      source_sequence?: unknown;
      content_hash?: unknown;
      payload_json?: unknown;
      billing_status?: unknown;
      statement_key?: unknown;
      source_scope_key?: unknown;
    }>;
    const priorUnbilled = candidates.filter(
      (candidate) =>
        candidate.billing_status === "unbilled" &&
        (candidate.statement_key == null || candidate.statement_key === ""),
    );
    const billedCandidates = candidates.filter(
      (candidate) => candidate.billing_status === "billed",
    );
    if (transaction.billingStatus === "unbilled" && billedCandidates.length > 0)
      throw new FubonCreditCardAdmissionError(
        "Fubon billing lifecycle cannot regress from billed to unbilled.",
      );
    if (transaction.billingStatus !== "billed") continue;
    const incomingStatementKey = transaction.statementKey ?? null;
    const incomingSourceScopeKey = transaction.sourceScopeKey ?? null;
    const priorBilled = billedCandidates.filter((candidate) => {
      const candidateStatementKey =
        candidate.statement_key == null || candidate.statement_key === ""
          ? null
          : String(candidate.statement_key);
      if (candidateStatementKey !== incomingStatementKey) return false;
      const candidateSourceScopeKey =
        candidate.source_scope_key == null || candidate.source_scope_key === ""
          ? null
          : String(candidate.source_scope_key);
      // A transition stores the immutable unbilled spine payload, so its
      // later billed detail has no source-scope field. Treat that absence as
      // an unknown scope only when it is the sole candidate for this
      // statement; two candidates remain an ambiguity and fail closed below.
      return (
        candidateSourceScopeKey === incomingSourceScopeKey ||
        (incomingSourceScopeKey !== null && candidateSourceScopeKey === null)
      );
    });
    if (priorUnbilled.length > 1 || priorBilled.length > 1)
      throw new FubonCreditCardAdmissionError(
        priorBilled.length > 0
          ? "Fubon billed transaction matches an existing billed occurrence."
          : "Fubon billed transaction matches multiple unbilled occurrences.",
      );
    if (priorUnbilled.length > 0 && priorBilled.length > 0)
      throw new FubonCreditCardAdmissionError(
        "Fubon billed transaction matches ambiguous billed and unbilled occurrences.",
      );
    const prior = priorBilled[0] ?? priorUnbilled[0];
    if (
      !prior ||
      typeof prior.source_sequence !== "string" ||
      typeof prior.content_hash !== "string" ||
      typeof prior.payload_json !== "string"
    )
      continue;
    resolved.set(transaction.sourceRecordKey, {
      occurrenceKey: prior.source_sequence,
      compactJson: prior.payload_json,
      contentHash: prior.content_hash,
    });
  }
  return resolved;
}


function persistFubonCanonicalExtensions(
  db: DatabaseSync,
  captures: readonly FubonCreditCardValidatedCapture[],
  persistenceIdentities: readonly FubonTransactionPersistenceIdentityMap[] = [],
): void {
  for (const [captureIndex, capture] of captures.entries()) {
    const capturePersistenceIdentities =
      persistenceIdentities[captureIndex] ?? new Map();
    const scope = db.prepare(
      `SELECT source_capture.capture_id, capture_scope.account_id,
              source_capture.source_subject_id, source_capture.commit_id,
              capture_scope.scope_id
       FROM source_captures source_capture
       JOIN capture_scopes capture_scope
         ON capture_scope.capture_id = source_capture.capture_id
       WHERE source_capture.capture_key = ?`,
    ).get(capture.captureId) as
      | {
          capture_id?: Uint8Array;
          account_id?: Uint8Array;
          source_subject_id?: Uint8Array;
          commit_id?: Uint8Array;
          scope_id?: Uint8Array;
        }
      | undefined;
    if (
      !scope?.capture_id ||
      !scope.account_id ||
      !scope.source_subject_id ||
      !scope.commit_id ||
      !scope.scope_id
    )
      throw new Error("Fubon shared canonical capture scope is missing.");
    const identityMetadata = capture.identity;
    const existingIdentity = db.prepare(
      `SELECT identity_method, pan_fingerprint, pan_last4,
              pan_fingerprint_key_version
       FROM fubon_credit_account_identity_details
       WHERE account_id = ?`,
    ).get(scope.account_id) as
      | {
          identity_method?: string;
          pan_fingerprint?: string | null;
          pan_last4?: string | null;
          pan_fingerprint_key_version?: string | null;
        }
      | undefined;
    const desiredIdentity = {
      identityMethod: identityMetadata.identityMethod,
      panFingerprint: identityMetadata.panFingerprint ?? null,
      panLast4: identityMetadata.panLast4 ?? null,
      panFingerprintKeyVersion: identityMetadata.panFingerprintKeyVersion ?? null,
    };
    if (
      existingIdentity &&
      (existingIdentity.identity_method !== desiredIdentity.identityMethod ||
        (existingIdentity.pan_fingerprint ?? null) !== desiredIdentity.panFingerprint ||
        (existingIdentity.pan_last4 ?? null) !== desiredIdentity.panLast4 ||
        (existingIdentity.pan_fingerprint_key_version ?? null) !==
          desiredIdentity.panFingerprintKeyVersion)
    )
      throw new FubonCreditCardAdmissionError(
        "Fubon account identity metadata changed without a new identity epoch.",
      );
    if (!existingIdentity)
      db.prepare(
        `INSERT INTO fubon_credit_account_identity_details(
          account_id, identity_method, pan_fingerprint, pan_last4,
          pan_fingerprint_key_version
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        scope.account_id,
        desiredIdentity.identityMethod,
        desiredIdentity.panFingerprint,
        desiredIdentity.panLast4,
        desiredIdentity.panFingerprintKeyVersion,
      );

    const statementEvidenceSourceRecord = new Map<string, Uint8Array>();
    for (const statement of capture.statements) {
      const existingRecord = db.prepare(
        `SELECT source_record_id FROM source_records
         WHERE capture_id = ? AND record_kind = 'fubon-credit-card-statement-summary'
           AND occurrence_key = ?`,
      ).get(scope.capture_id, statement.evidence.sourceRecordKey) as
        | { source_record_id?: Uint8Array }
        | undefined;
      if (!existingRecord?.source_record_id)
        throw new Error("Fubon statement source evidence is missing from admission.");
      const sourceRecordId = existingRecord.source_record_id;
      statementEvidenceSourceRecord.set(statement.evidence.sourceRecordKey, sourceRecordId);
    }
    const sharedTransactions = new Map<
      string,
      { transactionId: Uint8Array; revisionId: Uint8Array; sourceRecordId: Uint8Array }
    >();
    const currentTransactions = new Set(
      createCanonicalProjectionRuntime(db)
        .read({
          kind: "current",
          families: ["transactions"],
          scope: { accountIds: [Buffer.from(scope.account_id).toString("hex")] },
        })
        .families.transactions.map(
          (projected) => `${projected.transactionId}:${projected.revisionId}`,
        ),
    );
    for (const transaction of capture.transactions) {
      const sourceSequence =
        capturePersistenceIdentities.get(transaction.sourceRecordKey)?.occurrenceKey ??
        transaction.sourceKey;
      const row = db.prepare(
        `SELECT financial_transaction.transaction_id, current_row.revision_id,
                source_record.source_record_id
         FROM financial_transactions financial_transaction
         JOIN transaction_revisions current_row
           ON current_row.transaction_id = financial_transaction.transaction_id
         JOIN source_records source_record
           ON source_record.capture_id = ? AND source_record.occurrence_key = ?
         WHERE financial_transaction.account_id = ?
           AND financial_transaction.source_sequence = ?`,
      ).get(
        scope.capture_id,
        sourceSequence,
        scope.account_id,
        sourceSequence,
      ) as
        | { transaction_id?: Uint8Array; revision_id?: Uint8Array; source_record_id?: Uint8Array }
        | undefined;
      if (!row?.transaction_id || !row.revision_id || !row.source_record_id)
        throw new Error("Fubon shared canonical transaction is missing.");
      if (
        !currentTransactions.has(
          `${Buffer.from(row.transaction_id).toString("hex")}:${Buffer.from(row.revision_id).toString("hex")}`,
        )
      )
        throw new Error("Fubon shared canonical transaction is not current.");
      sharedTransactions.set(transaction.sourceRecordKey, {
        transactionId: row.transaction_id,
        revisionId: row.revision_id,
        sourceRecordId: row.source_record_id,
      });
    }
    const instruments = new Map<string, Uint8Array>();
    for (const instrument of capture.instruments) {
      const evidenceTransaction = sharedTransactions.get(
        instrument.evidence!.sourceRecordKey,
      );
      if (!evidenceTransaction)
        throw new FubonCreditCardAdmissionError(
          "Fubon instrument role evidence is not a shared source record in this capture.",
        );
      validateFubonInstrumentEvidencePayload(
        db,
        evidenceTransaction.sourceRecordId,
        instrument,
      );
      const existing = db.prepare(
        `SELECT instrument_id, role, lifecycle, card_mask
         FROM fubon_credit_instrument_details
         WHERE account_id = ? AND instrument_key = ?`,
      ).get(scope.account_id, instrument.instrumentKey) as
        | {
            instrument_id?: Uint8Array;
            role?: string;
            lifecycle?: string | null;
            card_mask?: string | null;
          }
        | undefined;
      if (
        existing &&
        (existing.role !== instrument.role ||
          (existing.lifecycle ?? null) !== (instrument.lifecycle ?? null) ||
          (existing.card_mask !== null &&
            instrument.cardMask !== undefined &&
            existing.card_mask !== instrument.cardMask))
      )
        throw new FubonCreditCardAdmissionError(
          "Fubon card instrument evidence changed without a new identity epoch.",
        );
      const instrumentId = existing?.instrument_id ?? canonicalId();
      if (!existing)
        db.prepare(
          `INSERT INTO fubon_credit_instrument_details(
            instrument_id, account_id, instrument_key, card_mask, role, lifecycle
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          instrumentId,
          scope.account_id,
          instrument.instrumentKey,
          instrument.cardMask ?? null,
          instrument.role,
          instrument.lifecycle ?? null,
        );
      else if (existing.card_mask === null && instrument.cardMask !== undefined)
        db.prepare(
          `UPDATE fubon_credit_instrument_details
           SET card_mask = ?
           WHERE instrument_id = ?`,
        ).run(instrument.cardMask, instrumentId);
      db.prepare(
        `INSERT INTO fubon_credit_instrument_role_evidence(
          instrument_id, account_id, capture_id, source_record_id
        ) VALUES (?, ?, ?, ?)`,
      ).run(
        instrumentId,
        scope.account_id,
        scope.capture_id,
        evidenceTransaction.sourceRecordId,
      );
      instruments.set(instrument.instrumentKey, instrumentId);
    }
    for (const transaction of capture.transactions) {
      const row = sharedTransactions.get(transaction.sourceRecordKey);
      if (!row) throw new Error("Fubon shared canonical transaction is missing.");
      const instrumentId = instruments.get(transaction.instrumentKey);
      if (!instrumentId)
        throw new Error("Fubon typed card instrument is missing.");
      db.prepare(
        `INSERT INTO fubon_credit_transaction_details(
          transaction_id, revision_id, source_record_id, capture_id,
          instrument_id, billing_status, consume_date, posting_date,
          effective_date_basis, statement_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.transactionId,
        row.revisionId,
        row.sourceRecordId,
        scope.capture_id,
        instrumentId,
        transaction.billingStatus,
        transaction.consumeDate,
        transaction.postingDate,
        transaction.effectiveDateBasis,
        transaction.statementKey ?? null,
      );
    }
    for (const statement of capture.statements) {
      const existingStatement = db.prepare(
        `SELECT statement_id FROM fubon_credit_statement_details
         WHERE account_id = ? AND statement_key = ?`,
      ).get(scope.account_id, statement.statementKey) as
        | { statement_id?: Uint8Array }
        | undefined;
      const statementId = existingStatement?.statement_id ?? canonicalId();
      if (!existingStatement)
        db.prepare(
          `INSERT INTO fubon_credit_statement_details(
            statement_id, account_id, statement_key
          ) VALUES (?, ?, ?)`,
        ).run(statementId, scope.account_id, statement.statementKey);
      const existingRevision = db.prepare(
        `SELECT statement_revision_id, cycle_start, cycle_end, issue_date, due_date,
                currency, balance_coefficient, balance_scale,
                minimum_coefficient, minimum_scale, evidence_source_record_key
         FROM fubon_credit_statement_revision_details
         WHERE statement_id = ? AND revision_key = ?`,
      ).get(statementId, statement.revisionKey) as
        | {
            statement_revision_id?: Uint8Array;
            cycle_start?: string;
            cycle_end?: string;
            issue_date?: string;
            due_date?: string;
            currency?: string;
            balance_coefficient?: string;
            balance_scale?: number;
            minimum_coefficient?: string | null;
            minimum_scale?: number | null;
            evidence_source_record_key?: string;
          }
        | undefined;
      if (existingRevision?.statement_revision_id) {
        const storedMembership = db.prepare(
          `SELECT hex(transaction_id) AS transaction_id,
                  hex(transaction_revision_id) AS transaction_revision_id
           FROM fubon_credit_statement_membership_details
           WHERE statement_revision_id = ?
           ORDER BY transaction_id, transaction_revision_id`,
        ).all(existingRevision.statement_revision_id) as Array<{
          transaction_id?: string;
          transaction_revision_id?: string;
        }>;
        const desiredMembership = statement.transactionSourceKeys
          .map((sourceRecordKey) => {
            const transaction = sharedTransactions.get(sourceRecordKey);
            if (!transaction)
              throw new Error("Fubon Statement shared membership transaction is missing.");
            return {
              transaction_id: Buffer.from(transaction.transactionId).toString("hex").toUpperCase(),
              transaction_revision_id: Buffer.from(transaction.revisionId).toString("hex").toUpperCase(),
            };
          })
          .sort((left, right) =>
            `${left.transaction_id}:${left.transaction_revision_id}`.localeCompare(
              `${right.transaction_id}:${right.transaction_revision_id}`,
            ),
          );
        const sameSummary =
          existingRevision.cycle_start === statement.cycleStart &&
          existingRevision.cycle_end === statement.cycleEnd &&
          existingRevision.issue_date === statement.issueDate &&
          existingRevision.due_date === statement.dueDate &&
          existingRevision.currency === statement.currency &&
          existingRevision.balance_coefficient === statement.balance.coefficient &&
          existingRevision.balance_scale === statement.balance.scale &&
          (existingRevision.minimum_coefficient ?? null) ===
            (statement.minimumPayment?.coefficient ?? null) &&
          (existingRevision.minimum_scale ?? null) ===
            (statement.minimumPayment?.scale ?? null) &&
          existingRevision.evidence_source_record_key === statement.evidence.sourceRecordKey;
        if (!sameSummary || JSON.stringify(storedMembership) !== JSON.stringify(desiredMembership))
          throw new FubonCreditCardAdmissionError(
            "Fubon Statement revision key was reused with changed summary or pinned membership.",
          );
        db.prepare(
          `INSERT INTO fubon_credit_statement_summary_evidence(
            statement_revision_id, account_id, capture_id, evidence_key,
            evidence_source_record_id
          ) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          existingRevision.statement_revision_id,
          scope.account_id,
          scope.capture_id,
          statement.evidence.sourceRecordKey,
          statementEvidenceSourceRecord.get(statement.evidence.sourceRecordKey)!,
        );
        continue;
      }
      const revisionNumber = Number(
        (
          db.prepare(
            `SELECT COALESCE(MAX(revision_number), 0) AS value
             FROM fubon_credit_statement_revision_details WHERE statement_id = ?`,
          ).get(statementId) as { value?: number }
        ).value ?? 0,
      ) + 1;
      const statementRevisionId = canonicalId();
      db.prepare(
        `INSERT INTO fubon_credit_statement_revision_details(
          statement_revision_id, statement_id, capture_id, revision_key,
          revision_number, cycle_start, cycle_end, issue_date, due_date,
          currency, balance_coefficient, balance_scale, minimum_coefficient,
          minimum_scale, evidence_source_record_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        statementRevisionId,
        statementId,
        scope.capture_id,
        statement.revisionKey,
        revisionNumber,
        statement.cycleStart,
        statement.cycleEnd,
        statement.issueDate,
        statement.dueDate,
        statement.currency,
        statement.balance.coefficient,
        statement.balance.scale,
        statement.minimumPayment?.coefficient ?? null,
        statement.minimumPayment?.scale ?? null,
        statement.evidence.sourceRecordKey,
      );
      for (const sourceRecordKey of statement.transactionSourceKeys) {
        const transaction = sharedTransactions.get(sourceRecordKey);
        if (!transaction)
          throw new Error("Fubon Statement shared membership transaction is missing.");
        db.prepare(
          `INSERT INTO fubon_credit_statement_membership_details(
            statement_revision_id, transaction_id, transaction_revision_id,
            source_record_id
          ) VALUES (?, ?, ?, ?)`,
        ).run(
          statementRevisionId,
          transaction.transactionId,
          transaction.revisionId,
          transaction.sourceRecordId,
        );
      }
      db.prepare(
        `INSERT INTO fubon_credit_statement_summary_evidence(
          statement_revision_id, account_id, capture_id, evidence_key,
          evidence_source_record_id
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        statementRevisionId,
        scope.account_id,
        scope.capture_id,
        statement.evidence.sourceRecordKey,
        statementEvidenceSourceRecord.get(statement.evidence.sourceRecordKey)!,
      );
    }
    for (const relation of capture.relations) {
      const from = sharedTransactions.get(relation.fromSourceRecordKey);
      const to = sharedTransactions.get(relation.toSourceRecordKey);
      if (!from || !to)
        throw new Error("Fubon explicit relation endpoint is missing from shared canonical.");
      db.prepare(
        `INSERT OR IGNORE INTO fubon_credit_relation_details(
          relation_id, account_id, relation_kind, from_transaction_id,
          to_transaction_id, evidence_source_record_key
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        canonicalId(),
        scope.account_id,
        relation.kind,
        from.transactionId,
        to.transactionId,
        (relation.evidence as { sourceRecordKey: string }).sourceRecordKey,
      );
    }
  }
}

function toFubonCreditCardCommitResult(
  store: FubonCreditCardWriterStore,
  capture: FubonCreditCardValidatedCapture,
  result: CanonicalFinancialDepositCommitResult,
): FubonCreditCardCommitResult {
  const row = store.db.prepare(
    `SELECT hex(scope.account_id) AS account_id
     FROM source_captures capture
     JOIN capture_scopes scope ON scope.capture_id = capture.capture_id
     WHERE capture.capture_key = ?`,
  ).get(capture.captureId) as { account_id?: string } | undefined;
  if (!row?.account_id)
    throw new Error("Fubon shared canonical account is missing after commit.");
  return {
    status: "canonical-live",
    canonicalAdmission: "admitted",
    captureId: capture.captureId,
    accountId: row.account_id.toLowerCase(),
    commitSequence: result.commitSequence,
    transactionCount: result.transactionCount,
    statementCount: capture.statements.length,
    relationCount: capture.relations.length,
    provenanceCount: result.provenanceCount,
  };
}

export function commitFubonCreditCardCaptureBatchInTransaction(
  store: FubonCreditCardWriterStore,
  captures: readonly FubonCreditCardValidatedCapture[],
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): FubonCreditCardCommitResult[] {
  if (captures.length === 0) throw new FubonCreditCardAdmissionError("Fubon credit-card capture batch cannot be empty.");
  for (const capture of captures) {
    if (!hasValidatedCapture(capture))
      throw new FubonCreditCardAdmissionError("Fubon credit-card batch contains an unvalidated capture.");
  }
  if (peekFubonCreditCardHumanAttestationStatus(store.db) === "revoked")
    throw new FubonCreditCardAdmissionError("Fubon credit-card durable human attestation is revoked.");
  const persistenceIdentities = captures.map((capture) =>
    resolveFubonTransactionPersistenceIdentities(store.db, capture),
  );
  const committed = commitCanonicalFinancialDepositCaptureBatchInTransaction(
    store,
    captures.map((capture, index) =>
      fubonCanonicalSpineCapture(capture, persistenceIdentities[index]),
    ),
    capability,
    (db) => {
      ensureFubonCreditCardSchema(db);
      recordInitialFubonCreditCardHumanAttestationV2IfMissing(db);
      if (!isFubonCreditCardHumanAttestationV2DurablyActive(db))
        throw new FubonCreditCardAdmissionError(
          "Fubon credit-card durable human attestation is revoked.",
        );
      store.beforeFubonCreditExtensionCommit?.(db);
      persistFubonCanonicalExtensions(db, captures, persistenceIdentities);
      commitCanonicalCreditCardDirectionEnrichmentForCapturesInTransaction(
        db,
        captures.map((capture) => capture.captureId),
      );
    },
  );
  return committed.map((result, index) =>
    toFubonCreditCardCommitResult(store, captures[index]!, result),
  );
}

/** Commit one Fubon capture inside an execution-owned transaction. */
export function commitFubonCreditCardCaptureInTransaction(
  store: FubonCreditCardWriterStore,
  capture: FubonCreditCardValidatedCapture,
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): FubonCreditCardCommitResult {
  return commitFubonCreditCardCaptureBatchInTransaction(store, [capture], capability)[0]!;
}

export async function commitFubonCreditCardCaptureBatch(
  store: FubonCreditCardWriterStore,
  captures: readonly FubonCreditCardValidatedCapture[],
): Promise<FubonCreditCardCommitResult[]> {
  return withCanonicalSourceCaptureAdmissionTransaction(
    store as unknown as CanonicalSourceStore,
    (capability) =>
      commitFubonCreditCardCaptureBatchInTransaction(store, captures, capability),
  );
}
