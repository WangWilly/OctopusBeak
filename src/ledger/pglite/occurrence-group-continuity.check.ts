import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { assignOccurrenceSlots } from "../canonical/occurrence-groups.ts";
import { applyPgliteBaseline } from "./baseline.ts";
import {
  admitPGliteCanonicalSourceCapture,
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import { PGliteCanonicalSourceAdmissionError } from "./source-admission-validation.ts";
import { PGliteStore } from "./transaction.ts";

const token = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;

type Row = Readonly<{ date: string; fingerprint: string; bucketKey?: string }>;

function request(
  captureId: string,
  rows: readonly Row[],
  options: Readonly<{
    scopeKey?: string;
    coverageScopeKeys?: readonly string[];
    subjectDigest?: string;
    recordKind?: string;
    startDate?: string;
    endDate?: string;
    coverage?: boolean;
    queriedBuckets?: boolean;
    bucketKeys?: readonly string[];
  }> = {},
): PGliteCanonicalFinancialCommitRequest {
  const scopeKey = options.scopeKey ?? token("checking-source-bucket");
  const routeKey = options.queriedBuckets
    ? "synthetic/domestic-deposit/queried-buckets-v1"
    : "synthetic/domestic-deposit/v8";
  const contractVersion = options.queriedBuckets
    ? "synthetic-queried-buckets-v1"
    : "synthetic-v8";
  const slots = assignOccurrenceSlots({
    rows,
    complete: true,
    scopeKey: () => scopeKey,
    fingerprint: (row) => row.fingerprint,
    partitionDate: (row) => row.date,
  });
  const records = slots.map(({ row, occurrenceKey, collisionKey, group }) => ({
    occurrenceKey,
    collisionKey,
    sequenceLexeme: `${row.date}/${row.fingerprint}/${group.ordinal}`,
    providerKey: "human-attested:no-provider-key",
    contentHash: token(JSON.stringify([row.date, row.fingerprint])),
    compact: { amount: { coefficient: "100", scale: 0 } },
    occurrenceGroup: group,
    ...(row.bucketKey === undefined ? {} : { occurrenceGroupBucketKey: row.bucketKey }),
  }));
  const capture: PGliteCanonicalFinancialCommitRequest["capture"] = {
    captureId,
    integrationNamespace: "synthetic",
    sourceConnectionKey: token("source-connection"),
    identityEpoch: token("identity-epoch"),
    stream: "domestic-deposit",
    recordKind: options.recordKind ?? "source-record",
    routeKey,
    contractVersion,
    subjectDigest: options.subjectDigest ?? token("source-subject"),
    observedAt: "2026-09-30T00:00:00.000Z",
    accountNumber: {
      value: "123456",
      kind: "depository-account",
      evidenceVersion: "synthetic-v1",
      sourceField: "accountNumber",
    },
    scope: {
      startDate: options.startDate ?? "2026-01-01",
      endDate: options.endDate ?? "2026-01-31",
      dateFormat: "YYYY-MM-DD",
      kind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "full-bounded-range",
      ruleVersion: "synthetic-completeness-v1",
      sourceAccountKey: "checking-account",
    },
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: records.length,
      terminal: true,
      metadata: { pageCount: 1 },
    }],
    records,
    ...(options.coverage === false ? {} : {
      occurrenceGroupCoverage: (options.coverageScopeKeys ?? [scopeKey]).map((coverageScopeKey) => ({
        scopeKey: coverageScopeKey,
        startDate: options.startDate ?? "2026-01-01",
        endDate: options.endDate ?? "2026-01-31",
        contractVersion,
        ...(options.bucketKeys === undefined ? {} : { bucketKeys: options.bucketKeys }),
      })),
    }),
  };
  return {
    capture,
    account: {
      sourceAccountKey: "checking-account",
      accountNo: "123456",
      accountType: "depository",
      currency: "TWD",
    },
    transactions: slots.map(({ row, occurrenceKey, group }) => ({
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: `${row.date}-${row.fingerprint}-${group.ordinal}`,
      amount: { coefficient: "100", scale: 0 },
      currency: "TWD",
      direction: "inflow" as const,
      postingStatus: "posted" as const,
      postingOrigin: "synthetic_origin",
      postingBasis: "synthetic_basis",
      postingRuleVersion: "synthetic-v1",
      description: "grouped source record",
      economicStatus: "normal" as const,
      administrativeState: "active" as const,
      semanticRuleVersion: "synthetic-v1",
      effectiveOn: row.date,
      transactionDateTimeLocal: `${row.date}T00:00:00+08:00`,
      timeZone: "Asia/Taipei" as const,
      timePrecision: "second" as const,
      timeOrigin: "source_reported" as const,
      effectiveTimeBasis: "accounting" as const,
      effectiveTimeRuleVersion: "synthetic-v1",
      utcInstantUtcUs: Date.parse(`${row.date}T00:00:00.000+08:00`) * 1000,
    })),
  };
}

