import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  CANONICAL_SCHEMA_VERSION,
  CATHAY_POSTING_MAPPING,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_PROVENANCE,
  commitCathayDomesticDeposit,
  canonicalSqlitePath,
  createCathayCanonicalFinancialQuery,
  openCanonicalDatabase,
  parseExactDecimalLexeme,
} from "./cathay-domestic-deposit.ts";
import { createCathayCanonicalFinancialQuery as createBoundaryCanonicalQuery } from "../../lib/shared-ledger/server/financial-query.ts";

assert.deepEqual(parseExactDecimalLexeme("123.4500"), {
  coefficient: 1234500n,
  scale: 4,
});
assert.throws(() => parseExactDecimalLexeme("1e3"), /exact decimal/);
assert.equal(CATHAY_DOMESTIC_DEPOSIT_PROVENANCE.values, "synthetic");
assert.equal(CATHAY_DOMESTIC_DEPOSIT_PROVENANCE.liveResponseRetained, false);

const workflowSource = readFileSync(new URL("../../workflows/cathay-statements.ts", import.meta.url), "utf8");
assert.match(workflowSource, /fetchTransferDetailsRaw/);
assert.match(workflowSource, /response\.text\(\)/);
assert.match(workflowSource, /fetchTransferDetailsRaw[\s\S]*JSON\.parse/);

const ledgerDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-"));
try {
  const first = await commitCathayDomesticDeposit(ledgerDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  assert.equal(first.transactions.length, 3);
  assert.equal(first.transactions[0]?.direction, "inflow");
  assert.deepEqual(first.transactions[0]?.amount, { coefficient: "12500", scale: 0 });

  const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    for (const [table, expected] of [
      ["canonical_commits", 1],
      ["source_connections", 1],
      ["identity_epochs", 1],
      ["source_captures", 1],
      ["source_records", 3],
      ["financial_accounts", 1],
      ["financial_transactions", 3],
      ["transaction_revisions", 3],
      ["source_assertions", 3],
      ["source_sync_states", 1],
      ["current_transactions", 3],
    ] as const) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, expected, table);
    }
    const commitRow = db.prepare("SELECT commit_id, recorded_at_utc_us FROM canonical_commits").get() as Record<string, unknown>;
    assert.equal(commitRow.commit_id instanceof Uint8Array, true);
    assert.equal((commitRow.commit_id as Uint8Array).byteLength, 16);
    assert.equal(typeof commitRow.recorded_at_utc_us, "number");
    assert.equal(Number.isInteger(commitRow.recorded_at_utc_us), true);
    assert.equal(db.prepare("SELECT commit_kind FROM canonical_commits").get()?.commit_kind, "source_capture");
    const captureRow = db.prepare("SELECT capture_id, commit_id FROM source_captures").get() as Record<string, unknown>;
    assert.equal(captureRow.capture_id instanceof Uint8Array, true);
    assert.equal(captureRow.commit_id instanceof Uint8Array, true);
    const revisionColumns = db.prepare("PRAGMA table_info(transaction_revisions)").all() as Array<{ name?: string }>;
    assert.equal(revisionColumns.some((column) => column.name === "balance_coefficient"), false);
    assert.equal(revisionColumns.some((column) => column.name === "balance_scale"), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM current_transactions WHERE commit_id IS NOT NULL").get()?.count, 3);
    assert.equal(db.prepare("SELECT cursor FROM source_sync_states").get()?.cursor, null);
    assert.deepEqual({ ...(db.prepare("SELECT completeness, completeness_basis, completeness_rule_version FROM source_captures").get() as Record<string, unknown>) }, {
      completeness: "complete-range",
      completeness_basis: "success-status-scope-count-details",
      completeness_rule_version: "cathay/domestic-deposit/v1",
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transaction_time_observations").get()?.count, 6);
    assert.deepEqual((db.prepare("SELECT role, local_value, time_precision, time_origin FROM transaction_time_observations ORDER BY role, local_value LIMIT 2").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })), [
      { role: "accounting", local_value: "2026-07-01", time_precision: "date", time_origin: "source_reported" },
      { role: "accounting", local_value: "2026-07-02", time_precision: "date", time_origin: "source_reported" },
    ]);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name?: string }>).map((row) => row.name);
    for (const index of ["idx_transaction_revisions_financial_time", "idx_transaction_revisions_knowledge_time", "idx_current_transactions_revision", "idx_transaction_revisions_lineage", "idx_assertion_provenance_record"]) {
      assert.equal(indexes.includes(index), true, index);
    }
  } finally {
    db.close();
  }

  const query = createCathayCanonicalFinancialQuery(ledgerDir);
  const current = await query.current({ kind: "current" });
  assert.equal(current.transactions.length, 3);
  assert.equal(current.transactions[0]?.currency, "TWD");
  assert.equal(current.transactions[0]?.postingStatus, "posted");
  assert.equal(current.transactions[0]?.postingOrigin, CATHAY_POSTING_MAPPING.origin);
  assert.equal(current.transactions[0]?.postingBasis, CATHAY_POSTING_MAPPING.basis);
  assert.equal(current.transactions[0]?.postingRuleVersion, CATHAY_POSTING_MAPPING.ruleVersion);
  assert.equal(current.transactions[0]?.displayLabel, "Synthetic Cathay deposit description");
  assert.equal(current.transactions[0]?.effectiveTimeBasis, "accounting");
  assert.equal(current.transactions[0]?.timeZone, "Asia/Taipei");
  assert.equal(current.transactions[0]?.timePrecision, "second");
  assert.equal(current.transactions[0]?.timeOrigin, "source_reported");
  assert.equal(current.transactions[0]?.utcInstantUtcUs, new Date("2026-07-01T09:00:00+08:00").getTime() * 1000);
  assert.equal("balance" in (current.transactions[0] ?? {}), false);
  assert.equal(current.transactions[0]?.effectiveOn, "2026-07-01");
  assert.equal(current.transactions[0]?.id, first.transactions[0]?.transactionId);

  const historicalBeforeCommit = await query.historical({
    kind: "historical",
    cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(first.commitSequence - 1) },
  });
  assert.equal(historicalBeforeCommit.transactions.length, 0);
  const historical = await query.historical({
    kind: "historical",
    cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(first.commitSequence) },
  });
  assert.equal(historical.transactions.length, 3);
  assert.equal(historical.transactions[0]?.id, current.transactions[0]?.id);

  const lineage = await query.lineage({
    kind: "lineage",
    subject: { kind: "transaction", id: current.transactions[0]!.id },
  });
  assert.equal(lineage.entries.length, 1);
  assert.equal(lineage.entries[0]?.revision.transactionId, current.transactions[0]?.id);
  assert.equal(lineage.entries[0]?.assertion.revisionId, lineage.entries[0]?.revision.id);
  assert.equal(lineage.entries[0]?.sourceRecord.captureId, lineage.entries[0]?.capture.id);
  assert.equal(lineage.entries[0]?.capture.authorityRoute, CATHAY_DOMESTIC_DEPOSIT_FIXTURE.authorityRoute);
  assert.equal(lineage.entries[0]?.sourceRecord.description, "Synthetic Cathay deposit description");

  const repeated = await commitCathayDomesticDeposit(ledgerDir, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    observedAt: "2026-08-18T00:00:00+08:00",
  });
  assert.equal(repeated.transactions.filter((transaction) => transaction.revisionCreated).length, 0);
  const repeatDb = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 2);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM source_records").get()?.count, 6);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM financial_transactions").get()?.count, 3);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM transaction_revisions").get()?.count, 3);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM source_assertions").get()?.count, 3);
    assert.equal(repeatDb.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count, 6);
  } finally {
    repeatDb.close();
  }

  const boundaryQuery = createBoundaryCanonicalQuery(ledgerDir);
  assert.equal((await boundaryQuery.current({ kind: "current" })).transactions.length, 3);
  assert.equal((await boundaryQuery.historical({
    kind: "historical",
    cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(repeated.commitSequence) },
  })).transactions.length, 3);
  assert.equal((await boundaryQuery.lineage({
    kind: "lineage",
    subject: { kind: "transaction", id: first.transactions[0]!.transactionId },
  })).entries.length, 1);
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}

