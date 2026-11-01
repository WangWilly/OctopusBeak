import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  manualBalancePoints,
  manualValuationStale,
  ManualAssetRejected,
  parseManualAssetCommand,
} from "../../lib/manual-assets/manual-assets.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { resetPGliteCanonicalStore } from "./canonical-reset.ts";
import { commitCathay } from "./direct-source-precedence-fixture.ts";
import {
  applyManualAssetCommand,
  applyPgliteManualAssetsSchema,
  readManualAssetRevision,
  readManualAssets,
  readManualSpendingPurchases,
} from "./manual-assets.ts";
import { PGliteStore } from "./transaction.ts";

async function withManualStore(run: (store: PGliteStore, apply: (command: unknown) => ReturnType<typeof applyManualAssetCommand>) => Promise<void>, database?: PGlite) {
  const store = new PGliteStore(database ?? await PGlite.create());
  try {
    await applyPgliteManualAssetsSchema(store);
    await run(store, (command) => applyManualAssetCommand(store, parseManualAssetCommand(command)));
  } finally {
    await store.close();
  }
}

const house = {
  kind: "createAsset", category: "house", name: "Apartment", currency: "TWD",
  firstValuation: { valuedOn: "2026-01-10", amount: "12000000", source: "purchase_price", note: null },
};
const wallet = (name = "Wallet", currency = "TWD", amount = "1000") => ({
  kind: "createAsset", category: "cash", name, currency,
  firstValuation: { valuedOn: "2026-10-01", amount, source: "counted", note: null },
});

test("a valuation on a date already valued replaces it, every other date stays, and the latest is current", async () => {
  await withManualStore(async (store, apply) => {
    const { assetId } = await apply(house);
    await apply({ kind: "upsertValuation", assetId, valuation: { valuedOn: "2026-06-01", amount: "12500000", source: "own_estimate", note: "neighbour sold" } });
    await apply({ kind: "upsertValuation", assetId, valuation: { valuedOn: "2026-06-01", amount: "12600000.5", source: "appraisal_report", note: null } });
    const [view] = await readManualAssets(store);
    assert.deepEqual(view!.valuations, [
      { valuedOn: "2026-01-10", amount: "12000000", source: "purchase_price", note: null },
      { valuedOn: "2026-06-01", amount: "12600000.5", source: "appraisal_report", note: null },
    ]);
    assert.deepEqual(manualBalancePoints("house", view!.valuations, []).at(-1), {
      date: "2026-06-01", exact: { coefficient: "126000005", scale: 1 },
    }, "the newest valuation is the current value, kept exact");
  });
});

test("a valuation source the category does not offer, or a malformed field, is refused at the boundary", () => {
  const refuse = (command: unknown, pattern: RegExp) =>
    assert.throws(() => parseManualAssetCommand(command), (error) => error instanceof ManualAssetRejected && pattern.test(error.message));
  refuse({ ...house, firstValuation: { ...house.firstValuation, source: "counted" } }, /not offered for house/u);
  refuse({ ...house, category: "deposit" }, /category/u);
  refuse({ ...house, currency: "twd" }, /ISO 4217/u);
  refuse({ ...house, firstValuation: { ...house.firstValuation, valuedOn: "2026-02-30" } }, /YYYY-MM-DD/u);
  refuse({ ...house, firstValuation: { ...house.firstValuation, amount: 12000000 } }, /exact/u);
  refuse({ ...house, firstValuation: { ...house.firstValuation, amount: "-5" } }, /exact/u);
  refuse({ kind: "addTransaction", accountId: "a", transaction: { kind: "purchase", occurredOn: "2026-10-02", amount: "0", note: null, personalCategory: null } }, /positive/u);
  refuse({ kind: "addTransaction", accountId: "a", transaction: { kind: "purchase", occurredOn: "2026-10-02", amount: "5", note: null, personalCategory: "groceries" } }, /Personal Category/u);
  refuse({ kind: "addTransaction", accountId: "a", transaction: { kind: "receipt", occurredOn: "2026-10-02", amount: "5", note: null, personalCategory: "dining" } }, /only a purchase/u);
  refuse({ kind: "dropTables" }, /unknown/u);
});

