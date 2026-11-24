/**
 * The compaction dry run must count what a compaction of a store written
 * before ADR 0152 would remove, and change nothing. The old-shaped store is
 * `legacyStore` (compaction-fixtures.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { planLedgerCompaction, type CompactionPlan, type CompactionPlanResult } from "./compaction-plan.ts";
import { legacyStore, ROWS, snapshot, SYNCS } from "./compaction-fixtures.ts";
import { commitResync } from "./resync-fixtures.ts";
import { installFinancialStore } from "./store-layout.ts";
import { PGLITE_FINANCIAL_CONTRACTS } from "../../lib/pglite-rpc/pglite-financial-contracts.ts";
import { createPGliteWorkScheduler } from "../../../electron/pglite-financial-rpc-server.ts";

function planned(result: CompactionPlanResult): CompactionPlan {
  assert.equal(result.status, "planned", JSON.stringify(result));
  return result as CompactionPlan;
}

test("the dry run counts what compaction would remove from an old-shaped store", async () => {
  const { store, repeated, edgeCases } = await legacyStore();
  try {
    const plan = planned(await planLedgerCompaction(store));
    // Each edge case touched what it names; the loan counterpart backed one assertion.
    assert.deepEqual(edgeCases, { payload: 1, revision: 1, revocation: 1, shape: 1, backing: 1, depositMixed: 1, cardMixed: 1, kind: 1 });

    // Phase A: every row the older writers repeated, and no row they wrote first.
    assert.deepEqual(repeated, {
      // Purchases seen again: 19 on the second sync and 18 on the third.
      canonical_credit_card_transaction_details: 37,
      canonical_credit_card_transaction_lifecycle: 37,
      canonical_credit_card_instrument_evidence: 2,
      // The second statement only; the first leaves the window on the second sync.
      canonical_credit_card_statement_summary_evidence: 2,
      investment_security_name_observations: 10,
      transaction_relation_provenance: 6,
      einvoice_revision_observations: 37,
      einvoice_revision_events: 37,
      // The deposit connection's two account identifiers on the second and third sync.
      financial_account_identifier_observations: 4,
      source_occurrence_group_counts: repeated.source_occurrence_group_counts!,
    });
    assert.ok(repeated.source_occurrence_group_counts! > 0);
    assert.deepEqual(
      Object.fromEntries(plan.phaseA.map(({ table, removable }) => [table, removable])),
      {
        ...Object.fromEntries(Object.entries(repeated).filter(([table]) => table !== "source_occurrence_group_counts")),
        // The invoice whose third sync created a revision, and the one whose second sync revoked, keep that observation and event.
        einvoice_revision_observations: 35,
        einvoice_revision_events: 35,
      },
    );

    // Phase B: copies cited only by phase A repeats are removable, the
    // copies the new sync reused are pinned by its manifest, the loan copies
    // differ only by position, the copies of a capture with a manifest wait,
    // and each edge case moves the copies it touched.
    const groups = Object.fromEntries(plan.phaseB.groups.map((group) => [`${group.integrationNamespace}/${group.recordKind}`, group]));
    const counts = (copies: number, first: number, rest: Partial<Record<"changed" | "manifestCapture" | "pinned" | "lexemeOnly" | "removable", number>>) =>
      ({ copies, unchained: 0, first, changed: 0, manifestCapture: 0, pinned: 0, lexemeOnly: 0, removable: 0, ...rest });
    assert.deepEqual(Object.keys(groups).sort(), [
      "einvoice/personal-invoice",
      "fubon/fubon-credit-card-statement",
      "fubon/fubon-credit-card-transaction",
      "fubon/fubon-domestic-deposit",
      "fubon/fubon-loan-counterpart-deposit",
      "fubon/fubon-loan-transaction",
      "yuanta-fund/investment-source-record",
    ]);
    // 20 + 19 + 18 copies; the fourth sync reused the third sync's 17 still in
    // its window, and the one it did not reuse names a run.
    assert.deepEqual(groups["fubon/fubon-domestic-deposit"]!.counts, counts(57, 20, { pinned: 18, removable: 19 }));
    assert.deepEqual(groups["fubon/fubon-domestic-deposit"]!.pinnedBy, {
      capture_source_record_manifests: 17,
      "assertion_provenance (non-source)": 1,
    });
    // Purchases, the instrument and the statements: 23, 21 and 20 copies, less
    // the second-sync statement stored under its own kind. The third sync's
    // copies wait for their manifest capture, the one naming a run too.
    assert.deepEqual(groups["fubon/fubon-credit-card-transaction"]!.counts, counts(63, 23, { manifestCapture: 20, removable: 20 }));
    assert.deepEqual(groups["fubon/fubon-credit-card-statement"]!.counts, counts(1, 1, {}));
    // The changed payload changes its copy and the one after it; the created
    // revision and the revocation keep a copy each.
    assert.deepEqual(groups["einvoice/personal-invoice"]!.counts, counts(57, 20, { changed: 2, pinned: 2, removable: 33 }));
    assert.deepEqual(groups["einvoice/personal-invoice"]!.pinnedBy, {
      einvoice_invoice_revisions: 1,
      einvoice_revision_events: 2,
      einvoice_revision_observations: 2,
    });
    // Two holdings a sync, each new; the third sync's 18 transactions have another coverage shape.
    assert.deepEqual(groups["yuanta-fund/investment-source-record"]!.counts, counts(63, 26, { changed: 18, removable: 19 }));
    assert.deepEqual(groups["fubon/fubon-loan-transaction"]!.counts, counts(57, 20, { lexemeOnly: 37 }));
    // The counterpart that backs nothing, and the copy after it.
    assert.deepEqual(groups["fubon/fubon-loan-counterpart-deposit"]!.counts, counts(9, 3, { changed: 2, removable: 4 }));
    assert.deepEqual(plan.phaseB.pinnedBy, {
      capture_source_record_manifests: 17,
      "assertion_provenance (non-source)": 1,
      einvoice_invoice_revisions: 1,
      einvoice_revision_events: 2,
      einvoice_revision_observations: 2,
    });

    const removedCopies = 19 + 20 + 33 + 19 + 4;
    const tables = Object.fromEntries(plan.phaseB.tables.map(({ table, removable }) => [table, removable]));
    assert.equal(tables.source_records, removedCopies);
    assert.equal(tables.source_record_scopes, removedCopies);
    assert.equal(tables.source_record_provenance, removedCopies);
    const { rows: [backing] } = await store.query<{ rows: number }>(
      `SELECT count(*)::int AS rows FROM assertion_provenance WHERE source_record_id IN (SELECT source_record_id FROM source_records)`,
    );
    assert.ok(tables.assertion_provenance! > 0 && tables.assertion_provenance! < backing!.rows);

    // Phase C: every repeated count row, but not the one that raised its maximum.
    assert.equal(plan.phaseC.removable, repeated.source_occurrence_group_counts! - 1);

    for (const table of [...plan.phaseA, ...plan.phaseB.tables, plan.phaseC])
      assert.equal(table.estimatedBytes > 0, table.removable > 0, `${table.table} estimates bytes only for rows it removes`);
    assert.equal(
      plan.estimatedBytes,
      [...plan.phaseA, ...plan.phaseB.tables, plan.phaseC].reduce((sum, table) => sum + table.estimatedBytes, 0),
    );
    assert.ok(plan.estimatedBytes < plan.databaseBytes);
    assert.ok(plan.citingColumns.includes("transaction_revisions.source_record_id"));
  } finally {
    await store.close();
  }
});

test("the dry run changes no row", async () => {
  const { store } = await legacyStore();
  try {
    const before = await snapshot(store);
    planned(await planLedgerCompaction(store));
    assert.deepEqual(await snapshot(store), before);
    // The store still takes writes once the read-only transaction is gone.
    await commitResync(store, "deposit", SYNCS + 2, { rowCount: ROWS });
  } finally {
    await store.close();
  }
});

test("the dry run is a host-only financial operation", () => {
  const contract = PGLITE_FINANCIAL_CONTRACTS["financial.canonical.compactionPlan"];
  assert.equal("renderer" in contract, false);
  assert.equal(contract.workflow, undefined);
  assert.equal(contract.lane, "background-steps");
});

test("the dry run runs in steps that other queued work runs between, and stops when aborted", async () => {
  const { store } = await legacyStore();
  try {
    const whole = planned(await planLedgerCompaction(store));
    const scheduler = createPGliteWorkScheduler();
    const order: string[] = [];
    let steps = 0;
    const stepped = planLedgerCompaction(store, {
      runStep: (step) => scheduler.schedule("background", async () => {
        steps += 1;
        order.push(`step ${steps}`);
        if (steps === 1) void scheduler.schedule("interactive", async () => order.push("click"));
        return step();
      }),
    });
    assert.deepEqual(await stepped, whole);
    // Nine phase A tables, six subjects, the citation check, the subject list and the sizes.
    assert.equal(steps, 1 + 9 + 1 + 6 + 1);
    assert.deepEqual(order.slice(0, 3), ["step 1", "click", "step 2"]);

    const controller = new AbortController();
    let started = 0;
    await assert.rejects(
      planLedgerCompaction(store, {
        signal: controller.signal,
        runStep: (step) => {
          started += 1;
          if (started === 3) controller.abort(new Error("Settings closed."));
          return step();
        },
      }),
      /Settings closed\./,
    );
    assert.equal(started, 3);
  } finally {
    await store.close();
  }
});

test("the dry run refuses a store with a record citation it does not know", async () => {
  const store = await installFinancialStore(await PGlite.create());
  try {
    await commitResync(store, "deposit", 1, { rowCount: ROWS, reuseSourceRecords: false });
    await store.exec(`CREATE SCHEMA probe;
      CREATE TABLE probe.citations(citation_id BYTEA PRIMARY KEY, source_record_id BYTEA REFERENCES source_records(source_record_id));
      CREATE TABLE probe.loose_citations(statement_source_record_id BYTEA)`);
    assert.deepEqual(await planLedgerCompaction(store), {
      status: "unrecognised-citations",
      problems: [
        { table: "probe.citations", columns: ["source_record_id"], problem: "unknown-foreign-key" },
        { table: "probe.loose_citations", columns: ["statement_source_record_id"], problem: "no-foreign-key" },
      ],
    });
  } finally {
    await store.close();
  }
});
