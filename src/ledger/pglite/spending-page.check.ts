import assert from "node:assert/strict";
import test from "node:test";
import type { SpendingPageDto } from "../../lib/spending/model.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitCathay } from "./direct-source-precedence-fixture.ts";
import {
  applyManual,
  commitVerifiedDeposit,
  createManualAsset as create,
  twdSavings,
  usdSavings,
  writePreviewDeposits,
} from "./financial-pages.fixtures.ts";
import { applyManualAssetCommand } from "./manual-assets.ts";
import { createPGlitePreviewFinancialData } from "./preview-financial-data.ts";
import { readSpendingPage, readSpendingPageVersion, spendingPageBehind } from "./spending-page.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import { PGliteStore } from "./transaction.ts";

const CLOCK = { now: () => "2026-11-01T02:00:00.000Z", today: () => "2026-11-01" };

async function withStore(run: (store: PGliteStore) => Promise<void>) {
  const store = new PGliteStore(await createTestPGlite("full"));
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
    const canonical = await readSpendingPage(store);
    const { assetId } = await apply(store, {
      kind: "createAsset", category: "cash", name: "Wallet", currency: "TWD",
      firstValuation: { valuedOn: "2026-10-01", amount: "500", source: "counted", note: null },
    });
    await apply(store, {
      kind: "addTransaction", accountId: assetId,
      transaction: { kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-02", amount: "40", note: null },
    });

    const page = await store.transaction((transaction) => readSpendingPage(transaction));
    const version = await store.transaction((transaction) => readSpendingPageVersion(transaction));
    assert.equal(page.manual?.revision, version.manualRevision);
    assert.equal(page.purchaseReport.knowledgeAt, version.knowledgeAt);
    assert.equal(page.manual?.purchases.length, 1);
    assert.equal(page.purchaseReport.summary!.recordCount, canonical.purchaseReport.summary!.recordCount + 1);
    assert.equal(page.canonical.availability, "available");
    assert.equal(spendingPageBehind(page, version), false, "a page read at the current version is not behind");
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

test("Spending counts manual purchases in their month, day, and Personal Category, and never a receipt or transfer", async () => {
  await withStore(async (store) => {
    const apply = (command: unknown) => applyManual(store, command);
    const before = await readSpendingPage(store, {});
    const { assetId: wallet } = await apply(create("cash", "Wallet", "TWD", "2026-10-01", "3000", "counted"));
    const { assetId: jar } = await apply(create("cash", "Jar", "TWD", "2026-10-01", "0", "counted"));
    const add = (transaction: object) => apply({ kind: "addTransaction", accountId: wallet, transaction });
    await add({ kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-03", amount: "120.5", note: "Noodles" });
    await add({ kind: "purchase", personalCategory: null, occurredOn: "2026-10-03", amount: "30", note: null });
    await add({ kind: "receipt", occurredOn: "2026-10-04", amount: "500", note: null });
    await add({ kind: "transfer", direction: "out", counterpartAccountId: jar, occurredOn: "2026-10-05", amount: "100", note: null });
    const page = await readSpendingPage(store, {});
    const summary = page.purchaseReport.summary!;
    assert.equal(summary.recordCount, before.purchaseReport.summary!.recordCount + 2);
    assert.deepEqual(page.manual?.purchases.map((row) => [row.amount, row.personalCategory]).sort(), [["120.5", "dining"], ["30", null]]);
    assert.deepEqual(summary.dayTotals.find((day) => day.date === "2026-10-03"), {
      month: "2026-10", date: "2026-10-03", recordCount: 2,
      totalsByCurrency: [{ currency: "TWD", coefficient: "1505", scale: 1, count: 2 }],
    });
    assert.equal(summary.dayTotals.some((day) => day.date === "2026-10-04" || day.date === "2026-10-05"), false);
    assert.deepEqual(summary.categoryTotalsByMonth.filter((entry) => entry.month === "2026-10").map((entry) => [entry.categoryCode, entry.coefficient, entry.scale])
      .sort(([left], [right]) => String(left).localeCompare(String(right))), [
      ["dining", "1205", 1],
      [null, "30", 0],
    ]);
    assert.equal(page.purchaseReport.knowledgeAt, before.purchaseReport.knowledgeAt, "manual purchases leave the canonical version alone");
  });
});

test("preview transactions stay out of Spending reads", async () => {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    await commitVerifiedDeposit(store);
    const spending = createPGliteSpendingQuery(store);
    const readSpending = async () => {
      const { knowledgeAt } = await readSpendingPageVersion(store);
      return {
        summary: await readSpendingPage(store),
        records: await spending.recordPage({ knowledgeAt, month: "2026-10" }),
      };
    };
    const before = await readSpending();
    await writePreviewDeposits(createPGlitePreviewFinancialData(store), twdSavings, usdSavings);
    assert.deepEqual(await readSpending(), before);
  } finally {
    await store.close();
  }
});
