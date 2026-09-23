import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  withCanonicalSourceCaptureAdmissionTransaction,
  type CanonicalSourceCaptureAdmissionTransactionCapability,
} from "./canonical-source-capture-admission.ts";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";
import {
  amountsEqual,
  canonicalInstant,
  isAdmittedCreditCardCurrentBalanceCapture,
  requireAmount,
  sourceEvidenceFromCreditCardCurrentBalanceCapture,
  validateCreditCardCurrentBalanceCapture as validateCapture,
  CanonicalCreditCardCurrentBalanceConflictError,
  type CreditCardCurrentBalanceCaptureInput,
  type CreditCardCurrentBalanceCommitResult,
  type CreditCardCurrentBalanceIdentity,
  type CreditCardCurrentBalanceObservationInput,
  type CreditCardCurrentBalanceValidatedCapture,
  type CreditCardCurrentBalanceWriterStore,
} from "./credit-card-current-balance-admission.ts";

export * from "./credit-card-current-balance-admission.ts";

function fail(message: string): never {
  throw new CanonicalCreditCardCurrentBalanceConflictError(message);
}

function findExistingAccount(db: DatabaseSync, identity: CreditCardCurrentBalanceIdentity): { accountId: Buffer; currency: string | null } {
  const rows = db.prepare(
    `SELECT account.account_id, account.currency
       FROM financial_accounts account
       JOIN source_connections connection_row ON connection_row.source_connection_id = account.source_connection_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = account.identity_epoch_id
      WHERE connection_row.integration_namespace = ?
        AND connection_row.source_connection_key = ?
        AND epoch.epoch_key = ?
        AND account.stream = 'credit-card'
        AND account.source_account_key = ?
        AND account.account_type = 'credit'`,
  ).all(identity.integrationNamespace, identity.sourceConnectionKey, identity.identityEpochKey, identity.sourceAccountKey) as Array<{ account_id?: unknown; currency?: unknown }>;
  if (rows.length !== 1 || !(rows[0]?.account_id instanceof Uint8Array))
    fail("Credit-card current balance must attach to exactly one existing issuer account.");
  return { accountId: Buffer.from(rows[0].account_id), currency: rows[0].currency == null ? null : String(rows[0].currency) };
}

function canonicalObservationKey(observation: CreditCardCurrentBalanceObservationInput, currency: string): string {
  return `sha256:${createHash("sha256")
    .update(`canonical/credit-card-current-used-credit/v1|${observation.observationKey}|${currency}|${canonicalInstant(observation.time.effectiveAt)}`)
    .digest("base64url")}`;
}

function sourceRecordIdByKey(capture: CreditCardCurrentBalanceValidatedCapture, ids: readonly Uint8Array[]): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  capture.records.forEach((record, index) => {
    const id = ids[index];
    if (!id) fail("Credit-card source record identity is missing.");
    result.set(record.sourceRecordKey, id);
  });
  return result;
}

