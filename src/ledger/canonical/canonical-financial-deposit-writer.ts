import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { withCanonicalWriterQueue } from "./canonical-runtime.ts";
import { syncCanonicalProjectionFromCompatibility } from "./canonical-source-store.ts";

export type FinancialDepositAmount = {
  coefficient: string;
  scale: number;
};

export type FinancialDepositSourceTime = {
  localDate: string;
  localTime: string;
  timeZone: string;
  epochMilliseconds: number;
};

export type CanonicalFinancialDepositPage = {
  pageOrdinal: number;
  responseCode: string;
  terminal: boolean;
  rowCount: number;
  responseDigest: string;
  proofKind: string;
  contractFingerprint: string;
  preflightFingerprint: string;
  metadataJson: string;
};

export type CanonicalFinancialDepositRecord = {
  occurrenceKey: string;
  collisionKey: string;
  providerKey: string;
  contentHash: string;
  sequenceLexeme: string;
  compactJson: string;
  amount: FinancialDepositAmount;
  balanceAfter: FinancialDepositAmount | null;
  currency: string;
  direction: string;
  sourceTime: FinancialDepositSourceTime;
  effectiveOn: string;
  transactionDateTimeLocal: string;
};

export type CanonicalFinancialDepositCapture = {
  captureId: string;
  authorityRoute: string;
  contractVersion: string;
  identity: {
    integrationNamespace: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    stream: string;
    recordKind: string;
    subjectDigest: string;
    accountNo: string;
    accountType: string;
    currency: string;
  };
  observedAt: string;
  scope: {
    startDate: string;
    endDate: string;
    scopeKind: "bounded-range";
    completeness: "complete-range";
    completenessBasis: string;
    completenessRuleVersion: string;
    absenceAuthority: string;
    contractFingerprint: string;
    preflightFingerprint: string;
    pageCount: number;
    /** Fubon human-attested observations never infer withdrawal from absence. */
    withdrawalPolicy?: "allow-inference" | "never-infer";
  };
  semantics: {
    postingStatus: string;
    postingOrigin: string;
    postingBasis: string;
    postingRuleVersion: string;
    economicStatus: string;
    administrativeState: string;
    semanticRuleVersion: string;
    effectiveTimeBasis: string;
    effectiveTimeRuleVersion: string;
    timeZone: string;
    timePrecision: string;
    timeOrigin: string;
    requireBalance: boolean;
  };
  pages: readonly CanonicalFinancialDepositPage[];
  records: readonly CanonicalFinancialDepositRecord[];
};

// Admission is intentionally held out-of-band. A copied object, even one
// carrying every enumerable/non-enumerable key, symbol, and descriptor from
// an admitted capture, cannot acquire this membership.
const VALIDATED_CAPTURES = new WeakSet<object>();

export type CanonicalFinancialDepositValidatedCapture =
  CanonicalFinancialDepositCapture & {
    readonly __runtimeValidatedCanonicalFinancialDeposit: true;
  };

export type CanonicalFinancialDepositWriterStore = {
  readonly db: DatabaseSync;
  readonly databasePath: string;
  readonly commitClock: () => number;
};

export type CanonicalFinancialDepositCommitResult = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  captureId: string;
  commitSequence: number;
  transactionCount: number;
  provenanceCount: number;
};

export class CanonicalFinancialDepositConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalFinancialDepositConflictError";
  }
}

function id(): Uint8Array {
  return randomBytes(16);
}

