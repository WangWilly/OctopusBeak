import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import { PGliteStore } from "./transaction.ts";
import {
  commitPGliteCanonicalDepositCapture,
  type PGliteCanonicalDepositCommitRequest,
} from "./deposit.ts";

const token = (value: string): string => `sha256:${createHash("sha256").update(value).digest("base64url")}`;
const uuid = (): Uint8Array => Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));

function cathayDepositCapture(captureId: string, amount = "100"): PGliteCanonicalDepositCommitRequest {
  return {
    capture: {
      captureId,
      authorityRoute: "cathay/domestic-deposit/v1",
      contractVersion: "v1",
      identity: {
        integrationNamespace: "cathay",
        sourceConnectionKey: token("categorization-sync-connection"),
        identityEpochKey: token("categorization-sync-epoch"),
        stream: "domestic-deposit",
        recordKind: "categorization-sync-deposit",
        subjectDigest: token("categorization-sync-subject"),
        accountNo: "900002",
        sourceAccountKey: "900002",
        accountNumber: { value: "900002", kind: "depository-account", evidenceVersion: "synthetic-v1", sourceField: "accountNumber" },
        accountType: "depository",
        currency: "TWD",
      },
      observedAt: "2026-09-22T13:00:00.000Z",
      scope: {
        startDate: "2026-09-22",
        endDate: "2026-09-22",
        scopeKind: "bounded-range",
        completeness: "complete-range",
        completenessBasis: "categorization-sync-complete-range",
        completenessRuleVersion: "cathay/domestic-deposit/v1",
        absenceAuthority: "comparable-complete-range",
        contractFingerprint: token("categorization-sync-contract"),
        preflightFingerprint: token("categorization-sync-preflight"),
        pageCount: 1,
        withdrawalPolicy: "allow-inference",
      },
      semantics: {
        postingStatus: "posted",
        postingOrigin: "provider_booked_history",
        postingBasis: "query-status-success-with-accounting-date",
        postingRuleVersion: "cathay/domestic-deposit/v1",
        economicStatus: "normal",
        administrativeState: "active",
        semanticRuleVersion: "cathay/domestic-deposit/v1",
        effectiveTimeBasis: "accounting",
        effectiveTimeRuleVersion: "cathay/domestic-deposit/v1",
        timeZone: "Asia/Taipei",
        timePrecision: "second",
        timeOrigin: "source_reported",
        requireBalance: false,
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        responseDigest: token(`${captureId}:page`),
        proofKind: "synthetic",
        contractFingerprint: token("categorization-sync-contract"),
        preflightFingerprint: token("categorization-sync-preflight"),
        metadataJson: JSON.stringify({ fixture: "projection-categorization-sync-check" }),
      }],
      records: [{
        occurrenceKey: token("categorization-sync-transaction"),
        collisionKey: token("categorization-sync-collision"),
        providerKey: token("categorization-sync-provider"),
        contentHash: token(`categorization-sync-content:${amount}`),
        sequenceLexeme: "1",
        compactJson: JSON.stringify({ amount: { coefficient: amount, scale: 0 } }),
        amount: { coefficient: amount, scale: 0 },
        balanceAfter: null,
        currency: "TWD",
        direction: "outflow",
        sourceTime: {
          localDate: "2026-09-22",
          localTime: "12:00:00",
          timeZone: "Asia/Taipei",
          epochMilliseconds: Date.parse("2026-09-22T12:00:00+08:00"),
          precision: "second" as const,
          timeOrigin: "source_reported" as const,
        },
        effectiveOn: "2026-09-22",
        transactionDateTimeLocal: "2026-09-22T12:00:00",
        description: "全聯福利中心",
      }],
    },
  };
}

type Current = Readonly<{ transactionId: Uint8Array; revisionId: Uint8Array; generationId: number; commitId: Uint8Array }>;