function persistObservations(
  db: DatabaseSync,
  capture: CreditCardCurrentBalanceValidatedCapture,
  accountId: Uint8Array,
  sourceCaptureId: Uint8Array,
  commitId: Uint8Array,
  sourceRecordIds: readonly Uint8Array[],
): { revisionCount: number; deduplicatedRevisionCount: number } {
  const ids = sourceRecordIdByKey(capture, sourceRecordIds);
  let revisionCount = 0;
  let deduplicatedRevisionCount = 0;
  for (const observation of capture.observations) {
    const currency = observation.currency.toUpperCase();
    const key = canonicalObservationKey(observation, currency);
    const effectiveAt = canonicalInstant(observation.time.effectiveAt);
    const sourceRecordId = ids.get(observation.sourceRecordKey);
    if (!sourceRecordId) fail("Credit-card source record is missing.");
    const existing = db.prepare(
      `SELECT observation_id FROM balance_observations
        WHERE account_id = ? AND observation_key = ? AND balance_kind = 'credit_used' AND balance_currency = ?
        ORDER BY rowid DESC LIMIT 1`,
    ).get(accountId, key, currency) as { observation_id?: unknown } | undefined;
    const observationId = existing?.observation_id instanceof Uint8Array ? Buffer.from(existing.observation_id) : randomBytes(16);
    if (!existing)
      db.prepare(
        `INSERT INTO balance_observations(observation_id, account_id, observation_key, balance_kind, balance_currency, created_capture_id, created_commit_id)
         VALUES (?, ?, ?, 'credit_used', ?, ?, ?)`,
      ).run(observationId, accountId, key, currency, sourceCaptureId, commitId);
    const duplicate = db.prepare(
      `SELECT revision_id, balance_coefficient, balance_scale FROM balance_observation_revisions
        WHERE observation_id = ? AND currency = ? AND effective_at = ?`,
    ).get(observationId, currency, effectiveAt) as { revision_id?: unknown; balance_coefficient?: unknown; balance_scale?: unknown } | undefined;
    if (duplicate) {
      const existingAmount = requireAmount({ coefficient: String(duplicate.balance_coefficient ?? ""), scale: Number(duplicate.balance_scale ?? -1) }, "Existing credit-card balance");
      if (!amountsEqual(existingAmount, observation.balance)) fail("Credit-card balance contradicts an existing measurement at the same provider instant.");
      if (!(duplicate.revision_id instanceof Uint8Array)) fail("Existing credit-card revision identity is missing.");
      const detail = db.prepare(
        `SELECT estimate_kind, estimate_basis, formula, component_limit_coefficient, component_limit_scale, component_available_coefficient, component_available_scale
           FROM credit_card_balance_estimate_details WHERE revision_id = ?`,
      ).get(duplicate.revision_id) as Record<string, unknown> | undefined;
      if (!detail || detail.estimate_kind !== observation.estimate.kind || detail.estimate_basis !== observation.estimate.basis || detail.formula !== observation.estimate.formula)
        fail("Credit-card duplicate measurement has conflicting estimate evidence.");
      if (observation.estimate.basis === "credit-limit-minus-available") {
        const expectedLimit = requireAmount(observation.estimate.limit, "Credit-card limit component");
        const expectedAvailable = requireAmount(observation.estimate.available, "Credit-card available component");
        const existingLimit = requireAmount({
          coefficient: String(detail.component_limit_coefficient ?? ""),
          scale: Number(detail.component_limit_scale ?? -1),
        }, "Existing credit-card limit component");
        const existingAvailable = requireAmount({
          coefficient: String(detail.component_available_coefficient ?? ""),
          scale: Number(detail.component_available_scale ?? -1),
        }, "Existing credit-card available component");
        if (!amountsEqual(existingLimit, expectedLimit) || !amountsEqual(existingAvailable, expectedAvailable))
          fail("Credit-card duplicate measurement has conflicting formula components.");
      } else if (
        detail.component_limit_coefficient !== null ||
        detail.component_limit_scale !== null ||
        detail.component_available_coefficient !== null ||
        detail.component_available_scale !== null
      ) {
        fail("Credit-card duplicate provider measurement has unexpected formula components.");
      }
      deduplicatedRevisionCount += 1;
      continue;
    }
    const prior = db.prepare("SELECT COALESCE(MAX(revision_number), 0) AS revision_number FROM balance_observation_revisions WHERE observation_id = ?").get(observationId) as { revision_number?: unknown };
    const revisionId = randomBytes(16);
    db.prepare(
      `INSERT INTO balance_observation_revisions(
         revision_id, observation_id, source_record_id, capture_id, commit_id, revision_number,
         balance_coefficient, balance_scale, currency, effective_at, effective_time_basis,
         effective_time_rule_version, effective_time_evidence_source_record_key,
         effective_time_evidence_source_field, effective_time_evidence_value,
         effective_time_evidence_contract_version, effective_time_evidence_endpoint,
         effective_time_evidence_response_status, effective_time_evidence_cache_policy, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200, ?, ?)`,
    ).run(
      revisionId,
      observationId,
      sourceRecordId,
      sourceCaptureId,
      commitId,
      Number(prior.revision_number ?? 0) + 1,
      observation.balance.coefficient,
      observation.balance.scale,
      currency,
      effectiveAt,
      observation.time.effectiveTimeBasis,
      observation.time.effectiveTimeRuleVersion,
      observation.sourceRecordKey,
      observation.time.sourceField,
      observation.time.sourceValue,
      observation.time.contractVersion,
      capture.providerResponse.endpoint,
      capture.providerResponse.cacheControl ?? "provider-contract",
      capture.observedAt,
    );
    db.prepare(
      `INSERT INTO credit_card_balance_estimate_details(
         revision_id, estimate_kind, estimate_basis, formula,
         component_limit_coefficient, component_limit_scale,
         component_available_coefficient, component_available_scale
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revisionId,
      observation.estimate.kind,
      observation.estimate.basis,
      observation.estimate.formula,
      observation.estimate.limit?.coefficient ?? null,
      observation.estimate.limit?.scale ?? null,
      observation.estimate.available?.coefficient ?? null,
      observation.estimate.available?.scale ?? null,
    );
    revisionCount += 1;
  }
  return { revisionCount, deduplicatedRevisionCount };
}

function idText(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function commitCreditCardCurrentBalanceCaptureInTransaction(
  store: CreditCardCurrentBalanceWriterStore,
  capture: CreditCardCurrentBalanceValidatedCapture,
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): CreditCardCurrentBalanceCommitResult {
  assertValidatedCanonicalDatabase(store.db);
  if (!isAdmittedCreditCardCurrentBalanceCapture(capture)) fail("Credit-card capture did not cross the validated seam.");
  validateCapture(capture);
  const account = findExistingAccount(store.db, capture.identity);
  if (account.currency !== null && capture.observations.some((observation) => observation.currency.toUpperCase() !== account.currency?.toUpperCase()))
    fail("Credit-card balance currency does not match the existing account.");
  const sourceContext = capability.admit(sourceEvidenceFromCreditCardCurrentBalanceCapture(capture));
  capability.linkFinancialAccount({ accountId: account.accountId, scopeId: sourceContext.scopeId, sourceRecordIds: sourceContext.sourceRecordIds });
  const revisions = persistObservations(store.db, capture, account.accountId, sourceContext.captureId, sourceContext.commitId, sourceContext.sourceRecordIds);
  createCanonicalProjectionRuntime(store.db).applyCommit({ commitId: sourceContext.commitId, kind: "source_capture" });
  return {
    status: "canonical-live",
    captureId: capture.captureId,
    accountId: idText(account.accountId),
    commitSequence: sourceContext.receipt.knowledgePoint,
    observationCount: capture.observations.length,
    revisionCount: revisions.revisionCount,
    deduplicatedRevisionCount: revisions.deduplicatedRevisionCount,
  };
}

export async function commitCreditCardCurrentBalanceCapture(
  store: CreditCardCurrentBalanceWriterStore,
  capture: CreditCardCurrentBalanceValidatedCapture,
): Promise<CreditCardCurrentBalanceCommitResult> {
  assertValidatedCanonicalDatabase(store.db);
  return withCanonicalSourceCaptureAdmissionTransaction(
    store as unknown as CanonicalSourceStore,
    (capability) =>
    commitCreditCardCurrentBalanceCaptureInTransaction(store, capture, capability),
  );
}
