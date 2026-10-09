import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { CANONICAL_SOURCE_ROUTE_REGISTRY } from "../canonical/canonical-source-route-registry.ts";
import { applyPgliteBaseline, PGLITE_BASELINE_MANIFEST } from "./baseline.ts";
import { PGliteStore } from "./transaction.ts";

const database = await PGlite.create();
const store = new PGliteStore(database);
try {
  await applyPgliteBaseline(database);
  const initialCreatedAt = await store.query<{ created_at: string }>(
    "SELECT created_at::text AS created_at FROM pglite_baseline_metadata WHERE singleton_id = 1",
  );
  await applyPgliteBaseline(database);
  assert.equal(
    (await store.query<{ created_at: string }>(
      "SELECT created_at::text AS created_at FROM pglite_baseline_metadata WHERE singleton_id = 1",
    )).rows[0]?.created_at,
    initialCreatedAt.rows[0]?.created_at,
    "reopening an initialized store must not rewrite baseline metadata",
  );

  const metadata = await store.query<{
    table_count: string;
    index_count: string;
    trigger_count: string;
    view_count: string;
    foreign_key_count: string;
  }>(
    "SELECT table_count, index_count, trigger_count, view_count, foreign_key_count FROM pglite_baseline_metadata WHERE singleton_id = 1",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(metadata.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
    ),
    {
      table_count: PGLITE_BASELINE_MANIFEST.objectCounts.table,
      index_count: PGLITE_BASELINE_MANIFEST.objectCounts.index,
      trigger_count: PGLITE_BASELINE_MANIFEST.objectCounts.trigger,
      view_count: PGLITE_BASELINE_MANIFEST.objectCounts.view,
      foreign_key_count: PGLITE_BASELINE_MANIFEST.objectCounts.foreignKey,
    },
  );
  const invariantCount = await store.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM pglite_invariant_manifest",
  );
  assert.equal(Number(invariantCount.rows[0]?.count), PGLITE_BASELINE_MANIFEST.invariantTriggerCount);

  const pairingTable = await store.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1) AS exists",
    [PGLITE_BASELINE_MANIFEST.derivedProjectionObjects.table],
  );
  assert.equal(pairingTable.rows[0]?.exists, true, "fresh baseline must install the Spending pairing projection table");
  const pairingFunctions = await store.query<{ proname: string }>(
    "SELECT proname FROM pg_proc WHERE proname IN ($1, $2, $3) ORDER BY proname",
    [
      PGLITE_BASELINE_MANIFEST.derivedProjectionObjects.refreshFunction,
      PGLITE_BASELINE_MANIFEST.derivedProjectionObjects.rebuildFunction,
      PGLITE_BASELINE_MANIFEST.derivedProjectionObjects.triggerFunction,
    ],
  );
  assert.deepEqual(
    pairingFunctions.rows.map((row) => row.proname),
    [
      PGLITE_BASELINE_MANIFEST.derivedProjectionObjects.refreshFunction,
      PGLITE_BASELINE_MANIFEST.derivedProjectionObjects.rebuildFunction,
      PGLITE_BASELINE_MANIFEST.derivedProjectionObjects.triggerFunction,
    ].sort(),
    "fresh baseline must install the reviewed Spending pairing functions",
  );
  const pairingTriggers = await store.query<{ tgname: string }>(
    "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'current_spending_pairing_%' ORDER BY tgname",
  );
  assert.deepEqual(
    pairingTriggers.rows.map((row) => row.tgname),
    [...PGLITE_BASELINE_MANIFEST.derivedProjectionObjects.triggers].sort(),
    "fresh baseline must install every reviewed Spending pairing trigger",
  );

  const seeded = await store.query<{ taxonomy_id: string; taxonomy_version: string; dimension: string; code: string }>(
    "SELECT taxonomy_id, taxonomy_version, dimension, code FROM taxonomy_codes ORDER BY taxonomy_id, taxonomy_version, dimension, code LIMIT 1",
  );
  const row = seeded.rows[0];
  assert.ok(row, "fresh baseline must include the published taxonomy registry");
  await assert.rejects(
    store.query(
      "UPDATE taxonomy_codes SET definition = definition WHERE taxonomy_id = $1 AND taxonomy_version = $2 AND dimension = $3 AND code = $4",
      [row.taxonomy_id, row.taxonomy_version, row.dimension, row.code],
    ),
    /published taxonomy codes are immutable/u,
  );
  await assert.rejects(
    store.query(
      "DELETE FROM taxonomy_codes WHERE taxonomy_id = $1 AND taxonomy_version = $2 AND dimension = $3 AND code = $4",
      [row.taxonomy_id, row.taxonomy_version, row.dimension, row.code],
    ),
    /published taxonomy codes cannot be deleted/u,
  );

  await assert.rejects(
    store.query(
      "INSERT INTO taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code, definition, localization_key, aggregation_safe) VALUES ('missing', 'v0', 'kind', 'bad', 'bad', 'bad', 1)",
    ),
    /violates foreign key constraint/u,
  );
  await assert.rejects(
    store.query(
      "INSERT INTO taxonomy_versions(taxonomy_id, taxonomy_version, status, package_hash, published_at_utc_us) VALUES ('bad', 'v0', 'draft', 'bad', 0)",
    ),
    /violates check constraint/u,
  );

  const id = (value: number): Uint8Array => Uint8Array.from({ length: 16 }, () => value);
  const digest = (value: number): Uint8Array => Uint8Array.from({ length: 32 }, () => value);
  const commitKinds = [
    "source_capture",
    "derived_import",
    "user_assertion",
    "projection_rebuild",
    "relation_resolution",
  ] as const;
  for (const [index, commitKind] of commitKinds.entries()) {
    await store.query(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, $2, $3, $4, $5)",
      [id(index + 1), index + 1, index + 1, "test/baseline/v1", commitKind],
    );
  }
  assert.deepEqual(
    (
      await store.query<{ commit_sequence: number; commit_kind: string }>(
        "SELECT commit_sequence, commit_kind FROM canonical_commits ORDER BY commit_sequence",
      )
    ).rows,
    commitKinds.map((commit_kind, index) => ({ commit_sequence: index + 1, commit_kind })),
  );
  await assert.rejects(
    store.query(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, $2, $3, $4, $5)",
      [id(6), 6, 6, "test/baseline/v1", "unknown_kind"],
    ),
    /violates check constraint/u,
  );

  const sourceConnectionId = id(11);
  const identityEpochId = id(12);
  const captureId = id(13);
  const sourceRecordId = id(14);
  const accountId = id(15);
  const transactionId = id(16);
  const revisionId = id(17);
  const assertionId = id(18);
  const sourceCommitId = id(1);
  const baselineSourceRegistration = CANONICAL_SOURCE_ROUTE_REGISTRY.find(
    (registration) => registration.routeKey === "cathay/domestic-deposit/v1",
  );
  assert.ok(baselineSourceRegistration);
  const baselineContractVersion = baselineSourceRegistration.contractVersions[0];
  assert.ok(baselineContractVersion);
  const baselineFinancialRules = baselineSourceRegistration.ruleCombinations?.find(
    (combination) =>
      combination.contractVersion === baselineContractVersion &&
      combination.postingRuleVersion !== null &&
      combination.semanticRuleVersion !== null,
  );
  assert.ok(baselineFinancialRules);
  await store.query(
    "INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES ($1, $2, $3, $4, $5)",
    [baselineSourceRegistration.routeKey, baselineSourceRegistration.integrationNamespace, baselineSourceRegistration.stream, baselineContractVersion, sourceCommitId],
  );
  await store.query(
    "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES ($1, $2, $3, $4)",
    [sourceConnectionId, baselineSourceRegistration.integrationNamespace, "connection", sourceCommitId],
  );
  await store.query(
    "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES ($1, $2, $3, $4)",
    [identityEpochId, sourceConnectionId, "epoch-1", sourceCommitId],
  );
  await store.query(
    "INSERT INTO source_captures(capture_id, capture_key, source_connection_id, identity_epoch_id, authority_route, stream, record_kind, source_account_key, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
    [captureId, "capture-1", sourceConnectionId, identityEpochId, baselineSourceRegistration.routeKey, baselineSourceRegistration.stream, "test", "account", "2026-09-22", "2026-09-22", "2026-09-22", "complete-range", "test", baselineSourceRegistration.completenessRuleVersions?.[0] ?? baselineContractVersion, sourceCommitId],
  );
  await store.query(
    "INSERT INTO source_records(source_record_id, capture_id, commit_id, record_kind, sequence_lexeme, payload_json) VALUES ($1, $2, $3, $4, $5, $6)",
    [sourceRecordId, captureId, sourceCommitId, "test", "1", "{}"],
  );
  await store.query(
    "INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_no, account_type, currency, institution_key, created_commit_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cathay', $9)",
    [accountId, sourceConnectionId, identityEpochId, baselineSourceRegistration.stream, "account", null, "depository", "TWD", sourceCommitId],
  );
  await store.query(
    "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES ($1, $2, $3, $4)",
    [transactionId, accountId, "1", sourceCommitId],
  );
  await store.query(
    "INSERT INTO transaction_revisions(revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number, amount_coefficient, amount_scale, currency, direction, posting_status, posting_origin, posting_basis, posting_rule_version, economic_status, administrative_state, semantic_rule_version, effective_on, transaction_date_time_local, time_zone, time_precision, time_origin, effective_time_basis, effective_time_rule_version, utc_instant_utc_us) VALUES ($1, $2, $3, $4, $5, 1, '1', 0, 'TWD', 'outflow', 'posted', 'provider_booked_history', 'query-status-success-with-accounting-date', $6, 'normal', 'active', $7, '2026-09-22', '2026-09-22T00:00:00', 'Asia/Taipei', 'date', 'source_reported', 'accounting', $8, 0)",
    [revisionId, transactionId, sourceRecordId, captureId, sourceCommitId, baselineFinancialRules.postingRuleVersion, baselineFinancialRules.semanticRuleVersion, baselineFinancialRules.effectiveTimeRuleVersion],
  );
  await store.query(
    "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) VALUES ($1, $2, 'transaction_revision', 'transaction', 'source', 'test/source', $3, $4, NULL, $5)",
    [assertionId, transactionId, baselineSourceRegistration.routeKey, revisionId, sourceCommitId],
  );
  await store.query(
    "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) VALUES ($1, $2, NULL, NULL, NULL, $3)",
    [assertionId, sourceRecordId, sourceCommitId],
  );
  await assert.rejects(
    store.query(
      "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) VALUES ($1, NULL, NULL, NULL, NULL, $2)",
      [assertionId, sourceCommitId],
    ),
    /assertion provenance coordinate mismatch/u,
  );

  const userCategoryAssertionId = id(20);
  await store.query(
    "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) VALUES ($1, $2, 'category', 'transaction', 'user', 'test/user', 'test/user/v1', NULL, 'food', $3)",
    [userCategoryAssertionId, transactionId, sourceCommitId],
  );
  await store.query(
    "INSERT INTO category_allocation_sets(allocation_set_id, assertion_id, transaction_id, booked_coefficient, booked_scale, booked_currency, created_commit_id) VALUES ($1, $2, $3, '10', 0, 'TWD', $4)",
    [id(21), userCategoryAssertionId, transactionId, sourceCommitId],
  );
  const invalidCategoryAssertionId = id(22);
  await store.query(
    "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) VALUES ($1, $2, 'category', 'transaction', 'user', 'test/user', 'test/user/v1', NULL, 'food', $3)",
    [invalidCategoryAssertionId, transactionId, sourceCommitId],
  );
  await assert.rejects(
    store.query(
      "INSERT INTO category_allocation_sets(allocation_set_id, assertion_id, transaction_id, booked_coefficient, booked_scale, booked_currency, created_commit_id) VALUES ($1, $2, $3, '01', 0, 'TWD', $4)",
      [id(23), invalidCategoryAssertionId, transactionId, sourceCommitId],
    ),
    /violates check constraint/u,
  );

  await store.query(
    "INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, switched_commit_id) VALUES (1, 'active', 5, 'test/baseline/v1', $1)",
    [sourceCommitId],
  );
  await assert.rejects(
    store.query(
      "INSERT INTO active_projection_generation(singleton_id, generation_id, switched_commit_id) VALUES (1, 1, $1)",
      [id(2)],
    ),
    /active projection switch commit does not match generation/u,
  );
  await store.query(
    "INSERT INTO active_projection_generation(singleton_id, generation_id, switched_commit_id) VALUES (1, 1, $1)",
    [sourceCommitId],
  );
  await store.query(
    "INSERT INTO projection_generation_provenance(event_id, generation_id, ordinal, event_kind, event_source, commit_id, event_digest) VALUES ($1, 1, 1, 'created', 'migration', $2, $3)",
    [id(19), sourceCommitId, digest(19)],
  );
  await assert.rejects(
    store.query("UPDATE projection_generation_provenance SET ordinal = ordinal WHERE generation_id = 1"),
    /projection generation provenance is append-only/u,
  );
  await assert.rejects(
    store.query("DELETE FROM projection_generation_provenance WHERE generation_id = 1"),
    /projection generation provenance is append-only/u,
  );

  await store.exec("CREATE TEMP TABLE pglite_adapter_probe (id BIGINT PRIMARY KEY, value TEXT NOT NULL)");
  await store.transaction(async (transaction) => {
    await transaction.query("INSERT INTO pglite_adapter_probe(id, value) VALUES ($1, $2)", [1, "committed"]);
  });
  await assert.rejects(
    store.transaction(async (transaction) => {
      await transaction.query("INSERT INTO pglite_adapter_probe(id, value) VALUES ($1, $2)", [2, "rolled back"]);
      throw new Error("intentional transaction rollback");
    }),
    /intentional transaction rollback/u,
  );
  await store.transaction(async (transaction) => {
    await transaction.query("INSERT INTO pglite_adapter_probe(id, value) VALUES ($1, $2)", [3, "explicit rollback"]);
    await transaction.rollback();
  });
  const rows = await store.query<{ id: number; value: string }>(
    "SELECT id, value FROM pglite_adapter_probe ORDER BY id",
  );
  assert.deepEqual(rows.rows, [{ id: 1, value: "committed" }]);

  const atomicProbe = await PGlite.create();
  try {
    await assert.rejects(
      atomicProbe.transaction(async (transaction) => {
        await transaction.exec("CREATE TABLE atomic_probe (id BIGINT PRIMARY KEY)");
        await transaction.exec("CREATE TABLE atomic_probe (id BIGINT PRIMARY KEY)");
      }),
      /already exists/u,
    );
    const rolledBackDdl = await atomicProbe.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'atomic_probe'",
    );
    assert.equal(rolledBackDdl.rows[0]?.count, 0, "baseline setup must use one rollback-capable transaction");
  } finally {
    await atomicProbe.close();
  }

  await store.query(
    "UPDATE pglite_baseline_metadata SET baseline_version = $1 WHERE singleton_id = 1",
    [PGLITE_BASELINE_MANIFEST.baselineVersion - 1],
  );
  await assert.rejects(
    applyPgliteBaseline(database),
    /baseline metadata does not match its known manifest/u,
    "an installed older baseline must be rejected without an automatic repair path",
  );
  const unsupportedVersion = await store.query<{ baseline_version: number | string }>(
    "SELECT baseline_version FROM pglite_baseline_metadata WHERE singleton_id = 1",
  );
  assert.equal(Number(unsupportedVersion.rows[0]?.baseline_version), PGLITE_BASELINE_MANIFEST.baselineVersion - 1);
} finally {
  await store.close();
}
