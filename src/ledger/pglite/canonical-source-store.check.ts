import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import {
  commitPGliteCanonicalFinancialBatch,
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import { PGliteStore } from "./transaction.ts";
import { PGliteCanonicalSourceAdmissionError } from "./source-admission-validation.ts";
import { commitPGliteCanonicalMixedCapture } from "./mixed-commit.ts";
import {
  getPGliteHumanAttestationStatus,
  revokePGliteHumanAttestationInTransaction,
} from "./attestation.ts";

const token = (letter: string): string => `sha256:${letter.repeat(64)}`;

function fact(sourceOccurrenceKey: string, sourceSequence: string) {
  return {
    sourceOccurrenceKey,
    sourceSequence,
    amount: { coefficient: "100", scale: 0 },
    currency: "TWD",
    direction: "inflow" as const,
    postingStatus: "posted" as const,
    postingOrigin: "synthetic_origin",
    postingBasis: "synthetic_basis",
    postingRuleVersion: "synthetic-v1",
    description: "test source",
    economicStatus: "normal" as const,
    administrativeState: "active" as const,
    semanticRuleVersion: "synthetic-v1",
    effectiveOn: "2026-01-01",
    transactionDateTimeLocal: "2026-01-01T00:00:00+08:00",
    timeZone: "Asia/Taipei" as const,
    timePrecision: "second" as const,
    timeOrigin: "source_reported" as const,
    effectiveTimeBasis: "accounting" as const,
    effectiveTimeRuleVersion: "synthetic-v1",
    utcInstantUtcUs: 1,
  };
}

function request(
  captureId: string,
  occurrenceKey = token("d"),
  collisionKey = token("e"),
): PGliteCanonicalFinancialCommitRequest {
  return {
    capture: {
      captureId,
      integrationNamespace: "synthetic",
      sourceConnectionKey: token("a"),
      identityEpoch: token("b"),
      stream: "domestic-deposit",
      recordKind: "source-record",
      routeKey: "synthetic/domestic-deposit/v8",
      contractVersion: "synthetic-v8",
      subjectDigest: token("c"),
      observedAt: "2026-08-19T00:00:00.000Z",
      accountNumber: {
        value: "123456",
        kind: "depository-account",
        evidenceVersion: "synthetic-v1",
        sourceField: "accountNumber",
      },
      scope: {
        startDate: "20260101",
        endDate: "20260102",
        kind: "point-in-time",
        completeness: "single-page",
        ruleVersion: "synthetic-completeness-v1",
        sourceAccountKey: "synthetic-account-1",
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: { pageCount: 1 },
      }],
      records: [{
        occurrenceKey,
        collisionKey,
        providerKey: token("f"),
        contentHash: token("g"),
        compact: { amount: { coefficient: "100", scale: 0 } },
      }],
    },
    account: {
      sourceAccountKey: "synthetic-account-1",
      accountNo: "123456",
      accountType: "depository",
      currency: "TWD",
    },
    transactions: [fact(occurrenceKey, "sequence-1")],
  };
}

async function counts(store: PGliteStore): Promise<Record<string, number>> {
  const rows = await store.query<{ table_name: string; value: number | string }>(
    `SELECT table_name, value FROM (
       SELECT 'commits' AS table_name, COUNT(*) AS value FROM canonical_commits
       UNION ALL SELECT 'captures', COUNT(*) FROM source_captures
       UNION ALL SELECT 'records', COUNT(*) FROM source_records
       UNION ALL SELECT 'transactions', COUNT(*) FROM financial_transactions
       UNION ALL SELECT 'revisions', COUNT(*) FROM transaction_revisions
       UNION ALL SELECT 'provenance', COUNT(*) FROM assertion_provenance
     ) counts ORDER BY table_name`,
  );
  return Object.fromEntries(rows.rows.map((row) => [row.table_name, Number(row.value)]));
}

