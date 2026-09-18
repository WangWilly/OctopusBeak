import assert from "node:assert/strict";
import test from "node:test";
import { isCanonicalSpendingTransactionKindIncluded } from "./spending-inclusion-policy.ts";

test("canonical Spending kind inclusion keeps the exclusion boundary stable", () => {
  for (const kind of [
    "transfer",
    "transfer.internal",
    "cash",
    "cash.withdrawal",
    "investment",
    "investment.purchase",
    "payment.credit_card",
    "payment.credit_card.autopay",
    "payment.loan",
    "payment.loan.principal",
  ]) {
    assert.equal(isCanonicalSpendingTransactionKindIncluded(kind), false, kind);
  }

  for (const kind of [
    "purchase",
    "purchase.food",
    "cashback",
    "transferable",
    "payment",
    "payment.credit_cardinality",
    "payment.loans",
  ]) {
    assert.equal(isCanonicalSpendingTransactionKindIncluded(kind), true, kind);
  }
});