async function counts(store: PGliteStore): Promise<Record<string, number>> {
  const result = await store.query<{ table_name: string; value: number | string }>(
    `SELECT table_name, value FROM (
       SELECT 'commits' AS table_name, COUNT(*) AS value FROM canonical_commits
       UNION ALL SELECT 'captures', COUNT(*) FROM source_captures
       UNION ALL SELECT 'records', COUNT(*) FROM source_records
       UNION ALL SELECT 'transactions', COUNT(*) FROM financial_transactions
       UNION ALL SELECT 'revisions', COUNT(*) FROM transaction_revisions
       UNION ALL SELECT 'coverages', COUNT(*) FROM source_occurrence_group_coverages
       UNION ALL SELECT 'group_counts', COUNT(*) FROM source_occurrence_group_counts
     ) totals ORDER BY table_name`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.table_name, Number(row.value)]));
}

const duplicateRows = (count: number, bucketKey?: string): readonly Row[] => Array.from(
  { length: count },
  () => ({
    date: "2026-01-10",
    fingerprint: token("same-semantic-transaction"),
    ...(bucketKey === undefined ? {} : { bucketKey }),
  }),
);

test("append-only group counts survive reopen and atomically block reductions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "occurrence-group-continuity-"));
  const dataDirectory = join(directory, "pglite");
  let database = await PGlite.create(dataDirectory);
  let store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalFinancialCapture(store, request("group-count-2", duplicateRows(2)));
    await store.close();

    database = await PGlite.create(dataDirectory);
    store = new PGliteStore(database);
    await applyPgliteBaseline(database);
    const afterTwo = await counts(store);
    assert.equal(afterTwo.coverages, 1);
    assert.equal(afterTwo.group_counts, 1);
    assert.equal(afterTwo.transactions, 2);
    assert.deepEqual((await store.query<{
      occurrence_group_scope_key: string;
      occurrence_group_fingerprint: string;
      occurrence_group_partition_date: string;
      occurrence_group_ordinal: number | string;
    }>(
      `SELECT occurrence_group_scope_key, occurrence_group_fingerprint,
              occurrence_group_partition_date::text AS occurrence_group_partition_date,
              occurrence_group_ordinal
         FROM source_records ORDER BY occurrence_group_ordinal`,
    )).rows.map((row) => ({
      ...row,
      occurrence_group_ordinal: Number(row.occurrence_group_ordinal),
    })), [
      {
        occurrence_group_scope_key: token("checking-source-bucket"),
        occurrence_group_fingerprint: token("same-semantic-transaction"),
        occurrence_group_partition_date: "2026-01-10",
        occurrence_group_ordinal: 1,
      },
      {
        occurrence_group_scope_key: token("checking-source-bucket"),
        occurrence_group_fingerprint: token("same-semantic-transaction"),
        occurrence_group_partition_date: "2026-01-10",
        occurrence_group_ordinal: 2,
      },
    ]);

    const groupMutation = request("group-metadata-overwrite", duplicateRows(2));
    const mutatedCapture = {
      ...groupMutation.capture,
      records: groupMutation.capture.records.map((record, index) => index === 0
        ? {
            ...record,
            occurrenceGroup: {
              ...record.occurrenceGroup!,
              fingerprint: token("changed-semantic-transaction"),
            },
          }
        : record),
    };
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(store, { ...groupMutation, capture: mutatedCapture }),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "occurrence-conflict",
    );
    assert.deepEqual(await counts(store), afterTwo);

    // Coverage is the inventory of buckets actually queried by this capture.
    // A separate B-only capture does not assert that A became empty.
    await commitPGliteCanonicalFinancialCapture(store, request("group-independent-bucket", [], {
      scopeKey: token("another-source-bucket"),
    }));
    const afterIndependentBucket = await counts(store);
    assert.equal(afterIndependentBucket.coverages, afterTwo.coverages + 1);
    assert.equal(afterIndependentBucket.transactions, afterTwo.transactions);

    // When both buckets are declared queried, rows in B cannot hide the loss
    // of A's prior members. A is explicitly complete and has count zero.
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(store, request("group-partial-bucket-proof", duplicateRows(3), {
        scopeKey: token("another-source-bucket"),
        coverageScopeKeys: [token("checking-source-bucket"), token("another-source-bucket")],
      })),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "occurrence-conflict",
    );
    assert.deepEqual(await counts(store), afterIndependentBucket);

    for (const [captureId, rows] of [
      ["group-count-down-to-1", duplicateRows(1)],
      ["group-count-down-to-0", []],
    ] as const) {
      await assert.rejects(
        commitPGliteCanonicalFinancialCapture(store, request(captureId, rows)),
        (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError &&
          error.reason === "occurrence-conflict",
      );
      assert.deepEqual(await counts(store), afterIndependentBucket);
    }

    await commitPGliteCanonicalFinancialCapture(store, request("group-count-up-to-3", duplicateRows(3)));
    const afterThree = await counts(store);
    assert.equal(afterThree.group_counts, 2);
    assert.equal(afterThree.transactions, 3);

    // A later range beginning after the group's date is outside that group's
    // continuity window and does not imply that the old occurrence vanished.
    await commitPGliteCanonicalFinancialCapture(store, request("group-shifted-window", [], {
      startDate: "2026-01-11",
      endDate: "2026-01-31",
    }));
    const afterShift = await counts(store);
    assert.equal(afterShift.coverages, afterThree.coverages + 1);

    // A distinct source bucket has an independent group namespace.
    await commitPGliteCanonicalFinancialCapture(store, request("group-other-bucket", duplicateRows(3), {
      coverageScopeKeys: [
        token("checking-source-bucket"),
        token("another-source-bucket"),
      ],
    }));
    const afterOtherBucket = await counts(store);
    assert.equal(afterOtherBucket.coverages, afterShift.coverages + 2);

    await commitPGliteCanonicalFinancialCapture(store, request("group-other-subject", [], {
      subjectDigest: token("another-source-subject"),
    }));
    const afterOtherSubject = await counts(store);
    assert.equal(afterOtherSubject.coverages, afterOtherBucket.coverages + 1);

    await commitPGliteCanonicalFinancialCapture(store, request("group-other-record-kind", [], {
      recordKind: "another-source-record-kind",
    }));
    const afterOtherRecordKind = await counts(store);
    assert.equal(afterOtherRecordKind.coverages, afterOtherSubject.coverages + 1);

    const savedRecord = (await store.query<{
      capture_id: Uint8Array;
      commit_id: Uint8Array;
    }>("SELECT capture_id, commit_id FROM source_records LIMIT 1")).rows[0];
    assert.ok(savedRecord);
    await assert.rejects(
      store.query(
        `INSERT INTO source_records(
           source_record_id, capture_id, commit_id, record_kind, sequence_lexeme,
           payload_json, occurrence_group_scope_key, occurrence_group_fingerprint,
           occurrence_group_partition_date, occurrence_group_ordinal
         ) VALUES ($1, $2, $3, 'source-record', 'partial-group', '{}', NULL, $4, '2026-01-10', 1)`,
        [randomBytes(16), savedRecord.capture_id, savedRecord.commit_id, token("partial-group")],
      ),
      /ck_source_records_occurrence_group_complete/u,
    );

    // Once complete grouped coverage exists, an overlapping capture cannot
    // omit the proof and thereby silently erase the previous group.
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(store, request("group-proof-omitted", [], {
        coverage: false,
      })),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "occurrence-conflict",
    );
    assert.deepEqual(await counts(store), afterOtherRecordKind);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("required group routes reject ungrouped financial facts before a transaction starts", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    const base = request("required-group-fact", duplicateRows(1));
    const capture = {
      ...base.capture,
      integrationNamespace: "fubon",
      routeKey: "fubon/domestic-deposit/human-attested-v1",
      contractVersion: "human-attested-v1",
      occurrenceGroupCoverage: base.capture.occurrenceGroupCoverage?.map((coverage) => ({
        ...coverage,
        contractVersion: "human-attested-v1",
      })),
      records: base.capture.records.map(({ occurrenceGroup: _group, ...record }) => record),
    };
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(store, { ...base, capture }),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "invalid-financial-fact",
    );

    const yuantaCapture = {
      ...base.capture,
      integrationNamespace: "yuanta-fund",
      stream: "investment",
      recordKind: "investment-transactions",
      routeKey: "yuanta-fund/investment/canonical-v1",
      contractVersion: "yuanta-fund/investment/canonical-v1",
      scope: {
        ...base.capture.scope,
        startDate: "2026-01-10",
        endDate: "2026-01-10",
        kind: "point-in-time" as const,
        completeness: "single-page" as const,
      },
      pages: [{ pageOrdinal: 0, responseCode: "200" as const, rowCount: 1, terminal: true, metadata: {} }],
      records: base.capture.records.map(({ occurrenceGroup: _group, ...record }) => record),
      occurrenceGroupCoverage: undefined,
    };
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(store, { ...base, capture: yuantaCapture }),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "invalid-financial-fact",
    );
  } finally {
    await store.close();
  }
});

