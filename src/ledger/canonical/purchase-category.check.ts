import assert from "node:assert/strict";
import test from "node:test";
import {
  purchaseCategoryCodes,
  readPurchaseCategory,
  type PurchaseCategoryInput,
  type PurchaseCategoryItem,
  type PurchaseItemCategorization,
} from "./purchase-category.ts";
import type { CanonicalSpendingCategorization } from "./canonical-spending-contracts.ts";

const twd = (coefficient: string, scale = 0) => ({ coefficient, scale, currency: "TWD" });

function item(sequence: number, amount: string | null, completeness: "complete" | "incomplete" = "complete"): PurchaseCategoryItem {
  return { sequence, completeness, amount: amount === null ? null : twd(amount) };
}

function categorized(sequence: number, categoryCode: string, origin: "user" | "derived" = "derived"): PurchaseItemCategorization {
  return { sequence, origin, categoryCode, taxonomyId: "transaction-taxonomy", taxonomyVersion: "v1", assertionId: `assertion-${sequence}-${origin}` };
}

function single(categoryCode: string, origin: "user" | "source" | "derived"): CanonicalSpendingCategorization {
  return { mode: "single", origin, assertionId: `tx-${categoryCode}`, categoryCode, taxonomyId: "transaction-taxonomy", taxonomyVersion: "v1" };
}

function allocated(parts: readonly [string, string][]): CanonicalSpendingCategorization {
  return {
    mode: "allocated",
    origin: "user",
    assertionId: "tx-allocation",
    components: parts.map(([categoryCode, coefficient]) => ({
      categoryCode, origin: "user" as const, assertionId: "tx-allocation",
      provenance: { projectionCommitId: null, projectionCommitSequence: 1 },
      taxonomyId: "transaction-taxonomy", taxonomyVersion: "v1", coefficient, scale: 0, currency: "TWD",
    })),
  };
}

const absent: CanonicalSpendingCategorization = { mode: "absent" };

function invoiceOnly(items: readonly PurchaseCategoryItem[], categorizations: readonly PurchaseItemCategorization[], total: string | null = "auto"): PurchaseCategoryInput {
  const sum = items.reduce((value, entry) => value + BigInt(entry.amount?.coefficient ?? "0"), 0n).toString();
  const invoiceTotal = total === "auto" ? twd(sum) : total === null ? null : twd(total);
  return { basis: "invoice", countedAmount: invoiceTotal, transaction: null, invoice: { total: invoiceTotal, items }, itemCategorizations: categorizations };
}

function linked(input: Readonly<{
  bankAmount: string;
  categorization: CanonicalSpendingCategorization;
  items: readonly PurchaseCategoryItem[];
  categorizations: readonly PurchaseItemCategorization[];
}>): PurchaseCategoryInput {
  const total = input.items.reduce((value, entry) => value + BigInt(entry.amount?.coefficient ?? "0"), 0n).toString();
  return {
    basis: "linked",
    countedAmount: twd(input.bankAmount),
    transaction: { categorization: input.categorization },
    invoice: { total: twd(total), items: input.items },
    itemCategorizations: input.categorizations,
  };
}

test("a bank-only purchase reads the transaction's Current Categorization", () => {
  const user = readPurchaseCategory({ basis: "bank-transaction", countedAmount: twd("100"), transaction: { categorization: single("dining", "user") }, invoice: null, itemCategorizations: [] });
  assert.deepEqual(user, { mode: "single", origin: "user", subject: "transaction", categoryCode: "dining", labels: { en: "Dining", zhHant: "餐飲" }, taxonomyId: "transaction-taxonomy", taxonomyVersion: "v1" });
  const derived = readPurchaseCategory({ basis: "bank-transaction", countedAmount: twd("100"), transaction: { categorization: single("transportation", "derived") }, invoice: null, itemCategorizations: [] });
  assert.equal(derived.mode === "single" && derived.origin, "derived");
  const split = readPurchaseCategory({ basis: "bank-transaction", countedAmount: twd("100"), transaction: { categorization: allocated([["dining", "60"], ["healthcare", "40"]]) }, invoice: null, itemCategorizations: [] });
  assert.equal(split.mode, "split");
  assert.deepEqual(purchaseCategoryCodes(split), ["dining", "healthcare"]);
  assert.deepEqual(readPurchaseCategory({ basis: "bank-transaction", countedAmount: twd("100"), transaction: { categorization: absent }, invoice: null, itemCategorizations: [] }), { mode: "absent" });
  assert.deepEqual(readPurchaseCategory({ basis: "refund", countedAmount: twd("100"), transaction: { categorization: single("dining", "user") }, invoice: null, itemCategorizations: [] }), { mode: "absent" });
});

