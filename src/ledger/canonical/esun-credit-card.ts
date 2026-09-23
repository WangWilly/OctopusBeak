import type { DatabaseSync } from "node:sqlite";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import {
  commitCanonicalFinancialDepositCaptureBatchInTransaction,
  type CanonicalFinancialDepositCommitResult,
} from "./canonical-financial-deposit-writer.ts";
import {
  withCanonicalSourceCaptureAdmissionTransaction,
  type CanonicalSourceCaptureAdmissionTransactionCapability,
} from "./canonical-source-capture-admission.ts";
import { commitCanonicalCreditCardDirectionEnrichmentForCapturesInTransaction } from "./credit-card-direction-enrichment.ts";
import {
  ensureCanonicalCreditCardSchema,
  persistCanonicalCreditCardExtensions,
  type CanonicalCreditCardPersistenceCapture,
} from "./canonical-credit-card-persistence.ts";
import {
  isEsunCreditCardHumanAttestationDurablyActive,
  isEsunCreditCardHumanAttestedV2Active,
  recordInitialEsunCreditCardHumanAttestationIfMissing,
} from "./esun-credit-card-human-attestation.ts";
import {
  buildEsunCreditCardTransactionSourceKey,
  buildEsunCreditCardTransactionSourceKeyV1,
  esunCanonicalSpineCapture,
  esunNeutralCreditCardCapture,
  isAdmittedEsunCreditCardCapture,
  opaqueEsunSpineToken,
  EsunCreditCardAdmissionError,
  type EsunCreditCardTransactionInput,
  type EsunCreditCardValidatedCapture,
} from "./esun-credit-card-admission.ts";

export * from "./esun-credit-card-admission.ts";

export type EsunCreditCardWriterStore = Pick<
  CanonicalSourceStore,
  "db" | "commitClock" | "withWriter"
> & {
  readonly beforeEsunCreditExtensionCommit?: (db: DatabaseSync) => void;
};

export type EsunCreditCardCommitResult = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  captureId: string;
  accountId: string;
  commitSequence: number;
  transactionCount: number;
  statementCount: number;
  provenanceCount: number;
};

function esunFinancialAccountId(
  db: DatabaseSync,
  capture: EsunCreditCardValidatedCapture,
): Uint8Array | undefined {
  const row = db.prepare(`
    SELECT account.account_id
    FROM financial_accounts account
    JOIN source_connections connection_row
      ON connection_row.source_connection_id = account.source_connection_id
    JOIN identity_epochs epoch
      ON epoch.identity_epoch_id = account.identity_epoch_id
    WHERE connection_row.integration_namespace = 'esun'
      AND connection_row.source_connection_key = ?
      AND epoch.epoch_key = ?
      AND account.stream = 'credit-card'
      AND account.source_account_key = ?
    LIMIT 1
  `).get(
    opaqueEsunSpineToken(
      "esun-credit-connection-v1",
      capture.identity.sourceConnectionKey,
    ),
    opaqueEsunSpineToken(
      "esun-credit-epoch-v1",
      capture.identity.identityEpochKey,
    ),
    capture.identity.accountNaturalKey,
  ) as { account_id?: unknown } | undefined;
  return row?.account_id instanceof Uint8Array
    ? row.account_id
    : undefined;
}

function esunLegacySourceKeyCandidates(
  capture: EsunCreditCardValidatedCapture,
  transaction: EsunCreditCardTransactionInput,
): readonly string[] {
  const statementKeys = [transaction.statementKey, undefined];
  const statuses = ["billed", "unbilled"] as const;
  return [...new Set(
    statuses.flatMap((billingStatus) =>
      statementKeys.map((statementKey) =>
        buildEsunCreditCardTransactionSourceKeyV1(capture.identity, {
          ...transaction,
          billingStatus,
          statementKey,
        }),
      ),
    ),
  )];
}

/**
 * Reconcile the one legacy identity shape that this provider emitted before
 * billing status left the economic tuple.  The financial authority key is
 * upgraded in-place only after an exact account-scoped v1 match; source rows
 * and their immutable payloads are never rewritten.
 */
