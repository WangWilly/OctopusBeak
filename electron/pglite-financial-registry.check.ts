/**
 * The Cleanup Backup's check before it copies needs what the run needs
 * after it (ADR 0156). The registry keeps the estimate's figure only while
 * the store is as that estimate read it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createPGliteFinancialRegistry } from "./pglite-financial-registry.ts";
import { createTestPGlite } from "../src/ledger/pglite/baseline-test-template.ts";
import { LedgerBackupError } from "../src/ledger/pglite/data-dir-backup.ts";
import { commitCathay } from "../src/ledger/pglite/direct-source-precedence-fixture.ts";
import { createPGliteFinancialPageActions } from "../src/ledger/pglite/spending-command.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";

/** A registry over a store with one source, whose backup records the need it is asked to leave room for and then fails. */
async function withBackupLedger(run: (input: Readonly<{
  registry: ReturnType<typeof createPGliteFinancialRegistry>;
  /** One entry per estimate read, the run's own included: the need each asked the room for. */
  estimates: number[];
  /** The need each backup was asked to leave room for. */
  takes: number[];
}>) => Promise<void>) {
  const store = new PGliteStore(await createTestPGlite("full"));
  const estimates: number[] = [];
  const takes: number[] = [];
  try {
    await commitCathay(store);
    const registry = createPGliteFinancialRegistry(store, createPGliteFinancialPageActions(store), {
      freeDiskBytes: async () => 1e12,
      ledgerBackup: {
        room: async (reserveBytes) => {
          estimates.push(reserveBytes);
          return { storeBytes: 1, neededBytes: 1 + reserveBytes, freeBytes: 1e12 };
        },
        take: async ({ reserveBytes }) => {
          takes.push(reserveBytes);
          throw new LedgerBackupError("copy-failed", "the check stops at the backup");
        },
        remove: async () => {},
        newest: async () => null,
        removeAll: async () => {},
      },
    });
    await run({ registry, estimates, takes });
  } finally {
    await store.close();
  }
}

const cleanUp = { backup: true, keepBackup: true } as const;

test("a run right after its estimate leaves the room that estimate read, without reading it again", async () => {
  await withBackupLedger(async ({ registry, estimates, takes }) => {
    const estimate = await registry["financial.ledger.cleanupEstimate"]([]);
    const result = await registry["financial.canonical.compact"]([cleanUp]);
    assert.equal(result.status, "failed");
    assert.deepEqual(takes, [estimate.reclaimNeededBytes]);
    assert.equal(estimates.length, 1, "the dry run ran once");
  });
});

test("a write after the estimate makes the run read the need again rather than trust the older figure", async () => {
  await withBackupLedger(async ({ registry, estimates, takes }) => {
    await registry["financial.ledger.cleanupEstimate"]([]);
    // The person cancelled; a sync, or here a manual write, changed the store before the next run.
    const written = await registry["financial.manualAssets.apply"]([{ kind: "deleteAllManualAssets" }]);
    assert.equal(written.ok, true);
    await registry["financial.canonical.compact"]([cleanUp]);
    assert.equal(estimates.length, 2, "the run read its own estimate");
    assert.deepEqual(takes, [estimates[1]], "and left the room that one read");
  });
});

test("a run with no estimate in this worker reads one first", async () => {
  await withBackupLedger(async ({ registry, estimates, takes }) => {
    await registry["financial.canonical.compact"]([cleanUp]);
    assert.equal(estimates.length, 1);
    assert.deepEqual(takes, estimates);
  });
});