function validateOpaque(value: string, label: string): void {
  if (!/^sha256:[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${label} must be an opaque sha256 token.`);
}

function validateCapture(capture: CanonicalFinancialDepositCapture): void {
  if (!capture.captureId.trim()) throw new Error("Capture ID is required.");
  if (!capture.authorityRoute.trim())
    throw new Error("Authority route is required.");
  if (!capture.contractVersion.trim())
    throw new Error("Contract version is required.");
  if (capture.scope.startDate > capture.scope.endDate)
    throw new Error("Capture scope is inverted.");
  if (capture.pages.length !== capture.scope.pageCount)
    throw new Error("Capture page count does not match scope.");
  if (capture.pages.length === 0)
    throw new Error("At least one capture page is required.");
  const routeRules: Record<
    string,
    {
      postingOrigin: string;
      postingBasis: string;
      ruleVersion: string;
      effectiveTimeBasis: string;
    }
  > = {
    "cathay/domestic-deposit/v1": {
      postingOrigin: "provider_booked_history",
      postingBasis: "query-status-success-with-accounting-date",
      ruleVersion: "cathay/domestic-deposit/v1",
      effectiveTimeBasis: "accounting",
    },
    "linebank/domestic-deposit/human-attested-v13": {
      postingOrigin: "human_attested_history",
      postingBasis: "human-attested-formally-posted",
      ruleVersion: "linebank/domestic-deposit/human-attested-v13",
      effectiveTimeBasis: "transaction-time",
    },
    "fubon/domestic-deposit/human-attested-v1": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      ruleVersion: "fubon/domestic-deposit/human-attested-v1",
      effectiveTimeBasis: "transaction-time",
    },
  };
  const routeRule = routeRules[capture.authorityRoute];
  if (
    routeRule &&
    (capture.semantics.postingOrigin !== routeRule.postingOrigin ||
      capture.semantics.postingBasis !== routeRule.postingBasis ||
      capture.semantics.postingRuleVersion !== routeRule.ruleVersion ||
      capture.semantics.semanticRuleVersion !== routeRule.ruleVersion ||
      capture.semantics.effectiveTimeBasis !== routeRule.effectiveTimeBasis ||
      capture.semantics.effectiveTimeRuleVersion !== routeRule.ruleVersion)
  )
    throw new Error("Financial semantics do not match the authority route.");
  if (
    capture.scope.withdrawalPolicy !== undefined &&
    capture.scope.withdrawalPolicy !== "allow-inference" &&
    capture.scope.withdrawalPolicy !== "never-infer"
  )
    throw new Error("Capture withdrawal policy is invalid.");
  validateOpaque(capture.identity.sourceConnectionKey, "Source connection key");
  validateOpaque(capture.identity.identityEpochKey, "Identity epoch key");
  validateOpaque(capture.identity.subjectDigest, "Subject digest");
  for (const page of capture.pages) {
    if (page.pageOrdinal < 0 || page.pageOrdinal >= capture.scope.pageCount)
      throw new Error("Capture page ordinal is invalid.");
  }
  const occurrences = new Set<string>();
  const collisions = new Set<string>();
  for (const record of capture.records) {
    validateOpaque(record.occurrenceKey, "Occurrence key");
    validateOpaque(record.collisionKey, "Collision key");
    validateOpaque(record.providerKey, "Provider key");
    validateOpaque(record.contentHash, "Content hash");
    if (occurrences.has(record.occurrenceKey))
      throw new CanonicalFinancialDepositConflictError(
        "Duplicate source occurrence in one capture.",
      );
    if (collisions.has(record.collisionKey))
      throw new CanonicalFinancialDepositConflictError(
        "Duplicate source collision identity in one capture.",
      );
    occurrences.add(record.occurrenceKey);
    collisions.add(record.collisionKey);
    if (capture.semantics.requireBalance && record.balanceAfter === null)
      throw new Error("Financial record lacks an exact balance.");
  }
}

export function admitCanonicalFinancialDepositCapture(
  capture: CanonicalFinancialDepositCapture,
): CanonicalFinancialDepositValidatedCapture {
  if (capture === null || typeof capture !== "object")
    throw new Error("A financial deposit capture object is required.");
  validateCapture(capture);
  for (const page of capture.pages) Object.freeze(page);
  for (const record of capture.records) {
    Object.freeze(record.amount);
    if (record.balanceAfter) Object.freeze(record.balanceAfter);
    Object.freeze(record.sourceTime);
    Object.freeze(record);
  }
  Object.freeze(capture.pages);
  Object.freeze(capture.records);
  Object.freeze(capture.identity);
  Object.freeze(capture.scope);
  Object.freeze(capture.semantics);
  Object.freeze(capture);
  VALIDATED_CAPTURES.add(capture);
  return capture as CanonicalFinancialDepositValidatedCapture;
}

function hasValidatedBrand(
  capture: unknown,
): capture is CanonicalFinancialDepositValidatedCapture {
  return (
    capture !== null &&
    typeof capture === "object" &&
    VALIDATED_CAPTURES.has(capture)
  );
}

function insertLifecycle(
  db: DatabaseSync,
  values: {
    assertionId: Uint8Array;
    transactionId: Uint8Array;
    captureId: Uint8Array;
    scopeId: Uint8Array;
    commitId: Uint8Array;
    kind: "observed" | "withdrawn" | "restored";
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

function commitOnce(
  store: CanonicalFinancialDepositWriterStore,
  capture: CanonicalFinancialDepositValidatedCapture,
): CanonicalFinancialDepositCommitResult {
  if (!hasValidatedBrand(capture))
    throw new CanonicalFinancialDepositConflictError(
      "Financial deposit capture did not cross the runtime-validated seam.",
    );
  validateCapture(capture);
  const db = store.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      db
        .prepare("SELECT 1 FROM source_captures WHERE capture_key = ?")
        .get(capture.captureId)
    )
      throw new CanonicalFinancialDepositConflictError(
        "Capture overwrite is forbidden.",
      );

    const commitId = id();
    const commitSequence = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(commit_sequence), 0) + 1 AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? 1,
    );
    const previousKnowledge = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(recorded_at_utc_us), -1) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? -1,
    );
    const clockValue = store.commitClock();
    if (!Number.isSafeInteger(clockValue) || clockValue < 0)
      throw new Error("Canonical admission clock returned invalid UTC micros.");
    db.prepare(
      `INSERT INTO canonical_commits(
        commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind
      ) VALUES (?, ?, ?, ?, 'source_capture')`,
    ).run(
      commitId,
      commitSequence,
      Math.max(clockValue, previousKnowledge + 1),
      capture.authorityRoute,
    );
    db.prepare(
      `INSERT INTO source_authority_routes(
        authority_route, integration_namespace, stream, contract_version, created_commit_id
      ) VALUES (?, ?, ?, ?, ?) ON CONFLICT(authority_route) DO NOTHING`,
    ).run(
      capture.authorityRoute,
      capture.identity.integrationNamespace,
      capture.identity.stream,
      capture.contractVersion,
      commitId,
    );

    const existingConnection = db
      .prepare(
        `SELECT source_connection_id FROM source_connections
         WHERE integration_namespace = ? AND source_connection_key = ?`,
      )
      .get(
        capture.identity.integrationNamespace,
        capture.identity.sourceConnectionKey,
      ) as { source_connection_id?: unknown } | undefined;
    const connectionId = existingConnection
      ? (existingConnection.source_connection_id as Uint8Array)
      : id();
    if (!existingConnection)
      db.prepare(
        `INSERT INTO source_connections(
          source_connection_id, integration_namespace, source_connection_key, created_commit_id
        ) VALUES (?, ?, ?, ?)`,
      ).run(
        connectionId,
        capture.identity.integrationNamespace,
        capture.identity.sourceConnectionKey,
        commitId,
      );

    const existingEpoch = db
      .prepare(
        `SELECT identity_epoch_id FROM identity_epochs
         WHERE source_connection_id = ? AND epoch_key = ?`,
      )
      .get(connectionId, capture.identity.identityEpochKey) as
      { identity_epoch_id?: unknown } | undefined;
    const epochId = existingEpoch
      ? (existingEpoch.identity_epoch_id as Uint8Array)
      : id();
    if (!existingEpoch)
      db.prepare(
        `INSERT INTO identity_epochs(
          identity_epoch_id, source_connection_id, epoch_key, created_commit_id
        ) VALUES (?, ?, ?, ?)`,
      ).run(epochId, connectionId, capture.identity.identityEpochKey, commitId);
    db.prepare(
      `INSERT INTO source_route_bindings(
        authority_route, source_connection_id, created_commit_id
      ) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    ).run(capture.authorityRoute, connectionId, commitId);

    const existingSubject = db
      .prepare(
        `SELECT source_subject_id FROM source_subjects
         WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ?
           AND record_kind = ? AND subject_digest = ?`,
      )
      .get(
        connectionId,
        epochId,
        capture.identity.stream,
        capture.identity.recordKind,
        capture.identity.subjectDigest,
      ) as { source_subject_id?: unknown } | undefined;
    const subjectId = existingSubject
      ? (existingSubject.source_subject_id as Uint8Array)
      : id();
    if (!existingSubject)
      db.prepare(
        `INSERT INTO source_subjects(
          source_subject_id, source_connection_id, identity_epoch_id, stream,
          record_kind, subject_digest, created_commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        subjectId,
        connectionId,
        epochId,
        capture.identity.stream,
        capture.identity.recordKind,
        capture.identity.subjectDigest,
        commitId,
      );

    for (const record of capture.records) {
      const collisions = db
        .prepare(
          `SELECT occurrence_key FROM source_records
           WHERE source_subject_id = ? AND collision_key = ?`,
        )
        .all(subjectId, record.collisionKey) as Array<{
        occurrence_key?: unknown;
      }>;
      if (
        collisions.some(
          (row) => String(row.occurrence_key) !== record.occurrenceKey,
        )
      )
        throw new CanonicalFinancialDepositConflictError(
          "Source occurrence collision is forbidden.",
        );
      const prior = db
        .prepare(
          `SELECT provider_key, content_hash FROM source_records
           WHERE source_subject_id = ? AND occurrence_key = ?`,
        )
        .all(subjectId, record.occurrenceKey) as Array<{
        provider_key?: unknown;
        content_hash?: unknown;
      }>;
      if (
        prior.some(
          (row) =>
            String(row.provider_key) !== record.providerKey ||
            String(row.content_hash) !== record.contentHash,
        )
      )
        throw new CanonicalFinancialDepositConflictError(
          "Source occurrence content overwrite is forbidden.",
        );
    }

    const existingAccount = db
      .prepare(
        `SELECT account_id, currency, account_type FROM financial_accounts
         WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND account_no = ?`,
      )
      .get(
        connectionId,
        epochId,
        capture.identity.stream,
        capture.identity.accountNo,
      ) as
      | { account_id?: unknown; currency?: unknown; account_type?: unknown }
      | undefined;
    if (
      existingAccount &&
      (existingAccount.currency !== capture.identity.currency ||
        existingAccount.account_type !== capture.identity.accountType)
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
          account_id, source_connection_id, identity_epoch_id, stream, account_no,
          account_type, currency, created_commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        accountId,
        connectionId,
        epochId,
        capture.identity.stream,
        capture.identity.accountNo,
        capture.identity.accountType,
        capture.identity.currency,
        commitId,
      );

    const captureId = id();
    const scopeId = id();
    db.prepare(
      `INSERT INTO source_captures(
        capture_id, capture_key, source_connection_id, identity_epoch_id,
        authority_route, source_subject_id, stream, record_kind, account_no,
        observed_at, scope_start, scope_end, completeness, completeness_basis,
        completeness_rule_version, commit_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      captureId,
      capture.captureId,
      connectionId,
      epochId,
      capture.authorityRoute,
      subjectId,
      capture.identity.stream,
      capture.identity.recordKind,
      capture.identity.accountNo,
      capture.observedAt,
      capture.scope.startDate,
      capture.scope.endDate,
      capture.scope.completeness,
      capture.scope.completenessBasis,
      capture.scope.completenessRuleVersion,
      commitId,
    );
    db.prepare(
      `INSERT INTO capture_scopes(
        scope_id, capture_id, source_connection_id, identity_epoch_id, account_id,
        source_subject_id, account_no, stream, scope_start, scope_end, scope_kind,
        completeness, completeness_basis, completeness_rule_version,
        absence_authority, contract_fingerprint, preflight_fingerprint,
        page_count, terminal, commit_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scopeId,
      captureId,
      connectionId,
      epochId,
      accountId,
      subjectId,
      capture.identity.accountNo,
      capture.identity.stream,
      capture.scope.startDate,
      capture.scope.endDate,
      capture.scope.scopeKind,
      capture.scope.completeness,
      capture.scope.completenessBasis,
      capture.scope.completenessRuleVersion,
      capture.scope.absenceAuthority,
      capture.scope.contractFingerprint,
      capture.scope.preflightFingerprint,
      capture.scope.pageCount,
      capture.pages.at(-1)?.terminal ? 1 : 0,
      commitId,
    );
    for (const page of capture.pages)
      db.prepare(
        `INSERT INTO capture_scope_pages(
          scope_page_id, scope_id, page_ordinal, response_code, terminal,
          row_count, response_digest, proof_kind, contract_fingerprint,
          preflight_fingerprint, metadata_json, commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id(),
        scopeId,
        page.pageOrdinal,
        page.responseCode,
        page.terminal ? 1 : 0,
        page.rowCount,
        page.responseDigest,
        page.proofKind,
        page.contractFingerprint,
        page.preflightFingerprint,
        page.metadataJson,
        commitId,
      );

    const seen = new Set<string>();
    for (const record of capture.records) {
      seen.add(record.occurrenceKey);
      const sourceRecordId = id();
      db.prepare(
        `INSERT INTO source_records(
          source_record_id, capture_id, source_subject_id, commit_id, record_kind,
          sequence_lexeme, provider_key, content_hash, occurrence_key,
          collision_key, description, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        sourceRecordId,
        captureId,
        subjectId,
        commitId,
        capture.identity.recordKind,
        record.sequenceLexeme,
        record.providerKey,
        record.contentHash,
        record.occurrenceKey,
        record.collisionKey,
        record.compactJson,
      );
      db.prepare(
        `INSERT INTO source_record_scopes(
          source_record_id, scope_id, capture_id, account_id, source_subject_id,
          sequence_lexeme, occurrence_key, commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceRecordId,
        scopeId,
        captureId,
        accountId,
        subjectId,
        record.sequenceLexeme,
        record.occurrenceKey,
        commitId,
      );
      db.prepare(
        "INSERT INTO source_record_provenance(source_record_id, capture_id, commit_id) VALUES (?, ?, ?)",
      ).run(sourceRecordId, captureId, commitId);

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
          "SELECT revision_id, commit_id FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision_number DESC LIMIT 1",
        )
        .get(transactionId) as
        { revision_id?: unknown; commit_id?: unknown } | undefined;
      let revisionId: Uint8Array;
      let assertionId: Uint8Array;
      if (!existingRevision) {
        revisionId = id();
        db.prepare(
          `INSERT INTO transaction_revisions(
            revision_id, transaction_id, source_record_id, capture_id, commit_id,
            revision_number, amount_coefficient, amount_scale, currency, direction,
            posting_status, posting_origin, posting_basis, posting_rule_version,
            description, economic_status, administrative_state,
            semantic_rule_version, effective_on, transaction_date_time_local,
            time_zone, time_precision, time_origin, effective_time_basis,
            effective_time_rule_version, utc_instant_utc_us
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          revisionId,
          transactionId,
          sourceRecordId,
          captureId,
          commitId,
          record.amount.coefficient,
          record.amount.scale,
          record.currency,
          record.direction,
          capture.semantics.postingStatus,
          capture.semantics.postingOrigin,
          capture.semantics.postingBasis,
          capture.semantics.postingRuleVersion,
          capture.semantics.economicStatus,
          capture.semantics.administrativeState,
          capture.semantics.semanticRuleVersion,
          record.effectiveOn,
          record.transactionDateTimeLocal,
          capture.semantics.timeZone,
          capture.semantics.timePrecision,
          capture.semantics.timeOrigin,
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
          capture.semantics.timePrecision,
          capture.semantics.timeOrigin,
          record.sourceTime.epochMilliseconds * 1_000,
        );
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
        db.prepare(
          `INSERT INTO current_transactions(
            transaction_id, revision_id, commit_id, projection_commit_id,
            revision_commit_id
          ) VALUES (?, ?, ?, ?, ?)`,
        ).run(transactionId, revisionId, commitId, commitId, commitId);
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
          db.prepare(
            `INSERT INTO current_transactions(
              transaction_id, revision_id, commit_id, projection_commit_id,
              revision_commit_id
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(transaction_id) DO UPDATE SET
              revision_id = excluded.revision_id,
              commit_id = excluded.commit_id,
              projection_commit_id = excluded.projection_commit_id,
              revision_commit_id = excluded.revision_commit_id`,
          ).run(
            transactionId,
            revisionId,
            commitId,
            commitId,
            existingRevision.commit_id as Uint8Array,
          );
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
         JOIN current_transactions current_row
           ON current_row.transaction_id = transaction_row.transaction_id
          AND current_row.revision_id = revision.revision_id
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
           AND prior_capture.authority_route = ?`,
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
        db.prepare(
          "DELETE FROM current_transactions WHERE transaction_id = ? AND revision_id = ?",
        ).run(row.transaction_id as Uint8Array, row.revision_id as Uint8Array);
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
    syncCanonicalProjectionFromCompatibility(db, commitId);
    db.prepare(
      `INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?)
       ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id`,
    ).run(commitId);
    db.exec("COMMIT");
    return {
      status: "canonical-live",
      canonicalAdmission: "admitted",
      captureId: capture.captureId,
      commitSequence,
      transactionCount: capture.records.length,
      provenanceCount: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM source_captures WHERE record_kind = ?",
            )
            .get(capture.identity.recordKind) as { count?: number }
        ).count ?? 0,
      ),
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve original failure */
    }
    throw error;
  }
}

export async function commitCanonicalFinancialDepositCapture(
  store: CanonicalFinancialDepositWriterStore,
  capture: CanonicalFinancialDepositValidatedCapture,
): Promise<CanonicalFinancialDepositCommitResult> {
  return withCanonicalWriterQueue(store.databasePath, () =>
    commitOnce(store, capture),
  );
}
