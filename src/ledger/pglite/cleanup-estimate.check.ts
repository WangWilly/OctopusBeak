/**
 * The App Data Cleanup's one estimate (ADR 0156): the dry run and the
 * reclaim estimate together, and the room the run needs before it deletes
 * anything, counted for the tables the reclaim would rewrite after the
 * compaction.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { combineLedgerCleanupEstimate, estimateLedgerCleanup } from "./cleanup-estimate.ts";
import { runLedgerCompaction } from "./compaction-job.ts";
import type { CompactionPlan, CompactionTablePlan } from "./compaction-plan.ts";
import { legacyStore } from "./compaction-fixtures.ts";
import { LEDGER_RECLAIM_HEADROOM_BYTES, type LedgerReclaimEstimate } from "./reclaim.ts";

const MiB = 1024 * 1024;

const table = (name: string, estimatedBytes: number): CompactionTablePlan => ({ table: name, rows: 10, removable: 5, estimatedBytes });

function plan(removed: Readonly<Record<string, number>>): CompactionPlan {
  const tables = Object.entries(removed).map(([name, bytes]) => table(name, bytes));
  const zero = { copies: 0, unchained: 0, first: 0, changed: 0, manifestCapture: 0, pinned: 0, lexemeOnly: 0, removable: 0 };
  return {
    status: "planned",
    databaseBytes: 0,
    phaseA: tables.slice(1),
    phaseB: { groups: [], totals: zero, pinnedBy: {}, tables: tables.slice(0, 1) },
    phaseC: table("source_occurrence_group_counts", 0),
    citingColumns: [],
    estimatedBytes: tables.reduce((sum, { estimatedBytes }) => sum + estimatedBytes, 0),
  };
}

/** `source_records`, 100 MiB with 80 MiB live, is not worth rewriting now; a churned catalog is. */
const reclaim: LedgerReclaimEstimate = {
  tables: [{ table: "pg_catalog.pg_depend", bytes: 30 * MiB, reclaimableBytes: 20 * MiB }],
  measured: [
    { table: "pg_catalog.pg_depend", bytes: 30 * MiB, compactBytes: 10 * MiB },
    { table: "public.source_records", bytes: 100 * MiB, compactBytes: 80 * MiB },
    { table: "public.automation_task_runs", bytes: 200 * MiB, compactBytes: 190 * MiB },
  ],
  reclaimableBytes: 20 * MiB,
  requiredFreeBytes: 3 * 10 * MiB + LEDGER_RECLAIM_HEADROOM_BYTES,
  freeBytes: 7_000 * MiB,
};

test("the room counts the largest table the reclaim would rewrite after the compaction, as its live bytes less what the dry run removes", () => {
  const estimate = combineLedgerCleanupEstimate(plan({ source_records: 40 * MiB }), reclaim, null);
  assert.equal(estimate.compaction, "planned");
  assert.equal(estimate.redundantBytes, 40 * MiB);
  assert.equal(estimate.temporaryBytes, 20 * MiB);
  // source_records keeps 40 MiB live of 100 MiB, so the reclaim picks it then; it is larger than the catalog's 10 MiB.
  assert.equal(estimate.reclaimNeededBytes, 3 * 40 * MiB + LEDGER_RECLAIM_HEADROOM_BYTES);
  assert.equal(estimate.freeBytes, 7_000 * MiB);
  assert.equal(estimate.backup, null);

  // Removing too little leaves source_records under a quarter of dead space: the reclaim would not pick it.
  const small = combineLedgerCleanupEstimate(plan({ source_records: 2 * MiB }), reclaim, null);
  assert.equal(small.reclaimNeededBytes, 3 * 10 * MiB + LEDGER_RECLAIM_HEADROOM_BYTES, "only the catalog is rewritten");
  assert.equal(combineLedgerCleanupEstimate(plan({}), reclaim, null).reclaimNeededBytes, reclaim.requiredFreeBytes,
    "removing nothing, the need is the reclaim's own");
});

test("a compacted store is only reclaimed; one the planner cannot read removes nothing; nothing to rewrite needs no room", () => {
  const compacted = combineLedgerCleanupEstimate(null, reclaim, { storeBytes: 500 * MiB, neededBytes: 806 * MiB, freeBytes: 900 * MiB });
  assert.deepEqual(compacted, {
    compaction: "compacted",
    redundantBytes: 0,
    temporaryBytes: 20 * MiB,
    reclaimNeededBytes: reclaim.requiredFreeBytes,
    backup: { storeBytes: 500 * MiB, neededBytes: 806 * MiB, freeBytes: 900 * MiB },
    freeBytes: 900 * MiB,
  });
  const cannot = combineLedgerCleanupEstimate({ status: "unrecognised-citations", problems: [] }, reclaim, null);
  assert.deepEqual([cannot.compaction, cannot.redundantBytes], ["cannot", 0]);
  const clean = combineLedgerCleanupEstimate(null, { tables: [], measured: [], reclaimableBytes: 0, requiredFreeBytes: 0, freeBytes: null }, null);
  assert.deepEqual([clean.reclaimNeededBytes, clean.temporaryBytes, clean.freeBytes], [0, 0, null]);
});

test("the estimate runs the dry run until the compaction's markers are written, and then only the reclaim's estimate", async () => {
  const { store } = await legacyStore();
  try {
    const before = await estimateLedgerCleanup(store, { minBytes: 0, minShare: 0 });
    assert.equal(before.compaction, "planned");
    assert.ok(before.redundantBytes > 0, "an old-shaped store holds redundant rows");
    assert.ok(before.reclaimNeededBytes > LEDGER_RECLAIM_HEADROOM_BYTES);
    assert.equal((await runLedgerCompaction(store)).status, "compacted");
    const after = await estimateLedgerCleanup(store);
    assert.deepEqual([after.compaction, after.redundantBytes], ["compacted", 0]);
  } finally {
    await store.close();
  }
});
