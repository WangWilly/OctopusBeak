import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPGliteFinancialRegistry } from "../../../electron/pglite-financial-registry.ts";
import { assertPgliteBaseline } from "./baseline.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { resetPGliteCanonicalStore } from "./canonical-reset.ts";
import { FAILURE_RECORD, readRecordedFailure } from "./compaction-job.ts";
import { readLedgerCleanupBackup, removeAllLedgerBackups } from "./data-dir-backup.ts";
import { commitCathay } from "./direct-source-precedence-fixture.ts";
import { createPgliteOperationalProvider } from "./operational.ts";
import { PGliteStore } from "./transaction.ts";
import { createPGliteFinancialPageActions } from "./spending-command.ts";

async function withDesktopStore(run: (store: PGliteStore) => Promise<void>) {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

async function rowCounts(store: PGliteStore): Promise<Record<string, number>> {
  const tables = await store.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  const counts: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    counts[table_name] = (await store.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "${table_name}"`)).rows[0]!.count;
  }
  return counts;
}

const knowledgeVersion = async (store: PGliteStore) =>
  Number((await store.query<{ value: string }>("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits")).rows[0]!.value);

test("a Canonical Reset of a fresh store keeps every row the baseline installed", async () => {
  await withDesktopStore(async (store) => {
    const before = await rowCounts(store);
    await resetPGliteCanonicalStore(store);
    const after = await rowCounts(store);
    assert.deepEqual({ ...after, canonical_commits: 0 }, before, "only the reset commit is new");
    await assertPgliteBaseline(store);
  });
});

test("a Canonical Reset empties financial state, keeps rates and run history, and admits new captures", async () => {
  await withDesktopStore(async (store) => {
    const fresh = await rowCounts(store);
    const provider = createPgliteOperationalProvider(store);
    await commitCathay(store);
    await store.query(
      `INSERT INTO capture_source_record_manifests(capture_id, source_record_ids, record_count, commit_id)
       SELECT capture_id, source_record_id, 1, commit_id FROM source_records LIMIT 1`,
    );
    await provider.exchangeRates.upsertExchangeRates([
      { rateDate: "2026-10-09", currency: "USD", twdPerUnit: 32.1, source: "synthetic", fetchedAt: "2026-10-09T00:00:00.000Z" },
    ]);
    await provider.automation.createTaskRun({
      taskId: "cathay-all-statements", kind: "crawler", status: "completed", attempt: 1, maxAttempts: 1,
      startedAt: "2026-10-09T00:00:00.000Z", finishedAt: "2026-10-09T00:05:00.000Z",
    });
    await provider.preview.write({
      sourceId: "synthetic-preview", institution: "bank-017", product: "deposit",
      collection: {
        collectedAt: "2026-10-09T01:00:00.000Z",
        accounts: [{
          sourceAccountKey: "acct-1", displayLabel: "Synthetic savings", currency: "TWD", type: "depository",
          balances: [{ kind: "current", amount: "100", currency: "TWD", observedAt: { at: "2026-10-09T01:00:00.000Z", source: "collection-time" } }],
          transactions: [],
        }],
      },
    });
    const before = await rowCounts(store);
    assert.ok(before.financial_accounts! > 0 && before.preview_accounts! > 0, "the store held financial and preview data");
    assert.equal(before.capture_source_record_manifests, 1, "the store held a capture manifest");
    const versionBefore = await knowledgeVersion(store);

    await resetPGliteCanonicalStore(store);

    assert.deepEqual(await rowCounts(store), {
      ...fresh,
      canonical_commits: 1,
      exchange_rates: 1,
      automation_task_runs: 1,
    }, "only the baseline rows, the reset commit, rates and run history remain");
    assert.ok(await knowledgeVersion(store) > versionBefore, "the knowledge version keeps increasing");
    await assertPgliteBaseline(store);
    assert.equal((await provider.exchangeRates.readExchangeRates(["USD"])).length, 1);
    assert.equal((await provider.automation.latestTaskRuns())["cathay-all-statements"]?.status, "completed");
    const overview = await createPGliteFinancialRegistry(store, createPGliteFinancialPageActions(store))["financial.overview.current"]([]);
    assert.deepEqual(overview.accounts, [], "the overview reads the empty store");

    await commitCathay(store);
    assert.ok((await rowCounts(store)).financial_accounts! > 0, "the same capture is admitted again after the reset");
  });
});

test("a Canonical Reset removes a compaction's recorded failure and keeps its markers", async () => {
  await withDesktopStore(async (store) => {
    await store.query(
      `INSERT INTO pglite_operational_migrations(migration_key, schema_signature)
       VALUES ($1, '{"removedRows":12,"chunks":{"done":1,"count":3},"backup":false}'), ('ledger-compaction-kept-marker-check', 'x')`,
      [FAILURE_RECORD],
    );
    assert.equal((await readRecordedFailure(store))?.removedRows, 12);

    await resetPGliteCanonicalStore(store);

    assert.equal(await readRecordedFailure(store), null, "Settings no longer reports rows of the emptied store");
    const kept = await store.query("SELECT 1 FROM pglite_operational_migrations WHERE migration_key = 'ledger-compaction-kept-marker-check'");
    assert.equal(kept.rows.length, 1, "every other operational row stays");
  });
});

test("a Canonical Reset deletes the Cleanup Backup, which holds the data it deletes", async () => {
  const root = await mkdtemp(join(tmpdir(), "octopus-beak-reset-backup-check-"));
  const dataDir = join(root, "ledger");
  try {
    await mkdir(dataDir);
    const finished = `${dataDir}.before-compaction-2026-11-01T00-00-00Z`;
    await mkdir(finished);
    await writeFile(join(finished, "PG_VERSION"), "17");
    await writeFile(`${finished}.versions.json`, JSON.stringify({ canonical: 1, operational: 1 }));
    await mkdir(`${dataDir}.before-compaction-2026-11-02T00-00-00Z.partial`);
    const versions = { canonical: 1, operational: 1 };
    await withDesktopStore(async (store) => {
      const registry = createPGliteFinancialRegistry(store, createPGliteFinancialPageActions(store), {
        ledgerBackup: {
          room: async () => { throw new Error("unused"); },
          take: async () => { throw new Error("unused"); },
          remove: async () => { throw new Error("unused"); },
          newest: () => readLedgerCleanupBackup(dataDir, versions),
          removeAll: () => removeAllLedgerBackups(dataDir),
        },
      });
      assert.equal((await registry["financial.ledger.cleanupBackup"]([]))?.path, finished);
      await commitCathay(store);
      await registry["financial.canonical.reset"]([]);
      assert.equal(await registry["financial.ledger.cleanupBackup"]([]), null);
      assert.equal((await rowCounts(store)).financial_accounts, 0, "and the store is emptied");
    });
    assert.deepEqual(await readdir(root), ["ledger"], "no backup, partial copy or versions file is left");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Canonical Reset whose backup removal fails leaves the store as it was and says so", async () => {
  await withDesktopStore(async (store) => {
    const registry = createPGliteFinancialRegistry(store, createPGliteFinancialPageActions(store), {
      ledgerBackup: {
        room: async () => { throw new Error("unused"); },
        take: async () => { throw new Error("unused"); },
        remove: async () => { throw new Error("unused"); },
        newest: async () => null,
        removeAll: async () => { throw new Error("EACCES: the backup could not be removed"); },
      },
    });
    await commitCathay(store);
    const before = await rowCounts(store);
    await assert.rejects(() => registry["financial.canonical.reset"]([]), /EACCES/u);
    assert.deepEqual(await rowCounts(store), before, "nothing was emptied, so the person can run the reset again");
  });
});
