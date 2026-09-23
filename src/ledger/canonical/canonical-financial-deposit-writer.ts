import {
  admitCanonicalFinancialDepositCapture,
  CanonicalFinancialDepositConflictError,
  isAdmittedCanonicalFinancialDepositCapture as hasValidatedBrand,
  isNonTransactionRecord,
  validateCanonicalFinancialDepositCapture as validateCapture,
  type CanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositConversionEvidence,
  type CanonicalFinancialDepositPage,
  type CanonicalFinancialDepositRate,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialNonTransactionRecord,
  type FinancialDepositAmount,
  type FinancialDepositSourceTime,
} from "./canonical-financial-deposit-admission.ts";
export {
  admitCanonicalFinancialDepositCapture,
  CanonicalFinancialDepositConflictError,
  type CanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositConversionEvidence,
  type CanonicalFinancialDepositPage,
  type CanonicalFinancialDepositRate,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialNonTransactionRecord,
  type FinancialDepositAmount,
  type FinancialDepositSourceTime,
} from "./canonical-financial-deposit-admission.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  createCanonicalProjectionRuntime,
} from "./canonical-projection-runtime.ts";
import {
  assertValidatedCanonicalDatabase,
  type ValidatedCanonicalDatabase,
} from "./canonical-schema-lifecycle.ts";
import {
  withCanonicalSourceCaptureAdmissionTransaction,
  type CanonicalSourceCaptureAdmissionRequest,
  type CanonicalSourceCaptureAdmissionTransactionCapability,
  type CanonicalSourceCaptureAdmissionTransactionResult,
} from "./canonical-source-capture-admission.ts";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";

export type CanonicalFinancialDepositWriterStore = Pick<
  CanonicalSourceStore,
  "db" | "commitClock" | "withWriter"
>;

/**
 * The writer type is kept narrow for adapter compatibility, but the runtime
 * seam is deliberately stricter than its structural TypeScript shape.  A
 * provider must pass the lifecycle-created CanonicalSourceStore; wrapping its
 * database in a look-alike object is not a production adapter.
 */
function requireValidatedFinancialWriterStore(
  store: CanonicalFinancialDepositWriterStore,
): void {
  assertValidatedCanonicalDatabase(store.db);
}

export type CanonicalFinancialDepositCommitResult = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  captureId: string;
  commitSequence: number;
  transactionCount: number;
  provenanceCount: number;
};

function id(): Uint8Array {
  return randomBytes(16);
}

