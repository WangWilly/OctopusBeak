import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE,
  CANONICAL_SCHEMA_VERSION,
  canonicalSqlitePath,
  commitCathayDomesticDeposit,
  commitCathayDerivedImportRun,
  commitCathayUserAssertion,
  createCathayCanonicalFinancialQuery,
  openCanonicalDatabase,
} from "./cathay-domestic-deposit.ts";
import { CanonicalBusyRetryExhaustedError } from "./canonical-runtime.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";

const rebuildCathayCanonicalProjection = (
  ledgerDir: string,
  options = {},
) => createCanonicalProjectionRuntime(canonicalSqlitePath(ledgerDir)).rebuild(options);

const ledgerDir = await mkdtemp(join(tmpdir(), "cathay-canonical-v7-runtime-"));
try {
  const first = await commitCathayDomesticDeposit(
    ledgerDir,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    assert.equal(
      Number(db.prepare("PRAGMA user_version").get()?.user_version),
      CANONICAL_SCHEMA_VERSION,
    );
    assert.equal(
      String(
        db.prepare("PRAGMA journal_mode").get()?.journal_mode,
      ).toLowerCase(),
      "wal",
    );
    assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA synchronous").get()?.synchronous, 2);
    assert.deepEqual(
      db
        .prepare(
          "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
        )
        .get()?.generation_id,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM projection_generation_transactions WHERE generation_id = 1",
        )
        .get()?.count,
      first.transactions.length,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM current_transactions").get()
        ?.count,
      first.transactions.length,
    );
  } finally {
    db.close();
  }

  const query = createCathayCanonicalFinancialQuery(ledgerDir);
  const before = await query.current({ kind: "current" });
  const rebuilt = await rebuildCathayCanonicalProjection(ledgerDir);
  assert.equal(rebuilt.previousGeneration, 1);
  assert.equal(rebuilt.generation, 2);
  assert.equal(
    (await query.current({ kind: "current" })).transactions.length,
    before.transactions.length,
  );

  const switched = openCanonicalDatabase(ledgerDir, { readOnly: true });
  let activeGeneration = 0;
  try {
    activeGeneration = Number(
      switched
        .prepare(
          "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
        )
        .get()?.generation_id,
    );
    assert.equal(activeGeneration, rebuilt.generation);
    assert.equal(
      switched
        .prepare(
          "SELECT status FROM projection_generations WHERE generation_id = ?",
        )
        .get(activeGeneration)?.status,
      "active",
    );
    assert.equal(
      switched
        .prepare(
          "SELECT status FROM projection_generations WHERE generation_id = 1",
        )
        .get()?.status,
      "retired",
    );
  } finally {
    switched.close();
  }

  await assert.rejects(
    () =>
      rebuildCathayCanonicalProjection(ledgerDir, {
        injectFailure: "validation",
      }),
    /Injected projection rebuild failure/,
  );
  const afterFailure = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    assert.equal(
      Number(
        afterFailure
          .prepare(
            "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
          )
          .get()?.generation_id,
      ),
      activeGeneration,
    );
    assert.equal(
      afterFailure
        .prepare(
          "SELECT COUNT(*) AS count FROM projection_generations WHERE status = 'building'",
        )
        .get()?.count,
      0,
    );
  } finally {
    afterFailure.close();
  }

  const lock = new DatabaseSync(canonicalSqlitePath(ledgerDir));
  lock.exec("PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
  const retried = commitCathayDomesticDeposit(
    ledgerDir,
    {
      ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
      observedAt: "2026-08-18T00:00:00+08:00",
    },
    {
      runtime: {
        busyTimeoutMs: 1,
        maxAttempts: 10,
        initialBackoffMs: 1,
        maxBackoffMs: 4,
      },
    },
  );
  setTimeout(() => lock.exec("COMMIT"), 10);
  await retried;
  lock.close();
  const exhausted = new DatabaseSync(canonicalSqlitePath(ledgerDir));
  exhausted.exec("PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
  await assert.rejects(
    () =>
      commitCathayDomesticDeposit(
        ledgerDir,
        {
          ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
          observedAt: "2026-08-19T00:00:00+08:00",
        },
        {
          runtime: {
            busyTimeoutMs: 1,
            maxAttempts: 2,
            initialBackoffMs: 1,
            maxBackoffMs: 1,
          },
        },
      ),
    CanonicalBusyRetryExhaustedError,
  );
  exhausted.exec("ROLLBACK");
  exhausted.close();

  const newer = new DatabaseSync(canonicalSqlitePath(ledgerDir));
  try {
    newer.exec(`PRAGMA user_version = ${CANONICAL_SCHEMA_VERSION + 1}`);
  } finally {
    newer.close();
  }
  assert.throws(() => openCanonicalDatabase(ledgerDir), /newer than supported/);
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}

async function makePopulatedLedger(
  prefix: string,
): Promise<{ dir: string; commitId: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await commitCathayDomesticDeposit(dir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const db = new DatabaseSync(canonicalSqlitePath(dir), { readOnly: true });
  try {
    return {
      dir,
      commitId: Buffer.from(
        (
          db
            .prepare(
              "SELECT commit_id FROM canonical_commits ORDER BY commit_sequence LIMIT 1",
            )
            .get() as { commit_id: Uint8Array }
        ).commit_id,
      ),
    };
  } finally {
    db.close();
  }
}

async function makeFieldLedger(
  prefix: string,
): Promise<{ dir: string; transactionId: string; otherTransactionId: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const source = await commitCathayDomesticDeposit(
    dir,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const transactionId = source.transactions[0]!.transactionId;
  const otherTransactionId = source.transactions[1]!.transactionId;
  await commitCathayDerivedImportRun(dir, {
    sourceConnectionId: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.sourceConnectionId,
    identityEpoch: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.identityEpoch,
    authorityRoute: "cathay/domestic-deposit/v1",
    stream: "domestic-deposit",
    producerId: "red-test-enricher",
    ruleLineage: "red-test-rule",
    complete: true,
    status: "complete",
    subjectIds: [transactionId],
    fields: ["display_name"],
    scope: [
      {
        transactionId,
        field: "display_name",
        state: "supported",
        value: "Red test label",
      },
    ],
  });
  await commitCathayUserAssertion(dir, {
    transactionId,
    field: "display_name",
    value: "Red test user label",
  });
  return { dir, transactionId, otherTransactionId };
}

// The documented empty-store state has no canonical evidence or projection
// generation yet. Read-only startup and all three public query contracts must
// treat that state as a valid empty result, while any partial state remains a
// recovery error.
{
  const dir = await mkdtemp(join(tmpdir(), "cathay-canonical-v7-empty-"));
  try {
    const writer = openCanonicalDatabase(dir);
    writer.close();
    const readable = openCanonicalDatabase(dir, { readOnly: true });
    readable.close();
    const query = createCathayCanonicalFinancialQuery(dir);
    assert.deepEqual(await query.current({ kind: "current" }), {
      status: "ok",
      kind: "current",
      accounts: [],
      transactions: [],
      commitSequence: 0,
    });
    assert.deepEqual(
      (
        await query.historical({
          kind: "historical",
          cutoff: { kind: "both", financialAt: "2026-01-01", knowledgeAt: "0" },
        })
      ).transactions,
      [],
    );
    assert.deepEqual(
      (
        await query.lineage({
          kind: "lineage",
          subject: {
            kind: "transaction",
            id: "00000000-0000-0000-0000-000000000000",
          },
        })
      ).entries,
      [],
    );

    const partial = new DatabaseSync(canonicalSqlitePath(dir));
    const commitId = Buffer.alloc(16, 0x2a);
    partial
      .prepare(
        "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, 1, 0, 'cathay/domestic-deposit/v1', 'source_capture')",
      )
      .run(commitId);
    partial.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /empty|projection|generation|pointer|provenance/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// These are deliberately isolated red cases: each corrupts a copy of an otherwise
// valid ledger, so a startup gate cannot be accidentally masked by a prior case.
{
  const { dir } = await makePopulatedLedger(
    "cathay-canonical-v7-red-arithmetic-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec(
      "UPDATE transaction_revisions SET amount_coefficient = '12abc'",
    );
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /exact arithmetic|decimal/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const { dir, commitId } = await makePopulatedLedger(
    "cathay-canonical-v7-red-route-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt
      .prepare(
        "INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run("evil/route", "evil", "domestic-deposit", "evil/v1", commitId);
    corrupt
      .prepare("UPDATE source_captures SET authority_route = 'evil/route'")
      .run();
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /authority|route/i,
    );
    assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /authority|route/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const { dir, commitId } = await makePopulatedLedger(
    "cathay-canonical-v7-red-active-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt
      .prepare(
        `INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id, validated_commit_id, switched_commit_id)
      VALUES (2, 'active', 1, 'canonical/projection/v1', ?, ?, ?)`,
      )
      .run(commitId, commitId, commitId);
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /active projection/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const { dir } = await makePopulatedLedger(
    "cathay-canonical-v7-red-pointer-null-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec(
      "DROP TRIGGER trg_active_projection_generation_switch_update; DROP TRIGGER trg_active_projection_generation_commit_update",
    );
    corrupt.exec(
      "UPDATE active_projection_generation SET switched_commit_id = NULL",
    );
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /pointer|switch|projection state/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(
    join(tmpdir(), "cathay-canonical-v7-red-pointer-mismatch-"),
  );
  try {
    const first = await commitCathayDomesticDeposit(
      dir,
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    );
    await commitCathayDomesticDeposit(dir, {
      ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
      observedAt: "2026-08-18T00:00:00+08:00",
    });
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const ids = corrupt
      .prepare(
        "SELECT commit_id FROM canonical_commits ORDER BY commit_sequence",
      )
      .all() as Array<{ commit_id: Uint8Array }>;
    assert.equal(ids.length >= 2, true);
    corrupt.exec("DROP TRIGGER trg_active_projection_generation_commit_update");
    corrupt
      .prepare("UPDATE active_projection_generation SET switched_commit_id = ?")
      .run(Buffer.from(ids[1]!.commit_id));
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /pointer|switch|projection state/i,
    );
    assert.equal(first.commitSequence, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const { dir } = await makePopulatedLedger("cathay-canonical-v7-exact-valid-");
  try {
    const largeSigned = "-123456789012345678901234567890123456789";
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt
      .prepare(
        "UPDATE transaction_revisions SET amount_coefficient = ?, amount_scale = 2",
      )
      .run(largeSigned);
    corrupt.close();
    const readable = openCanonicalDatabase(dir, { readOnly: true });
    readable.close();
    const rebuilt = await rebuildCathayCanonicalProjection(dir);
    assert.equal(rebuilt.status, "switched");
    const query = createCathayCanonicalFinancialQuery(dir);
    assert.equal(
      (await query.current({ kind: "current" })).transactions[0]?.amount
        .coefficient,
      largeSigned,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A latest revision can be structurally valid while its Source Assertion is
// missing. Rebuild population must report the missing identity rather than
// silently dropping it through an inner join.
{
  const { dir } = await makePopulatedLedger(
    "cathay-canonical-v7-red-completeness-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const sourceRevision = corrupt
      .prepare(
        "SELECT revision_id FROM transaction_revisions ORDER BY revision_number, revision_id LIMIT 1",
      )
      .get() as { revision_id: Uint8Array };
    const columns = (
      corrupt
        .prepare("PRAGMA table_info(transaction_revisions)")
        .all() as Array<{ name: string }>
    ).map((column) => column.name);
    const expressions = columns.map((column) =>
      column === "revision_id"
        ? "randomblob(16)"
        : column === "commit_id"
          ? "?"
          : column === "revision_number"
            ? "99"
            : column,
    );
    const maxSequence = Number(
      (
        corrupt
          .prepare(
            "SELECT MAX(commit_sequence) AS sequence FROM canonical_commits",
          )
          .get() as { sequence?: number }
      ).sequence ?? 0,
    );
    const commitId = Buffer.alloc(16, 0x44);
    corrupt
      .prepare(
        "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'source_capture')",
      )
      .run(commitId, maxSequence + 1, 0, "cathay/domestic-deposit/v1");
    corrupt
      .prepare(
        `INSERT INTO transaction_revisions(${columns.join(", ")}) SELECT ${expressions.join(", ")} FROM transaction_revisions WHERE revision_id = ?`,
      )
      .run(commitId, Buffer.from(sourceRevision.revision_id));
    corrupt.close();
    const valid = openCanonicalDatabase(dir, { readOnly: true });
    valid.close();
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /complete|missing|identity|projection/i,
    );
    const after = new DatabaseSync(canonicalSqlitePath(dir), {
      readOnly: true,
    });
    try {
      assert.equal(
        after
          .prepare(
            "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
          )
          .get()?.generation_id,
        1,
      );
      assert.equal(
        after
          .prepare(
            "SELECT COUNT(*) AS count FROM projection_generations WHERE status = 'building'",
          )
          .get()?.count,
        0,
      );
    } finally {
      after.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const [label, corruptField] of [
  [
    "user assertion used as derived",
    (db: DatabaseSync) =>
      db.exec(
        "UPDATE projection_generation_transaction_fields SET origin = 'derived', derived_assertion_id = user_assertion_id, user_assertion_id = NULL WHERE origin = 'user'",
      ),
  ],
  [
    "source assertion used as user",
    (db: DatabaseSync) => {
      const source = db
        .prepare(
          "SELECT assertion_id FROM assertions WHERE origin = 'source' LIMIT 1",
        )
        .get() as { assertion_id: Uint8Array };
      db.prepare(
        "UPDATE projection_generation_transaction_fields SET origin = 'user', user_assertion_id = ?, derived_assertion_id = NULL WHERE origin = 'user'",
      ).run(Buffer.from(source.assertion_id));
    },
  ],
  [
    "field row points at another transaction",
    (db: DatabaseSync, otherTransactionId?: string) =>
      db
        .prepare(
          "UPDATE projection_generation_transaction_fields SET transaction_id = ? WHERE origin = 'user'",
        )
        .run(Buffer.from(otherTransactionId!.replaceAll("-", ""), "hex")),
  ],
  [
    "field key disagrees with assertion",
    (db: DatabaseSync) =>
      db.exec(
        "UPDATE projection_generation_transaction_fields SET field_name = 'note' WHERE origin = 'user'",
      ),
  ],
  [
    "field projection commit disagrees with generation",
    (db: DatabaseSync) =>
      db.exec(
        "UPDATE projection_generation_transaction_fields SET projection_commit_id = (SELECT commit_id FROM canonical_commits ORDER BY commit_sequence LIMIT 1) WHERE origin = 'user'",
      ),
  ],
] as Array<[string, (db: DatabaseSync, otherTransactionId?: string) => void]>) {
  const { dir, otherTransactionId } = await makeFieldLedger(
    `cathay-canonical-v7-red-field-${label.replaceAll(" ", "-")}-`,
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec(
      "DROP TRIGGER IF EXISTS trg_projection_generation_fields_integrity_insert; DROP TRIGGER IF EXISTS trg_projection_generation_fields_integrity_update",
    );
    corruptField(corrupt, otherTransactionId);
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /field|assertion|projection|origin|generation/i,
      label,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /field|assertion|projection|origin|generation/i,
      label,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// User assertion provenance is local user authority, even when the nullable
// source/run/coordinate columns are all empty. A source-capture commit must
// never be accepted as the provenance of a user assertion.
{
  const { dir } = await makeFieldLedger(
    "cathay-canonical-v7-red-user-provenance-route-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const sourceCommit = (
      corrupt
        .prepare(
          "SELECT commit_id FROM canonical_commits WHERE commit_kind = 'source_capture' LIMIT 1",
        )
        .get() as { commit_id: Uint8Array }
    ).commit_id;
    corrupt
      .prepare(
        `UPDATE assertion_provenance SET commit_id = ? WHERE assertion_id = (
      SELECT user_assertion_id FROM projection_generation_transaction_fields WHERE origin = 'user' LIMIT 1
    )`,
      )
      .run(Buffer.from(sourceCommit));
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /user|provenance|authority|route|commit/i,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /user|provenance|authority|route|commit/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Every assertion selected into the active projection must retain at least one
// origin-appropriate provenance row. Removing all rows is distinct from a
// malformed row and must fail both startup and candidate rebuild validation.
for (const origin of ["source", "derived", "user"] as const) {
  const { dir, transactionId } = await makeFieldLedger(
    `cathay-canonical-v7-red-provenance-missing-${origin}-`,
  );
  try {
    if (origin === "derived") {
      await commitCathayDerivedImportRun(dir, {
        sourceConnectionId: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.sourceConnectionId,
        identityEpoch: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.identityEpoch,
        authorityRoute: "cathay/domestic-deposit/v1",
        stream: "domestic-deposit",
        producerId: "missing-provenance-enricher",
        ruleLineage: "missing-provenance-rule",
        complete: true,
        status: "complete",
        subjectIds: [transactionId],
        fields: ["note"],
        scope: [
          {
            transactionId,
            field: "note",
            state: "supported",
            value: "Missing provenance note",
          },
        ],
      });
    }
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const assertion =
      origin === "source"
        ? corrupt
            .prepare(
              "SELECT assertion_id FROM assertions WHERE origin = 'source' LIMIT 1",
            )
            .get()
        : corrupt
            .prepare(
              "SELECT CASE WHEN origin = 'derived' THEN derived_assertion_id ELSE user_assertion_id END AS assertion_id FROM projection_generation_transaction_fields WHERE origin = ? LIMIT 1",
            )
            .get(origin);
    assert.ok(
      assertion && (assertion as { assertion_id?: Uint8Array }).assertion_id,
    );
    corrupt
      .prepare("DELETE FROM assertion_provenance WHERE assertion_id = ?")
      .run(
        Buffer.from((assertion as { assertion_id: Uint8Array }).assertion_id),
      );
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /provenance|lineage|source|assertion|selected/i,
      origin,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /provenance|lineage|source|assertion|selected/i,
      origin,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const { dir, otherTransactionId } = await makeFieldLedger(
    "cathay-canonical-v7-red-lifecycle-coordinate-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec(
      "DROP TRIGGER IF EXISTS trg_assertion_transitions_integrity_insert; DROP TRIGGER IF EXISTS trg_assertion_transitions_integrity_update",
    );
    corrupt
      .prepare(
        `UPDATE assertion_transitions SET transaction_id = ? WHERE assertion_id = (
      SELECT user_assertion_id FROM projection_generation_transaction_fields WHERE origin = 'user' LIMIT 1
    )`,
      )
      .run(Buffer.from(otherTransactionId.replaceAll("-", ""), "hex"));
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /lifecycle|coordinate|assertion|transaction/i,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /lifecycle|coordinate|assertion|transaction/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const { dir } = await makeFieldLedger("cathay-canonical-v7-red-field-moved-");
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec(
      "DROP TRIGGER IF EXISTS trg_projection_generation_fields_integrity_insert; DROP TRIGGER IF EXISTS trg_projection_generation_fields_integrity_update",
    );
    const commitId = (
      corrupt
        .prepare(
          "SELECT commit_id FROM canonical_commits ORDER BY commit_sequence LIMIT 1",
        )
        .get() as { commit_id: Uint8Array }
    ).commit_id;
    corrupt
      .prepare(
        `INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id, validated_commit_id, switched_commit_id)
      VALUES (2, 'retired', 3, 'canonical/projection/v1', ?, ?, ?)`,
      )
      .run(Buffer.from(commitId), Buffer.from(commitId), Buffer.from(commitId));
    corrupt.exec(
      "UPDATE projection_generation_transaction_fields SET generation_id = 2 WHERE origin = 'user'",
    );
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /field|complete|projection/i,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /field|complete|projection/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(
    join(tmpdir(), "cathay-canonical-v7-red-old-revision-"),
  );
  try {
    const first = await commitCathayDomesticDeposit(
      dir,
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    );
    await commitCathayDomesticDeposit(dir, {
      ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
      rawResponse: CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(
        '"incomeAmt":12500',
        '"incomeAmt":13000',
      ).replace('"balance":12500', '"balance":13000'),
      observedAt: "2026-08-18T00:00:00+08:00",
    });
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const target = corrupt
      .prepare(
        `SELECT transaction_id, revision_id FROM current_transactions
      WHERE transaction_id IN (SELECT transaction_id FROM transaction_revisions WHERE revision_number = 2) LIMIT 1`,
      )
      .get() as { transaction_id: Uint8Array; revision_id: Uint8Array };
    const oldRevision = corrupt
      .prepare(
        "SELECT revision_id, commit_id FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision_number LIMIT 1",
      )
      .get(Buffer.from(target.transaction_id)) as {
      revision_id: Uint8Array;
      commit_id: Uint8Array;
    };
    corrupt
      .prepare(
        `UPDATE projection_generation_transactions SET revision_id = ?, revision_commit_id = ?
      WHERE generation_id = (SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1) AND transaction_id = ?`,
      )
      .run(
        Buffer.from(oldRevision.revision_id),
        Buffer.from(oldRevision.commit_id),
        Buffer.from(target.transaction_id),
      );
    corrupt.close();
    assert.equal(first.transactions.length, 3);
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /revision|projection|identity|complete/i,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /revision|projection|identity|complete/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const { dir } = await makeFieldLedger(
    "cathay-canonical-v7-red-too-new-commit-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const maxSequence = Number(
      (
        corrupt
          .prepare(
            "SELECT MAX(commit_sequence) AS sequence FROM canonical_commits",
          )
          .get() as { sequence?: number }
      ).sequence ?? 0,
    );
    const tooNew = Buffer.alloc(16, 0x66);
    corrupt
      .prepare(
        "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, 'user/local', 'user_assertion')",
      )
      .run(tooNew, maxSequence + 1, 0);
    corrupt
      .prepare(
        "UPDATE projection_generation_transactions SET projection_commit_id = ? WHERE transaction_id = (SELECT transaction_id FROM projection_generation_transactions LIMIT 1)",
      )
      .run(tooNew);
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /commit|projection|cutoff/i,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /commit|projection|cutoff/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(
    join(tmpdir(), "cathay-canonical-v7-valid-unchanged-fields-"),
  );
  try {
    const source = await commitCathayDomesticDeposit(
      dir,
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    );
    const transactionId = source.transactions[0]!.transactionId;
    const derivedInput = {
      sourceConnectionId: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.sourceConnectionId,
      identityEpoch: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.identityEpoch,
      authorityRoute: "cathay/domestic-deposit/v1",
      stream: "domestic-deposit",
      producerId: "valid-combination-enricher",
      ruleLineage: "valid-combination-rule",
      complete: true as const,
      status: "complete" as const,
      subjectIds: [transactionId],
      fields: ["note" as const],
      scope: [
        {
          transactionId,
          field: "note" as const,
          state: "supported" as const,
          value: "Stable note",
        },
      ],
    };
    const derived = await commitCathayDerivedImportRun(dir, derivedInput);
    const user = await commitCathayUserAssertion(dir, {
      transactionId,
      field: "display_name",
      value: "Stable user label",
    });
    await commitCathayDerivedImportRun(dir, derivedInput);
    const query = createCathayCanonicalFinancialQuery(dir);
    const current = (await query.current({ kind: "current" })).transactions[0]!;
    assert.equal(current.displayLabel, "Stable user label");
    assert.equal(current.note, "Stable note");
    assert.equal(current.displayLabelCommitSequence, user.commitSequence);
    assert.equal(current.noteCommitSequence, derived.commitSequence);
    const readable = openCanonicalDatabase(dir, { readOnly: true });
    try {
      assert.equal(
        readable
          .prepare(
            "SELECT COUNT(*) AS count FROM projection_generation_transaction_fields WHERE origin = 'derived'",
          )
          .get()?.count,
        1,
      );
    } finally {
      readable.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A valid canonical commit is not automatically a valid projection-selection
// commit: an unchanged transaction must retain the source lifecycle commit
// that selected its revision, not an unrelated later Derived/User commit.
{
  const { dir, otherTransactionId } = await makeFieldLedger(
    "cathay-canonical-v7-red-transaction-selection-commit-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const unrelated = (
      corrupt
        .prepare(
          "SELECT commit_id FROM canonical_commits WHERE commit_sequence = 2",
        )
        .get() as { commit_id: Uint8Array }
    ).commit_id;
    corrupt
      .prepare(
        "UPDATE projection_generation_transactions SET projection_commit_id = ? WHERE transaction_id = ?",
      )
      .run(
        Buffer.from(unrelated),
        Buffer.from(otherTransactionId.replaceAll("-", ""), "hex"),
      );
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /selection|projection|commit|provenance/i,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /selection|projection|commit|provenance/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Pointer, generation and current-state fields may all point at a real commit;
// without an append-only switch/knowledge event that commit is still orphaned.
{
  const { dir } = await makeFieldLedger(
    "cathay-canonical-v7-red-orphan-knowledge-commit-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const maxSequence = Number(
      (
        corrupt
          .prepare(
            "SELECT MAX(commit_sequence) AS sequence FROM canonical_commits",
          )
          .get() as { sequence?: number }
      ).sequence ?? 0,
    );
    const orphan = Buffer.alloc(16, 0x77);
    corrupt
      .prepare(
        "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, 'user/local', 'user_assertion')",
      )
      .run(orphan, maxSequence + 1, 0);
    corrupt.exec(
      "DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_update; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_update",
    );
    corrupt
      .prepare(
        "UPDATE projection_generations SET switched_commit_id = ? WHERE status = 'active'",
      )
      .run(orphan);
    corrupt
      .prepare(
        "UPDATE active_projection_generation SET switched_commit_id = ? WHERE singleton_id = 1",
      )
      .run(orphan);
    corrupt
      .prepare(
        "UPDATE current_projection_state SET commit_id = ? WHERE generation = 1",
      )
      .run(orphan);
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /switch|knowledge|provenance|projection/i,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /switch|knowledge|provenance|projection/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The provenance chain is a recovery boundary, not merely an append-only
// convention. Each tamper case disables the normal trigger and must still be
// rejected by the read-only startup verifier and rebuild gate.
for (const [label, corrupt] of [
  [
    "deleted history",
    (db: DatabaseSync) => {
      db.exec("DROP TRIGGER IF EXISTS projection_generation_events_no_delete");
      db.exec("DELETE FROM projection_generation_provenance WHERE ordinal = 4");
    },
  ],
  [
    "wrong digest",
    (db: DatabaseSync) => {
      db.exec("DROP TRIGGER IF EXISTS projection_generation_events_no_update");
      db.exec(
        "UPDATE projection_generation_provenance SET event_digest = randomblob(32) WHERE ordinal = 4",
      );
    },
  ],
  [
    "wrong ordinal",
    (db: DatabaseSync) => {
      db.exec("DROP TRIGGER IF EXISTS projection_generation_events_no_update");
      db.exec(
        "UPDATE projection_generation_provenance SET ordinal = 99 WHERE ordinal = 4",
      );
    },
  ],
  [
    "wrong previous event",
    (db: DatabaseSync) => {
      db.exec("DROP TRIGGER IF EXISTS projection_generation_events_no_update");
      db.exec(
        "UPDATE projection_generation_provenance SET previous_event_id = randomblob(16) WHERE ordinal = 4",
      );
    },
  ],
  [
    "wrong event source",
    (db: DatabaseSync) => {
      db.exec("DROP TRIGGER IF EXISTS projection_generation_events_no_update");
      db.exec(
        "UPDATE projection_generation_provenance SET event_source = 'migration' WHERE ordinal = 4",
      );
    },
  ],
  [
    "wrong commit kind",
    (db: DatabaseSync) => {
      db.exec(
        "UPDATE canonical_commits SET commit_kind = 'source_capture' WHERE commit_kind = 'derived_import'",
      );
    },
  ],
] as Array<[string, (db: DatabaseSync) => void]>) {
  const { dir } = await makeFieldLedger(
    `cathay-canonical-v7-red-chain-${label.replaceAll(" ", "-")}-`,
  );
  try {
    const corruptDb = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt(corruptDb);
    corruptDb.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /chain|provenance|knowledge|digest|commit|source/i,
      label,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /chain|provenance|knowledge|digest|commit|source/i,
      label,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A valid semantic duplicate from a different source must not hide a missing
// or relocated event. The digest is recomputed here so this exercises the
// full-history/source verifier rather than only the digest check.
{
  const { dir } = await makeFieldLedger(
    "cathay-canonical-v7-red-chain-semantic-duplicate-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const last = corrupt
      .prepare(
        `SELECT event_id, commit_id, ordinal FROM projection_generation_provenance
      WHERE generation_id = 1 ORDER BY ordinal DESC LIMIT 1`,
      )
      .get() as {
      event_id: Uint8Array;
      commit_id: Uint8Array;
      ordinal: number;
    };
    const ordinal = Number(last.ordinal) + 1;
    const previous = Buffer.from(last.event_id);
    const commitId = Buffer.from(last.commit_id);
    const duplicateId = Buffer.alloc(16, 0x55);
    const digest = createHash("sha256")
      .update(
        `canonical-projection-provenance/v1|1|${ordinal}|knowledge|migration|${commitId.toString("hex")}|${previous.toString("hex")}`,
        "utf8",
      )
      .digest();
    corrupt
      .prepare(
        `INSERT INTO projection_generation_provenance(event_id, generation_id, ordinal, previous_event_id, event_kind, event_source, commit_id, event_digest)
      VALUES (?, 1, ?, ?, 'knowledge', 'migration', ?, ?)`,
      )
      .run(duplicateId, ordinal, previous, commitId, digest);
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /chain|provenance|knowledge|source/i,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /chain|provenance|knowledge|source/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Moving a correctly shaped event to another generation must invalidate both
// chains, even when foreign keys and the active pointer remain valid.
{
  const { dir } = await makeFieldLedger(
    "cathay-canonical-v7-red-chain-relocation-",
  );
  try {
    await rebuildCathayCanonicalProjection(dir);
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec(
      "DROP TRIGGER IF EXISTS projection_generation_events_no_update",
    );
    corrupt.exec(
      "UPDATE projection_generation_provenance SET generation_id = 2 WHERE generation_id = 1 AND ordinal = 4",
    );
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /chain|provenance|knowledge|generation/i,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /chain|provenance|knowledge|generation/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A pre-chain v7 relation is upgraded in-place and its deterministic chain is
// committed atomically before the writer-open validation gate runs.
{
  const { dir } = await makeFieldLedger("cathay-canonical-v7-chain-migration-");
  try {
    const legacy = new DatabaseSync(canonicalSqlitePath(dir));
    legacy.exec(`PRAGMA foreign_keys = OFF;
      DROP TRIGGER IF EXISTS projection_generation_events_no_update;
      DROP TRIGGER IF EXISTS projection_generation_events_no_delete;
      ALTER TABLE projection_generation_provenance RENAME TO projection_generation_provenance_legacy;
      CREATE TABLE projection_generation_provenance(
        event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16), generation_id INTEGER NOT NULL,
        event_kind TEXT NOT NULL, event_source TEXT NOT NULL, commit_id BLOB NOT NULL
      );
      INSERT INTO projection_generation_provenance(event_id, generation_id, event_kind, event_source, commit_id)
        SELECT event_id, generation_id, event_kind, event_source, commit_id FROM projection_generation_provenance_legacy;
      DROP TABLE projection_generation_provenance_legacy;
      DELETE FROM canonical_contract_purge_commits;
      DELETE FROM canonical_contract_purges;
      DELETE FROM schema_migrations WHERE version > 7;
      PRAGMA user_version = 7;`);
    legacy.close();
    const writer = openCanonicalDatabase(dir);
    writer.close();
    const migrated = openCanonicalDatabase(dir, { readOnly: true });
    try {
      assert.equal(
        migrated
          .prepare(
            "SELECT COUNT(*) AS count FROM projection_generation_provenance WHERE ordinal IS NULL OR event_digest IS NULL",
          )
          .get()?.count,
        0,
      );
      assert.equal(
        migrated
          .prepare(
            "SELECT COUNT(*) AS count FROM projection_generation_provenance WHERE previous_event_id IS NULL",
          )
          .get()?.count,
        1,
      );
    } finally {
      migrated.close();
    }
    const immutable = new DatabaseSync(canonicalSqlitePath(dir));
    assert.throws(
      () =>
        immutable.exec(
          "UPDATE projection_generation_provenance SET event_source = 'routine' WHERE ordinal = 1",
        ),
      /append-only/i,
    );
    assert.throws(
      () =>
        immutable.exec(
          "DELETE FROM projection_generation_provenance WHERE ordinal = 1",
        ),
      /append-only/i,
    );
    immutable.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A genuine legacy chain may have lost an early phase row. Migration must
// reconstruct the complete ordered chain from generation state before the
// writer-open gate, rather than appending `created` after later phases.
{
  const { dir } = await makeFieldLedger(
    "cathay-canonical-v7-chain-migration-missing-phase-",
  );
  try {
    const legacy = new DatabaseSync(canonicalSqlitePath(dir));
    legacy.exec(`PRAGMA foreign_keys = OFF;
      DROP TRIGGER IF EXISTS projection_generation_events_no_update;
      DROP TRIGGER IF EXISTS projection_generation_events_no_delete;
      DELETE FROM projection_generation_provenance WHERE event_kind = 'created';
      ALTER TABLE projection_generation_provenance RENAME TO projection_generation_provenance_legacy;
      CREATE TABLE projection_generation_provenance(
        event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16), generation_id INTEGER NOT NULL,
        event_kind TEXT NOT NULL, event_source TEXT NOT NULL, commit_id BLOB NOT NULL
      );
      INSERT INTO projection_generation_provenance(event_id, generation_id, event_kind, event_source, commit_id)
        SELECT event_id, generation_id, event_kind, event_source, commit_id FROM projection_generation_provenance_legacy;
      DROP TABLE projection_generation_provenance_legacy;
      DELETE FROM canonical_contract_purge_commits;
      DELETE FROM canonical_contract_purges;
      DELETE FROM schema_migrations WHERE version > 7;
      PRAGMA user_version = 7;`);
    legacy.close();
    const writer = openCanonicalDatabase(dir);
    writer.close();
    const migrated = openCanonicalDatabase(dir, { readOnly: true });
    try {
      assert.deepEqual(
        (
          migrated
            .prepare(
              "SELECT event_kind FROM projection_generation_provenance WHERE generation_id = 1 ORDER BY ordinal",
            )
            .all() as Array<{ event_kind: string }>
        )
          .map((row) => row.event_kind)
          .slice(0, 3),
        ["created", "validated", "switched"],
      );
    } finally {
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Trigger names are part of the recovery contract: two present triggers with
// swapped operations are not equivalent to the required update/delete pair.
{
  const { dir } = await makePopulatedLedger(
    "cathay-canonical-v7-red-trigger-definition-",
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec(`DROP TRIGGER projection_generation_events_no_update;
      DROP TRIGGER projection_generation_events_no_delete;
      CREATE TRIGGER projection_generation_events_no_update
      BEFORE DELETE ON projection_generation_provenance
      BEGIN SELECT RAISE(ABORT, 'projection generation provenance is append-only'); END;
      CREATE TRIGGER projection_generation_events_no_delete
      BEFORE UPDATE ON projection_generation_provenance
      BEGIN SELECT RAISE(ABORT, 'projection generation provenance is append-only'); END;`);
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /trigger|append-only|provenance/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A committed candidate without a switch is never a recoverable active
// generation. It must block both read-only startup and a subsequent rebuild;
// the writer must not silently retire or delete it.
for (const [status, phaseCount] of [
  ["building", 1],
  ["validated", 2],
] as const) {
  const { dir } = await makeFieldLedger(
    `cathay-canonical-v7-red-stray-${status}-`,
  );
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const maxSequence = Number(
      (
        corrupt
          .prepare(
            "SELECT MAX(commit_sequence) AS sequence FROM canonical_commits",
          )
          .get() as { sequence?: number }
      ).sequence ?? 0,
    );
    const commitId = Buffer.alloc(16, status === "building" ? 0x71 : 0x72);
    corrupt
      .prepare(
        "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, 'canonical/projection/v1', 'projection_rebuild')",
      )
      .run(commitId, maxSequence + 1, 0);
    corrupt
      .prepare(
        `INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id, validated_commit_id)
      VALUES (2, ?, ?, 'canonical/projection/v1', ?, ?)`,
      )
      .run(status, maxSequence, commitId, phaseCount === 2 ? commitId : null);
    const createdId = Buffer.alloc(16, status === "building" ? 0x81 : 0x82);
    const createdDigest = createHash("sha256")
      .update(
        `canonical-projection-provenance/v1|2|1|created|rebuild|${commitId.toString("hex")}|`,
        "utf8",
      )
      .digest();
    corrupt
      .prepare(
        `INSERT INTO projection_generation_provenance(event_id, generation_id, ordinal, previous_event_id, event_kind, event_source, commit_id, event_digest)
      VALUES (?, 2, 1, NULL, 'created', 'rebuild', ?, ?)`,
      )
      .run(createdId, commitId, createdDigest);
    if (phaseCount === 2) {
      const validatedId = Buffer.alloc(16, 0x83);
      const validatedDigest = createHash("sha256")
        .update(
          `canonical-projection-provenance/v1|2|2|validated|rebuild|${commitId.toString("hex")}|${createdId.toString("hex")}`,
          "utf8",
        )
        .digest();
      corrupt
        .prepare(
          `INSERT INTO projection_generation_provenance(event_id, generation_id, ordinal, previous_event_id, event_kind, event_source, commit_id, event_digest)
        VALUES (?, 2, 1 + 1, ?, 'validated', 'rebuild', ?, ?)`,
        )
        .run(validatedId, createdId, commitId, validatedDigest);
    }
    corrupt.close();
    assert.throws(
      () => openCanonicalDatabase(dir, { readOnly: true }),
      /building|validated|recovery|generation/i,
      status,
    );
    await assert.rejects(
      () => rebuildCathayCanonicalProjection(dir),
      /building|validated|recovery|generation/i,
      status,
    );
    const unchanged = new DatabaseSync(canonicalSqlitePath(dir), {
      readOnly: true,
    });
    try {
      assert.equal(
        unchanged
          .prepare(
            "SELECT COUNT(*) AS count FROM projection_generations WHERE generation_id > 1",
          )
          .get()?.count,
        1,
      );
      assert.equal(
        unchanged
          .prepare(
            "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
          )
          .get()?.generation_id,
        1,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