test("queried-bucket inventories preserve pool counts across date shifts and billing movement", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const inventory = ["statement:2026/01", "unbilled"] as const;
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalFinancialCapture(
      store,
      request(
        "queried-bucket-unbilled-two",
        duplicateRows(2, "unbilled"),
        { queriedBuckets: true, bucketKeys: inventory },
      ),
    );
    const afterUnbilled = await counts(store);

    // The complete queried pool is unchanged even though its earliest
    // transaction date is outside the new row-derived date range.
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(
        store,
        request("queried-bucket-same-pool-zero", [], {
          queriedBuckets: true,
          bucketKeys: ["unbilled", "statement:2026/01"],
          startDate: "2026-02-01",
          endDate: "2026-02-28",
        }),
      ),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "occurrence-conflict",
    );
    assert.deepEqual(await counts(store), afterUnbilled);

    // The same complete inventory can reclassify both indistinguishable
    // transactions from unbilled to billed without changing their identities.
    await commitPGliteCanonicalFinancialCapture(
      store,
      request(
        "queried-bucket-billed-two",
        duplicateRows(2, "statement:2026/01"),
        { queriedBuckets: true, bucketKeys: ["unbilled", "statement:2026/01"] },
      ),
    );
    await commitPGliteCanonicalFinancialCapture(
      store,
      request(
        "queried-bucket-billed-replay-two",
        duplicateRows(2, "statement:2026/01"),
        { queriedBuckets: true, bucketKeys: inventory },
      ),
    );
    const afterReplay = await counts(store);
    assert.equal(afterReplay.transactions, 2);

    // Counts are summed inside each prior capture, then maxed across captures.
    // A later zero still rejects without double-counting the lifecycle move.
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(
        store,
        request("queried-bucket-after-billing-zero", [], {
          queriedBuckets: true,
          bucketKeys: inventory,
          startDate: "2026-02-01",
          endDate: "2026-02-28",
        }),
      ),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "occurrence-conflict",
    );
    assert.deepEqual(await counts(store), afterReplay);

    // When the queried inventory changes, the capture no longer proves that
    // the older bucket was included, so its missing group is not inferred zero.
    await commitPGliteCanonicalFinancialCapture(
      store,
      request("queried-bucket-old-period-aged-out", [], {
        queriedBuckets: true,
        bucketKeys: ["statement:2026/02", "unbilled"],
        startDate: "2026-02-01",
        endDate: "2026-02-28",
      }),
    );
    assert.equal((await counts(store)).transactions, 2);

    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(
        store,
        request(
          "queried-bucket-ambiguous-cross-bucket",
          [
            ...duplicateRows(1, "unbilled"),
            ...duplicateRows(1, "statement:2026/02"),
          ],
          { queriedBuckets: true, bucketKeys: ["statement:2026/02", "unbilled"] },
        ),
      ),
      /cannot span source query buckets/u,
    );
  } finally {
    await store.close();
  }
});