function reconcileEsunLegacySourceSequences(
  db: DatabaseSync,
  captures: readonly EsunCreditCardValidatedCapture[],
): void {
  for (const capture of captures) {
    const accountId = esunFinancialAccountId(db, capture);
    if (!accountId) continue;
    for (const transaction of capture.transactions) {
      const currentSourceKey = transaction.sourceKey;
      if (
        db.prepare(
          "SELECT 1 FROM financial_transactions WHERE account_id = ? AND source_sequence = ?",
        ).get(accountId, currentSourceKey)
      )
        continue;
      const legacyMatches = esunLegacySourceKeyCandidates(capture, transaction)
        .flatMap((legacySourceKey) => {
          const row = db.prepare(
            "SELECT source_sequence FROM financial_transactions WHERE account_id = ? AND source_sequence = ?",
          ).get(accountId, legacySourceKey) as {
            source_sequence?: unknown;
          } | undefined;
          return row?.source_sequence === undefined
            ? []
            : [String(row.source_sequence)];
        });
      const distinctLegacyMatches = [...new Set(legacyMatches)];
      if (distinctLegacyMatches.length === 0) continue;
      if (distinctLegacyMatches.length > 1)
        throw new EsunCreditCardAdmissionError(
          "E.SUN legacy v1 source identities are ambiguous for one economic transaction.",
        );
      const [legacySourceKey] = distinctLegacyMatches;
      const conflictingCurrent = db.prepare(
        "SELECT 1 FROM financial_transactions WHERE account_id = ? AND source_sequence = ?",
      ).get(accountId, currentSourceKey);
      if (conflictingCurrent)
        throw new EsunCreditCardAdmissionError(
          "E.SUN v1 source identity reconciliation would collide with a v2 transaction.",
        );
      const result = db.prepare(
        "UPDATE financial_transactions SET source_sequence = ? WHERE account_id = ? AND source_sequence = ?",
      ).run(currentSourceKey, accountId, legacySourceKey);
      if (Number(result.changes ?? 0) !== 1)
        throw new EsunCreditCardAdmissionError(
          "E.SUN v1 source identity reconciliation did not update exactly one transaction.",
        );
    }
  }
}

function esunNeutralCreditCardCaptureForCommit(
  db: DatabaseSync,
  capture: EsunCreditCardValidatedCapture,
): CanonicalCreditCardPersistenceCapture {
  const projected = esunNeutralCreditCardCapture(capture);
  const currentRevisionKeys = new Set(
    projected.transactions
      .filter((transaction) =>
        db.prepare(`
          SELECT 1
          FROM source_records record
          JOIN transaction_revisions revision
            ON revision.source_record_id = record.source_record_id
          JOIN financial_transactions financial
            ON financial.transaction_id = revision.transaction_id
          WHERE record.capture_id = (
            SELECT capture_id FROM source_captures WHERE capture_key = ?
          )
            AND record.occurrence_key = ?
            AND financial.source_sequence = ?
        `).get(
          capture.captureId,
          transaction.sourceRecordKey,
          transaction.sourceKey,
        ) !== undefined,
      )
      .map((transaction) => transaction.sourceRecordKey),
  );
  if (currentRevisionKeys.size === projected.transactions.length)
    return projected;
  return {
    ...projected,
    // The generic writer intentionally deduplicates an identical occurrence
    // without creating a second revision.  The neutral persistence contract
    // can only link extension facts to a revision in this capture, so retain
    // only rows with a current-capture revision on repeat observations.
    transactions: projected.transactions.filter((transaction) =>
      currentRevisionKeys.has(transaction.sourceRecordKey),
    ),
    statements: projected.statements.filter((statement) =>
      statement.transactionSourceKeys.every((key) => currentRevisionKeys.has(key)),
    ),
  };
}

function hasValidatedEsunCreditCardCapture(
  capture: unknown,
): capture is EsunCreditCardValidatedCapture {
  return isAdmittedEsunCreditCardCapture(capture);
}

