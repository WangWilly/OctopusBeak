import assert from "node:assert/strict";
import { test } from "node:test";
import { TRANSACTION_TAXONOMY_PACKAGE_V1 } from "../canonical/transaction-taxonomy.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { installFinancialStore } from "./store-layout.ts";

test("a store holds every producer compatibility row the package defines, and reopening adds none", async () => {
  const database = await createTestPGlite("ledger");
  await installFinancialStore(database);
  const store = await installFinancialStore(database);
  try {
    const rows = await store.query<{ producer_id: string; producer_version: string; origin: string; field_name: string; output_code: string | null; evidence_kinds_json: string }>(
      "SELECT producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json FROM taxonomy_producer_compatibility");
    const key = (row: { producerId: string; producerVersion: string; origin: string; field: string; outputCode: string | null; evidenceKinds: readonly string[] }) =>
      [row.producerId, row.producerVersion, row.origin, row.field, row.outputCode, JSON.stringify(row.evidenceKinds)].join("|");
    const stored = rows.rows.map((row) => key({ producerId: row.producer_id, producerVersion: row.producer_version, origin: row.origin, field: row.field_name, outputCode: row.output_code, evidenceKinds: JSON.parse(row.evidence_kinds_json) }));
    assert.deepEqual(new Set(stored), new Set(TRANSACTION_TAXONOMY_PACKAGE_V1.producerCompatibility.map(key)));
    assert.equal(stored.length, TRANSACTION_TAXONOMY_PACKAGE_V1.producerCompatibility.length);
  } finally {
    await store.close();
  }
});

test("a store holds every producer version and automatic route the package defines", async () => {
  const database = await createTestPGlite("ledger");
  const store = await installFinancialStore(database);
  try {
    const versions = await store.query<{ producer_id: string; producer_version: string; confidence_threshold_basis_points: number | string }>(
      "SELECT producer_id, producer_version, confidence_threshold_basis_points FROM enrichment_producer_versions");
    assert.deepEqual(
      new Set(versions.rows.map((row) => `${row.producer_id}@${row.producer_version}:${Number(row.confidence_threshold_basis_points)}`)),
      new Set(TRANSACTION_TAXONOMY_PACKAGE_V1.producerVersions.map((row) => `${row.producerId}@${row.producerVersion}:${row.confidenceThresholdBasisPoints}`)));
    const routes = await store.query<{ route_id: string; scope_key: string | null; producer_id: string; producer_version: string; field_name: string }>(
      "SELECT route_id, scope_key, producer_id, producer_version, field_name FROM automatic_enrichment_authority_routes");
    assert.deepEqual(
      new Set(routes.rows.map((row) => [row.route_id, row.scope_key, row.producer_id, row.producer_version, row.field_name].join("|"))),
      new Set(TRANSACTION_TAXONOMY_PACKAGE_V1.automaticRoutes.map((row) => [row.routeId, row.scopeKey, row.producerId, row.producerVersion, row.field].join("|"))));
  } finally {
    await store.close();
  }
});