test("invoice-only: one code when every non-negative item agrees, including incomplete items", () => {
  const agreed = readPurchaseCategory(invoiceOnly(
    [item(1, "60"), item(2, "40"), item(3, null, "incomplete")],
    [categorized(1, "dining"), categorized(2, "dining"), categorized(3, "dining")],
    "100",
  ));
  assert.equal(agreed.mode === "single" && agreed.categoryCode, "dining");
  assert.equal(agreed.mode === "single" && agreed.subject, "items");
  assert.equal(agreed.mode === "single" && agreed.origin, "derived");

  const incompleteUncategorized = readPurchaseCategory(invoiceOnly(
    [item(1, "60"), item(2, null, "incomplete")],
    [categorized(1, "dining")],
    "100",
  ));
  assert.deepEqual(incompleteUncategorized, { mode: "absent" }, "an uncategorized non-negative item blocks the single code and an incomplete item blocks a split");

  const userTouched = readPurchaseCategory(invoiceOnly([item(1, "60"), item(2, "40")], [categorized(1, "dining", "user"), categorized(2, "dining")]));
  assert.equal(userTouched.mode === "single" && userTouched.origin, "user");
});

test("invoice-only: negative lines never block a single code and net into a split", () => {
  const discounted = readPurchaseCategory(invoiceOnly(
    [item(1, "120"), item(2, "-20")],
    [categorized(1, "dining")],
    "100",
  ));
  assert.equal(discounted.mode === "single" && discounted.categoryCode, "dining", "an uncategorized discount line does not block");

  const netted = readPurchaseCategory(invoiceOnly(
    [item(1, "120"), item(2, "50"), item(3, "-20")],
    [categorized(1, "dining"), categorized(2, "healthcare"), categorized(3, "dining")],
    "150",
  ));
  assert.equal(netted.mode, "split");
  assert.deepEqual(netted.mode === "split" && netted.components.map((component) => [component.categoryCode, component.amount.coefficient]), [["dining", "100"], ["healthcare", "50"]]);

  const negativeNet = readPurchaseCategory(invoiceOnly(
    [item(1, "10"), item(2, "150"), item(3, "-20")],
    [categorized(1, "dining"), categorized(2, "healthcare"), categorized(3, "dining")],
    "140",
  ));
  assert.deepEqual(negativeNet, { mode: "absent" }, "a code whose net is negative blocks the split");
});

test("invoice-only: an exact split needs complete categorized items that sum to the total", () => {
  const exact = readPurchaseCategory(invoiceOnly([item(1, "60"), item(2, "40")], [categorized(1, "dining"), categorized(2, "healthcare")]));
  assert.deepEqual(exact.mode === "split" && exact.components.map((component) => [component.categoryCode, component.amount.coefficient, component.amount.currency]), [["dining", "60", "TWD"], ["healthcare", "40", "TWD"]]);
  assert.deepEqual(purchaseCategoryCodes(exact), ["dining", "healthcare"]);

  const mismatch = readPurchaseCategory(invoiceOnly([item(1, "60"), item(2, "40")], [categorized(1, "dining"), categorized(2, "healthcare")], "110"));
  assert.deepEqual(mismatch, { mode: "absent" }, "items that do not sum to the invoice total are Unclassified");

  const partiallyCategorized = readPurchaseCategory(invoiceOnly([item(1, "60"), item(2, "40")], [categorized(1, "dining")]));
  assert.deepEqual(partiallyCategorized, { mode: "absent" });

  assert.deepEqual(readPurchaseCategory(invoiceOnly([], [])), { mode: "absent" }, "zero items");
  assert.deepEqual(readPurchaseCategory(invoiceOnly([item(1, "-20")], [categorized(1, "dining")], "-20")), { mode: "absent" }, "only negative lines");
  const scaled = readPurchaseCategory({ basis: "invoice", countedAmount: twd("1000", 1), transaction: null, invoice: { total: twd("1000", 1), items: [item(1, "60"), item(2, "40")] }, itemCategorizations: [categorized(1, "dining"), categorized(2, "healthcare")] });
  assert.equal(scaled.mode, "split", "exact reconciliation compares values, not scales");
});