async function currentTransaction(store: PGliteStore): Promise<Current> {
  const row = (await store.query<{ transaction_id: Uint8Array; revision_id: Uint8Array; generation_id: number | string; commit_id: Uint8Array }>(
    `SELECT current_row.transaction_id, current_row.revision_id, generation.generation_id, current_row.projection_commit_id AS commit_id
       FROM current_transactions current_row
       JOIN active_projection_generation generation ON TRUE`,
  )).rows[0];
  assert.ok(row, "the capture must project one current transaction");
  return { transactionId: row.transaction_id, revisionId: row.revision_id, generationId: Number(row.generation_id), commitId: row.commit_id };
}

/** Writes a user single-category assertion the way a user command would, then
 * projects it into the active generation. */
async function writeUserCategory(store: PGliteStore, current: Current, code: string): Promise<Uint8Array> {
  const commitId = uuid();
  const sequence = Number((await store.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) + 1 AS value FROM canonical_commits")).rows[0]!.value);
  await store.query(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, $2, $3, 'user/local', 'user_assertion')",
    [commitId, sequence, Date.now() * 1000],
  );
  const assertionId = uuid();
  await store.query(
    `INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
     VALUES ($1, $2, 'category', 'transaction', 'user', 'local-user', 'user/categorization/v1', NULL, $3, $4)`,
    [assertionId, current.transactionId, code, commitId],
  );
  await store.query(
    `INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind)
     VALUES ($1, $2, $3, 'category', NULL, NULL, NULL, NULL, NULL, 'local-user', $4, 'observed')`,
    [uuid(), assertionId, current.transactionId, commitId],
  );
  await store.query(
    "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) VALUES ($1, NULL, NULL, NULL, NULL, $2)",
    [assertionId, commitId],
  );
  await store.query(
    `INSERT INTO transaction_categorization_values(assertion_id, transaction_id, mode, category_code, allocation_set_id, taxonomy_id, taxonomy_version, taxonomy_dimension, created_commit_id)
     VALUES ($1, $2, 'single', $3, NULL, 'transaction-taxonomy', 'v1', 'category', $4)`,
    [assertionId, current.transactionId, code, commitId],
  );
  await store.query(
    `INSERT INTO projection_generation_transaction_categorizations(
       generation_id, transaction_id, revision_id, assertion_id, mode, category_code,
       taxonomy_id, taxonomy_version, component_ordinal, projection_commit_id
     ) VALUES ($1, $2, $3, $4, 'single', $5, 'transaction-taxonomy', 'v1', 0, $6)`,
    [current.generationId, current.transactionId, current.revisionId, assertionId, code, commitId],
  );
  return assertionId;
}

async function generationCategorizations(store: PGliteStore, transactionId: Uint8Array) {
  return (await store.query<{ assertion_id: Uint8Array; category_code: string; mode: string }>(
    `SELECT assertion_id, category_code, mode
       FROM projection_generation_transaction_categorizations
      WHERE transaction_id = $1
      ORDER BY component_ordinal`,
    [transactionId],
  )).rows.map((row) => ({ assertionId: Buffer.from(row.assertion_id).toString("hex"), categoryCode: row.category_code, mode: row.mode }));
}

test("a capture that re-observes a user-categorized transaction keeps its generation categorization", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalDepositCapture(store, cathayDepositCapture("categorization-sync-first"));
    const current = await currentTransaction(store);
    const assertionId = await writeUserCategory(store, current, "food_and_groceries");
    assert.deepEqual(await generationCategorizations(store, current.transactionId), [
      { assertionId: Buffer.from(assertionId).toString("hex"), categoryCode: "food_and_groceries", mode: "single" },
    ]);

    await commitPGliteCanonicalDepositCapture(store, cathayDepositCapture("categorization-sync-recurrent"));

    assert.deepEqual(await generationCategorizations(store, current.transactionId), [
      { assertionId: Buffer.from(assertionId).toString("hex"), categoryCode: "food_and_groceries", mode: "single" },
    ], "the user category survives the re-observation in the active generation");
  } finally {
    await store.close();
  }
});