test("a store installed before the investment and loan event producer gains it on open", async () => {
  const database = await createTestPGlite("ledger");
  const store = await installFinancialStore(database);
  try {
    // An older baseline held none of the producer's rows and recorded no seed step for them.
    await database.exec(`
      ALTER TABLE taxonomy_producer_compatibility DISABLE TRIGGER USER;
      ALTER TABLE automatic_enrichment_authority_routes DISABLE TRIGGER USER;
      ALTER TABLE enrichment_producer_versions DISABLE TRIGGER USER;
      DELETE FROM taxonomy_producer_compatibility WHERE producer_id = 'account-event/kind-enrichment';
      DELETE FROM automatic_enrichment_authority_routes WHERE producer_id = 'account-event/kind-enrichment';
      DELETE FROM enrichment_producer_versions WHERE producer_id = 'account-event/kind-enrichment';
      ALTER TABLE taxonomy_producer_compatibility ENABLE TRIGGER USER;
      ALTER TABLE automatic_enrichment_authority_routes ENABLE TRIGGER USER;
      ALTER TABLE enrichment_producer_versions ENABLE TRIGGER USER;
      DELETE FROM pglite_operational_migrations WHERE migration_key = 'taxonomy-account-event-kinds-v1';`);
    await installFinancialStore(database);
    const count = async (table: string) => Number((await store.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE producer_id = 'account-event/kind-enrichment'`)).rows[0]?.count);
    assert.deepEqual([await count("enrichment_producer_versions"), await count("automatic_enrichment_authority_routes"), await count("taxonomy_producer_compatibility")],
      [1, 6, 8]);
  } finally {
    await store.close();
  }
});

test("a store installed before TDCC deposits had a Kind route gains the route and Cathay's transfer output on open", async () => {
  const database = await createTestPGlite("ledger");
  const store = await installFinancialStore(database);
  try {
    await database.exec(`
      ALTER TABLE taxonomy_producer_compatibility DISABLE TRIGGER USER;
      ALTER TABLE automatic_enrichment_authority_routes DISABLE TRIGGER USER;
      DELETE FROM taxonomy_producer_compatibility
       WHERE producer_id = 'cathay/domestic-deposit/automatic-enrichment' AND origin = 'derived' AND field_name = 'kind' AND output_code = 'transfer';
      DELETE FROM automatic_enrichment_authority_routes WHERE scope_key = 'tdcc/domestic-deposit';
      ALTER TABLE taxonomy_producer_compatibility ENABLE TRIGGER USER;
      ALTER TABLE automatic_enrichment_authority_routes ENABLE TRIGGER USER;`);
    await store.query("DELETE FROM pglite_operational_migrations WHERE migration_key = $1", ["taxonomy-deposit-kind-gaps-v1"]);
    await installFinancialStore(database);
    const routes = await store.query<{ route_id: string; producer_id: string }>(
      "SELECT route_id, producer_id FROM automatic_enrichment_authority_routes WHERE scope_key = 'tdcc/domestic-deposit'");
    assert.deepEqual(routes.rows, [{ route_id: "tdcc/domestic-deposit/kind-enrichment/v4/kind", producer_id: "bank/deposit-kind-enrichment" }]);
    const transfer = await store.query(
      `SELECT 1 FROM taxonomy_producer_compatibility
        WHERE producer_id = 'cathay/domestic-deposit/automatic-enrichment' AND origin = 'derived' AND field_name = 'kind' AND output_code = 'transfer'`);
    assert.equal(transfer.rows.length, 1);
  } finally {
    await store.close();
  }
});

test("a store installed before the interest-and-fees category gains the code, its labels and applicability, and its Kind producer on open (ADR 0141)", async () => {
  const database = await createTestPGlite("ledger");
  const store = await installFinancialStore(database);
  try {
    const tables = ["taxonomy_producer_compatibility", "automatic_enrichment_authority_routes", "enrichment_producer_versions", "taxonomy_applicability", "taxonomy_localizations", "taxonomy_codes"];
    for (const table of tables) await store.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await store.query("DELETE FROM taxonomy_producer_compatibility WHERE output_code = $1", ["interest_and_fees"]);
    await store.query("DELETE FROM automatic_enrichment_authority_routes WHERE producer_id = $1", ["kind/category-enrichment"]);
    await store.query("DELETE FROM enrichment_producer_versions WHERE producer_id = $1", ["kind/category-enrichment"]);
    await store.query("DELETE FROM taxonomy_applicability WHERE category_code = $1", ["interest_and_fees"]);
    await store.query("DELETE FROM taxonomy_localizations WHERE code = $1", ["interest_and_fees"]);
    await store.query("DELETE FROM taxonomy_codes WHERE code = $1", ["interest_and_fees"]);
    for (const table of tables) await store.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await store.query("DELETE FROM pglite_operational_migrations WHERE migration_key = $1", ["taxonomy-interest-and-fees-v1"]);

    await installFinancialStore(database);
    const count = async (sql: string, value: string) => Number((await store.query<{ count: number | string }>(sql, [value])).rows[0]?.count);
    assert.deepEqual([
      await count("SELECT COUNT(*) AS count FROM taxonomy_codes WHERE dimension = 'category' AND code = $1", "interest_and_fees"),
      await count("SELECT COUNT(*) AS count FROM taxonomy_localizations WHERE code = $1", "interest_and_fees"),
      await count("SELECT COUNT(*) AS count FROM taxonomy_applicability WHERE category_code = $1", "interest_and_fees"),
      await count("SELECT COUNT(*) AS count FROM enrichment_producer_versions WHERE producer_id = $1", "kind/category-enrichment"),
      await count("SELECT COUNT(*) AS count FROM automatic_enrichment_authority_routes WHERE producer_id = $1", "kind/category-enrichment"),
      await count("SELECT COUNT(*) AS count FROM taxonomy_producer_compatibility WHERE output_code = $1", "interest_and_fees"),
    ], [1, 2, 14, 1, 1, 3]);
    const labels = await store.query<{ locale: string; label: string }>(
      "SELECT locale, label FROM taxonomy_localizations WHERE code = $1 ORDER BY locale", ["interest_and_fees"]);
    assert.deepEqual(labels.rows, [{ locale: "en", label: "Interest And Fees" }, { locale: "zh-Hant", label: "利息與手續費" }]);
  } finally {
    await store.close();
  }
});

test("a fresh store holds every Personal Category, localization and applicability row the package defines", async () => {
  const database = await createTestPGlite("ledger");
  const store = await installFinancialStore(database);
  try {
    const codes = await store.query<{ code: string }>("SELECT code FROM taxonomy_codes WHERE dimension = 'category'");
    assert.deepEqual(new Set(codes.rows.map((row) => row.code)), new Set(TRANSACTION_TAXONOMY_PACKAGE_V1.categories.map((row) => row.code)));
    const applicability = await store.query<{ category_code: string; kind_code: string }>("SELECT category_code, kind_code FROM taxonomy_applicability");
    assert.deepEqual(new Set(applicability.rows.map((row) => `${row.category_code}|${row.kind_code}`)),
      new Set(TRANSACTION_TAXONOMY_PACKAGE_V1.applicability.map((row) => `${row.categoryCode}|${row.kindCode}`)));
    const labels = await store.query<{ dimension: string; code: string; locale: string; label: string }>("SELECT dimension, code, locale, label FROM taxonomy_localizations");
    assert.deepEqual(new Set(labels.rows.map((row) => `${row.dimension}.${row.code}|${row.locale}|${row.label}`)),
      new Set(Object.entries(TRANSACTION_TAXONOMY_PACKAGE_V1.localizations).flatMap(([key, value]) =>
        Object.entries(value).map(([locale, label]) => `${key.replace("transaction-taxonomy.", "")}|${locale}|${label}`))));
  } finally {
    await store.close();
  }
});