test("linked: user before automatic, then transaction before items", () => {
  const items = [item(1, "60"), item(2, "40")];
  const userItems = [categorized(1, "healthcare", "user"), categorized(2, "healthcare", "user")];
  const derivedItems = [categorized(1, "dining"), categorized(2, "dining")];

  const userTransaction = readPurchaseCategory(linked({ bankAmount: "100", categorization: single("travel", "user"), items, categorizations: userItems }));
  assert.deepEqual([userTransaction.mode === "single" && userTransaction.categoryCode, userTransaction.mode === "single" && userTransaction.subject], ["travel", "transaction"]);

  const userItemsOverDerivedTransaction = readPurchaseCategory(linked({ bankAmount: "100", categorization: single("travel", "derived"), items, categorizations: userItems }));
  assert.deepEqual([userItemsOverDerivedTransaction.mode === "single" && userItemsOverDerivedTransaction.categoryCode, userItemsOverDerivedTransaction.mode === "single" && userItemsOverDerivedTransaction.subject], ["healthcare", "items"]);

  const derivedTransactionOverDerivedItems = readPurchaseCategory(linked({ bankAmount: "100", categorization: single("travel", "source"), items, categorizations: derivedItems }));
  assert.equal(derivedTransactionOverDerivedItems.mode === "single" && derivedTransactionOverDerivedItems.categoryCode, "travel");

  const derivedItemsLast = readPurchaseCategory(linked({ bankAmount: "100", categorization: absent, items, categorizations: derivedItems }));
  assert.equal(derivedItemsLast.mode === "single" && derivedItemsLast.categoryCode, "dining");

  assert.deepEqual(readPurchaseCategory(linked({ bankAmount: "100", categorization: absent, items, categorizations: [] })), { mode: "absent" });
});

test("linked: a single item code covers the counted bank amount, a split only when items reconcile to it", () => {
  const items = [item(1, "60"), item(2, "40")];
  const agreed = readPurchaseCategory(linked({ bankAmount: "103", categorization: absent, items, categorizations: [categorized(1, "dining"), categorized(2, "dining")] }));
  assert.equal(agreed.mode === "single" && agreed.categoryCode, "dining", "a tipped payment still takes the agreed code");

  const reconciled = readPurchaseCategory(linked({ bankAmount: "100", categorization: absent, items, categorizations: [categorized(1, "dining"), categorized(2, "healthcare")] }));
  assert.equal(reconciled.mode, "split");

  const tipped = readPurchaseCategory(linked({ bankAmount: "103", categorization: absent, items, categorizations: [categorized(1, "dining"), categorized(2, "healthcare")] }));
  assert.deepEqual(tipped, { mode: "absent" }, "mixed items that do not reconcile to the bank amount never split");

  const foreign = readPurchaseCategory({
    basis: "linked",
    countedAmount: { coefficient: "320", scale: 2, currency: "USD" },
    transaction: { categorization: absent },
    invoice: { total: twd("100"), items },
    itemCategorizations: [categorized(1, "dining"), categorized(2, "healthcare")],
  });
  assert.deepEqual(foreign, { mode: "absent" }, "a foreign-currency payment never splits");

  const userSplitFallsThrough = readPurchaseCategory(linked({ bankAmount: "103", categorization: single("travel", "derived"), items, categorizations: [categorized(1, "dining", "user"), categorized(2, "healthcare", "user")] }));
  assert.equal(userSplitFallsThrough.mode === "single" && userSplitFallsThrough.categoryCode, "travel", "an unreconciled user split yields to the automatic transaction category");
});
