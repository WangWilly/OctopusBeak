import assert from "node:assert/strict";
import test from "node:test";
import { createPGliteFinancialRegistry } from "../../../electron/pglite-financial-registry.ts";
import { assertPgliteBaseline } from "./baseline.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { resetPGliteCanonicalStore } from "./canonical-reset.ts";
import { commitCathay } from "./direct-source-precedence-fixture.ts";
import { applyPgliteMaicoinOperationalSchema } from "./maicoin-operational.ts";
import { createPgliteOperationalProvider } from "./operational.ts";
import { applyPglitePreviewFinancialDataSchema } from "./preview-financial-data.ts";
import { PGliteStore } from "./transaction.ts";

async function withDesktopStore(run: (store: PGliteStore) => Promise<void>) {
  const store = new PGliteStore(await createTestPGlite("ledger+operational"));
  try {
    await applyPgliteMaicoinOperationalSchema(store);
    await applyPglitePreviewFinancialDataSchema(store);
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
    const overview = await createPGliteFinancialRegistry(store, provider.exchangeRates)["financial.overview.current"]([]);
    assert.deepEqual(overview.accounts, [], "the overview reads the empty store");

    await commitCathay(store);
    assert.ok((await rowCounts(store)).financial_accounts! > 0, "the same capture is admitted again after the reset");
  });
});
