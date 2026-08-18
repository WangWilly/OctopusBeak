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