const blockStart = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.indexOf('{"queryStatus"');
const blockEnd = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.lastIndexOf("}]}}") + 1;
const singleResultBlock = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.slice(blockStart, blockEnd);
for (const [label, rawResponse] of [
  ["zero result blocks", CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(`[${singleResultBlock}]`, "[]")],
  ["multiple result blocks", CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(`[${singleResultBlock}]`, `[${singleResultBlock},${singleResultBlock}]`)],
] as const) {
  const rejectedDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-result-block-"));
  try {
    assert.throws(() => commitCathayDomesticDeposit(rejectedDir, { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse }), /exactly one transfer result/, label);
    const rejectedDb = openCanonicalDatabase(rejectedDir);
    try {
      assert.equal(rejectedDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 0, label);
      assert.equal(rejectedDb.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 0, label);
    } finally { rejectedDb.close(); }
  } finally { await rm(rejectedDir, { recursive: true, force: true }); }
}

const emptyDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-empty-"));
try {
  const emptyRaw = CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(/"count":3,"startDate":"2025-08-17","endDate":"2026-08-17","details":\[[\s\S]*?\]\}/, '"count":0,"startDate":"2025-08-17","endDate":"2026-08-17","details":[]}');
  const empty = await commitCathayDomesticDeposit(emptyDir, { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: emptyRaw });
  assert.equal(empty.transactions.length, 0);
  const emptyDb = openCanonicalDatabase(emptyDir, { readOnly: true });
  try {
    assert.equal(emptyDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 1);
    assert.equal(emptyDb.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 1);
    assert.equal(emptyDb.prepare("SELECT COUNT(*) AS count FROM current_projection_state").get()?.count, 1);
    for (const table of ["source_records", "financial_transactions", "transaction_revisions", "source_assertions", "current_transactions"]) {
      assert.equal(emptyDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0, table);
    }
  } finally { emptyDb.close(); }
} finally { await rm(emptyDir, { recursive: true, force: true }); }

const completenessDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-completeness-"));
try {
  const result = await commitCathayDomesticDeposit(completenessDir, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    scope: { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope, complete: false },
  });
  assert.equal(result.transactions.length, 3);
  const completenessDb = openCanonicalDatabase(completenessDir, { readOnly: true });
  try {
    assert.equal(completenessDb.prepare("SELECT completeness FROM source_captures").get()?.completeness, "complete-range");
  } finally { completenessDb.close(); }
} finally { await rm(completenessDir, { recursive: true, force: true }); }

const backfillDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-backfill-"));
try {
  const backfill = await commitCathayDomesticDeposit(backfillDir, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    observedAt: "2020-01-01T00:00:00Z",
  }, { clock: () => "2026-08-20T12:00:00.123456Z" });
  const backfillDb = openCanonicalDatabase(backfillDir, { readOnly: true });
  try {
    const knowledge = backfillDb.prepare("SELECT recorded_at_utc_us FROM canonical_commits").get()?.recorded_at_utc_us as number;
    assert.equal(knowledge > new Date("2020-01-01T00:00:00Z").getTime() * 1000, true);
    assert.equal(backfillDb.prepare("SELECT recorded_at_utc_us FROM canonical_commits").get()?.recorded_at_utc_us, 1787227200123456);
  } finally { backfillDb.close(); }
  const backfillQuery = createCathayCanonicalFinancialQuery(backfillDir);
  assert.equal((await backfillQuery.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: "0" } })).transactions.length, 0);
  assert.equal((await backfillQuery.historical({ kind: "historical", cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(backfill.commitSequence) } })).transactions.length, 3);
} finally { await rm(backfillDir, { recursive: true, force: true }); }

const contendedDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-writer-"));
try {
  await Promise.all([
    commitCathayDomesticDeposit(contendedDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE),
    commitCathayDomesticDeposit(contendedDir, { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, observedAt: "2026-08-18T00:00:00+08:00" }),
  ]);
  const contendedDb = openCanonicalDatabase(contendedDir, { readOnly: true });
  try {
    assert.equal(contendedDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 2);
    assert.equal(contendedDb.prepare("SELECT COUNT(*) AS count FROM transaction_revisions").get()?.count, 3);
    assert.equal(contendedDb.prepare("SELECT COUNT(*) AS count FROM assertion_provenance").get()?.count, 6);
  } finally { contendedDb.close(); }
} finally { await rm(contendedDir, { recursive: true, force: true }); }

const newerSchemaDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-schema-"));
try {
  const schemaDb = openCanonicalDatabase(newerSchemaDir);
  schemaDb.exec(`PRAGMA user_version = ${CANONICAL_SCHEMA_VERSION + 1}`);
  schemaDb.close();
  assert.throws(() => openCanonicalDatabase(newerSchemaDir), /newer than supported/);
} finally { await rm(newerSchemaDir, { recursive: true, force: true }); }

const corruptDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-corrupt-"));
try {
  await commitCathayDomesticDeposit(corruptDir, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const corruptDb = new DatabaseSync(canonicalSqlitePath(corruptDir));
  corruptDb.exec("PRAGMA foreign_keys = OFF");
  corruptDb.prepare("UPDATE current_transactions SET commit_id = ?").run(Buffer.alloc(16, 7));
  corruptDb.close();
  assert.throws(() => openCanonicalDatabase(corruptDir, { readOnly: true }), /foreign-key integrity/);
} finally { await rm(corruptDir, { recursive: true, force: true }); }

for (const [label, capture] of [
  ["wrong currency", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, currency: "USD" }],
  ["legacy return code", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"returnCode":"0000"', '"returnCode":"000"') }],
  ["count mismatch", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"count":3', '"count":2') }],
  ["query failure", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"queryStatus":"Success"', '"queryStatus":"Failed"') }],
  ["duplicate sequence", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"sequenceNumber":2', '"sequenceNumber":1') }],
  ["missing sequence", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"sequenceNumber":1,', '') }],
  ["ambiguous direction", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"incomeAmt":null', '"incomeAmt":100') }],
  ["missing date", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"accountDate":"2026-07-01"', '"accountDate":null') }],
  ["invalid local date time", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"txnDateTime":"2026-07-01T09:00:00"', '"txnDateTime":"2026-02-30T09:00:00"') }],
  ["scope mismatch", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, scope: { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope, endDate: "2026-08-16" } }],
  ["invalid authority", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, authorityRoute: "cathay/domestic-deposit/other" }],
  ["non-exact amount", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"incomeAmt":12500', '"incomeAmt":1.25e4') }],
  ["unsupported posting fields", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"description":"Synthetic Cathay deposit description"', '"status":"pending","description":"Synthetic Cathay deposit description"') }],
  ["invalid description type", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"description":"Synthetic Cathay deposit description"', '"description":123') }],
  ["oversized description", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"description":"Synthetic Cathay deposit description"', `"description":"${"x".repeat(513)}"`) }],
  ["timezone-less observedAt", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, observedAt: "2026-08-17T12:00:00" }],
  ["unsafe timestamp microseconds", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, observedAt: "3000-08-17T12:00:00Z" }],
] as const) {
  const rejectedDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-canonical-reject-"));
  try {
    assert.throws(() => commitCathayDomesticDeposit(rejectedDir, capture), /./, label);
    const rejectedDb = openCanonicalDatabase(rejectedDir);
    try {
      assert.equal(rejectedDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 0, label);
      assert.equal(rejectedDb.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 0, label);
    } finally {
      rejectedDb.close();
    }
  } finally {
    await rm(rejectedDir, { recursive: true, force: true });
  }
}
