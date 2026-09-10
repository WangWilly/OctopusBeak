import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateCanonicalByMonth,
  canonicalSpendingCategoryMatches,
  scopeCanonicalSpendingView,
} from "./canonical-view.ts";
import type {
  CanonicalSpendingAmountDto,
  CanonicalSpendingRecordDto,
  CanonicalSpendingView,
} from "./model.ts";

function amount(coefficient: string, currency = "TWD"): CanonicalSpendingAmountDto {
  return {
    currency,
    exact: { coefficient, scale: 0 },
    value: Number(coefficient),
  };
}

const labels = (en: string, zhHant: string) => ({ en, zhHant });

function record(
  transactionId: string,
  date: string,
  value: CanonicalSpendingAmountDto,
  category: CanonicalSpendingRecordDto["category"],
  inclusion: CanonicalSpendingRecordDto["inclusion"],
): CanonicalSpendingRecordDto {
  return {
    transactionId,
    accountId: `account-${transactionId}`,
    accountNumber: "SYNTHETIC-001",
    sourceConnectionKey: "synthetic-spending",
    integrationNamespace: "test",
    stream: "domestic-deposit",
    date,
    description: `Synthetic ${transactionId}`,
    amount: value,
    kind: inclusion === "eligibility-gap" ? null : "purchase",
    category,
    display: { label: `Synthetic ${transactionId}`, status: "fallback", origin: "source", kind: "source_description" },
    tags: [],
    inclusion,
    eligibilityGap: inclusion === "eligibility-gap" ? "missing-report-inclusion-semantics" : null,
  };
}

const singleDining = {
  mode: "single" as const,
  code: "dining",
  taxonomyId: "transaction-taxonomy",
  taxonomyVersion: "v1",
  labels: labels("Dining", "餐飲"),
  components: [],
};
const allocated = {
  mode: "allocated" as const,
  code: null,
  taxonomyId: "transaction-taxonomy",
  taxonomyVersion: "v1",
  labels: null,
  components: [
    { code: "food_and_groceries", taxonomyId: "transaction-taxonomy", taxonomyVersion: "v1", labels: labels("Food and groceries", "食品雜貨"), amount: amount("125") },
    { code: "transportation", taxonomyId: "transaction-taxonomy", taxonomyVersion: "v1", labels: labels("Transportation", "交通"), amount: amount("175") },
  ],
};
const absent = { mode: "absent" as const, code: null, taxonomyId: null, taxonomyVersion: null, labels: null, components: [] };
const fixtureRecords = [
  record("single", "2026-07-01", amount("120"), singleDining, "included"),
  record("allocated", "2026-07-02", amount("300"), allocated, "included"),
  record("unclassified", "2026-07-03", amount("80"), absent, "included"),
  record("gap", "2026-07-04", amount("700"), absent, "eligibility-gap"),
  record("excluded", "2026-07-05", amount("999"), absent, "excluded"),
  record("next-month", "2026-08-01", amount("50"), singleDining, "included"),
  record("next-gap", "2026-08-02", amount("10"), absent, "eligibility-gap"),
];

const fixture: CanonicalSpendingView = {
  availability: "available",
  policy: { id: "gross-posted-outflow", version: "v1", name: "Gross posted outflow" },
  knowledgePoint: 7,
  selectedMonth: "2026-07",
  selectedCategory: null,
  transactions: fixtureRecords,
  includedTransactions: fixtureRecords.filter((value) => value.inclusion === "included"),
  totalsByCurrency: [amount("550")],
  categoryTotalsByCurrency: [],
  unclassifiedByCurrency: [amount("80")],
  classificationCoverage: {
    includedCount: 4,
    classifiedCount: 3,
    unclassifiedCount: 1,
    includedAmountByCurrency: [amount("550")],
    classifiedAmountByCurrency: [amount("470")],
    unclassifiedAmountByCurrency: [amount("80")],
  },
  reportEligibility: { status: "incomplete", gapCount: 2, gapAmountByCurrency: [amount("710")] },
  totalStatus: "incomplete",
};

test("canonical Spending period view scopes exact totals and excludes gaps from Unclassified", () => {
  const july = scopeCanonicalSpendingView(fixture, "2026-07");
  assert.deepEqual(july.totalsByCurrency.map((value) => value.exact), [{ coefficient: "500", scale: 0 }]);
  assert.deepEqual(july.categoryTotalsByCurrency.map((value) => [value.categoryCode, value.amount.exact]), [
    ["dining", { coefficient: "120", scale: 0 }],
    ["food_and_groceries", { coefficient: "125", scale: 0 }],
    ["transportation", { coefficient: "175", scale: 0 }],
  ]);
  assert.deepEqual(july.unclassifiedByCurrency.map((value) => value.exact), [{ coefficient: "80", scale: 0 }]);
  assert.equal(july.classificationCoverage.includedCount, 3);
  assert.equal(july.classificationCoverage.classifiedCount, 2);
  assert.equal(july.classificationCoverage.unclassifiedCount, 1);
  assert.equal(july.reportEligibility.gapCount, 1);
  assert.deepEqual(july.reportEligibility.gapAmountByCurrency.map((value) => value.exact), [{ coefficient: "700", scale: 0 }]);
  assert.equal(july.totalStatus, "incomplete");
  assert.equal(canonicalSpendingCategoryMatches(fixtureRecords[2]!, "__unclassified"), true);
  assert.equal(canonicalSpendingCategoryMatches(fixtureRecords[3]!, "__unclassified"), false);
  assert.deepEqual(aggregateCanonicalByMonth(fixture.includedTransactions).map((value) => [value.month, value.amount.exact]), [
    ["2026-07", { coefficient: "500", scale: 0 }],
    ["2026-08", { coefficient: "50", scale: 0 }],
  ]);
});