test("mixed raw evidence and derived financial facts commit or roll back together", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const committed = await commitPGliteCanonicalMixedCapture(store, {
      steps: [
        { kind: "source", request: request("raw-1", token("x"), token("y")).capture },
        { kind: "financial", request: request("derived-1") },
      ],
    });
    assert.equal(committed.admissions.length, 1);
    assert.equal(committed.financial.length, 1);
    assert.deepEqual(await counts(store), {
      captures: 2, commits: 2, provenance: 1, records: 2, revisions: 1, transactions: 1,
    });
    const invalid = request("derived-bad");
    await assert.rejects(commitPGliteCanonicalMixedCapture(store, {
      steps: [
        { kind: "source", request: request("raw-rollback", token("u"), token("v")).capture },
        { kind: "financial", request: { ...invalid, account: { ...invalid.account, accountType: "invalid" as "depository" } } },
      ],
    }));
    assert.deepEqual(await counts(store), {
      captures: 2, commits: 2, provenance: 1, records: 2, revisions: 1, transactions: 1,
    });
  } finally {
    await store.close();
  }
});

test("PGlite canonical source admission writes typed facts atomically", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = await commitPGliteCanonicalFinancialCapture(store, request("capture-1"), {
      clock: () => 100,
    });
    assert.equal(first.commitSequence, 1);
    assert.equal(first.transactions[0]?.revisionCreated, true);
    assert.deepEqual(await counts(store), {
      captures: 1,
      commits: 1,
      provenance: 1,
      records: 1,
      revisions: 1,
      transactions: 1,
    });
    const recurrence = await commitPGliteCanonicalFinancialCapture(store, request("capture-2"), {
      clock: () => 100,
    });
    assert.equal(recurrence.commitSequence, 2);
    assert.equal(recurrence.transactions[0]?.revisionCreated, false);
    assert.deepEqual(await counts(store), {
      captures: 2,
      commits: 2,
      provenance: 2,
      records: 2,
      revisions: 1,
      transactions: 1,
    });
    assert.deepEqual(
      (await store.query<{ recorded_at_utc_us: number | string }>(
        "SELECT recorded_at_utc_us FROM canonical_commits ORDER BY commit_sequence",
      )).rows.map((row) => Number(row.recorded_at_utc_us)),
      [100, 101],
    );

    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(
        store,
        request("capture-collision", token("x"), token("e")),
        { clock: () => 100 },
      ),
      (error: unknown) =>
        error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "occurrence-conflict",
    );
    assert.equal((await counts(store)).captures, 2);

    const invalidOrigin = {
      ...request("capture-invalid-origin", token("h"), token("i")),
      transactions: [{ ...fact(token("h"), "sequence-invalid"), postingOrigin: "untrusted-origin" }],
    };
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(store, invalidOrigin, { clock: () => 100 }),
      (error: unknown) =>
        error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "invalid-origin",
    );
    assert.equal((await counts(store)).captures, 2);

    const rollbackCapture = request("capture-rollback", token("j"), token("k"));
    rollbackCapture.capture.pages[0]!.rowCount = 2;
    rollbackCapture.capture.records.push({
      occurrenceKey: token("l"),
      collisionKey: token("m"),
      providerKey: token("n"),
      contentHash: token("o"),
      compact: { amount: { coefficient: "200", scale: 0 } },
    });
    const rollback = {
      ...rollbackCapture,
      transactions: [
      fact(token("j"), "sequence-rollback-1"),
      fact(token("missing"), "sequence-rollback-2"),
      ],
    };
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(store, rollback, { clock: () => 100 }),
      (error: unknown) =>
        error instanceof PGliteCanonicalSourceAdmissionError &&
        error.reason === "invalid-financial-fact",
    );
    assert.deepEqual(await counts(store), {
      captures: 2,
      commits: 2,
      provenance: 2,
      records: 2,
      revisions: 1,
      transactions: 1,
    });

    const midTransactionAbort = new AbortController();
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(store, request("cancelled-mid-transaction"), {
        signal: midTransactionAbort.signal,
        clock: () => {
          midTransactionAbort.abort();
          return 200;
        },
      }),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError && error.reason === "cancelled",
    );
    assert.deepEqual(await counts(store), {
      captures: 2,
      commits: 2,
      provenance: 2,
      records: 2,
      revisions: 1,
      transactions: 1,
    });
  } finally {
    await store.close();
  }
});