test("rules that depend on stored rows are refused when the command runs", async () => {
  await withManualStore(async (_store, apply) => {
    const { assetId: houseId } = await apply(house);
    const { assetId: twd } = await apply(wallet("TWD wallet"));
    const { assetId: usd } = await apply(wallet("USD wallet", "USD", "20"));
    const rejects = (command: unknown, pattern: RegExp) =>
      assert.rejects(apply(command), (error) => error instanceof ManualAssetRejected && pattern.test(error.message));
    await rejects({ kind: "upsertValuation", assetId: houseId, valuation: { valuedOn: "2026-02-01", amount: "1", source: "counted", note: null } }, /not offered/u);
    await rejects({ kind: "addTransaction", accountId: houseId, transaction: { kind: "receipt", occurredOn: "2026-10-02", amount: "5", note: null } }, /only a Manual Account/u);
    await rejects({ kind: "addTransaction", accountId: twd, transaction: { kind: "transfer", direction: "out", counterpartAccountId: usd, occurredOn: "2026-10-02", amount: "5", note: null } }, /one currency/u);
    await rejects({ kind: "addTransaction", accountId: twd, transaction: { kind: "transfer", direction: "out", counterpartAccountId: twd, occurredOn: "2026-10-02", amount: "5", note: null } }, /two different/u);
    await rejects({ kind: "deleteValuation", assetId: houseId, valuedOn: "2026-01-10" }, /at least one valuation/u);
    await apply({ kind: "endAsset", assetId: houseId, endedOn: "2026-08-01" });
    await rejects({ kind: "upsertValuation", assetId: houseId, valuation: { valuedOn: "2026-09-01", amount: "1", source: "own_estimate", note: null } }, /after the asset ended/u);
    await apply({ kind: "upsertValuation", assetId: twd, valuation: { valuedOn: "2026-10-20", amount: "900", source: "counted", note: null } });
    await rejects({ kind: "endAsset", assetId: twd, endedOn: "2026-10-10" }, /after that end date/u);
    await rejects({ kind: "renameAsset", assetId: "missing", name: "x" }, /does not exist/u);
  });
});

test("a Manual Account balance is the latest count plus the transactions dated after it", () => {
  const points = manualBalancePoints("cash", [
    { valuedOn: "2026-10-01", amount: "1000" },
    { valuedOn: "2026-10-05", amount: "700" },
  ], [
    { occurredOn: "2026-09-30", amount: "50", kind: "purchase", personalCategory: null },
    { occurredOn: "2026-10-01", amount: "80", kind: "purchase", personalCategory: null },
    { occurredOn: "2026-10-02", amount: "120.5", kind: "purchase", personalCategory: "dining" },
    { occurredOn: "2026-10-03", amount: "300", kind: "receipt" },
    { occurredOn: "2026-10-05", amount: "40", kind: "purchase", personalCategory: null },
    { occurredOn: "2026-10-06", amount: "100", kind: "transfer", direction: "out", transferId: "t", counterpartAccountId: "b" },
  ]);
  assert.deepEqual(points.map((point) => [point.date, point.exact]), [
    ["2026-10-01", { coefficient: "1000", scale: 0 }],
    ["2026-10-02", { coefficient: "8795", scale: 1 }],
    ["2026-10-03", { coefficient: "11795", scale: 1 }],
    ["2026-10-05", { coefficient: "700", scale: 0 }],
    ["2026-10-06", { coefficient: "600", scale: 0 }],
  ], "same-day and earlier transactions are already in a count, and the counted gap is never booked");
});

