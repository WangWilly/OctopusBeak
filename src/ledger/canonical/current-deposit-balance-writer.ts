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
  fail,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_ROUTE,
  requireAmount,
  requireRfc3339,
  requireValidatedCapture,
  sourceEvidenceFromCapture,
  validateCapture,
} from "../pglite/current-deposit-admission.ts";
import type {
  CurrentDepositAccountScope,
  CurrentDepositBalanceObservationInput,
  CurrentDepositBalanceValidatedCapture,
} from "../pglite/current-deposit-admission.ts";

export {
  CanonicalCurrentDepositBalanceConflictError,
  CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS,
  admitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  sourceEvidenceFromCapture,
} from "../pglite/current-deposit-admission.ts";
export type {
  CurrentDepositAccountScope,
  CurrentDepositBalanceCaptureInput,
  CurrentDepositBalanceKind,
  CurrentDepositBalanceObservationInput,
  CurrentDepositBalanceValidatedCapture,
  CurrentDepositExactAmount,
  CurrentDepositRequestDiscriminant,
  CurrentDepositSourceRecordInput,
  CurrentDepositTimeEvidence,
} from "../pglite/current-deposit-admission.ts";
export type CurrentDepositBalanceWriterStore = CanonicalSourceStore;
export type CurrentDepositBalanceTransactionStore = Pick<
  CanonicalSourceStore,
  "db" | "commitClock" | "withWriter"
>;

export type CurrentDepositBalanceCommitResult = Readonly<{
  status: "canonical-live";
  captureId: string;
  accountId: string;
  commitSequence: number;
  observationCount: number;
  revisionCount: number;
  deduplicatedRevisionCount: number;
}>;

function findExistingAccount(
  db: DatabaseSync,
  identity: CurrentDepositAccountScope,
): { accountId: Buffer; currency: string | null } {
  const row = db
    .prepare(
      `SELECT account.account_id, account.currency
         FROM financial_accounts account
         JOIN source_connections connection_row
           ON connection_row.source_connection_id = account.source_connection_id
         JOIN identity_epochs epoch
           ON epoch.identity_epoch_id = account.identity_epoch_id
        WHERE connection_row.integration_namespace = ?
          AND connection_row.source_connection_key = ?
          AND epoch.epoch_key = ?
          AND account.stream = ?
          AND account.source_account_key = ?
          AND account.account_type = 'depository'`,
    )
    .get(
      identity.integrationNamespace,
      identity.sourceConnectionKey,
      identity.identityEpochKey,
      identity.stream,
      identity.sourceAccountKey,
    ) as { account_id?: unknown; currency?: unknown } | undefined;
  if (!(row?.account_id instanceof Uint8Array))
    fail("Current deposit balance must attach to an existing depository account.");
  return {
    accountId: Buffer.from(row.account_id),
    currency: row.currency == null ? null : String(row.currency),
  };
}

function canonicalObservationKey(
  observation: CurrentDepositBalanceObservationInput,
  currency: string,
): string {
  const effectiveAt = canonicalInstant(
    requireRfc3339(observation.time.effectiveAt, "Current deposit effective time"),
  );
  return `sha256:${createHash("sha256")
    .update(`canonical/depository-balance-observation/v2|${observation.observationKey}|${observation.balanceKind}|${currency}|${effectiveAt}`)
    .digest("base64url")}`;
}

function sourceRecordIdByKey(
  capture: CurrentDepositBalanceValidatedCapture,
  sourceRecordIds: readonly Uint8Array[],
): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  capture.records.forEach((record, index) => {
    const sourceRecordId = sourceRecordIds[index];
    if (!sourceRecordId) fail("Current deposit source record identity is missing.");
    result.set(record.sourceRecordKey, sourceRecordId);
  });
  return result;
}

