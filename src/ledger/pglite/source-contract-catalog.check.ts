import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  CANONICAL_SOURCE_ROUTE_REGISTRY,
  type CanonicalSourceRouteRegistration,
  type CanonicalSourceRuleCombination,
} from "../canonical/canonical-source-route-registry.ts";
import { PGLITE_BASELINE_SQL } from "./baseline-sql.ts";
import { applyPgliteBaseline, assertPgliteBaseline } from "./baseline.ts";
import { PGLITE_OCCURRENCE_GROUP_SQL } from "./occurrence-group-sql.ts";
import {
  assertTrustedSourceContractCatalog,
  buildTrustedSourceContractCatalog,
  installTrustedSourceContractCatalog,
  PGLITE_SOURCE_CONTRACT_CATALOG_GUARDS_SQL,
} from "./source-contract-catalog.ts";

type RuntimeRoute = Readonly<{
  registration: CanonicalSourceRouteRegistration;
  contractVersion: string;
}>;

type FixtureIds = Readonly<{
  commitId: Uint8Array;
  connectionId: Uint8Array;
  identityEpochId: Uint8Array;
  captureId: Uint8Array;
  sourceRecordId: Uint8Array;
  accountId: Uint8Array;
  transactionId: Uint8Array;
}>;

const id = (value: number): Uint8Array =>
  Uint8Array.from({ length: 16 }, () => value);

function runtimeRoute(
  registration: CanonicalSourceRouteRegistration,
  contractVersion: string,
): RuntimeRoute {
  assert.ok(
    registration.contractVersions.includes(contractVersion),
    `${registration.routeKey} must register ${contractVersion}`,
  );
  return { registration, contractVersion };
}

async function seedCapture(
  database: PGlite,
  route: RuntimeRoute,
  ids: FixtureIds,
  commitSequence: number,
): Promise<void> {
  const { registration, contractVersion } = route;
  await database.query(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, $2, $3, $4, 'source_capture')",
    [ids.commitId, commitSequence, commitSequence, registration.routeKey],
  );
  await database.query(
    "INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES ($1, $2, $3, $4, $5)",
    [
      registration.routeKey,
      registration.integrationNamespace,
      registration.stream,
      contractVersion,
      ids.commitId,
    ],
  );
  await database.query(
    "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES ($1, $2, $3, $4)",
    [
      ids.connectionId,
      registration.integrationNamespace,
      `catalog-check-${commitSequence}`,
      ids.commitId,
    ],
  );
  await database.query(
    "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES ($1, $2, $3, $4)",
    [ids.identityEpochId, ids.connectionId, `epoch-${commitSequence}`, ids.commitId],
  );
  await database.query(
    `INSERT INTO source_captures
       (capture_id, capture_key, source_connection_id, identity_epoch_id,
        authority_route, source_subject_id, stream, record_kind, source_account_key,
        observed_at, scope_start, scope_end, completeness, completeness_basis,
        completeness_rule_version, commit_id)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, 'account', '2026-10-03',
             '2026-10-03', '2026-10-03', 'complete-range', 'catalog-check', $8, $9)`,
    [
      ids.captureId,
      `capture-${commitSequence}`,
      ids.connectionId,
      ids.identityEpochId,
      registration.routeKey,
      registration.stream,
      registration.stream,
      registration.completenessRuleVersions?.[0] ?? contractVersion,
      ids.commitId,
    ],
  );
  await database.query(
    "INSERT INTO source_records(source_record_id, capture_id, commit_id, record_kind, sequence_lexeme, payload_json) VALUES ($1, $2, $3, $4, '1', '{}')",
    [ids.sourceRecordId, ids.captureId, ids.commitId, registration.stream],
  );
  await database.query(
    `INSERT INTO financial_accounts
       (account_id, source_connection_id, identity_epoch_id, stream,
        source_account_key, account_no, account_type, currency, created_commit_id)
     VALUES ($1, $2, $3, $4, 'account', NULL, 'depository', 'TWD', $5)`,
    [
      ids.accountId,
      ids.connectionId,
      ids.identityEpochId,
      registration.stream,
      ids.commitId,
    ],
  );
}

