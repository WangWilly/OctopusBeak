import assert from "node:assert/strict";
import test from "node:test";
import {
  createSpendingPairingCandidateView,
  type SpendingPairingCandidateView,
} from "./pairing-presentation.ts";

const transaction = {
  transactionId: "tx-1",
  effectiveOn: "2026-09-01",
  consumeDate: "2026-09-01",
  postingDate: null,
  description: "Coffee shop",
  amount: { coefficient: "120", scale: 0, currency: "TWD" },
  stream: "bank" as const,
  effectiveDateBasis: "consume-date" as const,
};

const record = {
  purchaseId: "transaction:tx-1",
  basis: "bank-transaction" as const,
  amount: transaction.amount,
  occurrence: {
    value: "2026-09-01",
    precision: "date" as const,
    timeZone: "Asia/Taipei",
    basis: "purchase-date" as const,
  },
  description: transaction.description,
  invoice: null,
  transaction,
  items: [],
  possibleDuplicate: false,
  candidateIds: [],
  link: null,
  difference: null,
  refund: null,
};

test("pairing presentation preserves the worker-owned transaction view", () => {
  const candidate: SpendingPairingCandidateView = createSpendingPairingCandidateView(record);
  assert.deepEqual(candidate, {
    purchaseId: "transaction:tx-1",
    transactionId: "tx-1",
    description: "Coffee shop",
    amount: transaction.amount,
    occurrence: record.occurrence,
    stream: "bank",
    effectiveDateBasis: "consume-date",
  });
});

test("pairing presentation rejects records that cannot be selected", () => {
  assert.throws(
    () => createSpendingPairingCandidateView({ ...record, basis: "invoice", transaction: null }),
    /unlinked bank transactions/,
  );
});