test("Yuanta investment balance snapshots may follow complete grouped transaction history", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const history = request("yuanta-investment-history", duplicateRows(2)).capture;
    const historyEvidence = {
      ...history,
      integrationNamespace: "yuanta-fund",
      stream: "investment",
      recordKind: "investment-transactions",
      routeKey: "yuanta-fund/investment/canonical-v1",
      contractVersion: "yuanta-fund/investment/canonical-v1",
      occurrenceGroupCoverage: history.occurrenceGroupCoverage?.map((coverage) => ({
        ...coverage,
        contractVersion: "yuanta-fund/investment/canonical-v1",
      })),
    };
    await admitPGliteCanonicalSourceCapture(store, historyEvidence);

    const snapshot = {
      ...historyEvidence,
      captureId: "yuanta-investment-holdings-snapshot",
      scope: {
        ...historyEvidence.scope,
        startDate: "2026-01-10",
        endDate: "2026-01-10",
        kind: "point-in-time" as const,
        completeness: "single-page" as const,
      },
      pages: [{ pageOrdinal: 0, responseCode: "200" as const, rowCount: 0, terminal: true, metadata: {} }],
      records: [],
      occurrenceGroupCoverage: undefined,
    };
    await admitPGliteCanonicalSourceCapture(store, snapshot);

    const result = await store.query<{ captures: number; coverages: number; group_counts: number }>(
      `SELECT
         (SELECT COUNT(*) FROM source_captures) AS captures,
         (SELECT COUNT(*) FROM source_occurrence_group_coverages) AS coverages,
         (SELECT COUNT(*) FROM source_occurrence_group_counts) AS group_counts`,
    );
    assert.deepEqual({
      captures: Number(result.rows[0]?.captures),
      coverages: Number(result.rows[0]?.coverages),
      group_counts: Number(result.rows[0]?.group_counts),
    }, { captures: 2, coverages: 1, group_counts: 1 });
  } finally {
    await store.close();
  }
});
