import assert from "node:assert/strict";
import test from "node:test";
import {
  createSpendingManualPairingIndex,
  rankSpendingManualPaymentCandidates,
  spendingManualPaymentRanking,
} from "./spending-manual-pairing.ts";
import type {
  SpendingMatchingInvoice,
  SpendingMatchingTransaction,
} from "../../lib/spending/purchase-matching.ts";
import { SpendingPairingIndexCache } from "./spending-pairing-index.ts";

const invoice = (date = "2026-09-01"): SpendingMatchingInvoice => ({
  revision: {
    seller: { name: "Shop" },
    occurrence: { value: date },
    total: { coefficient: "1000", scale: 0, currency: "TWD" },
  },
});

const transaction = (
  id: string,
  coefficient: string,
  currency = "TWD",
  date = "2026-09-01",
  description = "Shop",
): SpendingMatchingTransaction => ({
  transactionId: id,
  effectiveOn: date,
  consumeDate: null,
  postingDate: null,
  description,
  amount: { coefficient, scale: 0, currency },
});

test("indexed manual ranking preserves the complete deterministic ordering", () => {
  const transactions = [
    transaction("different-currency", "1000", "USD"),
    transaction("same-currency", "1010"),
    transaction("exact-later", "1000", "TWD", "2026-09-08", "Other"),
    transaction("exact", "1000"),
  ];
  const expected = rankSpendingManualPaymentCandidates(invoice(), transactions);
  const index = createSpendingManualPairingIndex(7, transactions);
  const actual = rankSpendingManualPaymentCandidates(invoice(), index);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.map((candidate) => candidate.transactionId), [
    "exact",
    "exact-later",
    "same-currency",
    "different-currency",
  ]);
});

test("pairing index cache treats the immutable data version as its invalidation boundary", () => {
  const cache = new SpendingPairingIndexCache();
  const firstTransactions = [transaction("tx", "1000")];
  const first = cache.get(9, firstTransactions);
  assert.equal(first.reused, false);
  assert.equal(cache.get(9, firstTransactions).reused, true);
  assert.equal(cache.get(10, firstTransactions).reused, false);
  assert.equal(cache.currentVersion, 10);
  assert.equal(cache.get(10, [transaction("tx", "1010")]).reused, true);
});

test("pairing index prewarm deduplicates the current version and invalidates on change", () => {
  const cache = new SpendingPairingIndexCache();
  const firstTransactions = [transaction("tx", "1000")];
  const first = cache.prewarm(12, firstTransactions);
  const duplicate = cache.prewarm(12, [transaction("tx", "1010")]);
  assert.equal(first.reused, false);
  assert.equal(duplicate.reused, true);
  assert.strictEqual(duplicate.index, first.index);
  const refreshed = cache.prewarm(13, [transaction("tx", "1010")]);
  assert.equal(refreshed.reused, false);
  assert.notStrictEqual(refreshed.index, first.index);
  assert.equal(cache.currentVersion, 13);
});

test("indexed rank results are cached per invoice within a data version", () => {
  const index = createSpendingManualPairingIndex(11, [transaction("tx", "1000")]);
  const first = rankSpendingManualPaymentCandidates(invoice(), index);
  const second = rankSpendingManualPaymentCandidates(invoice(), index);
  assert.strictEqual(second, first);
});

test("ranking pages and lookups match the complete unindexed order", () => {
  const transactions = Array.from({ length: 60 }, (_, index) => transaction(
    `tx-${String(index).padStart(2, "0")}`,
    String(990 + (index % 7) * 5),
    index % 11 === 0 ? "USD" : "TWD",
    `2026-09-${String(1 + (index % 9)).padStart(2, "0")}`,
    index % 3 === 0 ? "Shop Taipei" : `Other ${index}`,
  ));
  const expected = rankSpendingManualPaymentCandidates(invoice("2026-09-04"), transactions);
  const ranking = spendingManualPaymentRanking(invoice("2026-09-04"), createSpendingManualPairingIndex(9, transactions));
  assert.equal(ranking.total, expected.length);
  for (const [offset, limit] of [[0, 7], [5, 13], [20, 50], [58, 10], [60, 5]] as const)
    assert.deepEqual(ranking.page(offset, limit), expected.slice(offset, offset + limit), `page ${offset}+${limit}`);
  for (const candidate of [expected[0]!, expected[33]!, expected.at(-1)!])
    assert.deepEqual(ranking.find(candidate.transactionId), candidate);
  assert.equal(ranking.find("missing"), undefined);
  assert.deepEqual(ranking.all(), expected);
});
