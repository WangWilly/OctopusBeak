import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
} from "../../../ledger/canonical/canonical-source-store.ts";
import {
  applyCanonicalTransactionTag,
  commitCanonicalAutomaticEnrichmentRun,
  commitCanonicalCounterpartyDisplay,
  createCanonicalTransactionTag,
} from "../../../ledger/canonical/canonical-enrichment.ts";
import { createCanonicalProjectionRuntime } from "../../../ledger/canonical/canonical-projection-runtime.ts";
import { openCanonicalDatabase } from "../../../ledger/canonical/canonical-database.ts";
import { blob, idToString } from "../../../ledger/canonical/canonical-schema-implementation.ts";
import { seedMockLedger } from "../../../ledger/seed-mock-ledger-db.ts";
import { activeImportSql } from "../../data-issues/server/ledger-visibility.ts";
import { loadSpending } from "./store.ts";

test("Spending loader uses the canonical report and exposes eligibility gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spending-canonical-store-"));
  try {
    await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    const before = loadSpending(directory);
    assert.ok(before.canonical);
    assert.equal(before.canonical.policy.id, "gross-posted-outflow");
    assert.equal(before.canonical.policy.version, "v1");
    assert.equal(before.canonical.reportEligibility.status, "incomplete");
    assert.equal(before.canonical.reportEligibility.gapCount, 3);
    assert.deepEqual(
      before.canonical.reportEligibility.gapAmountByCurrency.map((amount) => amount.exact),
      [{ coefficient: "13600", scale: 0 }],
    );
    assert.equal(before.canonical.unclassifiedByCurrency.length, 0);

    const db = openCanonicalDatabase(directory, { readOnly: true });
    const transactions = createCanonicalProjectionRuntime(db).read({
      kind: "current",
      families: ["transactions"],
      scope: { startDate: "1900-01-01", endDate: "2999-12-31" },
    }).families.transactions;
    const outflow = transactions.find((row) => row.direction === "outflow");
    assert.ok(outflow);
    const sourceRows = transactions.map((transaction) => {
      const transactionId = Buffer.from(transaction.transactionId, "hex");
      const sourceRecord = db.prepare(`
      SELECT revision.source_record_id
        FROM current_transactions current_row
        JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
       WHERE current_row.transaction_id = ?
      `).get(blob(transactionId)) as { source_record_id: Uint8Array };
      return {
        transactionId: idToString(transactionId),
        sourceRecordId: idToString(sourceRecord.source_record_id),
      };
    });
    const connection = db.prepare(`
      SELECT connection.source_connection_key
        FROM financial_transactions transaction_row
        JOIN financial_accounts account ON account.account_id = transaction_row.account_id
        JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
       WHERE transaction_row.transaction_id = ?
    `).get(blob(Buffer.from(outflow.transactionId, "hex"))) as { source_connection_key: string };
    db.close();

    await commitCanonicalAutomaticEnrichmentRun(directory, {
      sourceConnectionKey: connection.source_connection_key,
      stream: "domestic-deposit",
      ruleLineage: "test/spending/canonical-kind",
      declaredSubjects: sourceRows.map(({ transactionId }) => ({ transactionId, fields: ["kind"] })),
      outputs: sourceRows.map(({ transactionId, sourceRecordId }) => ({
        transactionId,
        field: "kind",
        origin: "derived",
        value: "purchase",
        confidenceBasisPoints: 10_000,
        evidence: {
          kind: "description",
          sourceRecordId,
          sourceValue: "synthetic spending purchase",
          contractVersion: "test/spending/v1",
        },
      })),
    });

    const loaded = loadSpending(directory, { selectedMonth: "2026-07" });
    assert.ok(loaded.canonical);
    assert.equal(loaded.canonical.reportEligibility.status, "complete");
    assert.deepEqual(loaded.canonical.totalsByCurrency.map((amount) => amount.exact), [
      { coefficient: "300", scale: 0 },
    ]);
    assert.deepEqual(loaded.canonical.unclassifiedByCurrency.map((amount) => amount.exact), [
      { coefficient: "300", scale: 0 },
    ]);
    assert.equal(loaded.canonical.classificationCoverage.unclassifiedCount, 1);
    const loadedOutflow = loaded.canonical.includedTransactions.find(
      (record) => record.amount.exact.coefficient === "300",
    );
    assert.ok(loadedOutflow);
    assert.equal(loadedOutflow.category.mode, "absent");
    assert.equal(loadedOutflow.display.status, "fallback");
    assert.equal(loadedOutflow.display.kind, "source_description");
    assert.equal(loadedOutflow.display.label, "Synthetic Cathay transfer description");

    const display = await commitCanonicalCounterpartyDisplay(directory, {
      transactionId: idToString(Buffer.from(outflow.transactionId, "hex")),
      action: "override",
      label: "Canonical Cafe",
      userId: "fixture-user",
    });
    const tag = await createCanonicalTransactionTag(directory, {
      label: "reviewed",
      userId: "fixture-user",
    });
    await applyCanonicalTransactionTag(directory, {
      tagId: tag.tagId,
      transactionId: idToString(Buffer.from(outflow.transactionId, "hex")),
      userId: "fixture-user",
    });
    assert.equal(display.status, "committed");
    const enriched = loadSpending(directory).canonical!.includedTransactions.find(
      (record) => record.amount.exact.coefficient === "300",
    );
    assert.equal(enriched?.display.label, "Canonical Cafe");
    assert.equal(enriched?.display.kind, "override");
    assert.deepEqual(enriched?.tags.map((value) => value.label), ["reviewed"]);
    assert.equal(loaded.invoices.length, 0);
    assert.equal(loaded.accountRecords.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Spending does not fall back to legacy rows when canonical data is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spending-canonical-empty-"));
  try {
    seedMockLedger(directory, new Date("2026-07-11T04:00:00.000Z"));
    const loaded = loadSpending(directory);
    assert.ok(loaded.canonical);
    assert.equal(loaded.canonical.availability, "empty");
    assert.deepEqual(loaded.canonical.transactions, []);
    assert.deepEqual(loaded.invoices, []);
    assert.deepEqual(loaded.accountRecords, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

assert.throws(() => activeImportSql("invoices; DROP TABLE personal_invoices"), /Unsafe SQL alias/);
