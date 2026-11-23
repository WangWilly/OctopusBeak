import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { assignOccurrenceSlots } from "../canonical/occurrence-groups.ts";
import {
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import { installFinancialStore } from "./store-layout.ts";
import type { PGliteStore } from "./transaction.ts";

/** The tables a commit's projection refresh writes for each transaction in its capture. */
const PROJECTION_TABLES = [
  "current_transactions",
  "current_transaction_enrichment",
  "current_spending_pairing_entries",
  "projection_generation_transactions",
  "projection_generation_transaction_selection",
] as const;

const token = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
const day = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);

/** A complete card capture of `count` rows; every call for the same count observes the same rows. */
function cardCapture(captureId: string, count: number): PGliteCanonicalFinancialCommitRequest {
  const routeKey = "fubon/credit-card/human-attested-v2";
  const scopeKey = token("scope");
  const rows = Array.from({ length: count }, (_, index) => ({
    index,
    date: day(index % 90),
    fingerprint: token(`row-${index}`),
    bucketKey: `2026-${String(1 + Math.floor((index % 90) / 30)).padStart(2, "0")}`,
  }));
  const slots = assignOccurrenceSlots({
    rows,
    complete: true,
    scopeKey: () => scopeKey,
    fingerprint: (row) => row.fingerprint,
    partitionDate: (row) => row.date,
  });
  const amount = (index: number) => ({ coefficient: String(1000 + index), scale: 0 });
  return {
    capture: {
      captureId,
      integrationNamespace: "fubon",
      sourceConnectionKey: token("connection"),
      identityEpoch: token("epoch"),
      stream: "credit-card",
      recordKind: "fubon-credit-card-transaction",
      routeKey,
      contractVersion: routeKey,
      subjectDigest: token("subject"),
      observedAt: "2026-09-30T00:00:00.000Z",
      accountNumber: { value: "123456", kind: "credit-portfolio-account", evidenceVersion: "synthetic-v1", sourceField: "accountNumber" },
      scope: {
        startDate: "2026-01-01", endDate: "2026-03-31", dateFormat: "YYYY-MM-DD", kind: "bounded-range",
        completeness: "complete-range", completenessBasis: "full-bounded-range", ruleVersion: routeKey, sourceAccountKey: "card",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: slots.length, terminal: true, metadata: { pageCount: 1 } }],
      records: slots.map(({ row, occurrenceKey, collisionKey, group }) => ({
        occurrenceKey,
        collisionKey,
        sequenceLexeme: `${row.date}/${row.fingerprint}/${group.ordinal}`,
        providerKey: "human-attested:no-provider-key",
        contentHash: token(JSON.stringify([row.date, row.fingerprint])),
        compact: { amount: amount(row.index), currency: "TWD", direction: "outflow", postedOn: row.date, description: `MERCHANT ${row.index}` },
        occurrenceGroup: group,
        occurrenceGroupBucketKey: row.bucketKey,
      })),
      occurrenceGroupCoverage: [{
        scopeKey, startDate: "2026-01-01", endDate: "2026-03-31", contractVersion: routeKey,
        bucketKeys: [...new Set(rows.map((row) => row.bucketKey))],
      }],
    },
    account: { sourceAccountKey: "card", accountNo: "123456", accountType: "credit", currency: "TWD" },
    transactions: slots.map(({ row, occurrenceKey, group }) => ({
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: `${row.date}-${row.fingerprint}-${group.ordinal}`,
      amount: amount(row.index),
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: routeKey,
      description: `MERCHANT ${row.index}`,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: routeKey,
      effectiveOn: row.date,
      transactionDateTimeLocal: `${row.date}T00:00:00+08:00`,
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: routeKey,
      utcInstantUtcUs: Date.parse(`${row.date}T00:00:00.000+08:00`) * 1000,
    })),
    withdrawalPolicy: "never-infer",
  } as unknown as PGliteCanonicalFinancialCommitRequest;
}

/** Each table's live rows, the transaction that wrote each, and its heap pages. */
async function tableState(store: PGliteStore) {
  const state: Record<string, { rows: number; writers: string; pages: number }> = {};
  for (const table of PROJECTION_TABLES) {
    const row = (await store.query<{ rows: number | string; writers: string | null; pages: number | string }>(
      `SELECT count(*) AS rows,
              string_agg(xmin::text, ',' ORDER BY transaction_id) AS writers,
              pg_relation_size('${table}') / current_setting('block_size')::int AS pages
         FROM ${table}`,
    )).rows[0]!;
    state[table] = { rows: Number(row.rows), writers: row.writers ?? "", pages: Number(row.pages) };
  }
  return state;
}

test("committing the same capture again rewrites no projection row, so the tables stay their size", async () => {
  const store = await installFinancialStore(await PGlite.create());
  try {
    await commitPGliteCanonicalFinancialCapture(store, cardCapture("capture-0", 60));
    const first = await tableState(store);
    for (const table of PROJECTION_TABLES) assert.ok(first[table]!.rows === 60, `${table} holds every transaction`);
    for (let sync = 1; sync <= 20; sync += 1) await commitPGliteCanonicalFinancialCapture(store, cardCapture(`capture-${sync}`, 60));
    const after = await tableState(store);
    for (const table of PROJECTION_TABLES) {
      assert.equal(after[table]!.rows, 60, `${table} still holds every transaction`);
      assert.equal(after[table]!.writers, first[table]!.writers, `${table} rows were not rewritten`);
      assert.equal(after[table]!.pages, first[table]!.pages, `${table} did not grow`);
    }
  } finally {
    await store.close();
  }
});

test("a re-sync that adds a transaction writes only that transaction's rows", async () => {
  const store = await installFinancialStore(await PGlite.create());
  try {
    await commitPGliteCanonicalFinancialCapture(store, cardCapture("capture-0", 10));
    const first = await tableState(store);
    await commitPGliteCanonicalFinancialCapture(store, cardCapture("capture-1", 11));
    const after = await tableState(store);
    for (const table of PROJECTION_TABLES) {
      const before = new Set(first[table]!.writers.split(","));
      const now = after[table]!.writers.split(",");
      assert.equal(now.length, 11, `${table} holds the new transaction`);
      assert.equal(now.filter((writer) => !before.has(writer)).length, 1, `${table} wrote one row`);
    }
  } finally {
    await store.close();
  }
});
