import assert from "node:assert/strict";
import test from "node:test";
import type { SpendingPageDto } from "../../lib/spending/model.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitCathay } from "./direct-source-precedence-fixture.ts";
import { applyManualAssetCommand, applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { readSpendingPage, readSpendingPageVersion, spendingPageBehind } from "./spending-page.ts";
import { PGliteStore } from "./transaction.ts";

const CLOCK = { now: () => "2026-11-01T02:00:00.000Z", today: () => "2026-11-01" };

async function withStore(run: (store: PGliteStore) => Promise<void>) {
  const store = new PGliteStore(await createTestPGlite("ledger+operational"));
  try {
    await commitCathay(store);
    await run(store);
  } finally {
    await store.close();
  }
}

async function apply(store: PGliteStore, command: unknown) {
  const result = await applyManualAssetCommand(store, command, CLOCK);
  if (!result.ok) assert.fail(`refused: ${result.code}`);
  return result;
}

test("the Spending page and its version read canonical purchases and Manual Asset purchases from one reader", async () => {
  await withStore(async (store) => {
    await applyPgliteManualAssetsSchema(store);
    const canonical = await readSpendingPage(store, { manualAssets: true });
    const { assetId } = await apply(store, {
      kind: "createAsset", category: "cash", name: "Wallet", currency: "TWD",
      firstValuation: { valuedOn: "2026-10-01", amount: "500", source: "counted", note: null },
    });
    await apply(store, {
      kind: "addTransaction", accountId: assetId,
      transaction: { kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-02", amount: "40", note: null },
    });

    const page = await store.transaction((transaction) => readSpendingPage(transaction, { manualAssets: true }));
    const version = await store.transaction((transaction) => readSpendingPageVersion(transaction, { manualAssets: true }));
    assert.equal(page.manual?.revision, version.manualRevision);
    assert.equal(page.purchaseReport.knowledgeAt, version.knowledgeAt);
    assert.equal(page.manual?.purchases.length, 1);
    assert.equal(page.purchaseReport.summary!.recordCount, canonical.purchaseReport.summary!.recordCount + 1);
    assert.equal(page.canonical.availability, "available");
    assert.equal(spendingPageBehind(page, version), false, "a page read at the current version is not behind");
  });
});

test("a store without the Manual Asset tables reads its Spending page and version without them", async () => {
  await withStore(async (store) => {
    const page = await readSpendingPage(store, { manualAssets: false });
    assert.equal(page.manual, undefined);
    const version = await readSpendingPageVersion(store, { manualAssets: false });
    assert.equal(version.manualRevision, 0);
    assert.equal(version.knowledgeAt, page.purchaseReport.knowledgeAt);
  });
});

test("a page is behind when canonical data moved forward or Manual Assets changed, and not otherwise", () => {
  const page = { purchaseReport: { knowledgeAt: 5 }, manual: { revision: 2, purchases: [] } } as unknown as SpendingPageDto;
  assert.equal(spendingPageBehind(page, { knowledgeAt: 5, manualRevision: 2 }), false);
  assert.equal(spendingPageBehind(page, { knowledgeAt: 6, manualRevision: 2 }), true, "a newer canonical commit");
  assert.equal(spendingPageBehind(page, { knowledgeAt: 5, manualRevision: 3 }), true, "a manual write");
  assert.equal(spendingPageBehind(page, { knowledgeAt: 4, manualRevision: 2 }), false, "an older canonical version is not newer data");
  assert.equal(spendingPageBehind(undefined, { knowledgeAt: 0, manualRevision: 0 }), true, "nothing published yet");
});
