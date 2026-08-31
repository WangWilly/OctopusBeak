import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import {
  CANONICAL_SQLITE_FILE,
  createCanonicalSourceStore,
  rebuildCanonicalProjection,
  validateCanonicalSourceStore,
} from "./canonical-source-store.ts";

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
    assert.equal(
      current.accounts[0]?.accountKey,
      LOAN_CONTRACT_FIXTURES.fubon.identity.accountKey,
    );
    assert.notEqual(
      current.accounts[0]?.accountKey,
      LOAN_CONTRACT_FIXTURES.fubon.identity.accountNo,
    );
    assert.deepEqual(
      current.transactions.map((transaction) => [
        transaction.account.sourceId,
        transaction.direction,
        transaction.amount,
      ]),
      [
        ["fubon", "outflow", { coefficient: "100000", scale: 2 }],
        ["fubon", "inflow", { coefficient: "12500", scale: 2 }],
        ["yuanta", "outflow", { coefficient: "100000", scale: 2 }],
        ["yuanta", "inflow", { coefficient: "12500", scale: 2 }],
      ],
    );
    assert.equal(current.balanceObservations.length, 2);
    assert.equal(
      current.balanceObservations[0]?.balanceKind,
      "loan_outstanding",
    );
    assert.equal(current.relations.length, 2);
    assert.equal(
      current.relations[0]?.evidence.kind,
      "explicit-source-linkage",
    );
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

test("loan query uses the versioned canonical schema without runtime DDL", () => {
  const sourceStore = createCanonicalSourceStore(":memory:");
  try {
    const schemaBefore = sourceStore.db
      .prepare("SELECT name, sql FROM sqlite_master ORDER BY name")
      .all();
    assert.throws(
      () => queryCanonicalLoanCurrent(sourceStore),
      /current projection cutoff is missing/i,
    );
    assert.deepEqual(
      sourceStore.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
      schemaBefore,
    );
    assert.equal(
      Number(
        (
          sourceStore.db
            .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
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
    changed.counterpartTransactions = changed.counterpartTransactions.map(
      (counterpart) => ({
        ...counterpart,
        captureId: "sha256:fubon-balance-correction-counterpart",
      }),
    );
    changed.balanceObservations = changed.balanceObservations.map(
      (observation) => ({
        ...observation,
        sourceRecordKey: "sha256:fubon-balance-correction-record",
        balance: { coefficient: "87000", scale: 2 },
        effectiveTimeEvidence: {
          ...observation.effectiveTimeEvidence,
          sourceRecordKey: "sha256:fubon-balance-correction-record",
        },
      }),
    );
    changed.records = changed.records.map((record, index) =>
      index === 1
        ? {
            ...record,
            sourceRecordKey: "sha256:fubon-balance-correction-record",
            occurrenceIndex: 3,
            eventEvidence: {
              ...record.eventEvidence,
              sourceRecordKey: "sha256:fubon-balance-correction-record",
            },
            balanceSourceEvidence: record.balanceSourceEvidence?.map(
              (evidence) => ({
                ...evidence,
                balance: { coefficient: "87000", scale: 2 },
                correctionOfObservationKey:
                  changed.balanceObservations[0]!.observationKey,
              }),
            ),
          }
        : record,
    );
    assert.throws(
      () => admitCanonicalLoanCapture(structuredClone(changed)),
      /correction/i,
    );
    changed.balanceObservations = changed.balanceObservations.map(
      (observation) => ({
        ...observation,
        correctionEvidence: {
          kind: "source-correction",
          sourceRecordKey: observation.sourceRecordKey,
          observationKey: observation.observationKey,
          contractVersion: changed.contractVersion,
        },
      }),
    );
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(changed));
    assert.deepEqual(
      queryCanonicalLoanCurrent(store, {
        sourceId: "fubon",
      }).balanceObservations.find(
        (observation) =>
          observation.observationKey ===
          changed.balanceObservations[0]!.observationKey,
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
      1,
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
      2,
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

test("loan admission binds balance value, kind, and effective time to retained source evidence", () => {
  const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
  const observation = fixture.balanceObservations[0]!;
  for (const replacement of [
    { ...observation, balance: { coefficient: "1", scale: 2 } },
    { ...observation, balanceKind: "outstanding_principal" as const },
    {
      ...observation,
      effectiveAt: "2026-01-30T23:59:59+08:00",
      effectiveTimeEvidence: {
        ...observation.effectiveTimeEvidence,
        value: "2026-01-30T23:59:59+08:00",
      },
    },
  ]) {
    assert.throws(
      () =>
        admitCanonicalLoanCapture({
          ...structuredClone(fixture),
          balanceObservations: [replacement],
        }),
      /balance.*source|source.*balance|source field evidence/i,
    );
  }
});

test("loan relation endpoints must share source connection and identity epoch", () => {
  const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.yuanta);
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        counterpartTransactions: fixture.counterpartTransactions.map(
          (counterpart) => ({
            ...counterpart,
            sourceConnectionKey: "sha256:other-connection",
          }),
        ),
      }),
    /source connection|source scope/i,
  );
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        counterpartTransactions: fixture.counterpartTransactions.map(
          (counterpart) => ({
            ...counterpart,
            identityEpochKey: "sha256:other-epoch",
          }),
        ),
      }),
    /identity epoch|source scope/i,
  );
});