test("a transfer is recorded on both accounts, and editing or deleting one side changes both", async () => {
  await withManualStore(async (store, apply) => {
    const { assetId: wallet1 } = await apply(wallet("Wallet"));
    const { assetId: jar } = await apply(wallet("Coin jar", "TWD", "0"));
    const { transactionId } = await apply({
      kind: "addTransaction", accountId: wallet1,
      transaction: { kind: "transfer", direction: "out", counterpartAccountId: jar, occurredOn: "2026-10-02", amount: "200", note: null },
    });
    const sides = async () => Object.fromEntries((await readManualAssets(store)).map((view) => [view.asset.name, view.transactions.map((row) =>
      row.kind === "transfer" ? [row.direction, row.amount, row.counterpartAccountId] : [row.kind])]));
    assert.deepEqual(await sides(), { Wallet: [["out", "200", jar]], "Coin jar": [["in", "200", wallet1]] });
    await apply({
      kind: "updateTransaction", transactionId,
      transaction: { kind: "transfer", direction: "out", counterpartAccountId: jar, occurredOn: "2026-10-02", amount: "250", note: null },
    });
    assert.deepEqual(await sides(), { Wallet: [["out", "250", jar]], "Coin jar": [["in", "250", wallet1]] });
    await apply({
      kind: "updateTransaction", transactionId,
      transaction: { kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-02", amount: "250", note: null },
    });
    assert.deepEqual(await sides(), { Wallet: [["purchase"]], "Coin jar": [] }, "a transfer edited into a purchase leaves the other side");
    const { transactionId: second } = await apply({
      kind: "addTransaction", accountId: jar,
      transaction: { kind: "transfer", direction: "out", counterpartAccountId: wallet1, occurredOn: "2026-10-03", amount: "10", note: null },
    });
    await apply({ kind: "deleteTransaction", transactionId: second });
    assert.deepEqual(await sides(), { Wallet: [["purchase"]], "Coin jar": [] });
  });
});

test("only purchases are spending; receipts and transfers never are", async () => {
  await withManualStore(async (store, apply) => {
    const { assetId: a } = await apply(wallet("Wallet"));
    const { assetId: b } = await apply(wallet("Jar"));
    const add = (transaction: object) => apply({ kind: "addTransaction", accountId: a, transaction });
    await add({ kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-02", amount: "120", note: "Lunch" });
    await add({ kind: "purchase", personalCategory: null, occurredOn: "2026-10-03", amount: "35.5", note: null });
    await add({ kind: "receipt", occurredOn: "2026-10-04", amount: "500", note: "Gift" });
    await add({ kind: "transfer", direction: "out", counterpartAccountId: b, occurredOn: "2026-10-05", amount: "50", note: null });
    assert.deepEqual((await readManualSpendingPurchases(store)).map((row) => [row.occurredOn, row.amount, row.currency, row.personalCategory, row.accountName]), [
      ["2026-10-03", "35.5", "TWD", null, "Wallet"],
      ["2026-10-02", "120", "TWD", "dining", "Wallet"],
    ]);
  });
});

test("ending keeps history, deleting removes it, and every write advances the revision", async () => {
  await withManualStore(async (store, apply) => {
    const revisions: number[] = [await readManualAssetRevision(store)];
    const { assetId } = await apply(house);
    revisions.push(await readManualAssetRevision(store));
    await apply({ kind: "endAsset", assetId, endedOn: "2026-09-01" });
    revisions.push(await readManualAssetRevision(store));
    assert.equal((await readManualAssets(store))[0]!.asset.endedOn, "2026-09-01");
    assert.equal((await readManualAssets(store))[0]!.valuations.length, 1, "ending keeps the valuation history");
    await apply({ kind: "deleteAsset", assetId });
    revisions.push(await readManualAssetRevision(store));
    assert.deepEqual(await readManualAssets(store), []);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM manual_valuations")).rows[0]!.count, 0);
    await apply(wallet());
    await apply(house);
    await apply({ kind: "deleteAllManualAssets" });
    revisions.push(await readManualAssetRevision(store));
    assert.deepEqual(await readManualAssets(store), []);
    assert.deepEqual(revisions, [0, 1, 2, 3, 6]);
  });
});

test("a stale valuation is one at least the category's freshness period old; a count never goes stale", () => {
  assert.equal(manualValuationStale("vehicle", "2026-04-15", "2026-10-14"), false);
  assert.equal(manualValuationStale("vehicle", "2026-04-15", "2026-10-15"), true);
  assert.equal(manualValuationStale("house", "2025-11-01", "2026-10-31"), false);
  assert.equal(manualValuationStale("house", "2025-11-01", "2026-11-01"), true);
  assert.equal(manualValuationStale("cash", "2020-01-01", "2026-11-01"), false);
});

test("a Canonical Reset empties collected data and keeps every Manual Asset", async () => {
  const database = await createTestPGlite("ledger+operational");
  await withManualStore(async (store, apply) => {
    await commitCathay(store);
    const { assetId } = await apply(wallet());
    await apply({ kind: "addTransaction", accountId: assetId, transaction: { kind: "receipt", occurredOn: "2026-10-02", amount: "5", note: null } });
    const before = await readManualAssets(store);
    const revision = await readManualAssetRevision(store);
    await resetPGliteCanonicalStore(store);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts")).rows[0]!.count, 0);
    assert.deepEqual(await readManualAssets(store), before);
    assert.equal(await readManualAssetRevision(store), revision);
  }, database);
});

test("the manual schema refuses a changed migration and tables without a record", async () => {
  const store = new PGliteStore(await PGlite.create());
  try {
    await store.exec("CREATE TABLE manual_assets (asset_id TEXT)");
    await assert.rejects(applyPgliteManualAssetsSchema(store), /exist without a migration record/u);
  } finally {
    await store.close();
  }
});