export async function commitEsunCreditCardCapture(
  store: EsunCreditCardWriterStore,
  capture: EsunCreditCardValidatedCapture,
): Promise<EsunCreditCardCommitResult> {
  return (await commitEsunCreditCardCaptureBatch(store, [capture]))[0]!;
}

function toEsunCreditCardCommitResult(
  store: EsunCreditCardWriterStore,
  capture: EsunCreditCardValidatedCapture,
  result: CanonicalFinancialDepositCommitResult,
): EsunCreditCardCommitResult {
  const row = store.db.prepare(
    `SELECT hex(scope.account_id) AS account_id
     FROM source_captures capture
     JOIN capture_scopes scope ON scope.capture_id = capture.capture_id
     WHERE capture.capture_key = ?`,
  ).get(capture.captureId) as { account_id?: string } | undefined;
  if (!row?.account_id)
    throw new Error("E.SUN shared canonical account is missing after commit.");
  return {
    status: "canonical-live",
    canonicalAdmission: "admitted",
    captureId: capture.captureId,
    accountId: row.account_id.toLowerCase(),
    commitSequence: result.commitSequence,
    transactionCount: result.transactionCount,
    statementCount: capture.statements.length,
    provenanceCount: result.provenanceCount,
  };
}

export function commitEsunCreditCardCaptureBatchInTransaction(
  store: EsunCreditCardWriterStore,
  captures: readonly EsunCreditCardValidatedCapture[],
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): EsunCreditCardCommitResult[] {
  if (captures.length === 0)
    throw new EsunCreditCardAdmissionError(
      "E.SUN credit-card capture batch cannot be empty.",
    );
  for (const capture of captures) {
    if (!hasValidatedEsunCreditCardCapture(capture))
      throw new EsunCreditCardAdmissionError(
        "E.SUN credit-card batch contains an unvalidated capture.",
      );
  }
  if (!isEsunCreditCardHumanAttestedV2Active())
    throw new EsunCreditCardAdmissionError(
      "E.SUN credit-card human-attested v1 contract is revoked.",
    );
  reconcileEsunLegacySourceSequences(store.db, captures);
  const committed = commitCanonicalFinancialDepositCaptureBatchInTransaction(
    store,
    captures.map(esunCanonicalSpineCapture),
    capability,
    (db) => {
      ensureCanonicalCreditCardSchema(db);
      recordInitialEsunCreditCardHumanAttestationIfMissing(db);
      if (!isEsunCreditCardHumanAttestationDurablyActive(db))
        throw new EsunCreditCardAdmissionError(
          "E.SUN credit-card durable human attestation is revoked.",
        );
      store.beforeEsunCreditExtensionCommit?.(db);
      persistCanonicalCreditCardExtensions(
        db,
        captures.map((capture) => esunNeutralCreditCardCaptureForCommit(db, capture)),
      );
      commitCanonicalCreditCardDirectionEnrichmentForCapturesInTransaction(
        db,
        captures.map((capture) => capture.captureId),
      );
    },
  );
  return committed.map((result, index) =>
    toEsunCreditCardCommitResult(store, captures[index]!, result),
  );
}

/** Commit one E.SUN capture inside an execution-owned transaction. */
export function commitEsunCreditCardCaptureInTransaction(
  store: EsunCreditCardWriterStore,
  capture: EsunCreditCardValidatedCapture,
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): EsunCreditCardCommitResult {
  return commitEsunCreditCardCaptureBatchInTransaction(store, [capture], capability)[0]!;
}

export async function commitEsunCreditCardCaptureBatch(
  store: EsunCreditCardWriterStore,
  captures: readonly EsunCreditCardValidatedCapture[],
): Promise<EsunCreditCardCommitResult[]> {
  return withCanonicalSourceCaptureAdmissionTransaction(
    store as unknown as CanonicalSourceStore,
    (capability) =>
      commitEsunCreditCardCaptureBatchInTransaction(store, captures, capability),
  );
}