test("loan identity uses accountKey and current queries read projection selections", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(fixture));
    const persisted = store.db
      .prepare(
        `SELECT account.account_no AS spine_key, identity.account_key, identity.account_no,
                identity.created_commit_id
         FROM loan_account_identities identity
         JOIN financial_accounts account ON account.account_id = identity.account_id
         WHERE identity.account_type = 'loan'`,
      )
      .get() as Record<string, unknown>;
    assert.equal(persisted.spine_key, fixture.identity.accountKey);
    assert.equal(persisted.account_key, fixture.identity.accountKey);
    assert.equal(persisted.account_no, fixture.identity.accountNo);
    assert.ok(persisted.created_commit_id instanceof Uint8Array);

    store.db.exec("DELETE FROM current_transactions");
    assert.equal(
      queryCanonicalLoanCurrent(store, { sourceId: "fubon" }).transactions
        .length,
      2,
    );
    store.db.exec(
      "DELETE FROM current_loan_accounts; DELETE FROM current_loan_balance_observations; DELETE FROM current_loan_relations",
    );
    const current = queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
    assert.equal(current.accounts.length, 0);
    assert.equal(current.balanceObservations.length, 0);
    assert.equal(current.relations.length, 0);
    const historical = queryCanonicalLoanHistorical(store, {
      knowledgeAt: current.knowledgeAt,
      financialAt: "2026-01-31",
      sourceId: "fubon",
    });
    assert.equal(historical.balanceObservations.length, 1);
    assert.equal(historical.relations.length, 1);
  } finally {
    store.close();
  }
});

test("equal display account numbers do not merge different contract account keys", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const first = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(first));
    const second = structuredClone(first);
    second.captureId = "sha256:second-account-key-capture";
    second.identity = {
      ...second.identity,
      accountKey: "sha256:second-contract-account-key",
    };
    second.counterpartTransactions = second.counterpartTransactions.map(
      (counterpart) => ({
        ...counterpart,
        captureId: "sha256:second-account-key-counterpart",
      }),
    );
    second.relations = second.relations.map((relation) => ({
      ...relation,
      fromAccountKey: second.identity.accountKey,
    }));
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(second));
    const accounts = queryCanonicalLoanCurrent(store, {
      sourceId: "fubon",
    }).accounts;
    assert.equal(accounts.length, 2);
    assert.deepEqual(
      new Set(accounts.map((account) => account.accountNo)),
      new Set([first.identity.accountNo]),
    );
    assert.deepEqual(
      new Set(accounts.map((account) => account.accountKey)),
      new Set([first.identity.accountKey, second.identity.accountKey]),
    );
  } finally {
    store.close();
  }
});

test("independent balance measurements create observations while corrections create revisions", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const first = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(first));
    const second = structuredClone(first);
    second.captureId = "sha256:independent-balance-capture";
    second.observedAt = "2026-02-03T02:00:00.000Z";
    second.counterpartTransactions = second.counterpartTransactions.map(
      (counterpart) => ({
        ...counterpart,
        captureId: "sha256:independent-balance-counterpart",
      }),
    );
    second.relations = second.relations.map((relation) => ({
      ...relation,
      fromSourceRecordKey: relation.toSourceRecordKey,
      toSourceRecordKey: relation.fromSourceRecordKey,
      fromAccountKey: relation.toAccountKey,
      toAccountKey: relation.fromAccountKey,
      fromDirection: relation.toDirection,
      toDirection: relation.fromDirection,
    }));
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(second));
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM balance_observations")
            .get() as { count: number }
        ).count,
      ),
      2,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM balance_observation_revisions",
            )
            .get() as { count: number }
        ).count,
      ),
      2,
    );
  } finally {
    store.close();
  }
});

