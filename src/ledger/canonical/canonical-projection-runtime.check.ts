import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  canonicalSqlitePath,
  commitCathayDomesticDeposit,
  commitCathayUserAssertion,
  openCanonicalDatabase,
} from "./canonical-source-store.ts";
import {
  createCanonicalProjectionRuntime,
  type CanonicalProjectionCommitKind,
  type CanonicalProjectionFamily,
} from "./canonical-projection-runtime.ts";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCapture,
  createCanonicalInvestmentStore,
} from "./investment-financial.ts";

const token = (label: string) =>
  `sha256:${createHash("sha256").update(label).digest("base64url")}`;

const ALL_PROJECTION_FAMILIES = [
  "transactions",
  "transaction-fields",
  "loan-accounts",
  "loan-balances",
  "loan-relations",
  "loan-settlement-groups",
  "investment-accounts",
  "investment-holdings",
  "investment-transactions",
  "investment-margin-balances",
  "investment-funding-relations",
] as const satisfies readonly CanonicalProjectionFamily[];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "canonical-projection-runtime-"));
  await commitCathayDomesticDeposit(
    directory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const runtime = createCanonicalProjectionRuntime(directory);
  const scope = {
    sourceConnectionKey: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.sourceConnectionId,
  } as const;
  return { directory, runtime, scope };
}

function withoutProjectionCommit(
  rows: readonly { projectionCommitId: string | null }[] | undefined,
) {
  return rows?.map(({ projectionCommitId: _projectionCommitId, ...row }) => row);
}

