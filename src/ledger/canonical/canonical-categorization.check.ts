import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  createCanonicalSourceStore,
  openCanonicalDatabase,
} from "./canonical-source-store.ts";
import {
  commitCanonicalAutomaticEnrichmentRun,
} from "./canonical-enrichment.ts";
import {
  commitCanonicalUserCategorization,
  createCanonicalSpendingQuery,
  CANONICAL_SPENDING_INCLUSION_POLICY,
} from "./canonical-categorization.ts";
import {
  blob,
  idToString,
  uuidV7,
} from "./canonical-schema-implementation.ts";

type FixtureState = Readonly<{
  directory: string;
  sourceConnectionKey: string;
  transactionId: string;
  sourceRecordId: string;
  captureCommitSequence: number;
}>;

async function fixture(): Promise<FixtureState> {
  return fixtureWithInput(CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
}

async function fixtureWithInput(
  input: typeof CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
): Promise<FixtureState> {
  const directory = await mkdtemp(join(tmpdir(), "canonical-categorization-"));
  await commitCathayDomesticDeposit(directory, input);
  const db = openCanonicalDatabase(directory, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT transaction_row.transaction_id, revision.source_record_id,
                connection.source_connection_key,
                (SELECT MAX(commit_sequence) FROM canonical_commits) AS capture_commit_sequence
           FROM financial_transactions transaction_row
           JOIN current_transactions current_row
             ON current_row.transaction_id = transaction_row.transaction_id
           JOIN transaction_revisions revision
             ON revision.revision_id = current_row.revision_id
           JOIN financial_accounts account
             ON account.account_id = transaction_row.account_id
           JOIN source_connections connection
             ON connection.source_connection_id = account.source_connection_id
          WHERE revision.direction = 'outflow'
          LIMIT 1`,
      )
      .get() as Record<string, unknown>;
    return {
      directory,
      sourceConnectionKey: String(row.source_connection_key),
      transactionId: idToString(blob(row.transaction_id)),
      sourceRecordId: idToString(blob(row.source_record_id)),
      captureCommitSequence: Number(row.capture_commit_sequence),
    };
  } finally {
    db.close();
  }
}

async function foreignConversionFixture(): Promise<FixtureState> {
  const raw = JSON.parse(CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse) as {
    content: { datas: Array<{ details: Array<Record<string, unknown>> }> };
  };
  const details = raw.content.datas[0]!.details;
  details[1]!.expendAmt = 315;
  details[1]!.balance = 12185;
  details[2]!.balance = 12985;
  return fixtureWithInput({
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    rawResponse: JSON.stringify(raw),
  });
}

function admitTypedConversionEvidence(state: FixtureState): void {
  const store = createCanonicalSourceStore(join(state.directory, "canonical.sqlite"));
  try {
    const row = store.db
      .prepare(
        `SELECT current_row.transaction_id, current_row.revision_id,
                revision.source_record_id, revision.capture_id, revision.commit_id
           FROM current_transactions current_row
           JOIN transaction_revisions revision
             ON revision.revision_id = current_row.revision_id
          WHERE current_row.transaction_id = ?`,
      )
      .get(blob(Buffer.from(state.transactionId.replaceAll("-", ""), "hex"))) as
      | Record<string, unknown>
      | undefined;
    assert.ok(row);
    const transactionId = row.transaction_id as Uint8Array;
    const revisionId = row.revision_id as Uint8Array;
    const sourceRecordId = row.source_record_id as Uint8Array;
    const captureId = row.capture_id as Uint8Array;
    const commitId = row.commit_id as Uint8Array;
    store.db
      .prepare(
        `INSERT INTO transaction_conversion_evidence(
           conversion_id, transaction_id, revision_id, source_record_id,
           capture_id, commit_id, original_amount_coefficient,
           original_amount_scale, original_currency, booked_amount_coefficient,
           booked_amount_scale, booked_currency, source_reported_rate_coefficient,
           source_reported_rate_scale, source_reported_rate_base_currency,
           source_reported_rate_quote_currency, source_reported_rate_date,
           comparison, evidence_origin
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidV7(),
        transactionId,
        revisionId,
        sourceRecordId,
        captureId,
        commitId,
        "10",
        0,
        "USD",
        "315",
        0,
        "TWD",
        "315",
        1,
        "USD",
        "TWD",
        "2026-07-02",
        "consistent",
        "foreign-currency/cathay/v1",
      );
  } finally {
    store.close();
  }
}

async function discard(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

async function publishPurchaseKind(
  state: FixtureState,
): Promise<{ commitSequence: number }> {
  return commitCanonicalAutomaticEnrichmentRun(state.directory, {
    sourceConnectionKey: state.sourceConnectionKey,
    stream: "domestic-deposit",
    ruleLineage: "test/canonical-categorization/purchase-kind",
    declaredSubjects: [{ transactionId: state.transactionId, fields: ["kind"] }],
    outputs: [
      {
        transactionId: state.transactionId,
        field: "kind",
        origin: "derived",
        value: "purchase",
        confidenceBasisPoints: 10_000,
        evidence: {
          kind: "description",
          sourceRecordId: state.sourceRecordId,
          sourceValue: "synthetic purchase",
          contractVersion: "test/canonical-categorization/v1",
        },
      },
    ],
  });
}

async function publishAutomaticCategory(
  state: FixtureState,
  value: "dining" | "transportation",
): Promise<{ commitSequence: number }> {
  return commitCanonicalAutomaticEnrichmentRun(state.directory, {
    sourceConnectionKey: state.sourceConnectionKey,
    stream: "domestic-deposit",
    ruleLineage: "test/canonical-categorization/automatic-category",
    declaredSubjects: [
      { transactionId: state.transactionId, fields: ["category"] },
    ],
    outputs: [
      {
        transactionId: state.transactionId,
        field: "category",
        origin: "derived",
        value,
        confidenceBasisPoints: 10_000,
        evidence: {
          kind: "description",
          sourceRecordId: state.sourceRecordId,
          sourceValue: "synthetic category",
          contractVersion: "test/canonical-categorization/v1",
        },
      },
    ],
  });
}

function spending(state: FixtureState) {
  return createCanonicalSpendingQuery(state.directory).current({
    sourceConnectionKey: state.sourceConnectionKey,
  });
}

function matchesTransaction(transactionId: string, expectedId: string): boolean {
  return transactionId === expectedId.replaceAll("-", "");
}

test("user categorization supersedes and clears atomically to the current automatic result", async () => {
  const state = await fixture();
  try {
    const purchase = await publishPurchaseKind(state);
    const automatic = await publishAutomaticCategory(state, "dining");
    assert.equal(automatic.commitSequence, purchase.commitSequence + 1);
    const before = spending(state);
    const beforeTransaction = before.transactions.find(
      (transaction) => matchesTransaction(transaction.transactionId, state.transactionId),
    );
    assert.equal(beforeTransaction?.categorization.mode, "single");
    assert.equal(beforeTransaction?.categorization.origin, "derived");
    assert.equal(beforeTransaction?.categorization.categoryCode, "dining");

    const user = await commitCanonicalUserCategorization(
      state.directory,
      {
        transactionId: state.transactionId,
        mode: "single",
        categoryCode: "transportation",
        userId: "local-user",
      },
      { clock: () => "2026-08-18T00:00:00.000Z" },
    );
    assert.equal(user.mode, "single");
    assert.equal(user.commitSequence, automatic.commitSequence + 1);

    const selected = spending(state).transactions.find(
      (transaction) => matchesTransaction(transaction.transactionId, state.transactionId),
    );
    assert.equal(selected?.categorization.origin, "user");
    assert.equal(selected?.categorization.categoryCode, "transportation");
    assert.equal(selected?.categorization.taxonomyId, "transaction-taxonomy");
    assert.equal(selected?.categorization.taxonomyVersion, "v1");

    const cleared = await commitCanonicalUserCategorization(
      state.directory,
      {
        transactionId: state.transactionId,
        mode: "clear",
        userId: "local-user",
      },
      { clock: () => "2026-08-19T00:00:00.000Z" },
    );
    assert.equal(cleared.mode, "absent");
    assert.equal(cleared.withdrawn, true);
    assert.equal(cleared.commitSequence, user.commitSequence + 1);

    const afterClear = spending(state).transactions.find(
      (transaction) => matchesTransaction(transaction.transactionId, state.transactionId),
    );
    assert.equal(afterClear?.categorization.origin, "derived");
    assert.equal(afterClear?.categorization.categoryCode, "dining");

    const currentLineage = createCanonicalSpendingQuery(state.directory).lineage({
      sourceConnectionKey: state.sourceConnectionKey,
    });
    const currentLineageEntry = currentLineage.lineage.find((entry) =>
      matchesTransaction(entry.transactionId, state.transactionId),
    );
    assert.equal(currentLineageEntry?.selectedOrigin, "derived");
    assert.equal(currentLineageEntry?.selectedCategoryCode, "dining");
    assert.ok(currentLineageEntry?.selectedAssertionId);
    const withdrawnUser = currentLineageEntry?.assertions.find(
      (assertion) => assertion.origin === "user",
    );
    assert.deepEqual(
      withdrawnUser?.events.map((event) => event.eventKind),
      ["observed", "withdrawn"],
    );

    const historicalBeforeUser = createCanonicalSpendingQuery(
      state.directory,
    ).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: automatic.commitSequence,
    });
    const historicalTransaction = historicalBeforeUser.transactions.find(
      (transaction) => matchesTransaction(transaction.transactionId, state.transactionId),
    );
    assert.equal(historicalTransaction?.categorization.origin, "derived");
    assert.equal(historicalTransaction?.categorization.categoryCode, "dining");

    const historicalUser = createCanonicalSpendingQuery(
      state.directory,
    ).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: user.commitSequence,
    });
    const historicalUserTransaction = historicalUser.transactions.find(
      (transaction) => matchesTransaction(transaction.transactionId, state.transactionId),
    );
    assert.equal(historicalUserTransaction?.categorization.origin, "user");
    assert.equal(
      historicalUserTransaction?.categorization.categoryCode,
      "transportation",
    );
    const historicalUserLineage = createCanonicalSpendingQuery(
      state.directory,
    ).lineage({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: user.commitSequence,
    });
    const historicalUserEntry = historicalUserLineage.lineage.find((entry) =>
      matchesTransaction(entry.transactionId, state.transactionId),
    );
    assert.equal(historicalUserEntry?.selectedOrigin, "user");
    assert.equal(historicalUserEntry?.selectedCategoryCode, "transportation");
    assert.deepEqual(
      historicalUserEntry?.assertions
        .find((assertion) => assertion.origin === "user")
        ?.events.map((event) => event.eventKind),
      ["observed"],
    );
  } finally {
    await discard(state.directory);
  }
});