async function insertFinancialTransaction(
  database: PGlite,
  ids: FixtureIds,
  sourceSequence: string,
): Promise<void> {
  await database.query(
    "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES ($1, $2, $3, $4)",
    [ids.transactionId, ids.accountId, sourceSequence, ids.commitId],
  );
}

async function insertTransactionRevision(
  database: PGlite,
  ids: FixtureIds,
  tuple: CanonicalSourceRuleCombination,
  revisionNumber: number,
): Promise<void> {
  assert.ok(tuple.postingRuleVersion && tuple.semanticRuleVersion);
  await database.query(
    `INSERT INTO transaction_revisions
       (revision_id, transaction_id, source_record_id, capture_id, commit_id,
        revision_number, amount_coefficient, amount_scale, currency, direction,
        posting_status, posting_origin, posting_basis, posting_rule_version,
        economic_status, administrative_state, semantic_rule_version, effective_on,
        transaction_date_time_local, time_zone, time_precision, time_origin,
        effective_time_basis, effective_time_rule_version, utc_instant_utc_us)
     VALUES ($1, $2, $3, $4, $5, $6, '1', 0, 'TWD', 'outflow', 'posted',
             'provider_booked_history', 'query-status-success-with-accounting-date',
             $7, 'normal', 'active', $8, '2026-10-03', '2026-10-03T00:00:00',
             'Asia/Taipei', 'date', 'source_reported', 'accounting', $9, 0)`,
    [
      id(40 + revisionNumber),
      ids.transactionId,
      ids.sourceRecordId,
      ids.captureId,
      ids.commitId,
      revisionNumber,
      tuple.postingRuleVersion,
      tuple.semanticRuleVersion,
      tuple.effectiveTimeRuleVersion,
    ],
  );
}

async function insertBalanceObservationRevision(
  database: PGlite,
  ids: FixtureIds,
  tuple: CanonicalSourceRuleCombination,
  revisionId: Uint8Array,
  contractVersion: string,
): Promise<void> {
  await database.query(
    `INSERT INTO balance_observations
       (observation_id, account_id, observation_key, balance_kind, balance_currency,
        created_capture_id, created_commit_id)
     VALUES ($1, $2, 'catalog-check-balance', 'ledger', 'TWD', $3, $4)
     ON CONFLICT (observation_id) DO NOTHING`,
    [id(50), ids.accountId, ids.captureId, ids.commitId],
  );
  await database.query(
    `INSERT INTO balance_observation_revisions
       (revision_id, observation_id, source_record_id, capture_id, commit_id,
        revision_number, balance_coefficient, balance_scale, currency, effective_at,
        effective_time_basis, effective_time_rule_version,
        effective_time_evidence_source_record_key, effective_time_evidence_source_field,
        effective_time_evidence_value, effective_time_evidence_contract_version,
        observed_at)
     VALUES ($1, $2, $3, $4, $5, 1, '100', 0, 'TWD', '2026-10-03',
             'source-reported', $6, 'record-1', 'balance-date', '2026-10-03', $7,
             '2026-10-03')`,
    [
      revisionId,
      id(50),
      ids.sourceRecordId,
      ids.captureId,
      ids.commitId,
      tuple.effectiveTimeRuleVersion,
      contractVersion,
    ],
  );
}

