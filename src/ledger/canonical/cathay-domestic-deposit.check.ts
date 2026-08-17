import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_PROVENANCE,
  commitCathayDomesticDeposit,
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
  } finally {
    db.close();
  }

  const query = createCathayCanonicalFinancialQuery(ledgerDir);
  const current = await query.current({ kind: "current" });
  assert.equal(current.transactions.length, 3);
  assert.equal(current.transactions[0]?.currency, "TWD");
  assert.equal(current.transactions[0]?.postingStatus, "posted");
  assert.equal(current.transactions[0]?.timeZone, "Asia/Taipei");
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

for (const [label, capture] of [
  ["wrong currency", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, currency: "USD" }],
  ["legacy return code", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"returnCode":"0000"', '"returnCode":"000"') }],
  ["count mismatch", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"count":3', '"count":2') }],
  ["query failure", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"queryStatus":"Success"', '"queryStatus":"Failed"') }],
  ["duplicate sequence", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"sequenceNumber":2', '"sequenceNumber":1') }],
  ["missing sequence", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"sequenceNumber":1,', '') }],
  ["ambiguous direction", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"incomeAmt":null', '"incomeAmt":100') }],
  ["missing date", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"accountDate":"2026-07-01"', '"accountDate":null') }],
  ["scope mismatch", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, scope: { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope, endDate: "2026-08-16" } }],
  ["invalid authority", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, authorityRoute: "cathay/domestic-deposit/other" }],
  ["non-exact amount", { ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE, rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"incomeAmt":12500', '"incomeAmt":1.25e4') }],
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