test("allocation rejects partial or duplicate targets without a commit and preserves exact high scale totals", async () => {
  const state = await fixture();
  try {
    await publishPurchaseKind(state);
    const db = openCanonicalDatabase(state.directory, { readOnly: true });
    const beforeCommits = Number(
      (
        db.prepare("SELECT MAX(commit_sequence) AS value FROM canonical_commits").get() as {
          value?: unknown;
        }
      ).value,
    );
    db.close();

    await assert.rejects(
      () =>
        commitCanonicalUserCategorization(state.directory, {
          transactionId: state.transactionId,
          mode: "allocated",
          allocation: [
            { categoryCode: "dining", coefficient: "100", scale: 0, currency: "TWD" },
            { categoryCode: "transportation", coefficient: "199", scale: 0, currency: "TWD" },
          ],
        }),
      /exactly reconcile/u,
    );
    await assert.rejects(
      () =>
        commitCanonicalUserCategorization(state.directory, {
          transactionId: state.transactionId,
          mode: "allocated",
          allocation: [
            { categoryCode: "dining", coefficient: "100", scale: 0, currency: "TWD" },
            { categoryCode: "dining", coefficient: "200", scale: 0, currency: "TWD" },
          ],
        }),
      /duplicate target/u,
    );

    const untouched = openCanonicalDatabase(state.directory, { readOnly: true });
    assert.equal(
      Number(
        (
          untouched.prepare("SELECT MAX(commit_sequence) AS value FROM canonical_commits").get() as {
            value?: unknown;
          }
        ).value,
      ),
      beforeCommits,
    );
    assert.equal(
      Number(
        (
          untouched.prepare("SELECT COUNT(*) AS value FROM transaction_categorization_values").get() as {
            value?: unknown;
          }
        ).value,
      ),
      0,
    );
    untouched.close();

    const highScale = 10n ** 1_000n;
    const tiny = "1";
    const remainder = (300n * highScale - 1n).toString();
    await commitCanonicalUserCategorization(state.directory, {
      transactionId: state.transactionId,
      mode: "allocated",
      allocation: [
        { categoryCode: "dining", coefficient: tiny, scale: 1_000, currency: "TWD" },
        {
          categoryCode: "transportation",
          coefficient: remainder,
          scale: 1_000,
          currency: "TWD",
        },
      ],
    });
    const report = spending(state);
    const transaction = report.includedTransactions.find(
      (candidate) => matchesTransaction(candidate.transactionId, state.transactionId),
    );
    assert.equal(transaction?.categorization.mode, "allocated");
    assert.deepEqual(
      transaction?.categorization.components?.map((component) => [
        component.categoryCode,
        component.coefficient,
        component.scale,
      ]),
      [
        ["dining", "1", 1_000],
        ["transportation", remainder, 1_000],
      ],
    );
    assert.deepEqual(report.totalsByCurrency, [
      { currency: "TWD", coefficient: "300", scale: 0, count: 1 },
    ]);
    assert.equal(report.classificationCoverage.classifiedCount, 1);
  } finally {
    await discard(state.directory);
  }
});