test("file-backed loan current projections survive rebuild and schema migration is stable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-loan-v9-"));
  const databasePath = join(directory, CANONICAL_SQLITE_FILE);
  try {
    const v9Seed = createCanonicalSourceStore(databasePath);
    v9Seed.close();
    const v8 = new DatabaseSync(databasePath);
    v8.exec(`PRAGMA foreign_keys = OFF;
      DROP TABLE current_loan_relations;
      DROP TABLE current_loan_balance_observations;
      DROP TABLE current_loan_accounts;
      DROP TABLE transaction_relation_provenance;
      DROP TABLE transaction_relations;
      DROP TABLE balance_observation_revisions;
      DROP TABLE balance_observations;
      DROP TABLE loan_transaction_facts;
      DROP TABLE loan_account_identities;
      DELETE FROM schema_migrations WHERE version = 9;
      PRAGMA user_version = 8;`);
    v8.close();

    const initial = createCanonicalLoanStore(databasePath);
    await commitCanonicalLoanCapture(
      initial,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    const before = queryCanonicalLoanCurrent(initial, { sourceId: "fubon" });
    assert.deepEqual(
      [before.accounts.length, before.transactions.length, before.balanceObservations.length, before.relations.length],
      [1, 2, 1, 1],
    );
    initial.close();

    await rebuildCanonicalProjection(directory);
    const reopened = createCanonicalLoanStore(databasePath);
    validateCanonicalSourceStore(reopened.sourceStore);
    const after = queryCanonicalLoanCurrent(reopened, { sourceId: "fubon" });
    assert.deepEqual(
      [after.accounts.length, after.transactions.length, after.balanceObservations.length, after.relations.length],
      [1, 2, 1, 1],
    );
    assert.equal(
      Number(
        (
          reopened.db
            .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
    reopened.close();

    const reopenedAgain = createCanonicalLoanStore(databasePath);
    validateCanonicalSourceStore(reopenedAgain.sourceStore);
    assert.equal(
      Number(
        (
          reopenedAgain.db
            .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
    reopenedAgain.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate relation evidence adds provenance without duplicating the edge", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const first = structuredClone(LOAN_CONTRACT_FIXTURES.yuanta);
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(first));
    const second = structuredClone(first);
    second.captureId = "sha256:relation-provenance-capture";
    second.observedAt = "2026-02-03T02:00:00.000Z";
    second.counterpartTransactions = second.counterpartTransactions.map(
      (counterpart) => ({
        ...counterpart,
        captureId: "sha256:relation-provenance-counterpart",
      }),
    );
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(second));
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM transaction_relations")
            .get() as { count: number }
        ).count,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM transaction_relation_provenance",
            )
            .get() as { count: number }
        ).count,
      ),
      2,
    );
  } finally {
    store.close();
  }
});

test("every loan extension and projection row retains canonical commit lineage", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    for (const query of [
      "SELECT created_commit_id AS commit_id FROM loan_account_identities",
      "SELECT commit_id FROM loan_transaction_facts",
      "SELECT created_commit_id AS commit_id FROM balance_observations",
      "SELECT commit_id FROM balance_observation_revisions",
      "SELECT commit_id FROM transaction_relations",
      "SELECT commit_id FROM transaction_relation_provenance",
      "SELECT projection_commit_id AS commit_id FROM current_loan_accounts",
      "SELECT projection_commit_id AS commit_id FROM current_loan_balance_observations",
      "SELECT projection_commit_id AS commit_id FROM current_loan_relations",
    ]) {
      const rows = store.db.prepare(query).all() as Array<{
        commit_id?: unknown;
      }>;
      assert.ok(rows.length > 0, query);
      assert.equal(
        rows.every(
          (row) =>
            row.commit_id instanceof Uint8Array &&
            row.commit_id.byteLength === 16,
        ),
        true,
        query,
      );
    }
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
  }
});