function persistObservations(
  db: DatabaseSync,
  capture: CurrentDepositBalanceValidatedCapture,
  accountId: Uint8Array,
  sourceCaptureId: Uint8Array,
  commitId: Uint8Array,
  sourceRecordIds: readonly Uint8Array[],
): { revisionCount: number; deduplicatedRevisionCount: number } {
  const recordIds = sourceRecordIdByKey(capture, sourceRecordIds);
  let revisionCount = 0;
  let deduplicatedRevisionCount = 0;
  for (const observation of capture.observations) {
    const currency = observation.currency.toUpperCase();
    const observationKey = canonicalObservationKey(observation, currency);
    const effectiveAt = canonicalInstant(
      requireRfc3339(observation.time.effectiveAt, "Current deposit effective time"),
    );
    const sourceRecordId = recordIds.get(observation.sourceRecordKey);
    if (!sourceRecordId) fail("Current deposit observation source record is missing.");
    const existing = db
      .prepare(
        `SELECT observation_id
           FROM balance_observations
          WHERE account_id = ? AND observation_key = ?
            AND balance_kind = ? AND balance_currency = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(accountId, observationKey, observation.balanceKind, currency) as
      | { observation_id?: unknown }
      | undefined;
    const observationId = existing?.observation_id instanceof Uint8Array
      ? Buffer.from(existing.observation_id)
      : randomBytes(16);
    if (!existing)
      db.prepare(
        `INSERT INTO balance_observations(
           observation_id, account_id, observation_key, balance_kind,
           balance_currency, created_capture_id, created_commit_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        observationId,
        accountId,
        observationKey,
        observation.balanceKind,
        currency,
        sourceCaptureId,
        commitId,
      );

    const duplicate = db
      .prepare(
        `SELECT revision_id, balance_coefficient, balance_scale
           FROM balance_observation_revisions
          WHERE observation_id = ? AND currency = ? AND effective_at = ?`,
      )
      .get(
        observationId,
        currency,
        effectiveAt,
      ) as { revision_id?: unknown; balance_coefficient?: unknown; balance_scale?: unknown } | undefined;
    if (duplicate) {
      const existingAmount = requireAmount(
        {
          coefficient: String(duplicate.balance_coefficient ?? ""),
          scale: Number(duplicate.balance_scale ?? -1),
        },
        "Existing current deposit balance",
      );
      if (!amountsEqual(existingAmount, observation.balance))
        fail("Current deposit balance contradicts an existing measurement at the same provider instant.");
      deduplicatedRevisionCount += 1;
      continue;
    }
    const prior = db
      .prepare(
        "SELECT COALESCE(MAX(revision_number), 0) AS revision_number FROM balance_observation_revisions WHERE observation_id = ?",
      )
      .get(observationId) as { revision_number?: unknown };
    db.prepare(
      `INSERT INTO balance_observation_revisions(
         revision_id, observation_id, source_record_id, capture_id, commit_id,
         revision_number, balance_coefficient, balance_scale, currency,
         effective_at, effective_time_basis, effective_time_rule_version,
         effective_time_evidence_source_record_key,
         effective_time_evidence_source_field,
         effective_time_evidence_value,
         effective_time_evidence_contract_version,
         effective_time_evidence_endpoint,
         effective_time_evidence_response_status,
         effective_time_evidence_cache_policy, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomBytes(16),
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
      capture.providerResponse.status,
      capture.providerResponse.cacheControl ?? "provider-contract",
      capture.observedAt,
    );
    revisionCount += 1;
  }
  return { revisionCount, deduplicatedRevisionCount };
}

function idText(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function commitCurrentDepositBalanceCaptureInTransaction(
  store: CurrentDepositBalanceTransactionStore,
  capture: CurrentDepositBalanceValidatedCapture,
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): CurrentDepositBalanceCommitResult {
  assertValidatedCanonicalDatabase(store.db);
  requireValidatedCapture(capture);
  validateCapture(capture, { allowExistingIdentityKeys: true });
  const account = findExistingAccount(store.db, capture.identity);
  const overviewUsesCanonicalCurrency =
    capture.authorityRoute === HNCB_CURRENT_DEPOSIT_OVERVIEW_ROUTE &&
    capture.records.some(
      (record) => record.compact.currencyResolution === "canonical-account",
    );
  if (
    overviewUsesCanonicalCurrency &&
    (account.currency === null ||
      account.currency.trim() === "" ||
      capture.observations.some(
        (observation) =>
          observation.currency.toUpperCase() !== account.currency!.toUpperCase(),
      ))
  )
    fail(
      "HNCB current deposit overview canonical currency requires an exact existing account currency.",
    );
  if (
    account.currency !== null &&
    capture.identity.stream === "domestic-deposit" &&
    capture.observations.some((observation) => observation.currency !== account.currency)
  )
    fail("Current deposit currency does not match the existing account.");
  const sourceContext = capability.admit(
    sourceEvidenceFromCapture(capture),
    [],
    { allowExistingIdentityKeys: true },
  );
  capability.linkFinancialAccount({
    accountId: account.accountId,
    scopeId: sourceContext.scopeId,
    sourceRecordIds: sourceContext.sourceRecordIds,
  });
  const revisions = persistObservations(
    store.db,
    capture,
    account.accountId,
    sourceContext.captureId,
    sourceContext.commitId,
    sourceContext.sourceRecordIds,
  );
  createCanonicalProjectionRuntime(store.db).applyCommit({
    commitId: sourceContext.commitId,
    kind: "source_capture",
  });
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

export async function commitCurrentDepositBalanceCapture(
  store: CurrentDepositBalanceWriterStore,
  capture: CurrentDepositBalanceValidatedCapture,
): Promise<CurrentDepositBalanceCommitResult> {
  assertValidatedCanonicalDatabase(store.db);
  return withCanonicalSourceCaptureAdmissionTransaction(store, (capability) =>
    commitCurrentDepositBalanceCaptureInTransaction(store, capture, capability),
  );
}

export type { CanonicalSourcePage } from "./canonical-source-evidence.ts";
