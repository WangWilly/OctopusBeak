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