test("conflicting categorization aliases fail before any assertion mutation", async () => {
  const state = await fixture();
  try {
    await publishPurchaseKind(state);
    const before = spending(state);
    const db = openCanonicalDatabase(state.directory, { readOnly: true });
    const countsBefore = db
      .prepare(
        `SELECT (SELECT MAX(commit_sequence) FROM canonical_commits) AS commits,
                (SELECT COUNT(*) FROM assertions) AS assertions,
                (SELECT COUNT(*) FROM transaction_categorization_values) AS values_count,
                (SELECT COUNT(*) FROM category_allocation_sets) AS allocations`,
      )
      .get() as Record<string, unknown>;
    db.close();
    const validAllocation = [
      { categoryCode: "dining", coefficient: "100", scale: 0, currency: "TWD" },
      {
        categoryCode: "transportation",
        coefficient: "200",
        scale: 0,
        currency: "TWD",
      },
    ];
    const invalidInputs = [
      { mode: "clear" as const, categoryCode: "dining" },
      { mode: "single" as const, categoryCode: "dining", allocation: validAllocation },
      { allocation: validAllocation, components: validAllocation },
      { categoryCode: "dining", category: "transportation" },
      { mode: "single" as const, categoryCode: "dining", unexpected: true },
    ];
    for (const input of invalidInputs) {
      await assert.rejects(
        () =>
          commitCanonicalUserCategorization(state.directory, {
            transactionId: state.transactionId,
            ...input,
          } as never),
        /conflict|unknown field|cannot include/u,
      );
    }
    assert.deepEqual(spending(state), before);
    const afterDb = openCanonicalDatabase(state.directory, { readOnly: true });
    const countsAfter = afterDb
      .prepare(
        `SELECT (SELECT MAX(commit_sequence) FROM canonical_commits) AS commits,
                (SELECT COUNT(*) FROM assertions) AS assertions,
                (SELECT COUNT(*) FROM transaction_categorization_values) AS values_count,
                (SELECT COUNT(*) FROM category_allocation_sets) AS allocations`,
      )
      .get() as Record<string, unknown>;
    afterDb.close();
    assert.deepEqual(countsAfter, countsBefore);
  } finally {
    await discard(state.directory);
  }
});

