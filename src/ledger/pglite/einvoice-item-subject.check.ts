import assert from "node:assert/strict";
import test from "node:test";
import { createBaselinePGlite } from "./baseline-test-template.ts";
import { PGliteStore } from "./transaction.ts";
import {
  EINVOICE_ITEM_CATEGORY_ENRICHMENT_ROUTE_ID,
  TRANSACTION_TAXONOMY_PACKAGE_V1,
} from "../canonical/transaction-taxonomy.ts";

function id(seed: number): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes[15] = seed & 0xff;
  bytes[14] = (seed >> 8) & 0xff;
  return bytes;
}

async function fixture(): Promise<PGliteStore> {
  const database = await createBaselinePGlite();
  const store = new PGliteStore(database);
  await store.query(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, 1, 1, 'fixture', 'source_capture')",
    [id(1)],
  );
  await store.query(
    "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES ($1, 'einvoice', 'fixture-connection', $2)",
    [id(2), id(1)],
  );
  await store.query(
    "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES ($1, $2, 'fixture-epoch', $3)",
    [id(3), id(2), id(1)],
  );
  await store.query(
    `INSERT INTO source_subjects(source_subject_id, source_connection_id, identity_epoch_id, stream, record_kind, subject_digest, created_commit_id)
     VALUES ($1, $2, $3, 'personal-invoices', 'personal-invoice', 'fixture-subject', $4)`,
    [id(4), id(2), id(3), id(1)],
  );
  await store.query(
    `INSERT INTO einvoice_invoices(invoice_id, source_connection_id, identity_epoch_id, source_subject_id, stable_invoice_key, created_commit_id)
     VALUES ($1, $2, $3, $4, 'fixture-invoice', $5)`,
    [id(5), id(2), id(3), id(4), id(1)],
  );
  return store;
}

const INSERT_ASSERTION = `INSERT INTO assertions(
  assertion_id, transaction_id, invoice_id, item_sequence, field_name, target_kind, origin,
  producer_id, rule_lineage, revision_id, value_text, created_commit_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, 'local-user', 'user/categorization/v1', NULL, $8, $9)`;

test("an assertion names exactly one subject and items accept only category assertions", async () => {
  const store = await fixture();
  try {
    await assert.rejects(
      store.query(INSERT_ASSERTION, [id(10), id(99), id(5), 1, "category", "einvoice_item", "user", "dining", id(1)]),
      /check constraint|violates/iu,
      "an item assertion must not also carry a transaction",
    );
    await assert.rejects(
      store.query(INSERT_ASSERTION, [id(11), null, null, null, "category", "einvoice_item", "user", "dining", id(1)]),
      /check constraint|violates/iu,
      "an assertion without any subject is rejected",
    );
    await assert.rejects(
      store.query(INSERT_ASSERTION, [id(12), null, id(5), 1, "kind", "einvoice_item", "derived", "purchase", id(1)]),
      /check constraint|violates/iu,
      "items carry categories only",
    );
    await assert.rejects(
      store.query(INSERT_ASSERTION, [id(13), null, id(5), 0, "category", "einvoice_item", "user", "dining", id(1)]),
      /check constraint|violates/iu,
      "item sequence starts at one",
    );
    await store.query(INSERT_ASSERTION, [id(14), null, id(5), 2, "category", "einvoice_item", "user", "dining", id(1)]);
    const stored = await store.query<{ target_kind: string; item_sequence: string }>(
      "SELECT target_kind, item_sequence FROM assertions WHERE assertion_id = $1",
      [id(14)],
    );
    assert.deepEqual(stored.rows, [{ target_kind: "einvoice_item", item_sequence: 2 }]);
  } finally {
    await store.close();
  }
});

test("item transitions and typed values must name the assertion's own item subject", async () => {
  const store = await fixture();
  try {
    await store.query(INSERT_ASSERTION, [id(14), null, id(5), 2, "category", "einvoice_item", "user", "dining", id(1)]);
    const transition = `INSERT INTO assertion_transitions(
      event_id, assertion_id, transaction_id, invoice_id, item_sequence, field_name, capture_id, scope_id,
      run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind
    ) VALUES ($1, $2, NULL, $3, $4, 'category', NULL, NULL, NULL, NULL, NULL, 'local-user', $5, 'observed')`;
    await assert.rejects(
      store.query(transition, [id(20), id(14), id(5), 3, id(1)]),
      /assertion transition coordinate mismatch/u,
      "a transition on another item sequence is rejected",
    );
    await store.query(transition, [id(21), id(14), id(5), 2, id(1)]);
    const value = `INSERT INTO einvoice_item_categorization_values(
      assertion_id, invoice_id, item_sequence, origin, category_code, taxonomy_id, taxonomy_version,
      taxonomy_dimension, item_fact_fingerprint, route_id, created_commit_id
    ) VALUES ($1, $2, $3, 'user', $4, 'transaction-taxonomy', 'v1', 'category', 'fp', NULL, $5)`;
    await assert.rejects(
      store.query(value, [id(14), id(5), 2, "healthcare", id(1)]),
      /e-invoice item categorization assertion authority mismatch/u,
      "the typed value must repeat the asserted code",
    );
    await store.query(value, [id(14), id(5), 2, "dining", id(1)]);
    await assert.rejects(
      store.query("UPDATE einvoice_item_categorization_values SET category_code = 'healthcare' WHERE assertion_id = $1", [id(14)]),
      /immutable/u,
    );
    await assert.rejects(
      store.query("DELETE FROM einvoice_item_categorization_values WHERE assertion_id = $1", [id(14)]),
      /immutable/u,
    );
  } finally {
    await store.close();
  }
});

test("exactly one automatic route is active per subject kind, field, and scope (check 24)", async () => {
  const store = await fixture();
  try {
    const duplicates = await store.query<{ subject_kind: string; field_name: string; scope_key: string | null; routes: string }>(
      `SELECT subject_kind, field_name, scope_key, COUNT(*)::text AS routes
         FROM automatic_enrichment_authority_routes
        WHERE valid_to_commit_sequence IS NULL
        GROUP BY subject_kind, field_name, scope_kind, scope_key
       HAVING COUNT(*) > 1`,
    );
    assert.deepEqual(duplicates.rows, []);
    const itemRoute = await store.query<{ route_id: string; producer_id: string; origin_policy: string }>(
      "SELECT route_id, producer_id, origin_policy FROM automatic_enrichment_authority_routes WHERE subject_kind = 'einvoice_item'",
    );
    assert.deepEqual(itemRoute.rows, [{
      route_id: EINVOICE_ITEM_CATEGORY_ENRICHMENT_ROUTE_ID,
      producer_id: "einvoice/item-category-enrichment",
      origin_policy: "derived",
    }]);
    const compatibility = await store.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM taxonomy_producer_compatibility WHERE producer_id = 'einvoice/item-category-enrichment' AND field_name = 'category' AND origin = 'derived'",
    );
    assert.equal(Number(compatibility.rows[0]?.count), TRANSACTION_TAXONOMY_PACKAGE_V1.categories.length);
  } finally {
    await store.close();
  }
});
