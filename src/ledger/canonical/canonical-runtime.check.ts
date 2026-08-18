import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CANONICAL_SCHEMA_VERSION,
  canonicalSqlitePath,
  commitCathayDomesticDeposit,
  commitCathayDerivedImportRun,
  commitCathayUserAssertion,
  createCathayCanonicalFinancialQuery,
  openCanonicalDatabase,
  rebuildCathayCanonicalProjection,
} from "./cathay-domestic-deposit.ts";
import { CanonicalBusyRetryExhaustedError } from "./canonical-runtime.ts";

const ledgerDir = await mkdtemp(join(tmpdir(), "cathay-canonical-v7-runtime-"));
try {
  const first = await commitCathayDomesticDeposit(ledgerDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), CANONICAL_SCHEMA_VERSION);
    assert.equal(String(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toLowerCase(), "wal");
    assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA synchronous").get()?.synchronous, 2);
    assert.deepEqual(db.prepare("SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1").get()?.generation_id, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM projection_generation_transactions WHERE generation_id = 1").get()?.count, first.transactions.length);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM current_transactions").get()?.count, first.transactions.length);
  } finally { db.close(); }

  const query = createCathayCanonicalFinancialQuery(ledgerDir);
  const before = await query.current({ kind: "current" });
  const rebuilt = await rebuildCathayCanonicalProjection(ledgerDir);
  assert.equal(rebuilt.previousGeneration, 1);
  assert.equal(rebuilt.generation, 2);
  assert.equal((await query.current({ kind: "current" })).transactions.length, before.transactions.length);

  const switched = openCanonicalDatabase(ledgerDir, { readOnly: true });
  let activeGeneration = 0;
  try {
    activeGeneration = Number(switched.prepare("SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1").get()?.generation_id);
    assert.equal(activeGeneration, rebuilt.generation);
    assert.equal(switched.prepare("SELECT status FROM projection_generations WHERE generation_id = ?").get(activeGeneration)?.status, "active");
    assert.equal(switched.prepare("SELECT status FROM projection_generations WHERE generation_id = 1").get()?.status, "retired");
  } finally { switched.close(); }

  await assert.rejects(() => rebuildCathayCanonicalProjection(ledgerDir, { injectFailure: "validation" }), /Injected projection rebuild failure/);
  const afterFailure = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    assert.equal(Number(afterFailure.prepare("SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1").get()?.generation_id), activeGeneration);
    assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM projection_generations WHERE status = 'building'").get()?.count, 0);
  } finally { afterFailure.close(); }

  const lock = new DatabaseSync(canonicalSqlitePath(ledgerDir));
  lock.exec("PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
  const retried = commitCathayDomesticDeposit(ledgerDir, { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, observedAt: "2026-08-18T00:00:00+08:00" }, { runtime: { busyTimeoutMs: 1, maxAttempts: 10, initialBackoffMs: 1, maxBackoffMs: 4 } });
  setTimeout(() => lock.exec("COMMIT"), 10);
  await retried;
  lock.close();
  const exhausted = new DatabaseSync(canonicalSqlitePath(ledgerDir));
  exhausted.exec("PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
  await assert.rejects(() => commitCathayDomesticDeposit(ledgerDir, { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, observedAt: "2026-08-19T00:00:00+08:00" }, { runtime: { busyTimeoutMs: 1, maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1 } }), CanonicalBusyRetryExhaustedError);
  exhausted.exec("ROLLBACK");
  exhausted.close();

  const newer = new DatabaseSync(canonicalSqlitePath(ledgerDir));
  try { newer.exec("PRAGMA user_version = 8"); } finally { newer.close(); }
  assert.throws(() => openCanonicalDatabase(ledgerDir), /newer than supported/);
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}

async function makePopulatedLedger(prefix: string): Promise<{ dir: string; commitId: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await commitCathayDomesticDeposit(dir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const db = new DatabaseSync(canonicalSqlitePath(dir), { readOnly: true });
  try {
    return { dir, commitId: Buffer.from((db.prepare("SELECT commit_id FROM canonical_commits ORDER BY commit_sequence LIMIT 1").get() as { commit_id: Uint8Array }).commit_id) };
  } finally { db.close(); }
}

async function makeFieldLedger(prefix: string): Promise<{ dir: string; transactionId: string; otherTransactionId: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const source = await commitCathayDomesticDeposit(dir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
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
    scope: [{ transactionId, field: "display_name", state: "supported", value: "Red test label" }],
  });
  await commitCathayUserAssertion(dir, { transactionId, field: "display_name", value: "Red test user label" });
  return { dir, transactionId, otherTransactionId };
}

// These are deliberately isolated red cases: each corrupts a copy of an otherwise
// valid ledger, so a startup gate cannot be accidentally masked by a prior case.
{
  const { dir } = await makePopulatedLedger("cathay-canonical-v7-red-arithmetic-");
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec("UPDATE transaction_revisions SET amount_coefficient = '12abc'");
    corrupt.close();
    assert.throws(() => openCanonicalDatabase(dir, { readOnly: true }), /exact arithmetic|decimal/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  const { dir, commitId } = await makePopulatedLedger("cathay-canonical-v7-red-route-");
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.prepare("INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?)").run("evil/route", "evil", "domestic-deposit", "evil/v1", commitId);
    corrupt.prepare("UPDATE source_captures SET authority_route = 'evil/route'").run();
    corrupt.close();
    assert.throws(() => openCanonicalDatabase(dir, { readOnly: true }), /authority|route/i);
    assert.rejects(() => rebuildCathayCanonicalProjection(dir), /authority|route/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  const { dir, commitId } = await makePopulatedLedger("cathay-canonical-v7-red-active-");
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.prepare(`INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id, validated_commit_id, switched_commit_id)
      VALUES (2, 'active', 1, 'canonical/projection/v1', ?, ?, ?)`).run(commitId, commitId, commitId);
    corrupt.close();
    assert.throws(() => openCanonicalDatabase(dir, { readOnly: true }), /active projection/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  const { dir } = await makePopulatedLedger("cathay-canonical-v7-red-pointer-null-");
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec("DROP TRIGGER trg_active_projection_generation_switch_update; DROP TRIGGER trg_active_projection_generation_commit_update");
    corrupt.exec("UPDATE active_projection_generation SET switched_commit_id = NULL");
    corrupt.close();
    assert.throws(() => openCanonicalDatabase(dir, { readOnly: true }), /pointer|switch|projection state/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  const dir = await mkdtemp(join(tmpdir(), "cathay-canonical-v7-red-pointer-mismatch-"));
  try {
    const first = await commitCathayDomesticDeposit(dir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    await commitCathayDomesticDeposit(dir, { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, observedAt: "2026-08-18T00:00:00+08:00" });
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const ids = corrupt.prepare("SELECT commit_id FROM canonical_commits ORDER BY commit_sequence").all() as Array<{ commit_id: Uint8Array }>;
    assert.equal(ids.length >= 2, true);
    corrupt.exec("DROP TRIGGER trg_active_projection_generation_commit_update");
    corrupt.prepare("UPDATE active_projection_generation SET switched_commit_id = ?").run(Buffer.from(ids[0]!.commit_id));
    corrupt.close();
    assert.throws(() => openCanonicalDatabase(dir, { readOnly: true }), /pointer|switch|projection state/i);
    assert.equal(first.commitSequence, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  const { dir } = await makePopulatedLedger("cathay-canonical-v7-exact-valid-");
  try {
    const largeSigned = "-123456789012345678901234567890123456789";
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.prepare("UPDATE transaction_revisions SET amount_coefficient = ?, amount_scale = 2").run(largeSigned);
    corrupt.close();
    const readable = openCanonicalDatabase(dir, { readOnly: true });
    readable.close();
    const rebuilt = await rebuildCathayCanonicalProjection(dir);
    assert.equal(rebuilt.status, "switched");
    const query = createCathayCanonicalFinancialQuery(dir);
    assert.equal((await query.current({ kind: "current" })).transactions[0]?.amount.coefficient, largeSigned);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// A latest revision can be structurally valid while its Source Assertion is
// missing. Rebuild population must report the missing identity rather than
// silently dropping it through an inner join.
{
  const { dir } = await makePopulatedLedger("cathay-canonical-v7-red-completeness-");
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    const sourceRevision = corrupt.prepare("SELECT revision_id FROM transaction_revisions ORDER BY revision_number, revision_id LIMIT 1").get() as { revision_id: Uint8Array };
    const columns = (corrupt.prepare("PRAGMA table_info(transaction_revisions)").all() as Array<{ name: string }>).map((column) => column.name);
    const expressions = columns.map((column) => column === "revision_id" ? "randomblob(16)" : column === "commit_id" ? "?" : column === "revision_number" ? "99" : column);
    const maxSequence = Number((corrupt.prepare("SELECT MAX(commit_sequence) AS sequence FROM canonical_commits").get() as { sequence?: number }).sequence ?? 0);
    const commitId = Buffer.alloc(16, 0x44);
    corrupt.prepare("INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'source_capture')").run(commitId, maxSequence + 1, 0, "cathay/domestic-deposit/v1");
    corrupt.prepare(`INSERT INTO transaction_revisions(${columns.join(", ")}) SELECT ${expressions.join(", ")} FROM transaction_revisions WHERE revision_id = ?`).run(commitId, Buffer.from(sourceRevision.revision_id));
    corrupt.close();
    const valid = openCanonicalDatabase(dir, { readOnly: true });
    valid.close();
    await assert.rejects(() => rebuildCathayCanonicalProjection(dir), /complete|missing|identity|projection/i);
    const after = new DatabaseSync(canonicalSqlitePath(dir), { readOnly: true });
    try {
      assert.equal(after.prepare("SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1").get()?.generation_id, 1);
      assert.equal(after.prepare("SELECT COUNT(*) AS count FROM projection_generations WHERE status = 'building'").get()?.count, 0);
    } finally { after.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

for (const [label, corruptField] of [
  ["user assertion used as derived", (db: DatabaseSync) => db.exec("UPDATE projection_generation_transaction_fields SET origin = 'derived', derived_assertion_id = user_assertion_id, user_assertion_id = NULL WHERE origin = 'user'")],
  ["source assertion used as user", (db: DatabaseSync) => {
    const source = db.prepare("SELECT assertion_id FROM assertions WHERE origin = 'source' LIMIT 1").get() as { assertion_id: Uint8Array };
    db.prepare("UPDATE projection_generation_transaction_fields SET origin = 'user', user_assertion_id = ?, derived_assertion_id = NULL WHERE origin = 'user'").run(Buffer.from(source.assertion_id));
  }],
  ["field row points at another transaction", (db: DatabaseSync, otherTransactionId?: string) => db.prepare("UPDATE projection_generation_transaction_fields SET transaction_id = ? WHERE origin = 'user'").run(Buffer.from(otherTransactionId!.replaceAll("-", ""), "hex"))],
  ["field key disagrees with assertion", (db: DatabaseSync) => db.exec("UPDATE projection_generation_transaction_fields SET field_name = 'note' WHERE origin = 'user'")],
  ["field projection commit disagrees with generation", (db: DatabaseSync) => db.exec("UPDATE projection_generation_transaction_fields SET projection_commit_id = (SELECT commit_id FROM canonical_commits ORDER BY commit_sequence LIMIT 1) WHERE origin = 'user'")],
] as Array<[string, (db: DatabaseSync, otherTransactionId?: string) => void]>) {
  const { dir, otherTransactionId } = await makeFieldLedger(`cathay-canonical-v7-red-field-${label.replaceAll(" ", "-")}-`);
  try {
    const corrupt = new DatabaseSync(canonicalSqlitePath(dir));
    corrupt.exec("DROP TRIGGER IF EXISTS trg_projection_generation_fields_integrity_insert; DROP TRIGGER IF EXISTS trg_projection_generation_fields_integrity_update");
    corruptField(corrupt, otherTransactionId);
    corrupt.close();
    assert.throws(() => openCanonicalDatabase(dir, { readOnly: true }), /field|assertion|projection|origin|generation/i, label);
    await assert.rejects(() => rebuildCathayCanonicalProjection(dir), /field|assertion|projection|origin|generation/i, label);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