const mainDatabase = await PGlite.create();
try {
  await applyPgliteBaseline(mainDatabase);
  const originalBaseline = await mainDatabase.query<{ baseline_version: string }>(
    "SELECT baseline_version FROM pglite_baseline_metadata WHERE singleton_id = 1",
  );
  await applyPgliteBaseline(mainDatabase);
  assert.equal(
    (await mainDatabase.query<{ baseline_version: string }>(
      "SELECT baseline_version FROM pglite_baseline_metadata WHERE singleton_id = 1",
    )).rows[0]?.baseline_version,
    originalBaseline.rows[0]?.baseline_version,
    "reopening must preserve the installed baseline version",
  );
  await assertPgliteBaseline(mainDatabase);

  const cathay = CANONICAL_SOURCE_ROUTE_REGISTRY.find(
    (registration) => registration.routeKey === "cathay/domestic-deposit/v1",
  );
  assert.ok(cathay, "the active Cathay deposit route must remain registered");
  const cathayContractVersion = cathay.contractVersions[0];
  assert.ok(cathayContractVersion);
  const cathayRoute = runtimeRoute(cathay, cathayContractVersion);
  const cathayTuple = cathay.ruleCombinations?.find(
    (tuple) =>
      tuple.contractVersion === cathayContractVersion &&
      tuple.postingRuleVersion !== null &&
      tuple.semanticRuleVersion !== null,
  );
  assert.ok(cathayTuple, "the active Cathay route must register a financial tuple");

  const storedContract = await mainDatabase.query<{
    integration_namespace: string;
    stream: string;
    contract_version: string;
  }>(
    "SELECT integration_namespace, stream, contract_version FROM source_contract_catalog WHERE authority_route = $1 AND contract_version = $2",
    [cathay.routeKey, cathayContractVersion],
  );
  assert.deepEqual(storedContract.rows[0], {
    integration_namespace: cathay.integrationNamespace,
    stream: cathay.stream,
    contract_version: cathayContractVersion,
  });

  const mainIds: FixtureIds = {
    commitId: id(1),
    connectionId: id(2),
    identityEpochId: id(3),
    captureId: id(4),
    sourceRecordId: id(5),
    accountId: id(6),
    transactionId: id(7),
  };
  await seedCapture(mainDatabase, cathayRoute, mainIds, 1);
  await insertFinancialTransaction(mainDatabase, mainIds, "1");
  await insertTransactionRevision(mainDatabase, mainIds, cathayTuple, 1);
  const commitId = mainIds.commitId;

  await assert.rejects(
    mainDatabase.query(
      "INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES ('unregistered/source/v1', 'unregistered', 'domestic-deposit', 'v1', $1)",
      [commitId],
    ),
    /not in the trusted source contract catalog/u,
    "unknown route metadata must fail in direct SQL",
  );
  for (const metadata of [
    {
      namespace: "wrong-namespace",
      stream: cathay.stream,
      version: cathayContractVersion,
    },
    {
      namespace: cathay.integrationNamespace,
      stream: "wrong-stream",
      version: cathayContractVersion,
    },
    {
      namespace: cathay.integrationNamespace,
      stream: cathay.stream,
      version: "unregistered-contract-version",
    },
  ]) {
    await assert.rejects(
      mainDatabase.query(
        "INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES ($1, $2, $3, $4, $5)",
        [
          cathay.routeKey,
          metadata.namespace,
          metadata.stream,
          metadata.version,
          commitId,
        ],
      ),
      /not in the trusted source contract catalog/u,
      "route namespace, stream, and contract version must match the catalog",
    );
  }

  const existingCatalogRow = await mainDatabase.query<{
    authority_route: string;
    contract_version: string;
  }>(
    "SELECT authority_route, contract_version FROM source_contract_catalog LIMIT 1",
  );
  const catalogRow = existingCatalogRow.rows[0];
  assert.ok(catalogRow);
  const existingTuple = await mainDatabase.query<{
    authority_route: string;
    contract_version: string;
    rule_ordinal: number | string;
  }>(
    "SELECT authority_route, contract_version, rule_ordinal FROM source_contract_rule_tuples LIMIT 1",
  );
  const tupleRow = existingTuple.rows[0];
  assert.ok(tupleRow);

  const immutableOperations: readonly Readonly<{ sql: string; params?: unknown[] }>[] = [
    {
      sql: "INSERT INTO source_contract_catalog(authority_route, integration_namespace, stream, contract_version) VALUES ('new-provider/deposit/v1', 'new-provider', 'domestic-deposit', 'v1')",
    },
    {
      sql: "UPDATE source_contract_catalog SET stream = stream WHERE authority_route = $1 AND contract_version = $2",
      params: [catalogRow.authority_route, catalogRow.contract_version],
    },
    {
      sql: "DELETE FROM source_contract_catalog WHERE authority_route = $1 AND contract_version = $2",
      params: [catalogRow.authority_route, catalogRow.contract_version],
    },
    { sql: "TRUNCATE source_contract_catalog, source_contract_rule_tuples" },
    {
      sql: "INSERT INTO source_contract_rule_tuples(authority_route, contract_version, rule_ordinal, posting_rule_version, semantic_rule_version, effective_time_rule_version) VALUES ($1, $2, 999, 'new/posting/v1', 'new/semantic/v1', 'new/effective-time/v1')",
      params: [catalogRow.authority_route, catalogRow.contract_version],
    },
    {
      sql: "UPDATE source_contract_rule_tuples SET effective_time_rule_version = effective_time_rule_version WHERE authority_route = $1 AND contract_version = $2 AND rule_ordinal = $3",
      params: [tupleRow.authority_route, tupleRow.contract_version, tupleRow.rule_ordinal],
    },
    {
      sql: "DELETE FROM source_contract_rule_tuples WHERE authority_route = $1 AND contract_version = $2 AND rule_ordinal = $3",
      params: [tupleRow.authority_route, tupleRow.contract_version, tupleRow.rule_ordinal],
    },
    { sql: "TRUNCATE source_contract_rule_tuples" },
  ];
  for (const operation of immutableOperations) {
    await assert.rejects(
      mainDatabase.query(operation.sql, operation.params),
      /installed source contract catalog is immutable/u,
      "normal catalog DML and TRUNCATE must not change trusted authority",
    );
  }

  const foreignTupleResult = await mainDatabase.query<{
    posting_rule_version: string;
    semantic_rule_version: string;
    effective_time_rule_version: string;
  }>(
    `SELECT tuple.posting_rule_version, tuple.semantic_rule_version,
            tuple.effective_time_rule_version
       FROM source_contract_rule_tuples tuple
       JOIN source_contract_catalog catalog
         ON catalog.authority_route = tuple.authority_route
        AND catalog.contract_version = tuple.contract_version
      WHERE catalog.authority_route <> $1
        AND tuple.posting_rule_version IS NOT NULL
        AND tuple.semantic_rule_version IS NOT NULL
      LIMIT 1`,
    [cathay.routeKey],
  );
  const foreignTuple = foreignTupleResult.rows[0];
  assert.ok(foreignTuple, "the catalog must contain a financial tuple for another route");
  await assert.rejects(
    mainDatabase.query(
      `INSERT INTO transaction_revisions
         (revision_id, transaction_id, source_record_id, capture_id, commit_id,
          revision_number, amount_coefficient, amount_scale, currency, direction,
          posting_status, posting_origin, posting_basis, posting_rule_version,
          economic_status, administrative_state, semantic_rule_version, effective_on,
          transaction_date_time_local, time_zone, time_precision, time_origin,
          effective_time_basis, effective_time_rule_version, utc_instant_utc_us)
       VALUES ($1, $2, $3, $4, $5, 2, '1', 0, 'TWD', 'outflow', 'posted',
               'provider_booked_history', 'query-status-success-with-accounting-date',
               $6, 'normal', 'active', $7, '2026-10-03', '2026-10-03T00:00:00',
               'Asia/Taipei', 'date', 'source_reported', 'accounting', $8, 0)`,
      [
        id(42),
        mainIds.transactionId,
        mainIds.sourceRecordId,
        mainIds.captureId,
        mainIds.commitId,
        foreignTuple.posting_rule_version,
        foreignTuple.semantic_rule_version,
        foreignTuple.effective_time_rule_version,
      ],
    ),
    /transaction rule tuple is not registered for its source capture contract/u,
    "a tuple registered for another route must fail in direct SQL",
  );

  const observationIds = mainIds;
  const foreignEffectiveTimeRule = await mainDatabase.query<{
    effective_time_rule_version: string;
  }>(
    `SELECT effective_time_rule_version
       FROM source_contract_rule_tuples
      WHERE authority_route <> $1
        AND effective_time_rule_version <> $2
      LIMIT 1`,
    [cathay.routeKey, cathayTuple.effectiveTimeRuleVersion],
  );
  const foreignEffectiveVersion = foreignEffectiveTimeRule.rows[0]?.effective_time_rule_version;
  assert.ok(foreignEffectiveVersion);
  await assert.rejects(
    insertBalanceObservationRevision(
      mainDatabase,
      observationIds,
      { ...cathayTuple, effectiveTimeRuleVersion: foreignEffectiveVersion },
      id(51),
      cathayContractVersion,
    ),
    /balance observation effective-time rule is not registered/u,
    "a balance observation must use a rule registered for its source contract",
  );
  await insertBalanceObservationRevision(
    mainDatabase,
    observationIds,
    cathayTuple,
    id(52),
    cathayContractVersion,
  );

  const rollbackCaptureId = id(60);
  const rollbackRecordId = id(61);
  const rollbackTransactionId = id(62);
  await assert.rejects(
    mainDatabase.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO source_captures
           (capture_id, capture_key, source_connection_id, identity_epoch_id,
            authority_route, source_subject_id, stream, record_kind,
            source_account_key, observed_at, scope_start, scope_end, completeness,
            completeness_basis, completeness_rule_version, commit_id)
         VALUES ($1, 'rollback-capture', $2, $3, $4, NULL, $5, $6, 'account',
                 '2026-10-03', '2026-10-03', '2026-10-03', 'complete-range',
                 'catalog-check', $7, $8)`,
        [
          rollbackCaptureId,
          mainIds.connectionId,
          mainIds.identityEpochId,
          cathay.routeKey,
          cathay.stream,
          cathay.stream,
          cathayRoute.registration.completenessRuleVersions?.[0] ?? cathayContractVersion,
          mainIds.commitId,
        ],
      );
      await transaction.query(
        "INSERT INTO source_records(source_record_id, capture_id, commit_id, record_kind, sequence_lexeme, payload_json) VALUES ($1, $2, $3, $4, 'rollback-1', '{}')",
        [rollbackRecordId, rollbackCaptureId, mainIds.commitId, cathay.stream],
      );
      await transaction.query(
        "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES ($1, $2, 'rollback-sequence', $3)",
        [rollbackTransactionId, mainIds.accountId, mainIds.commitId],
      );
      await transaction.query(
        `INSERT INTO transaction_revisions
           (revision_id, transaction_id, source_record_id, capture_id, commit_id,
            revision_number, amount_coefficient, amount_scale, currency, direction,
            posting_status, posting_origin, posting_basis, posting_rule_version,
            economic_status, administrative_state, semantic_rule_version, effective_on,
            transaction_date_time_local, time_zone, time_precision, time_origin,
            effective_time_basis, effective_time_rule_version, utc_instant_utc_us)
         VALUES ($1, $2, $3, $4, $5, 1, '1', 0, 'TWD', 'outflow', 'posted',
                 'provider_booked_history', 'query-status-success-with-accounting-date',
                 'unregistered/posting-rule', 'normal', 'active',
                 'unregistered/semantic-rule', '2026-10-03', '2026-10-03T00:00:00',
                 'Asia/Taipei', 'date', 'source_reported', 'accounting',
                 $6, 0)`,
        [
          id(63),
          rollbackTransactionId,
          rollbackRecordId,
          rollbackCaptureId,
          mainIds.commitId,
          cathayTuple.effectiveTimeRuleVersion,
        ],
      );
    }),
    /transaction rule tuple is not registered for its source capture contract/u,
    "an invalid fact must abort its entire source-capture transaction",
  );
  const rolledBackRows = await mainDatabase.query<{ count: number | string }>(
    `SELECT
       (SELECT COUNT(*) FROM source_captures WHERE capture_id = $1) +
       (SELECT COUNT(*) FROM source_records WHERE source_record_id = $2) +
       (SELECT COUNT(*) FROM financial_transactions WHERE transaction_id = $3) AS count`,
    [rollbackCaptureId, rollbackRecordId, rollbackTransactionId],
  );
  assert.equal(Number(rolledBackRows.rows[0]?.count), 0);
} finally {
  await mainDatabase.close();
}

const customDatabase = await PGlite.create();
try {
  const financialRegistration: CanonicalSourceRouteRegistration = {
    routeKey: "fixture-bank/domestic-deposit/financial-v1",
    integrationNamespace: "fixture-bank",
    stream: "domestic-deposit",
    contractVersions: ["financial-contract-v1", "financial-contract-v2"],
    ruleCombinations: [
      {
        contractVersion: "financial-contract-v1",
        postingRuleVersion: "fixture-bank/posting-v1",
        semanticRuleVersion: "fixture-bank/semantic-v1",
        effectiveTimeRuleVersion: "fixture-bank/effective-time-v1",
      },
      {
        contractVersion: "financial-contract-v2",
        postingRuleVersion: "fixture-bank/posting-v2",
        semanticRuleVersion: "fixture-bank/semantic-v2",
        effectiveTimeRuleVersion: "fixture-bank/effective-time-v2",
      },
    ],
  };
  const observationRegistration: CanonicalSourceRouteRegistration = {
    routeKey: "fixture-bank/domestic-deposit/balance-v1",
    integrationNamespace: "fixture-bank",
    stream: "domestic-deposit",
    contractVersions: ["balance-contract-v1"],
    ruleCombinations: [
      {
        contractVersion: "balance-contract-v1",
        postingRuleVersion: null,
        semanticRuleVersion: null,
        effectiveTimeRuleVersion: "fixture-bank/balance-time-v1",
      },
    ],
  };
  const customRegistry = [financialRegistration, observationRegistration] as const;
  const malformedRegistries: readonly (readonly CanonicalSourceRouteRegistration[])[] = [
    [financialRegistration, financialRegistration],
    [
      {
        ...financialRegistration,
        ruleCombinations: [
          {
            ...financialRegistration.ruleCombinations![0]!,
            contractVersion: "unregistered-contract-version",
          },
        ],
      },
    ],
    [
      {
        ...financialRegistration,
        contractVersions: ["financial-contract-v1", "financial-contract-v1"],
      },
    ],
    [
      {
        ...financialRegistration,
        ruleCombinations: [
          financialRegistration.ruleCombinations![0]!,
          financialRegistration.ruleCombinations![0]!,
        ],
      },
    ],
  ];
  for (const malformed of malformedRegistries) {
    assert.throws(
      () => buildTrustedSourceContractCatalog(malformed),
      /duplicate route|duplicate contract version|duplicate rule tuple|unregistered contract version/u,
      "malformed registrations must fail before catalog insertion",
    );
  }

  await customDatabase.transaction(async (transaction) => {
    await transaction.exec(PGLITE_BASELINE_SQL);
    await transaction.exec(PGLITE_OCCURRENCE_GROUP_SQL);
    await assert.rejects(
      installTrustedSourceContractCatalog(transaction, malformedRegistries[1]),
      /unregistered contract version/u,
    );
    const empty = await transaction.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM source_contract_catalog",
    );
    assert.equal(Number(empty.rows[0]?.count), 0);
    await installTrustedSourceContractCatalog(transaction, customRegistry);
    await transaction.exec(PGLITE_SOURCE_CONTRACT_CATALOG_GUARDS_SQL);
  });
  await assertTrustedSourceContractCatalog(customDatabase, customRegistry);

  const customFinancialRoute = runtimeRoute(
    financialRegistration,
    financialRegistration.contractVersions[0]!,
  );
  const customFinancialTuple = financialRegistration.ruleCombinations![0]!;
  const customFinancialIds: FixtureIds = {
    commitId: id(70),
    connectionId: id(71),
    identityEpochId: id(72),
    captureId: id(73),
    sourceRecordId: id(74),
    accountId: id(75),
    transactionId: id(76),
  };
  await seedCapture(customDatabase, customFinancialRoute, customFinancialIds, 70);
  await assert.rejects(
    customDatabase.query(
      "UPDATE source_authority_routes SET contract_version = $2 WHERE authority_route = $1",
      [financialRegistration.routeKey, financialRegistration.contractVersions[1]],
    ),
    /source authority route metadata is immutable/u,
    "a history route cannot switch to another authorized contract version",
  );
  await insertFinancialTransaction(customDatabase, customFinancialIds, "1");
  await insertTransactionRevision(
    customDatabase,
    customFinancialIds,
    customFinancialTuple,
    1,
  );
  const customRevisionCount = await customDatabase.query<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM transaction_revisions WHERE transaction_id = $1",
    [customFinancialIds.transactionId],
  );
  assert.equal(Number(customRevisionCount.rows[0]?.count), 1);

  const customObservationRoute = runtimeRoute(
    observationRegistration,
    observationRegistration.contractVersions[0]!,
  );
  const observationTuple = observationRegistration.ruleCombinations![0]!;
  const customObservationIds: FixtureIds = {
    commitId: id(80),
    connectionId: id(81),
    identityEpochId: id(82),
    captureId: id(83),
    sourceRecordId: id(84),
    accountId: id(85),
    transactionId: id(86),
  };
  await seedCapture(
    customDatabase,
    customObservationRoute,
    customObservationIds,
    80,
  );
  await insertBalanceObservationRevision(
    customDatabase,
    customObservationIds,
    observationTuple,
    id(87),
    "balance-contract-v1",
  );
} finally {
  await customDatabase.close();
}

const oldDatabase = await PGlite.create();
try {
  await oldDatabase.exec(`
    CREATE TABLE pglite_baseline_metadata (
      singleton_id SMALLINT PRIMARY KEY,
      baseline_version BIGINT NOT NULL,
      canonical_schema_version BIGINT NOT NULL,
      canonical_schema_signature TEXT NOT NULL,
      table_count BIGINT NOT NULL,
      index_count BIGINT NOT NULL,
      trigger_count BIGINT NOT NULL,
      view_count BIGINT NOT NULL,
      foreign_key_count BIGINT NOT NULL
    );
    INSERT INTO pglite_baseline_metadata VALUES (1, 2, 28, 'old', 0, 0, 0, 0, 0);
  `);
  await assert.rejects(
    applyPgliteBaseline(oldDatabase),
    /baseline metadata does not match/u,
    "an older baseline must fail closed without an automatic reset",
  );
  const untouchedMetadata = await oldDatabase.query<{ baseline_version: number | string }>(
    "SELECT baseline_version FROM pglite_baseline_metadata WHERE singleton_id = 1",
  );
  assert.equal(Number(untouchedMetadata.rows[0]?.baseline_version), 2);
  const catalogInstalled = await oldDatabase.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'source_contract_catalog') AS exists",
  );
  assert.equal(catalogInstalled.rows[0]?.exists, false);
} finally {
  await oldDatabase.close();
}
