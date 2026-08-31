import assert from "node:assert/strict";
import test from "node:test";
import {
  LOAN_CONTRACT_FIXTURES,
  admitCanonicalLoanCapture,
  commitCanonicalLoanCapture,
  createCanonicalLoanStore,
  queryCanonicalLoanCurrent,
  queryCanonicalLoanHistorical,
  queryCanonicalLoanLineage,
} from "./loan-financial.ts";

test("loan canonical writer preserves source-scoped accounts and exact facts", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const fubon = await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    const yuanta = await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.yuanta),
    );

    assert.equal(fubon.transactionCount, 2);
    assert.equal(fubon.balanceObservationCount, 1);
    assert.equal(fubon.relationCount, 1);
    assert.equal(yuanta.transactionCount, 2);

    const current = queryCanonicalLoanCurrent(store);
    assert.equal(current.accounts.length, 2);
    assert.notEqual(current.accounts[0]?.id, current.accounts[1]?.id);
    assert.deepEqual(
      current.transactions.map((transaction) => [transaction.account.sourceId, transaction.direction, transaction.amount]),
      [
        ["fubon", "outflow", { coefficient: "100000", scale: 2 }],
        ["fubon", "inflow", { coefficient: "12500", scale: 2 }],
        ["yuanta", "outflow", { coefficient: "100000", scale: 2 }],
        ["yuanta", "inflow", { coefficient: "12500", scale: 2 }],
      ],
    );
    assert.equal(current.balanceObservations.length, 2);
    assert.equal(current.balanceObservations[0]?.balanceKind, "loan_outstanding");
    assert.equal(current.relations.length, 2);
    assert.equal(current.relations[0]?.evidence.kind, "explicit-source-linkage");

    const historical = queryCanonicalLoanHistorical(store, {
      knowledgeAt: fubon.commitSequence,
      financialAt: "2026-01-05",
    });
    assert.equal(historical.accounts.length, 1);
    assert.equal(historical.transactions.length, 1);
    assert.equal(historical.transactions[0]?.direction, "outflow");
    assert.equal(historical.balanceObservations.length, 0);
    assert.equal(historical.relations.length, 1);

    const beforeDisbursement = queryCanonicalLoanHistorical(store, {
      knowledgeAt: fubon.commitSequence,
      financialAt: "2026-01-04",
    });
    assert.equal(beforeDisbursement.transactions.length, 0);
    assert.equal(beforeDisbursement.relations.length, 0);

    const lineage = queryCanonicalLoanLineage(store, {
      sourceId: "fubon",
      sourceRecordKey: LOAN_CONTRACT_FIXTURES.fubon.records[0]!.sourceRecordKey,
    });
    assert.equal(lineage.transactions.length, 1);
    assert.equal(lineage.lineage.length, 1);
    assert.equal(lineage.lineage[0]?.payload.eventKind, "disbursement");
  } finally {
    store.close();
  }
});