test("typed conversion evidence supports an exact split and rejects guessed or stale proof", async () => {
  const state = await foreignConversionFixture();
  try {
    admitTypedConversionEvidence(state);
    await publishPurchaseKind(state);
    const conversion = (evidenceId = state.sourceRecordId) => ({
      fromCurrency: "USD",
      toCurrency: "TWD",
      convertedAmount: { coefficient: evidenceId === state.sourceRecordId ? "126" : "127", scale: 0, currency: "TWD" },
      evidenceKind: "source_record",
      evidenceId,
    });
    const user = await commitCanonicalUserCategorization(state.directory, {
      transactionId: state.transactionId,
      mode: "allocated",
      allocation: [
        {
          categoryCode: "dining",
          amount: { coefficient: "4", scale: 0, currency: "USD" },
          conversion: conversion(),
        },
        {
          categoryCode: "transportation",
          amount: { coefficient: "6", scale: 0, currency: "USD" },
          conversion: {
            ...conversion(),
            convertedAmount: { coefficient: "189", scale: 0, currency: "TWD" },
          },
        },
      ],
    });
    assert.equal(user.mode, "allocated");
    const transaction = spending(state).includedTransactions.find(
      (candidate) => matchesTransaction(candidate.transactionId, state.transactionId),
    );
    assert.equal(transaction?.categorization.mode, "allocated");
    assert.deepEqual(
      transaction?.categorization.components?.map((component) => [
        component.categoryCode,
        component.coefficient,
        component.currency,
        component.conversionEvidence?.id,
      ]),
      [
        ["dining", "126", "TWD", state.sourceRecordId],
        ["transportation", "189", "TWD", state.sourceRecordId],
      ],
    );
    const db = openCanonicalDatabase(state.directory, { readOnly: true });
    const before = db
      .prepare(
        `SELECT (SELECT MAX(commit_sequence) FROM canonical_commits) AS commits,
                (SELECT COUNT(*) FROM assertions) AS assertions,
                (SELECT COUNT(*) FROM transaction_categorization_values) AS values_count`,
      )
      .get() as Record<string, unknown>;
    db.close();
    await assert.rejects(
      () =>
        commitCanonicalUserCategorization(state.directory, {
          transactionId: state.transactionId,
          mode: "allocated",
          allocation: [
            {
              categoryCode: "dining",
              amount: { coefficient: "4", scale: 0, currency: "USD" },
              conversion: {
                ...conversion(),
                convertedAmount: { coefficient: "127", scale: 0, currency: "TWD" },
              },
            },
            {
              categoryCode: "transportation",
              amount: { coefficient: "6", scale: 0, currency: "USD" },
              conversion: {
                ...conversion(),
                convertedAmount: { coefficient: "188", scale: 0, currency: "TWD" },
              },
            },
          ],
        }),
      /cross-multiply/u,
    );
    await assert.rejects(
      () =>
        commitCanonicalUserCategorization(state.directory, {
          transactionId: state.transactionId,
          mode: "allocated",
          allocation: [
            {
              categoryCode: "dining",
              amount: { coefficient: "4", scale: 0, currency: "USD" },
              conversion: {
                ...conversion("00000000000000000000000000000001"),
                convertedAmount: { coefficient: "126", scale: 0, currency: "TWD" },
              },
            },
            {
              categoryCode: "transportation",
              amount: { coefficient: "6", scale: 0, currency: "USD" },
              conversion: {
                ...conversion(),
                convertedAmount: { coefficient: "189", scale: 0, currency: "TWD" },
              },
            },
          ],
        }),
      /typed fact/u,
    );
    const afterDb = openCanonicalDatabase(state.directory, { readOnly: true });
    const after = afterDb
      .prepare(
        `SELECT (SELECT MAX(commit_sequence) FROM canonical_commits) AS commits,
                (SELECT COUNT(*) FROM assertions) AS assertions,
                (SELECT COUNT(*) FROM transaction_categorization_values) AS values_count`,
      )
      .get() as Record<string, unknown>;
    afterDb.close();
    assert.deepEqual(after, before);
  } finally {
    await discard(state.directory);
  }
});

