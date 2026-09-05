import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  openCanonicalDatabase,
} from "./canonical-source-store.ts";
import {
  commitCanonicalAutomaticEnrichmentRun,
  createCanonicalEnrichmentQuery,
  type CanonicalEnrichmentFieldResult,
  type CanonicalEnrichmentOutput,
} from "./canonical-enrichment.ts";
import { commitCathayAutomaticEnrichmentFromDescriptions } from "./cathay-automatic-enrichment.ts";
import { blob, canonicalSqlitePath, idToString } from "./canonical-schema-implementation.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";

type FixtureState = Readonly<{
  directory: string;
  sourceConnectionKey: string;
  transactionId: string;
  sourceRecordId: string;
  captureCommitSequence: number;
}>;

type SupportedFieldResult = Extract<CanonicalEnrichmentFieldResult, { status: "supported" }>;

function requireSupported(field: CanonicalEnrichmentFieldResult): SupportedFieldResult {
  if (field.status !== "supported") throw new Error("Expected a supported enrichment field in this fixture.");
  return field;
}

function countRows(db: ReturnType<typeof openCanonicalDatabase>, sql: string): number {
  const row = db.prepare(sql).get() as { value?: unknown } | undefined;
  return Number(row?.value ?? 0);
}

async function createFixtureState(): Promise<FixtureState> {
  const directory = await mkdtemp(join(tmpdir(), "canonical-enrichment-"));
  await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const db = openCanonicalDatabase(directory, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT transaction_row.transaction_id, revision.source_record_id,
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
       ORDER BY transaction_row.source_sequence
       LIMIT 1
    `).get() as Record<string, unknown>;
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

async function discard(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

function derivedOutput(
  state: FixtureState,
  value: string,
  ruleLineage: string,
  extra: Record<string, unknown> = {},
) {
  return {
    transactionId: state.transactionId,
    field: "kind" as const,
    origin: "derived" as const,
    value,
    confidenceBasisPoints: 9_000,
    evidence: {
      kind: "description",
      sourceRecordId: state.sourceRecordId,
      sourceValue: "Synthetic Cathay deposit description",
      contractVersion: "cathay/domestic-deposit/v1",
      ...extra,
    },
    ruleLineage,
  };
}

function typedDerivedOutput(
  state: FixtureState,
  field: Exclude<CanonicalEnrichmentOutput["field"], "counterparty_display">,
  value: string,
  ruleLineage: string,
  extra: Record<string, unknown> = {},
): CanonicalEnrichmentOutput {
  return {
    transactionId: state.transactionId,
    field,
    origin: "derived",
    value,
    confidenceBasisPoints: 9_000,
    evidence: {
      kind: "description",
      sourceRecordId: state.sourceRecordId,
      sourceValue: "Synthetic Cathay deposit description",
      contractVersion: "cathay/domestic-deposit/v1",
      ...extra,
    },
    // Kept in the fixture object to make the intended producer rule explicit;
    // the run-level ruleLineage remains the canonical coordinate.
    ruleLineage,
  } as CanonicalEnrichmentOutput;
}

test("Cathay description producer reaches Current, Historical, and Lineage", async () => {
  const state = await createFixtureState();
  try {
    const result = await commitCathayAutomaticEnrichmentFromDescriptions(state.directory);
    assert.equal(result.commitSequence, state.captureCommitSequence + 1);
    assert.equal(result.assertionIds.length, 3);
    assert.equal(result.absent.length, 9);

    const query = createCanonicalEnrichmentQuery(state.directory);
    const current = query.current({ sourceConnectionKey: state.sourceConnectionKey });
    assert.equal(current.transactions.length, 3);
    assert.deepEqual(current.transactions.map((transaction) => requireSupported(transaction.kind).code), [
      "cash.deposit",
      "transfer.internal",
      "payment.credit_card",
    ]);
    for (const transaction of current.transactions) {
      assert.equal(transaction.kind.status, "supported");
      assert.equal(transaction.kind.origin, "derived");
      assert.equal(transaction.kind.taxonomyId, "transaction-taxonomy");
      assert.equal(transaction.kind.taxonomyVersion, "v1");
      assert.match(requireSupported(transaction.kind).route.id, /automatic-enrichment\/v1\/kind/u);
      assert.equal(transaction.kind.provenance.evidenceKind, "description");
      assert.equal(transaction.category.status, "absent");
      assert.equal(transaction.display.status, "absent");
      assert.equal(transaction.counterparties.length, 0);
    }

    const beforeEnrichment = query.historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: state.captureCommitSequence,
    });
    assert.equal(beforeEnrichment.transactions.length, 3);
    assert.equal(beforeEnrichment.transactions.every((transaction) => transaction.kind.status === "absent"), true);

    const afterEnrichment = query.historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: result.commitSequence,
    });
    assert.deepEqual(afterEnrichment.transactions.map((transaction) => requireSupported(transaction.kind).code), [
      "cash.deposit",
      "transfer.internal",
      "payment.credit_card",
    ]);

    const lineage = query.lineage({
      sourceConnectionKey: state.sourceConnectionKey,
      knowledgeAt: result.commitSequence,
    });
    const kindLineage = lineage.lineage?.find((entry) => entry.field === "kind" && entry.transactionId === state.transactionId);
    assert.equal(kindLineage?.taxonomyId, "transaction-taxonomy");
    assert.equal(kindLineage?.taxonomyVersion, "v1");
    assert.equal(kindLineage?.taxonomyCode, "cash.deposit");
    assert.equal(kindLineage?.origin, "derived");
    assert.match(String(kindLineage?.routeId), /automatic-enrichment\/v1\/kind/u);
    assert.equal((kindLineage?.provenance as Record<string, unknown>).ruleLineage, "cathay/domestic-deposit/v1/description-taxonomy");
    assert.equal((kindLineage?.events as Array<Record<string, unknown>>).every((event) => Number(event.commitSequence) <= result.commitSequence), true);
  } finally {
    await discard(state.directory);
  }
});

test("admission stores the unique candidate winner and treats ties or threshold equality as absence", async () => {
  const winnerState = await createFixtureState();
  try {
    const result = await commitCanonicalAutomaticEnrichmentRun(winnerState.directory, {
      sourceConnectionKey: winnerState.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/candidate-winner",
      declaredFields: ["kind"],
      outputs: [derivedOutput(winnerState, "cash.deposit", "test/candidate-winner", {
        candidates: [
          { value: "cash.deposit", confidenceBasisPoints: 8_000 },
          { value: "transfer.internal", confidenceBasisPoints: 9_000 },
        ],
      })],
    });
    assert.equal(result.assertionIds.length, 1);
    const winner = createCanonicalEnrichmentQuery(winnerState.directory).current({ sourceConnectionKey: winnerState.sourceConnectionKey }).transactions[0]!;
    assert.equal(requireSupported(winner.kind).code, "transfer.internal");
  } finally {
    await discard(winnerState.directory);
  }

  const tieState = await createFixtureState();
  try {
    const result = await commitCanonicalAutomaticEnrichmentRun(tieState.directory, {
      sourceConnectionKey: tieState.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/candidate-tie",
      declaredFields: ["kind"],
      outputs: [derivedOutput(tieState, "cash.deposit", "test/candidate-tie", {
        candidates: [
          { value: "cash.deposit", confidenceBasisPoints: 9_000 },
          { value: "transfer.internal", confidenceBasisPoints: 9_000 },
        ],
      })],
    });
    assert.deepEqual(result.assertionIds, []);
    assert.deepEqual(result.absent, [{ transactionId: tieState.transactionId, field: "kind" }]);
    assert.equal(createCanonicalEnrichmentQuery(tieState.directory).current({ sourceConnectionKey: tieState.sourceConnectionKey }).transactions[0]!.kind.status, "absent");
  } finally {
    await discard(tieState.directory);
  }

  const boundaryState = await createFixtureState();
  try {
    const result = await commitCanonicalAutomaticEnrichmentRun(boundaryState.directory, {
      sourceConnectionKey: boundaryState.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/threshold-boundary",
      declaredFields: ["kind"],
      outputs: [{
        ...derivedOutput(boundaryState, "cash.deposit", "test/threshold-boundary"),
        confidenceBasisPoints: 7_500,
      }],
    });
    assert.deepEqual(result.assertionIds, []);
    assert.equal(result.absent[0]?.field, "kind");
    assert.equal(createCanonicalEnrichmentQuery(boundaryState.directory).current({ sourceConnectionKey: boundaryState.sourceConnectionKey }).transactions[0]!.kind.status, "absent");
  } finally {
    await discard(boundaryState.directory);
  }
});

test("Source admission rejects forged or non-retained Cathay taxonomy fields and rolls back", async () => {
  const state = await createFixtureState();
  try {
    await assert.rejects(
      commitCanonicalAutomaticEnrichmentRun(state.directory, {
        sourceConnectionKey: state.sourceConnectionKey,
        stream: "domestic-deposit",
        ruleLineage: "test/forged-source",
        declaredFields: ["kind"],
        outputs: [{
          transactionId: state.transactionId,
          field: "kind",
          origin: "source",
          value: "cash.deposit",
          evidence: {
            kind: "explicit-source-field",
            sourceRecordId: state.sourceRecordId,
            sourceField: "transaction_kind",
            sourceValue: "cash.deposit",
            contractVersion: "cathay/domestic-deposit/v1",
          },
        }],
      }),
      /not retained by the source contract/u,
    );
    const db = openCanonicalDatabase(state.directory, { readOnly: true });
    try {
      assert.equal(countRows(db, "SELECT COUNT(*) AS value FROM canonical_commits"), 1);
      assert.equal(countRows(db, "SELECT COUNT(*) AS value FROM enrichment_runs"), 0);
      assert.equal(countRows(db, "SELECT COUNT(*) AS value FROM current_transaction_enrichment"), 0);
    } finally {
      db.close();
    }
  } finally {
    await discard(state.directory);
  }
});

test("missing and overlapping authority routes fail admission before a commit", async () => {
  const missing = await createFixtureState();
  try {
    const db = openCanonicalDatabase(missing.directory);
    // Close the published route immediately before the attempted run. Route
    // rows are immutable records; interval closure is the supported way to
    // represent a gap in a later knowledge point.
    db.prepare("UPDATE automatic_enrichment_authority_routes SET valid_to_commit_sequence = 2 WHERE field_name = 'kind'").run();
    db.close();
    await assert.rejects(
      commitCanonicalAutomaticEnrichmentRun(missing.directory, {
        sourceConnectionKey: missing.sourceConnectionKey,
        stream: "domestic-deposit",
        ruleLineage: "test/missing-route",
        declaredFields: ["kind"],
        outputs: [derivedOutput(missing, "cash.deposit", "test/missing-route")],
      }),
      /No automatic enrichment authority route/u,
    );
  } finally {
    await discard(missing.directory);
  }

  const overlap = await createFixtureState();
  try {
    const db = openCanonicalDatabase(overlap.directory);
    db.prepare(`
      INSERT INTO automatic_enrichment_authority_routes(
        route_id, subject_kind, field_name, scope_kind, scope_key,
        producer_id, producer_version, origin_policy, taxonomy_id,
        taxonomy_version, valid_from_commit_sequence, valid_to_commit_sequence)
      VALUES (?, 'transaction', 'kind', 'source_stream', 'cathay/domestic-deposit',
              'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source_or_derived',
              'transaction-taxonomy', 'v1', 1, NULL)
    `).run("test/overlapping-kind-route");
    db.close();
    await assert.rejects(
      commitCanonicalAutomaticEnrichmentRun(overlap.directory, {
        sourceConnectionKey: overlap.sourceConnectionKey,
        stream: "domestic-deposit",
        ruleLineage: "test/overlap-route",
        declaredFields: ["kind"],
        outputs: [derivedOutput(overlap, "cash.deposit", "test/overlap-route")],
      }),
      /overlap/u,
    );
  } finally {
    await discard(overlap.directory);
  }
});

test("compatible Category and Counterparty Role values are typed and incompatible values are atomic", async () => {
  const compatible = await createFixtureState();
  try {
    const result = await commitCanonicalAutomaticEnrichmentRun(compatible.directory, {
      sourceConnectionKey: compatible.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/typed-values",
      declaredFields: ["kind", "category", "counterparty_role", "counterparty_display"],
      outputs: [
        typedDerivedOutput(compatible, "kind", "purchase", "test/typed-values"),
        typedDerivedOutput(compatible, "category", "dining", "test/typed-values"),
        {
          ...typedDerivedOutput(compatible, "counterparty_role", "merchant", "test/typed-values"),
          counterparty: {
            producerNamespace: "test",
            producerEntityKey: "merchant:001",
            displayName: "Synthetic Cafe",
          },
        },
        {
          transactionId: compatible.transactionId,
          field: "counterparty_display",
          origin: "derived",
          value: "Synthetic Cafe",
          confidenceBasisPoints: 9_000,
          evidence: {
            kind: "description",
            sourceRecordId: compatible.sourceRecordId,
            sourceValue: "Synthetic Cathay deposit description",
            contractVersion: "cathay/domestic-deposit/v1",
          },
        },
      ],
    });
    assert.equal(result.assertionIds.length, 4);
    const transaction = createCanonicalEnrichmentQuery(compatible.directory)
      .current({ sourceConnectionKey: compatible.sourceConnectionKey }).transactions[0]!;
    assert.equal(requireSupported(transaction.kind).code, "purchase");
    assert.equal(requireSupported(transaction.category).code, "dining");
    assert.equal(requireSupported(transaction.category).taxonomyDimension, "category");
    assert.equal(transaction.counterparties.length, 1);
    assert.equal(transaction.counterparties[0]?.taxonomyId, "transaction-taxonomy");
    assert.equal(transaction.counterparties[0]?.taxonomyVersion, "v1");
    assert.equal(transaction.counterparties[0]?.taxonomyCode, "merchant");
    assert.equal(transaction.counterparties[0]?.origin, "derived");
    assert.equal(requireSupported(transaction.display).value, "Synthetic Cafe");
  } finally {
    await discard(compatible.directory);
  }

  const incompatible = await createFixtureState();
  try {
    await assert.rejects(
      commitCanonicalAutomaticEnrichmentRun(incompatible.directory, {
        sourceConnectionKey: incompatible.sourceConnectionKey,
        stream: "domestic-deposit",
        ruleLineage: "test/incompatible-category",
        declaredFields: ["kind", "category"],
        outputs: [
          typedDerivedOutput(incompatible, "kind", "transfer.internal", "test/incompatible-category"),
          typedDerivedOutput(incompatible, "category", "dining", "test/incompatible-category"),
        ],
      }),
      /incompatible with Kind/u,
    );
    const db = openCanonicalDatabase(incompatible.directory, { readOnly: true });
    try {
      assert.equal(countRows(db, "SELECT COUNT(*) AS value FROM canonical_commits"), 1);
      assert.equal(countRows(db, "SELECT COUNT(*) AS value FROM enrichment_runs"), 0);
      assert.equal(countRows(db, "SELECT COUNT(*) AS value FROM assertions WHERE field_name IN ('kind', 'category')"), 0);
      assert.equal(createCanonicalEnrichmentQuery(incompatible.directory)
        .current({ sourceConnectionKey: incompatible.sourceConnectionKey }).transactions[0]!.kind.status, "absent");
    } finally {
      db.close();
    }
  } finally {
    await discard(incompatible.directory);
  }
});

test("complete unsupported output withdraws one producer lineage, while failed or partial runs preserve it", async () => {
  const state = await createFixtureState();
  try {
    const ruleLineage = "test/complete-withdrawal";
    const supported = await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage,
      declaredFields: ["kind"],
      outputs: [derivedOutput(state, "cash.deposit", ruleLineage)],
    });
    const before = createCanonicalEnrichmentQuery(state.directory).current({ sourceConnectionKey: state.sourceConnectionKey }).transactions[0]!;
    assert.equal(requireSupported(before.kind).code, "cash.deposit");
    const beforeDb = openCanonicalDatabase(state.directory, { readOnly: true });
    const beforeProvenance = countRows(beforeDb, "SELECT COUNT(*) AS value FROM assertion_provenance WHERE enrichment_run_id IS NOT NULL");
    beforeDb.close();

    const withdrawn = await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage,
      declaredFields: ["kind"],
      outputs: [{
        ...derivedOutput(state, "cash.deposit", ruleLineage),
        state: "unsupported",
        value: null,
      }],
    });
    assert.deepEqual(withdrawn.assertionIds, []);
    assert.deepEqual(withdrawn.absent, [{ transactionId: state.transactionId, field: "kind" }]);
    assert.equal(createCanonicalEnrichmentQuery(state.directory).current({ sourceConnectionKey: state.sourceConnectionKey }).transactions[0]!.kind.status, "absent");
    assert.equal(requireSupported(createCanonicalEnrichmentQuery(state.directory).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: supported.commitSequence,
    }).transactions[0]!.kind).code, "cash.deposit");
    assert.equal(createCanonicalEnrichmentQuery(state.directory).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: withdrawn.commitSequence,
    }).transactions[0]!.kind.status, "absent");

    const afterWithdrawalDb = openCanonicalDatabase(state.directory, { readOnly: true });
    const afterWithdrawal = {
      provenance: countRows(afterWithdrawalDb, "SELECT COUNT(*) AS value FROM assertion_provenance WHERE enrichment_run_id IS NOT NULL"),
      transitions: countRows(afterWithdrawalDb, "SELECT COUNT(*) AS value FROM assertion_transitions WHERE enrichment_run_id IS NOT NULL"),
    };
    afterWithdrawalDb.close();
    assert.equal(afterWithdrawal.provenance, beforeProvenance + 1);
    assert.equal(afterWithdrawal.transitions, 2);

    for (const status of ["failed", "partial"] as const) {
      await assert.rejects(
        commitCanonicalAutomaticEnrichmentRun(state.directory, {
          sourceConnectionKey: state.sourceConnectionKey,
          stream: "domestic-deposit",
          ruleLineage,
          status,
          complete: false,
          declaredFields: ["kind"],
          outputs: [derivedOutput(state, "cash.deposit", ruleLineage)],
        }),
        /complete successful enrichment run/u,
      );
      const preserved = createCanonicalEnrichmentQuery(state.directory).current({ sourceConnectionKey: state.sourceConnectionKey }).transactions[0]!;
      assert.equal(preserved.kind.status, "absent");
    }
  } finally {
    await discard(state.directory);
  }
});

test("historical enrichment respects transaction creation, corrected financial dates, and assertion lifecycle", async () => {
  const state = await createFixtureState();
  try {
    const first = await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage: "test/historical-cutoffs",
      declaredFields: ["kind"],
      outputs: [derivedOutput(state, "cash.deposit", "test/historical-cutoffs")],
    });
    const notYetCreated = createCanonicalEnrichmentQuery(state.directory).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: state.captureCommitSequence - 1,
    });
    assert.equal(notYetCreated.transactions.length, 0);

    const raw = JSON.parse(CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse) as {
      content: { datas: Array<{ details: Array<{ sequenceNumber: number; accountDate: string }> }> };
    };
    raw.content.datas[0]!.details[0]!.accountDate = "2027-07-01";
    const correction = await commitCathayDomesticDeposit(state.directory, {
      ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
      rawResponse: JSON.stringify(raw),
      observedAt: "2026-08-20T00:00:00+08:00",
    });
    const correctedOutOfRange = createCanonicalEnrichmentQuery(state.directory).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: correction.commitSequence,
    });
    assert.equal(correctedOutOfRange.transactions.some((transaction) => transaction.transactionId === state.transactionId), false);
    const correctedInRange = createCanonicalEnrichmentQuery(state.directory).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2027-12-31",
      knowledgeAt: correction.commitSequence,
    });
    const correctedInRangeTransaction = correctedInRange.transactions.find((transaction) => transaction.transactionId === state.transactionId);
    assert.equal(correctedInRangeTransaction ? requireSupported(correctedInRangeTransaction.kind).code : undefined, "cash.deposit");
    const afterCorrectionBeforeEnrichment = createCanonicalEnrichmentQuery(state.directory).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2027-12-31",
      knowledgeAt: first.commitSequence,
    });
    const preCorrectionTransaction = afterCorrectionBeforeEnrichment.transactions.find((transaction) => transaction.transactionId === state.transactionId);
    assert.equal(preCorrectionTransaction ? requireSupported(preCorrectionTransaction.kind).code : undefined, "cash.deposit");
  } finally {
    await discard(state.directory);
  }
});

test("projection rebuild failure preserves the current typed enrichment projection", async () => {
  const state = await createFixtureState();
  try {
    await commitCathayAutomaticEnrichmentFromDescriptions(state.directory);
    const query = createCanonicalEnrichmentQuery(state.directory);
    const before = query.current({ sourceConnectionKey: state.sourceConnectionKey });
    const runtime = createCanonicalProjectionRuntime(canonicalSqlitePath(state.directory));
    await assert.rejects(runtime.rebuild({ injectFailure: "population" }), /Injected projection rebuild failure/u);
    const after = query.current({ sourceConnectionKey: state.sourceConnectionKey });
    assert.deepEqual(after.transactions, before.transactions);
    assert.equal(after.knowledgePoint, before.knowledgePoint);
  } finally {
    await discard(state.directory);
  }
});

test("a route revision selects the new assertion while historical knowledge points retain the old route", async () => {
  const state = await createFixtureState();
  try {
    const ruleLineage = "test/route-revision";
    const first = await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage,
      declaredFields: ["kind"],
      outputs: [derivedOutput(state, "cash.deposit", ruleLineage)],
    });
    const oldRouteId = "cathay/domestic-deposit/automatic-enrichment/v1/kind";
    const newRouteId = "cathay/domestic-deposit/automatic-enrichment/v1/kind-route-revision";
    const db = openCanonicalDatabase(state.directory);
    db.prepare("UPDATE automatic_enrichment_authority_routes SET valid_to_commit_sequence = ? WHERE route_id = ?").run(first.commitSequence + 1, oldRouteId);
    db.prepare(`
      INSERT INTO automatic_enrichment_authority_routes(
        route_id, subject_kind, field_name, scope_kind, scope_key,
        producer_id, producer_version, origin_policy, taxonomy_id,
        taxonomy_version, valid_from_commit_sequence, valid_to_commit_sequence)
      VALUES (?, 'transaction', 'kind', 'source_stream',
              'cathay/domestic-deposit',
              'cathay/domestic-deposit/automatic-enrichment', 'v1',
              'source_or_derived', 'transaction-taxonomy', 'v1', ?, NULL)
    `).run(newRouteId, first.commitSequence + 1);
    db.close();

    const second = await commitCanonicalAutomaticEnrichmentRun(state.directory, {
      sourceConnectionKey: state.sourceConnectionKey,
      stream: "domestic-deposit",
      ruleLineage,
      declaredFields: ["kind"],
      outputs: [derivedOutput(state, "transfer.internal", ruleLineage)],
    });
    const current = createCanonicalEnrichmentQuery(state.directory).current({ sourceConnectionKey: state.sourceConnectionKey }).transactions[0]!;
    assert.equal(requireSupported(current.kind).code, "transfer.internal");
    assert.equal(requireSupported(current.kind).route.id, newRouteId);
    const beforeRouteChange = createCanonicalEnrichmentQuery(state.directory).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: first.commitSequence,
    }).transactions[0]!;
    assert.equal(requireSupported(beforeRouteChange.kind).code, "cash.deposit");
    assert.equal(requireSupported(beforeRouteChange.kind).route.id, oldRouteId);
    const afterRouteChange = createCanonicalEnrichmentQuery(state.directory).historical({
      sourceConnectionKey: state.sourceConnectionKey,
      financialAt: "2026-12-31",
      knowledgeAt: second.commitSequence,
    }).transactions[0]!;
    assert.equal(requireSupported(afterRouteChange.kind).code, "transfer.internal");
    assert.equal(requireSupported(afterRouteChange.kind).route.id, newRouteId);
    const dbAfter = openCanonicalDatabase(state.directory, { readOnly: true });
    try {
      assert.equal(countRows(dbAfter, "SELECT COUNT(*) AS value FROM assertions WHERE field_name = 'kind'"), 2);
      assert.equal(countRows(dbAfter, "SELECT COUNT(*) AS value FROM assertion_transitions WHERE field_name = 'kind' AND event_kind = 'superseded'"), 0);
    } finally {
      dbAfter.close();
    }
  } finally {
    await discard(state.directory);
  }
});