function hexIdAsUuid(value: string): string {
  assert.match(value, /^[0-9a-f]{32}$/u);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

test("applyCommit joins the caller transaction and is idempotent", async () => {
  const { directory, runtime, scope } = await fixture();
  try {
    const before = runtime.read({
      kind: "current",
      families: ["transactions"],
      scope,
    });
    const db = openCanonicalDatabase(directory);
    try {
      const transactionRuntime = createCanonicalProjectionRuntime(db);
      const latest = db
        .prepare(
          "SELECT commit_id, commit_sequence FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1",
        )
        .get() as { commit_id: Uint8Array; commit_sequence: number };
      db.exec("BEGIN IMMEDIATE");
      transactionRuntime.applyCommit({
        commitId: latest.commit_id,
        kind: "source_capture",
      });
      const afterFirstApply = transactionRuntime.read({
        kind: "current",
        families: ["transactions", "loan-accounts"],
        scope,
      });
      transactionRuntime.applyCommit({
        commitId: latest.commit_id,
        kind: "source_capture",
      });
      assert.deepEqual(
        transactionRuntime.read({
          kind: "current",
          families: ["transactions", "loan-accounts"],
          scope,
        }),
        afterFirstApply,
      );
      db.exec("COMMIT");

      const nextCommit = randomBytes(16);
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO canonical_commits(
           commit_id, commit_sequence, recorded_at_utc_us,
           authority_route, commit_kind
         ) VALUES (?, ?, ?, ?, 'source_capture')`,
      ).run(
        nextCommit,
        latest.commit_sequence + 1,
        1_800_000_000_000_000,
        CATHAY_DOMESTIC_DEPOSIT_FIXTURE.authorityRoute,
      );
      transactionRuntime.applyCommit({
        commitId: nextCommit,
        kind: "source_capture",
      });
      assert.equal(
        transactionRuntime.read({
          kind: "current",
          families: ["transactions"],
          scope,
        }).knowledgePoint,
        latest.commit_sequence + 1,
      );
      db.exec("ROLLBACK");
      assert.equal(
        Number(
          (
            db
              .prepare("SELECT COUNT(*) AS count FROM canonical_commits WHERE commit_id=?")
              .get(nextCommit) as { count?: number }
          ).count ?? 0,
        ),
        0,
        "rolling back must remove both the financial commit fact and its projection",
      );
    } finally {
      db.close();
    }
    assert.deepEqual(
      runtime.read({
        kind: "current",
        families: ["transactions"],
        scope,
      }),
      before,
      "rolling back the financial commit must also roll back its projection",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("closed impact registry rejects unknown kinds and accepts explicit no-op", async () => {
  const { directory, runtime, scope } = await fixture();
  try {
    const rowsBefore = runtime.read({
      kind: "current",
      families: ["transactions"],
      scope,
    }).families.transactions;
    let latestSequence = 0;
    const db = openCanonicalDatabase(directory);
    try {
      const transactionRuntime = createCanonicalProjectionRuntime(db);
      const latest = db
        .prepare(
          "SELECT commit_sequence FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1",
        )
        .get() as { commit_sequence: number };
      latestSequence = latest.commit_sequence;
      assert.throws(
        () => {
          db.exec("BEGIN IMMEDIATE");
          try {
          transactionRuntime.applyCommit({
            commitId: randomBytes(16),
            kind: "future_projection_kind" as CanonicalProjectionCommitKind,
          });
          } finally {
            db.exec("ROLLBACK");
          }
        },
        /Unknown canonical projection commit kind/,
      );

      const noOpCommit = randomBytes(16);
      db.prepare(
        `INSERT INTO canonical_commits(
           commit_id, commit_sequence, recorded_at_utc_us,
           authority_route, commit_kind
         ) VALUES (?, ?, ?, ?, 'projection_rebuild')`,
      ).run(
        noOpCommit,
        latest.commit_sequence + 1,
        1_800_000_000_000_000,
        "canonical/projection-runtime/no-op/v1",
      );
      db.exec("BEGIN IMMEDIATE");
      transactionRuntime.applyCommit({
        commitId: noOpCommit,
        kind: "projection_rebuild",
      });
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const after = runtime.read({
      kind: "current",
      families: ["transactions"],
      scope,
    });
    assert.deepEqual(after.families.transactions, rowsBefore);
    assert.equal(after.knowledgePoint, latestSequence);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rebuild validates a shadow generation before exactly one switch", async () => {
  const { directory, runtime, scope } = await fixture();
  try {
    const before = runtime.read({
      kind: "current",
      families: ["transactions", "transaction-fields"],
      scope,
    });
    await assert.rejects(
      runtime.rebuild({ injectFailure: "validation" }),
      /Injected projection rebuild failure/,
    );
    assert.deepEqual(
      runtime.read({
        kind: "current",
        families: ["transactions", "transaction-fields"],
        scope,
      }),
      before,
    );

    const rebuilt = await runtime.rebuild();
    assert.equal(rebuilt.previousGeneration, before.generation);
    assert.equal(rebuilt.generation, rebuilt.previousGeneration + 1);
    const after = runtime.read({
      kind: "current",
      families: ["transactions", "transaction-fields"],
      scope,
    });
    assert.equal(after.generation, rebuilt.generation);
    assert.deepEqual(
      withoutProjectionCommit(after.families.transactions),
      withoutProjectionCommit(before.families.transactions),
    );
    assert.deepEqual(
      after.families["transaction-fields"],
      before.families["transaction-fields"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicit older rebuild reports one generation Knowledge Point", async () => {
  const { directory, runtime, scope } = await fixture();
  let laterCommitId: Buffer | null = null;
  try {
    const db = openCanonicalDatabase(directory);
    try {
      const sourceConnectionId = (
        db
          .prepare(
            "SELECT source_connection_id FROM source_connections WHERE source_connection_key = ?",
          )
          .get(scope.sourceConnectionKey) as { source_connection_id: Uint8Array }
      ).source_connection_id;
      const relationCommitId = randomBytes(16);
      db.prepare(
        `INSERT INTO canonical_commits(
           commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind
         ) VALUES (?, 2, 2000000, 'synthetic/later-relation', 'relation_resolution')`,
      ).run(relationCommitId);
      db.prepare(
        `INSERT INTO loan_repayment_resolution_runs(
           resolution_id, resolution_key, source_connection_id, resolver_version,
           coverage_state, outcome, reason, observed_at, commit_id
         ) VALUES (?, 'synthetic-later-relation', ?, 'synthetic/runtime',
                   'complete', 'no-admission', 'synthetic',
                   '2026-08-31T00:00:00.000Z', ?)`,
      ).run(randomBytes(16), sourceConnectionId, relationCommitId);
      db.exec("BEGIN IMMEDIATE");
      createCanonicalProjectionRuntime(db).applyCommit({
        commitId: relationCommitId,
        kind: "relation_resolution",
      });
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    await runtime.rebuild({
      cutoff: { kind: "commit-sequence", commitSequence: 1 },
    });
    assert.equal(
      runtime.read({ kind: "current", families: ["transactions"], scope })
        .knowledgePoint,
      1,
      "a later retained relation commit cannot widen an older active generation",
    );

    const writer = openCanonicalDatabase(directory);
    try {
      laterCommitId = randomBytes(16);
      const sourceConnectionId = (
        writer
          .prepare(
            "SELECT source_connection_id FROM source_connections WHERE source_connection_key = ?",
          )
          .get(scope.sourceConnectionKey) as { source_connection_id: Uint8Array }
      ).source_connection_id;
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare(
        `INSERT INTO canonical_commits(
           commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind
         ) VALUES (?, 4, 4000000, 'synthetic/applied-relation', 'relation_resolution')`,
      ).run(laterCommitId);
      writer.prepare(
        `INSERT INTO loan_repayment_resolution_runs(
           resolution_id, resolution_key, source_connection_id, resolver_version,
           coverage_state, outcome, reason, observed_at, commit_id
         ) VALUES (?, 'synthetic-applied-relation', ?, 'synthetic/runtime',
                   'complete', 'no-admission', 'synthetic',
                   '2026-08-31T00:00:01.000Z', ?)`,
      ).run(randomBytes(16), sourceConnectionId, laterCommitId);
      createCanonicalProjectionRuntime(writer).applyCommit({
        commitId: laterCommitId,
        kind: "relation_resolution",
      });
      writer.exec("COMMIT");
    } finally {
      writer.close();
    }
    assert.equal(
      runtime.read({ kind: "current", families: ["transactions"], scope })
        .knowledgePoint,
      4,
      "applying a later commit advances the whole active generation together",
    );
    const transactionId = runtime.read({
      kind: "current",
      families: ["transactions"],
      scope,
    }).families.transactions[0]!.transactionId;
    await commitCathayUserAssertion(directory, {
      transactionId: hexIdAsUuid(transactionId),
      field: "note",
      value: "later financial knowledge",
    });
    const beforeReplay = runtime.read({
      kind: "current",
      families: ["transactions", "transaction-fields", "loan-relations"],
      scope,
    });
    assert.ok(laterCommitId);
    const replay = openCanonicalDatabase(directory);
    try {
      replay.exec("BEGIN IMMEDIATE");
      createCanonicalProjectionRuntime(replay).applyCommit({
        commitId: laterCommitId,
        kind: "relation_resolution",
      });
      replay.exec("COMMIT");
    } finally {
      replay.close();
    }
    assert.deepEqual(
      runtime.read({
        kind: "current",
        families: ["transactions", "transaction-fields", "loan-relations"],
        scope,
      }),
      beforeReplay,
      "replaying an older relation commit cannot regress the active generation",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("read returns one eager immutable bounded snapshot and fails closed", async () => {
  const { directory, runtime, scope } = await fixture();
  try {
    assert.throws(
      () => runtime.read({ kind: "current", families: ["transactions"], scope: {} }),
      /bounded scope|source connection/,
    );
    assert.throws(
      () =>
        runtime.read({
          kind: "current",
          families: ["transactions", "unknown" as "transactions"],
          scope,
        }),
      /Unknown canonical projection family/,
    );
    const snapshot = runtime.read({
      kind: "current",
      families: ALL_PROJECTION_FAMILIES,
      scope,
    });
    assert.equal(
      Object.keys(snapshot.families).length,
      ALL_PROJECTION_FAMILIES.length,
    );
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.families));
    assert.ok(Object.isFrozen(snapshot.families.transactions));
    assert.ok(Object.isFrozen(snapshot.families.transactions?.[0]));
    assert.equal(typeof snapshot.families.transactions[0]?.transactionId, "string");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returned account IDs round-trip and date bounds apply to transaction fields", async () => {
  const { directory, runtime, scope } = await fixture();
  try {
    const current = runtime.read({
      kind: "current",
      families: ["transactions"],
      scope,
    });
    const transaction = current.families.transactions[0]!;
    await commitCathayUserAssertion(directory, {
      transactionId: hexIdAsUuid(transaction.transactionId),
      field: "note",
      value: "sanitized bounded note",
    });
    const afterAssertion = createCanonicalProjectionRuntime(directory);
    assert.equal(
      afterAssertion.read({
        kind: "current",
        families: ["transactions"],
        scope: { accountIds: [transaction.accountId] },
      }).families.transactions.length,
      current.families.transactions.length,
      "a Runtime-returned hex account ID is a valid bounded scope",
    );
    const outside = afterAssertion.read({
      kind: "current",
      families: ["transactions", "transaction-fields"],
      scope: {
        sourceConnectionKey: scope.sourceConnectionKey,
        startDate: "2020-01-01",
        endDate: "2020-12-31",
      },
    });
    assert.equal(outside.families.transactions.length, 0);
    assert.equal(outside.families["transaction-fields"].length, 0);
    const explicitlyEmpty = afterAssertion.read({
      kind: "current",
      families: ALL_PROJECTION_FAMILIES,
      scope: { accountIds: [] },
    });
    for (const family of ALL_PROJECTION_FAMILIES)
      assert.equal(
        explicitlyEmpty.families[family].length,
        0,
        `an explicit empty account scope must not widen ${family}`,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical reads require dual cutoffs and never use retired generations", async () => {
  const { directory, runtime, scope } = await fixture();
  try {
    assert.throws(
      () => runtime.read({ kind: "historical", families: ["transactions"], scope }),
      /financial and knowledge cutoffs/,
    );
    const request = {
      kind: "historical" as const,
      families: ["transactions"] as const,
      scope,
      cutoff: { financialAt: "2026-08-17", knowledgeAt: 1 },
    };
    const before = runtime.read(request);
    assert.equal(before.generation, null);
    await runtime.rebuild();
    assert.deepEqual(runtime.read(request), before);
    const earlier = runtime.read({
      ...request,
      cutoff: { financialAt: "2025-01-01", knowledgeAt: 1 },
    });
    assert.equal(earlier.families.transactions?.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical selection ignores revisions that become effective after the financial cutoff", async () => {
  const { directory, runtime, scope } = await fixture();
  const db = openCanonicalDatabase(directory);
  try {
    const latest = db
      .prepare(
        `SELECT revision.*
           FROM transaction_revisions revision
           JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
          ORDER BY commit_row.commit_sequence DESC, revision.transaction_id
          LIMIT 1`,
      )
      .get() as Record<string, unknown>;
    const laterCommitId = randomBytes(16);
    const laterRevisionId = randomBytes(16);
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO canonical_commits(
         commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind
       ) VALUES (?, 2, 2000000, 'synthetic/runtime-cutoff-test', 'source_capture')`,
    ).run(laterCommitId);
    db.prepare(
      `INSERT INTO transaction_revisions(
         revision_id, transaction_id, source_record_id, capture_id, commit_id,
         revision_number, amount_coefficient, amount_scale, currency, direction,
         posting_status, posting_origin, posting_basis, posting_rule_version,
         description, economic_status, administrative_state, semantic_rule_version,
         effective_on, transaction_date_time_local, time_zone, time_precision,
         time_origin, effective_time_basis, effective_time_rule_version,
         utc_instant_utc_us
       ) SELECT ?, transaction_id, source_record_id, capture_id, ?,
                revision_number + 1, amount_coefficient, amount_scale, currency, direction,
                posting_status, posting_origin, posting_basis, posting_rule_version,
                description, economic_status, administrative_state, semantic_rule_version,
                '2027-01-01', '2027-01-01T00:00:00', time_zone, time_precision,
                time_origin, effective_time_basis, effective_time_rule_version,
                utc_instant_utc_us + 1000000
           FROM transaction_revisions
          WHERE revision_id = ?`,
    ).run(laterRevisionId, laterCommitId, latest.revision_id as Uint8Array);
    db.exec("COMMIT");

    const snapshot = createCanonicalProjectionRuntime(db).read({
      kind: "historical",
      families: ["transactions"],
      scope,
      cutoff: { financialAt: "2026-08-17", knowledgeAt: 2 },
    });
    assert.equal(snapshot.families.transactions.length, 3);
    assert.equal(
      snapshot.families.transactions.some(
        (transaction) => transaction.revisionId === laterRevisionId.toString("hex"),
      ),
      false,
    );
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime accepts a canonical sqlite file path", async () => {
  const { directory, scope } = await fixture();
  try {
    const runtime = createCanonicalProjectionRuntime(canonicalSqlitePath(directory));
    assert.equal(
      runtime.read({ kind: "current", families: ["transactions"], scope })
        .families.transactions?.length,
      3,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("investment families are derived inside the Runtime snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-projection-investment-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const store = createCanonicalInvestmentStore(path);
    await commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture({
        captureId: "projection-runtime-investment",
        sourceId: "yuanta-trade",
        authorityRoute: "yuanta-trade/investment/canonical-v1",
        contractVersion: "yuanta-trade/investment/canonical-v1",
        observedAt: "2026-08-31T12:00:00.000Z",
        identity: {
          sourceConnectionKey: token("projection-runtime-connection"),
          identityEpochKey: token("projection-runtime-epoch"),
          accountKey: token("projection-runtime-account"),
          accountType: "investment",
          reportingCurrency: "TWD",
        },
        scope: { effectiveOn: "2026-08-30", complete: true },
        securities: [
          {
            securityKey: "yuanta-trade:TWSE:2330",
            producerSecurityId: "TWSE:2330",
            name: "SANITIZED EQUITY",
            ticker: "2330",
            currency: "TWD",
            identityEvidence: {
              kind: "producer-security-id",
              contractVersion: "yuanta-trade/investment/canonical-v1",
            },
          },
        ],
        holdings: [
          {
            measurementKey: token("projection-runtime-measurement"),
            measurementSubjectKey: token("projection-runtime-subject"),
            sourceRecordKey: token("projection-runtime-holding-record"),
            securityKey: "yuanta-trade:TWSE:2330",
            quantity: { coefficient: "1000", scale: 0 },
            valuation: { coefficient: "500000", scale: 0, currency: "TWD" },
            effectiveOn: "2026-08-30",
            observedAt: "2026-08-31T12:00:00.000Z",
            effectiveTimeEvidence: {
              kind: "source-reported-as-of",
              sourceRecordKey: token("projection-runtime-holding-record"),
              sourceField: "as_of_date",
              value: "2026-08-30",
              contractVersion: "yuanta-trade/investment/canonical-v1",
            },
            lineage: {
              page: 0,
              row: 0,
              contractVersion: "yuanta-trade/investment/canonical-v1",
            },
          },
        ],
        transactions: [
          {
            sourceRecordKey: token("projection-runtime-transaction-record"),
            transactionKey: token("projection-runtime-transaction"),
            securityKey: "yuanta-trade:TWSE:2330",
            action: "buy",
            quantity: { coefficient: "1000", scale: 0 },
            cashEffect: { coefficient: "500000", scale: 0, currency: "TWD" },
            effectiveOn: "2026-08-29",
            fundingEvidence: {
              kind: "unresolved",
              sourceRecordKey: token("projection-runtime-transaction-record"),
            },
          },
        ],
        margin: {
          kind: "embedded",
          amount: { coefficient: "25000", scale: 0, currency: "TWD" },
          effectiveOn: "2026-08-30",
          sourceRecordKey: token("projection-runtime-margin-record"),
        },
      }),
    );
    store.close();

    const snapshot = createCanonicalProjectionRuntime(path).read({
      kind: "current",
      families: [
        "investment-accounts",
        "investment-holdings",
        "investment-transactions",
        "investment-margin-balances",
      ],
      scope: { sourceConnectionKey: token("projection-runtime-connection") },
    });
    assert.equal(snapshot.families["investment-accounts"]?.length, 1);
    assert.equal(snapshot.families["investment-holdings"]?.length, 1);
    assert.equal(snapshot.families["investment-transactions"]?.length, 1);
    assert.equal(snapshot.families["investment-margin-balances"]?.length, 1);
    assert.equal(
      snapshot.families["investment-transactions"]?.[0]?.action,
      "buy",
    );
    const outside = createCanonicalProjectionRuntime(path).read({
      kind: "current",
      families: [
        "investment-holdings",
        "investment-transactions",
        "investment-margin-balances",
      ],
      scope: {
        sourceConnectionKey: token("projection-runtime-connection"),
        startDate: "2020-01-01",
        endDate: "2020-12-31",
      },
    });
    assert.equal(outside.families["investment-holdings"].length, 0);
    assert.equal(outside.families["investment-transactions"].length, 0);
    assert.equal(outside.families["investment-margin-balances"].length, 0);

    const reader = openCanonicalDatabase(directory);
    const writer = new DatabaseSync(path);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
    const prepare = DatabaseSync.prototype.prepare;
    try {
      const runtime = createCanonicalProjectionRuntime(reader);
      let writerCommitted = false;
      DatabaseSync.prototype.prepare = function (
        this: DatabaseSync,
        sql: string,
        ...options: unknown[]
      ) {
        if (
          !writerCommitted &&
          sql.includes("FROM investment_holding_observations observation")
        ) {
          writer.exec("BEGIN IMMEDIATE");
          writer.prepare(
            "UPDATE investment_holding_observations SET is_current = 0",
          ).run();
          writer.exec("COMMIT");
          writerCommitted = true;
        }
        return (prepare as (...values: unknown[]) => unknown).call(
          this,
          sql,
          ...options,
        );
      } as DatabaseSync["prepare"];

      const stable = runtime.read({
        kind: "current",
        families: ["investment-accounts", "investment-holdings"],
        scope: { sourceConnectionKey: token("projection-runtime-connection") },
      });
      assert.equal(writerCommitted, true);
      assert.equal(stable.families["investment-accounts"].length, 1);
      assert.equal(
        stable.families["investment-holdings"].length,
        1,
        "a DB-bound Runtime read keeps one snapshot across family statements",
      );
      DatabaseSync.prototype.prepare = prepare;
      assert.equal(
        createCanonicalProjectionRuntime(reader).read({
          kind: "current",
          families: ["investment-holdings"],
          scope: { sourceConnectionKey: token("projection-runtime-connection") },
        }).families["investment-holdings"].length,
        0,
        "a later read observes the committed correction",
      );
    } finally {
      DatabaseSync.prototype.prepare = prepare;
      if (writer.isTransaction) writer.exec("ROLLBACK");
      reader.close();
      writer.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