test("spending report publishes gross posted outflow scope and reports semantic gaps separately from unclassified amounts", async () => {
  const state = await fixture();
  try {
    await publishPurchaseKind(state);
    const report = spending(state);
    assert.deepEqual(report.inclusionPolicy, CANONICAL_SPENDING_INCLUSION_POLICY);
    assert.equal(report.inclusionPolicy.id, "gross-posted-outflow");
    assert.equal(report.inclusionPolicy.version, "v1");
    assert.equal(report.includedTransactions.length, 1);
    assert.equal(report.classificationCoverage.includedCount, 1);
    assert.equal(report.classificationCoverage.unclassifiedCount, 1);
    assert.deepEqual(report.unclassifiedByCurrency, [
      { currency: "TWD", coefficient: "300", scale: 0, count: 1 },
    ]);
    assert.equal(report.reportEligibility.status, "incomplete");
    assert.equal(report.reportEligibility.gapCount, 2);
    assert.deepEqual(report.reportEligibility.gapAmountByCurrency, [
      { currency: "TWD", coefficient: "13300", scale: 0, count: 2 },
    ]);
    assert.equal(report.totalStatus, "incomplete");
    assert.equal(
      report.includedTransactions[0]?.categorization.mode,
      "absent",
    );

    const beforePurchase = createCanonicalSpendingQuery(state.directory).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: state.captureCommitSequence,
    });
    assert.equal(beforePurchase.includedTransactions.length, 0);
    assert.equal(beforePurchase.reportEligibility.gapCount, 3);
  } finally {
    await discard(state.directory);
  }
});

test("rebuild and reopen retain the selected user categorization and allocation set", async () => {
  const state = await fixture();
  try {
    await publishPurchaseKind(state);
    await commitCanonicalUserCategorization(state.directory, {
      transactionId: state.transactionId,
      mode: "single",
      categoryCode: "dining",
    });
    const before = spending(state);
    const runtimeModule = await import("./canonical-projection-runtime.ts");
    await runtimeModule.createCanonicalProjectionRuntime(state.directory).rebuild();
    const after = spending(state);
    assert.deepEqual(after.includedTransactions, before.includedTransactions);
    assert.deepEqual(after.categoryTotalsByCurrency, before.categoryTotalsByCurrency);
  } finally {
    await discard(state.directory);
  }
});
