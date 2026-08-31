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
import { createCanonicalSourceStore } from "./canonical-source-store.ts";

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
    assert.equal(current.accounts[0]?.accountKey, LOAN_CONTRACT_FIXTURES.fubon.identity.accountKey);
    assert.notEqual(
      current.accounts[0]?.accountKey,
      LOAN_CONTRACT_FIXTURES.fubon.identity.accountNo,
    );
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
    assert.notEqual(current.relations[0]?.fromTransactionId, null);
    assert.notEqual(current.relations[0]?.toTransactionId, null);
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              `SELECT COUNT(*) AS count FROM financial_transactions
               WHERE account_id IN (
                 SELECT account_id FROM financial_accounts WHERE account_type = 'depository'
               )`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      2,
    );

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

test("loan historical queries require both cutoffs", () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    assert.throws(
      () => queryCanonicalLoanHistorical(store, {} as never),
      /both.*financial|cutoff/i,
    );
  } finally {
    store.close();
  }
});

test("loan queries fail closed without creating an uninitialized extension schema", () => {
  const sourceStore = createCanonicalSourceStore(":memory:");
  try {
    assert.throws(
      () => queryCanonicalLoanCurrent(sourceStore),
      /initialized loan schema/i,
    );
    assert.equal(
      Number(
        (
          sourceStore.db
            .prepare(
              `SELECT COUNT(*) AS count FROM sqlite_master
               WHERE type = 'table' AND name IN (
                 'loan_account_identities', 'loan_transaction_facts',
                 'balance_observations', 'balance_observation_revisions',
                 'transaction_relations'
               )`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      0,
    );
  } finally {
    sourceStore.close();
  }
});

test("loan event facts remain queryable from typed facts, not source payload JSON", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    store.db
      .prepare(
        `UPDATE source_records SET payload_json = ?
         WHERE occurrence_key = ?`,
      )
      .run(
        JSON.stringify({ eventKind: "fee", direction: "inflow" }),
        LOAN_CONTRACT_FIXTURES.fubon.records[0]!.sourceRecordKey,
      );
    const current = queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
    assert.equal(current.transactions[0]?.eventKind, "disbursement");
    assert.equal(current.transactions[0]?.direction, "outflow");
  } finally {
    store.close();
  }
});

test("loan balance corrections require explicit correction evidence and preserve observations", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    const changed = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
    changed.captureId = "sha256:fubon-balance-correction-capture";
    changed.observedAt = "2026-02-03T02:00:00.000Z";
    changed.counterpartTransactions = changed.counterpartTransactions.map((counterpart) => ({
      ...counterpart,
      captureId: "sha256:fubon-balance-correction-counterpart",
    }));
    changed.balanceObservations = changed.balanceObservations.map((observation) => ({
      ...observation,
      balance: { coefficient: "87000", scale: 2 },
    }));
    const admittedChanged = admitCanonicalLoanCapture(structuredClone(changed));
    await assert.rejects(
      () => commitCanonicalLoanCapture(store, admittedChanged),
      /changed loan balance|correction/i,
    );
    changed.balanceObservations = changed.balanceObservations.map((observation) => ({
      ...observation,
      correctionEvidence: {
        kind: "source-correction",
        sourceRecordKey: observation.sourceRecordKey,
        observationKey: observation.observationKey,
        contractVersion: changed.contractVersion,
      },
    }));
    changed.balanceObservations = [
      ...changed.balanceObservations,
      {
        observationKey: "sha256:fubon-independent-principal-observation",
        sourceRecordKey: changed.records[1]!.sourceRecordKey,
        balanceKind: "outstanding_principal",
        balance: { coefficient: "85000", scale: 2 },
        currency: "TWD",
        effectiveAt: "2026-01-31T23:59:59+08:00",
        effectiveTimeBasis: "source-reported",
        effectiveTimeRuleVersion: changed.contractVersion,
        effectiveTimeEvidence: {
          kind: "source-reported-balance-effective-time",
          sourceRecordKey: changed.records[1]!.sourceRecordKey,
          sourceField: "statement-as-of",
          value: "2026-01-31T23:59:59+08:00",
          contractVersion: changed.contractVersion,
        },
      },
    ];
    await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(changed),
    );
    assert.deepEqual(
      queryCanonicalLoanCurrent(store, { sourceId: "fubon" }).balanceObservations.find(
        (observation) =>
          observation.observationKey === changed.balanceObservations[0]!.observationKey,
      )?.balance,
      {
        coefficient: "87000",
        scale: 2,
      },
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              `SELECT COUNT(*) AS count FROM balance_observations
               WHERE account_id IN (
                 SELECT account_id FROM financial_accounts
                 WHERE account_type = 'loan' AND stream = 'loan'
               )`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      2,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              `SELECT COUNT(*) AS count FROM balance_observation_revisions
               WHERE observation_id IN (SELECT observation_id FROM balance_observations)`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      3,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              `SELECT COUNT(*) AS count FROM transaction_relations
               WHERE account_id IN (
                 SELECT account_id FROM financial_accounts
                 WHERE account_type = 'loan' AND stream = 'loan'
               )`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
  } finally {
    store.close();
  }
});
