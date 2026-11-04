import assert from "node:assert/strict";
import test from "node:test";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitCathay } from "./direct-source-precedence-fixture.ts";
import { readAssetsPage, readLiabilitiesPage, readOverviewPage, type FinancialPageScope } from "./financial-pages.ts";
import { PGliteStore } from "./transaction.ts";

const SCOPE: FinancialPageScope = { expectedSources: [], previewVisibility: { visible: [] }, today: "2026-11-03" };

async function withStore(run: (store: PGliteStore) => Promise<void>) {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

async function readPages(store: PGliteStore) {
  return {
    overview: await store.transaction((reader) => readOverviewPage(reader, SCOPE)),
    assets: await store.transaction((reader) => readAssetsPage(reader, SCOPE)),
    liabilities: await store.transaction((reader) => readLiabilitiesPage(reader, SCOPE)),
  };
}

test("every Financial page is valued at the newest history date, not the person's date", async () => {
  await withStore(async (store) => {
    await commitCathay(store);
    const { overview, assets, liabilities } = await readPages(store);
    const newest = overview.dailyHistory.map((row) => row.date).sort().at(-1);
    assert.ok(newest && newest < SCOPE.today, "the fixture's history ends before the person's date");
    assert.equal(overview.valuationDate, newest);
    assert.equal(assets.valuationDate, newest);
    assert.equal(liabilities.valuationDate, newest);
  });
});

test("without history or rates, the pages are valued at the person's date", async () => {
  await withStore(async (store) => {
    const { overview, assets, liabilities } = await readPages(store);
    assert.deepEqual(overview.dailyHistory, []);
    assert.deepEqual(
      [overview.valuationDate, assets.valuationDate, liabilities.valuationDate],
      [SCOPE.today, SCOPE.today, SCOPE.today],
    );
  });
});
