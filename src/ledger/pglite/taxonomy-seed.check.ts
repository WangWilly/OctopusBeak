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