test("financial fact denomination is independent of account reporting currency", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const base = request("capture-cross-currency");
    const input = {
      ...base,
      transactions: [{ ...base.transactions[0]!, currency: "USD" }],
    };
    await commitPGliteCanonicalFinancialCapture(store, input);
    const row = (await store.query<{ amount_coefficient: string; currency: string }>(
      "SELECT amount_coefficient, currency FROM transaction_revisions",
    )).rows[0];
    assert.deepEqual(row, { amount_coefficient: "100", currency: "USD" });
  } finally {
    await store.close();
  }
});

test("financial admission seeds local attestation and rejects a revoked durable chain", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const authorityRoute = "ctbc/domestic-deposit/human-attested-v1";
  const providerRequest = (captureId: string) => {
    const original = request(captureId);
    return {
      ...original,
      capture: {
        ...original.capture,
        integrationNamespace: "ctbc",
        routeKey: authorityRoute,
        contractVersion: "human-attested-v1",
        scope: { ...original.capture.scope, ruleVersion: authorityRoute },
      },
    } satisfies PGliteCanonicalFinancialCommitRequest;
  };
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalFinancialCapture(store, providerRequest("ctbc-first"));
    const active = await store.transaction((transaction) =>
      getPGliteHumanAttestationStatus(transaction, { authorityRoute }));
    assert.equal(active.status, "active");
    assert.equal(active.sequence, 1);
    await store.transaction((transaction) =>
      revokePGliteHumanAttestationInTransaction(transaction, {
        authorityRoute,
        at: "2026-09-23",
        reason: "test revoke",
      }));
    await assert.rejects(commitPGliteCanonicalFinancialCapture(store, providerRequest("ctbc-second")));
    assert.equal((await counts(store)).captures, 1);
    const revoked = await store.transaction((transaction) =>
      getPGliteHumanAttestationStatus(transaction, { authorityRoute }));
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.sequence, 2);
  } finally {
    await store.close();
  }
});

test("PGlite canonical financial batches retain one transaction boundary", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = request("batch-1");
    const second = {
      ...request("batch-2", token("x"), token("y")),
      transactions: [fact(token("x"), "batch-sequence-2")],
    };
    const results = await commitPGliteCanonicalFinancialBatch(store, {
      commits: [first, second],
    }, { clock: () => 10 });
    assert.deepEqual(results.map((result) => result.commitSequence), [1, 2]);
    assert.deepEqual((await store.query<{ value: number }>("SELECT COUNT(*)::int AS value FROM canonical_commits")).rows, [{ value: 2 }]);

    const failedFirst = request("batch-rollback-1", token("p"), token("q"));
    const failedSecond = {
      ...request("batch-rollback-2", token("r"), token("s")),
      transactions: [fact(token("missing"), "batch-invalid")],
    };
    await assert.rejects(
      commitPGliteCanonicalFinancialBatch(store, { commits: [failedFirst, failedSecond] }, { clock: () => 10 }),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError && error.reason === "invalid-financial-fact",
    );
    assert.deepEqual((await store.query<{ value: number }>("SELECT COUNT(*)::int AS value FROM canonical_commits")).rows, [{ value: 2 }]);

    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      commitPGliteCanonicalFinancialCapture(store, request("cancelled"), { signal: cancelled.signal }),
      (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError && error.reason === "cancelled",
    );
    assert.deepEqual((await store.query<{ value: number }>("SELECT COUNT(*)::int AS value FROM canonical_commits")).rows, [{ value: 2 }]);
  } finally {
    await store.close();
  }
});