function insertLifecycle(
  db: DatabaseSync,
  values: {
    assertionId: Uint8Array;
    transactionId: Uint8Array;
    captureId: Uint8Array;
    scopeId: Uint8Array;
    commitId: Uint8Array;
    kind: "observed" | "withdrawn" | "restored" | "superseded";
  },
): void {
  db.prepare(
    `INSERT INTO assertion_transitions(
      event_id, assertion_id, transaction_id, field_name, capture_id, scope_id,
      run_id, coordinate_id, user_id, commit_id, event_kind
    ) VALUES (?, ?, ?, 'transaction_revision', ?, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id(),
    values.assertionId,
    values.transactionId,
    values.captureId,
    values.scopeId,
    values.commitId,
    values.kind,
  );
}

function latestLifecycle(
  db: DatabaseSync,
  assertionId: Uint8Array,
): string | null {
  const row = db
    .prepare(
      `SELECT transition.event_kind FROM assertion_transitions transition
       JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
       WHERE transition.assertion_id = ?
       ORDER BY commit_row.commit_sequence DESC, transition.event_id DESC LIMIT 1`,
    )
    .get(assertionId) as { event_kind?: string } | undefined;
  return row?.event_kind ?? null;
}

function compactSourcePayload(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Financial compact source payload must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Financial compact source payload must be an object.");
  return parsed as Record<string, unknown>;
}

function sourceAdmissionRequestFromFinancialCapture(
  capture: CanonicalFinancialDepositCapture,
): CanonicalSourceCaptureAdmissionRequest {
  const records = [
    ...capture.records,
    ...(capture.nonTransactionRecords ?? []).filter(
      (record) => record.recordType === "holding-observation",
    ),
  ].map((record) => ({
    occurrenceKey: record.occurrenceKey,
    collisionKey: record.collisionKey,
    providerKey: record.providerKey,
    contentHash: record.contentHash,
    compact: compactSourcePayload(record.compactJson),
    sequenceLexeme: record.sequenceLexeme,
    description: record.description ?? null,
    compactJson: record.compactJson,
  }));
  return {
    captureId: capture.captureId,
    integrationNamespace: capture.identity.integrationNamespace,
    sourceConnectionKey: capture.identity.sourceConnectionKey,
    identityEpoch: capture.identity.identityEpochKey,
    stream: capture.identity.stream,
    recordKind: capture.identity.recordKind,
    routeKey: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    subjectDigest: capture.identity.subjectDigest,
    accountNumber: capture.identity.accountNumber ?? null,
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      dateFormat: "YYYY-MM-DD",
      kind: capture.scope.scopeKind,
      completeness: capture.scope.completeness,
      ruleVersion: capture.scope.completenessRuleVersion,
      completenessBasis: capture.scope.completenessBasis,
      contractFingerprint: capture.scope.contractFingerprint,
      preflightFingerprint: capture.scope.preflightFingerprint,
      pageTerminalPolicy: capture.pages.every((page) => page.terminal)
        ? "each"
        : "last",
      absenceAuthority:
        capture.scope.absenceAuthority === null
          ? undefined
          : (capture.scope.absenceAuthority as
              | "comparable-complete-range"
              | "provider-explicit-no-data"),
      sourceAccountKey:
        capture.identity.sourceAccountKey ?? capture.identity.accountNo,
      accountNo: capture.identity.accountNo,
    },
    pages: capture.pages.map((page) => ({
      pageOrdinal: page.pageOrdinal,
      responseCode: page.responseCode as "200",
      rowCount: page.rowCount,
      terminal: page.terminal,
      metadata: compactSourcePayload(page.metadataJson),
      responseDigest: page.responseDigest,
      proofKind: page.proofKind,
      contractFingerprint: page.contractFingerprint,
      preflightFingerprint: page.preflightFingerprint,
      metadataJson: page.metadataJson,
    })),
    records,
  };
}

function commitOnce(
  store: CanonicalFinancialDepositWriterStore,
  capture: CanonicalFinancialDepositValidatedCapture,
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): CanonicalFinancialDepositCommitResult {
  if (!hasValidatedBrand(capture))
    throw new CanonicalFinancialDepositConflictError(
      "Financial deposit capture did not cross the runtime-validated seam.",
    );
  validateCapture(capture);
  const db = store.db;
  const sourceAccountKey =
    capture.identity.sourceAccountKey ?? capture.identity.accountNo;
  try {
    const additionalRecords = (capture.nonTransactionRecords ?? [])
      .filter((record) => record.recordType === "statement-evidence")
      .map(
      (record) => ({
        occurrenceKey: record.occurrenceKey,
        collisionKey: record.collisionKey,
        providerKey: record.providerKey,
        contentHash: record.contentHash,
        compact: compactSourcePayload(record.compactJson),
        sequenceLexeme: record.sequenceLexeme,
        description: record.description ?? null,
        compactJson: record.compactJson,
        recordKind: record.recordKind,
      }),
    );
    const sourceContext = capability.admit(
      sourceAdmissionRequestFromFinancialCapture(capture),
      additionalRecords,
    );
    const {
      receipt: sourceReceipt,
      captureId,
      scopeId,
      commitId,
      sourceConnectionId: connectionId,
      identityEpochId: epochId,
      sourceSubjectId: subjectId,
      sourceRecordIds,
    } = sourceContext;
    const commitSequence = sourceReceipt.knowledgePoint;
    const sourceRecords = [
      ...capture.records,
      ...(capture.nonTransactionRecords ?? []),
    ];
    const existingAccount = db
      .prepare(
        `SELECT account_id, currency, account_type, account_no FROM financial_accounts
         WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND source_account_key = ?`,
      )
      .get(
        connectionId,
        epochId,
        capture.identity.stream,
        sourceAccountKey,
      ) as
      | {
          account_id?: unknown;
          currency?: unknown;
          account_type?: unknown;
          account_no?: unknown;
        }
      | undefined;
    const isForeignCurrencyRoute =
      capture.authorityRoute.includes("/foreign-currency/");
    if (
      existingAccount &&
      (existingAccount.account_type !== capture.identity.accountType ||
        (!isForeignCurrencyRoute &&
          existingAccount.currency !== capture.identity.currency))
    )
      throw new CanonicalFinancialDepositConflictError(
        "Financial account classification conflict is forbidden.",
      );
    const accountId = existingAccount
      ? (existingAccount.account_id as Uint8Array)
      : id();
    if (!existingAccount)
      db.prepare(
        `INSERT INTO financial_accounts(
          account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_no,
          account_type, currency, created_commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        accountId,
        connectionId,
        epochId,
        capture.identity.stream,
        sourceAccountKey,
        capture.identity.accountNumber?.value ?? null,
        capture.identity.accountType,
        capture.identity.currency,
        commitId,
      );
    else if (capture.identity.accountNumber) {
      const existingAccountNumber = existingAccount.account_no;
      if (
        existingAccountNumber !== null &&
        existingAccountNumber !== undefined &&
        String(existingAccountNumber) !== capture.identity.accountNumber.value
      )
        throw new CanonicalFinancialDepositConflictError(
          "Financial account provider identifier changed without a versioned account revision.",
        );
      if (existingAccountNumber === null || existingAccountNumber === undefined)
        db.prepare(
          "UPDATE financial_accounts SET account_no = ? WHERE account_id = ?",
        ).run(capture.identity.accountNumber.value, accountId);
    }
    if (capture.identity.accountNumber) {
      db.prepare(
        `INSERT OR IGNORE INTO financial_account_identifier_observations(
          observation_id, account_id, capture_id, source_record_id, commit_id,
          identifier_kind, identifier_value, evidence_version, source_field, observed_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id(),
        accountId,
        captureId,
        commitId,
        capture.identity.accountNumber.kind,
        capture.identity.accountNumber.value,
        capture.identity.accountNumber.evidenceVersion,
        capture.identity.accountNumber.sourceField,
        capture.observedAt,
      );
    }
    capability.linkFinancialAccount({
      accountId,
      scopeId,
      sourceRecordIds,
    });

    const seen = new Set<string>();
    for (const [sourceRecordIndex, record] of sourceRecords.entries()) {
      if (!isNonTransactionRecord(record)) seen.add(record.occurrenceKey);
      const sourceRecordId = sourceRecordIds[sourceRecordIndex];
      if (!sourceRecordId)
        throw new Error("Canonical source admission record identity is missing.");
      if (isNonTransactionRecord(record)) continue;

      const existingTransaction = db
        .prepare(
          "SELECT transaction_id FROM financial_transactions WHERE account_id = ? AND source_sequence = ?",
        )
        .get(accountId, record.occurrenceKey) as
        { transaction_id?: unknown } | undefined;
      const transactionId = existingTransaction
        ? (existingTransaction.transaction_id as Uint8Array)
        : id();
      if (!existingTransaction)
        db.prepare(
          "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)",
        ).run(transactionId, accountId, record.occurrenceKey, commitId);
      const existingRevision = db
        .prepare(
          `SELECT revision.revision_id, revision.commit_id,
              revision.revision_number, source_record.content_hash
           FROM transaction_revisions revision
           JOIN source_records source_record
             ON source_record.source_record_id = revision.source_record_id
           WHERE revision.transaction_id = ?
           ORDER BY revision.revision_number DESC LIMIT 1`,
        )
        .get(transactionId) as
        | {
            revision_id?: unknown;
            commit_id?: unknown;
            revision_number?: unknown;
            content_hash?: unknown;
          }
        | undefined;
      let revisionId: Uint8Array;
      let assertionId: Uint8Array;
      if (
        !existingRevision ||
        String(existingRevision.content_hash) !== record.contentHash
      ) {
        if (existingRevision) {
          const priorAssertion = db
            .prepare(
              "SELECT assertion_id FROM assertions WHERE origin = 'source' AND revision_id = ?",
            )
            .get(existingRevision.revision_id as Uint8Array) as
            { assertion_id?: unknown } | undefined;
          if (!priorAssertion)
            throw new Error("Canonical source assertion is missing.");
          insertLifecycle(db, {
            assertionId: priorAssertion.assertion_id as Uint8Array,
            transactionId,
            captureId,
            scopeId,
            commitId,
            kind: "superseded",
          });
        }
        revisionId = id();
        const revisionNumber = existingRevision
          ? Number(existingRevision.revision_number) + 1
          : 1;
        db.prepare(
          `INSERT INTO transaction_revisions(
            revision_id, transaction_id, source_record_id, capture_id, commit_id,
            revision_number, amount_coefficient, amount_scale, currency, direction,
            posting_status, posting_origin, posting_basis, posting_rule_version,
            description, economic_status, administrative_state,
            semantic_rule_version, effective_on, transaction_date_time_local,
            time_zone, time_precision, time_origin, effective_time_basis,
            effective_time_rule_version, utc_instant_utc_us
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          revisionId,
          transactionId,
          sourceRecordId,
          captureId,
          commitId,
          revisionNumber,
          record.amount.coefficient,
          record.amount.scale,
          record.currency,
          record.direction,
          capture.semantics.postingStatus,
          capture.semantics.postingOrigin,
          capture.semantics.postingBasis,
          capture.semantics.postingRuleVersion,
          record.description ?? null,
          capture.semantics.economicStatus,
          capture.semantics.administrativeState,
          capture.semantics.semanticRuleVersion,
          record.effectiveOn,
          record.transactionDateTimeLocal,
          capture.semantics.timeZone,
          record.sourceTime.precision ?? capture.semantics.timePrecision,
          record.sourceTime.timeOrigin ?? capture.semantics.timeOrigin,
          capture.semantics.effectiveTimeBasis,
          capture.semantics.effectiveTimeRuleVersion,
          record.sourceTime.epochMilliseconds * 1_000,
        );
        db.prepare(
          `INSERT INTO transaction_time_observations(
            observation_id, transaction_id, revision_id, source_record_id,
            commit_id, role, local_value, time_zone, time_precision,
            time_origin, utc_instant_utc_us
          ) VALUES (?, ?, ?, ?, ?, 'occurred', ?, ?, ?, ?, ?)`,
        ).run(
          id(),
          transactionId,
          revisionId,
          sourceRecordId,
          commitId,
          record.transactionDateTimeLocal,
          capture.semantics.timeZone,
          record.sourceTime.precision ?? capture.semantics.timePrecision,
          record.sourceTime.timeOrigin ?? capture.semantics.timeOrigin,
          record.sourceTime.epochMilliseconds * 1_000,
        );
        if (record.conversionEvidence) {
          const conversion = record.conversionEvidence;
          db.prepare(
            `INSERT INTO transaction_conversion_evidence(
              conversion_id, transaction_id, revision_id, source_record_id,
              capture_id, commit_id, original_amount_coefficient,
              original_amount_scale, original_currency, booked_amount_coefficient,
              booked_amount_scale, booked_currency, source_reported_rate_coefficient,
              source_reported_rate_scale, source_reported_rate_base_currency,
              source_reported_rate_quote_currency, source_reported_rate_date,
              implied_rate_coefficient, implied_rate_scale, implied_rate_base_currency,
              implied_rate_quote_currency, implied_rate_date, comparison,
              fee_amount_coefficient, fee_amount_scale, fee_currency, evidence_origin
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id(),
            transactionId,
            revisionId,
            sourceRecordId,
            captureId,
            commitId,
            conversion.originalAmount?.coefficient ?? null,
            conversion.originalAmount?.scale ?? null,
            conversion.originalCurrency,
            conversion.bookedAmount.coefficient,
            conversion.bookedAmount.scale,
            conversion.bookedCurrency,
            conversion.sourceReportedRate?.amount.coefficient ?? null,
            conversion.sourceReportedRate?.amount.scale ?? null,
            conversion.sourceReportedRate?.baseCurrency ?? null,
            conversion.sourceReportedRate?.quoteCurrency ?? null,
            conversion.sourceReportedRate?.observedOn ?? null,
            conversion.impliedRate?.amount.coefficient ?? null,
            conversion.impliedRate?.amount.scale ?? null,
            conversion.impliedRate?.baseCurrency ?? null,
            conversion.impliedRate?.quoteCurrency ?? null,
            conversion.impliedRate?.observedOn ?? null,
            conversion.comparison,
            conversion.feeAmount?.coefficient ?? null,
            conversion.feeAmount?.scale ?? null,
            conversion.feeCurrency ?? null,
            conversion.evidenceOrigin,
          );
        }
        assertionId = id();
        db.prepare(
          `INSERT INTO assertions(
            assertion_id, transaction_id, field_name, target_kind, origin,
            producer_id, rule_lineage, revision_id, value_text, created_commit_id
          ) VALUES (?, ?, 'transaction_revision', 'transaction', 'source', ?, ?, ?, NULL, ?)`,
        ).run(
          assertionId,
          transactionId,
          capture.authorityRoute,
          capture.semantics.semanticRuleVersion,
          revisionId,
          commitId,
        );
        insertLifecycle(db, {
          assertionId,
          transactionId,
          captureId,
          scopeId,
          commitId,
          kind: "observed",
        });
      } else {
        revisionId = existingRevision.revision_id as Uint8Array;
        const assertion = db
          .prepare(
            "SELECT assertion_id FROM assertions WHERE origin = 'source' AND revision_id = ?",
          )
          .get(revisionId) as { assertion_id?: unknown } | undefined;
        if (!assertion)
          throw new Error("Canonical source assertion is missing.");
        assertionId = assertion.assertion_id as Uint8Array;
        if (latestLifecycle(db, assertionId) === "withdrawn") {
          insertLifecycle(db, {
            assertionId,
            transactionId,
            captureId,
            scopeId,
            commitId,
            kind: "restored",
          });
        }
      }
      db.prepare(
        "INSERT INTO assertion_provenance(assertion_id, source_record_id, commit_id) VALUES (?, ?, ?)",
      ).run(assertionId, sourceRecordId, commitId);
    }

    if (capture.scope.withdrawalPolicy !== "never-infer") {
      const prior = db
        .prepare(
          `SELECT assertion.assertion_id, assertion.transaction_id,
          transaction_row.source_sequence, revision.revision_id
         FROM assertions assertion
         JOIN financial_transactions transaction_row
           ON transaction_row.transaction_id = assertion.transaction_id
         JOIN transaction_revisions revision ON revision.revision_id = assertion.revision_id
         JOIN assertions current_assertion
           ON current_assertion.revision_id = revision.revision_id
          AND current_assertion.origin = 'source'
         JOIN assertion_provenance provenance
           ON provenance.assertion_id = assertion.assertion_id
         JOIN source_record_scopes record_scope
           ON record_scope.source_record_id = provenance.source_record_id
         JOIN capture_scopes prior_scope ON prior_scope.scope_id = record_scope.scope_id
         JOIN source_captures prior_capture ON prior_capture.capture_id = prior_scope.capture_id
         WHERE assertion.origin = 'source' AND transaction_row.account_id = ?
           AND revision.effective_on BETWEEN ? AND ?
           AND prior_scope.source_connection_id = ?
           AND prior_scope.identity_epoch_id = ?
           AND prior_scope.account_id = ? AND prior_scope.stream = ?
           AND prior_scope.scope_start = ? AND prior_scope.scope_end = ?
           AND prior_scope.scope_kind = ?
           AND prior_scope.completeness = ?
           AND prior_scope.completeness_rule_version = ?
           AND prior_scope.contract_fingerprint = ?
           AND prior_scope.preflight_fingerprint = ?
           AND prior_capture.authority_route = ?
           AND COALESCE((
             SELECT lifecycle.event_kind
             FROM assertion_transitions lifecycle
             JOIN canonical_commits lifecycle_commit
               ON lifecycle_commit.commit_id = lifecycle.commit_id
             WHERE lifecycle.assertion_id = current_assertion.assertion_id
             ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC
             LIMIT 1
           ), 'observed') <> 'withdrawn'`,
        )
        .all(
          accountId,
          capture.scope.startDate,
          capture.scope.endDate,
          connectionId,
          epochId,
          accountId,
          capture.identity.stream,
          capture.scope.startDate,
          capture.scope.endDate,
          capture.scope.scopeKind,
          capture.scope.completeness,
          capture.scope.completenessRuleVersion,
          capture.scope.contractFingerprint,
          capture.scope.preflightFingerprint,
          capture.authorityRoute,
        ) as Array<Record<string, unknown>>;
      for (const row of prior) {
        if (seen.has(String(row.source_sequence))) continue;
        const assertionId = row.assertion_id as Uint8Array;
        if (latestLifecycle(db, assertionId) === "withdrawn") continue;
        insertLifecycle(db, {
          assertionId,
          transactionId: row.transaction_id as Uint8Array,
          captureId,
          scopeId,
          commitId,
          kind: "withdrawn",
        });
      }
    }

    db.prepare(
      `INSERT INTO source_sync_states(
        source_connection_id, account_id, stream, scope_start, scope_end,
        cursor, last_capture_id, commit_id
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(source_connection_id, account_id, stream) DO UPDATE SET
        scope_start = excluded.scope_start, scope_end = excluded.scope_end,
        cursor = excluded.cursor, last_capture_id = excluded.last_capture_id,
        commit_id = excluded.commit_id`,
    ).run(
      connectionId,
      accountId,
      capture.identity.stream,
      capture.scope.startDate,
      capture.scope.endDate,
      captureId,
      commitId,
    );
    createCanonicalProjectionRuntime(db).applyCommit({
      commitId,
      kind: "source_capture",
    });
    const provenanceCount =
      capture.records.length === 0
        ? 0
        : Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS count
                   FROM assertion_provenance provenance
                   JOIN assertions assertion
                     ON assertion.assertion_id = provenance.assertion_id
                   JOIN financial_transactions transaction_row
                     ON transaction_row.transaction_id = assertion.transaction_id
                   WHERE transaction_row.account_id = ?
                     AND EXISTS (
                       SELECT 1 FROM source_records affected_record
                       WHERE affected_record.capture_id = ?
                         AND affected_record.occurrence_key = transaction_row.source_sequence
                     )`,
                )
                .get(accountId, captureId) as { count?: number }
            ).count ?? 0,
          );
    return {
      status: "canonical-live",
      canonicalAdmission: "admitted",
      captureId: capture.captureId,
      commitSequence,
      transactionCount: capture.records.length,
      provenanceCount,
    };
  } catch (error) {
    throw error;
  }
}

export async function commitCanonicalFinancialDepositCapture(
  store: CanonicalFinancialDepositWriterStore,
  capture: CanonicalFinancialDepositValidatedCapture,
  beforeCommit?: (
    db: ValidatedCanonicalDatabase,
    results: readonly CanonicalFinancialDepositCommitResult[],
  ) => void,
): Promise<CanonicalFinancialDepositCommitResult> {
  requireValidatedFinancialWriterStore(store);
  const [result] = await commitCanonicalFinancialDepositCaptureBatch(
    store,
    [capture],
    beforeCommit,
  );
  return result!;
}

/** Commit a provider's already-admitted account captures as one SQLite unit.
 * A collision or overwrite in any later account rolls the entire batch back.
 * The optional extension hook is retained for generic statement families
 * whose schemas are outside the closed loan/investment admission variants.
 * Domain adapters use canonical-financial-admission.ts instead. */
export async function commitCanonicalFinancialDepositCaptureBatch(
  store: CanonicalFinancialDepositWriterStore,
  captures: readonly CanonicalFinancialDepositValidatedCapture[],
  beforeCommit?: (
    db: ValidatedCanonicalDatabase,
    results: readonly CanonicalFinancialDepositCommitResult[],
  ) => void,
): Promise<CanonicalFinancialDepositCommitResult[]> {
  requireValidatedFinancialWriterStore(store);
  if (captures.length === 0)
    throw new Error("Financial deposit capture batch cannot be empty.");
  return withCanonicalSourceCaptureAdmissionTransaction(
    store as unknown as CanonicalSourceStore,
    (capability) =>
      commitCanonicalFinancialDepositCaptureBatchInTransaction(
        store,
        captures,
        capability,
        beforeCommit,
      ),
  );
}

/**
 * Commit an already-admitted financial batch inside an existing source
 * admission transaction.  Provider workflows use this seam when source-only
 * captures and financial captures belong to the same source run: the caller
 * can admit the source-only evidence with the same capability, then commit
 * every financial capture before the single SQLite COMMIT.  The public batch
 * function above remains the normal one-store entry point and owns its
 * transaction when a caller does not already have one.
 */
export function commitCanonicalFinancialDepositCaptureBatchInTransaction(
  store: CanonicalFinancialDepositWriterStore,
  captures: readonly CanonicalFinancialDepositValidatedCapture[],
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
  beforeCommit?: (
    db: ValidatedCanonicalDatabase,
    results: readonly CanonicalFinancialDepositCommitResult[],
  ) => void,
): CanonicalFinancialDepositCommitResult[] {
  requireValidatedFinancialWriterStore(store);
  if (captures.length === 0)
    throw new Error("Financial deposit capture batch cannot be empty.");
  for (const capture of captures) {
    if (!hasValidatedBrand(capture))
      throw new CanonicalFinancialDepositConflictError(
        "Financial deposit batch contains a capture outside the runtime-validated seam.",
      );
    validateCapture(capture);
  }
  const results = captures.map((capture) =>
    commitOnce(store, capture, capability),
  );
  beforeCommit?.(store.db, results);
  return results;
}

/**
 * Commit one validated financial Capture in an execution-owned transaction.
 * The supplied capability is the only admission authority, so this adapter
 * performs exactly one source admission and never opens, queues, or closes a
 * store.  Batch callers retain the batch adapter above for their existing
 * all-or-nothing semantics.
 */
export function commitCanonicalFinancialDepositCaptureInTransaction(
  store: CanonicalFinancialDepositWriterStore,
  capture: CanonicalFinancialDepositValidatedCapture,
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
  beforeCommit?: (
    db: ValidatedCanonicalDatabase,
    results: readonly CanonicalFinancialDepositCommitResult[],
  ) => void,
): CanonicalFinancialDepositCommitResult {
  const [result] = commitCanonicalFinancialDepositCaptureBatchInTransaction(
    store,
    [capture],
    capability,
    beforeCommit,
  );
  return result!;
}
