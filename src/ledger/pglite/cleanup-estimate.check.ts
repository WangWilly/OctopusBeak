/**
 * The App Data Cleanup's one estimate (ADR 0156): the dry run and the
 * reclaim estimate together, and the room the run needs before it deletes
 * anything, counted for the tables the reclaim would rewrite after the
 * compaction.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cleanupReclaimBytesNeeded, combineLedgerCleanupEstimate, estimateLedgerCleanup } from "./cleanup-estimate.ts";
import { cleanupBackupBytesNeeded, ledgerBackupBytesNeeded } from "./data-dir-backup.ts";
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

test("with a backup the run needs the backup's room and the reclaim's together, since the backup stays on the disk during the reclaim", () => {
  const GiB = 1024 * MiB;
  // A 2 GB ledger whose largest table keeps 500 MB after the compaction, on a disk with 2.6 GB free.
  const reserve = cleanupReclaimBytesNeeded(null, {
    ...reclaim,
    tables: [{ table: "public.big", bytes: 800 * MiB, reclaimableBytes: 300 * MiB }],
    measured: [{ table: "public.big", bytes: 800 * MiB, compactBytes: 500 * MiB }],
  });
  assert.equal(reserve, 3 * 500 * MiB + LEDGER_RECLAIM_HEADROOM_BYTES);
  const free = 2.6 * GiB;
  assert.ok(reserve <= free, "the reclaim alone fits");
  assert.ok(ledgerBackupBytesNeeded(2 * GiB) <= free, "the backup alone fits");
  assert.equal(cleanupBackupBytesNeeded(2 * GiB, reserve), ledgerBackupBytesNeeded(2 * GiB) + reserve);
  assert.ok(cleanupBackupBytesNeeded(2 * GiB, reserve) > free, "together they do not, so no backup is offered");
});

test("the estimate runs the dry run until the compaction's markers are written, and then only the reclaim's estimate", async () => {
  const { store } = await legacyStore();
  try {
    const reserves: number[] = [];
    const before = await estimateLedgerCleanup(store, {
      minBytes: 0,
      minShare: 0,
      backupRoom: async (reserveBytes) => {
        reserves.push(reserveBytes);
        return { storeBytes: 10 * MiB, neededBytes: cleanupBackupBytesNeeded(10 * MiB, reserveBytes), freeBytes: 7_000 * MiB };
      },
    });
    assert.equal(before.compaction, "planned");
    assert.deepEqual(reserves, [before.reclaimNeededBytes], "the backup's room is asked with the run's need on top");
    assert.equal(before.backup !== null && before.backup !== "unreadable" && before.backup.neededBytes,
      ledgerBackupBytesNeeded(10 * MiB) + before.reclaimNeededBytes);
    assert.ok(before.redundantBytes > 0, "an old-shaped store holds redundant rows");
    assert.ok(before.reclaimNeededBytes > LEDGER_RECLAIM_HEADROOM_BYTES);
    assert.equal((await runLedgerCompaction(store)).status, "compacted");
    const after = await estimateLedgerCleanup(store, { backupRoom: async () => { throw new Error("EIO"); } });
    assert.deepEqual([after.compaction, after.redundantBytes, after.backup], ["compacted", 0, "unreadable"],
      "a room that could not be read is said, not hidden");
  } finally {
    await store.close();
  }
});
