import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  createCanonicalSourceStore,
} from "../../../ledger/canonical/canonical-source-store.ts";
import { canonicalDatabaseWriterKey } from "../../../ledger/canonical/canonical-database.ts";
import {
  commitCanonicalEInvoiceCapture,
  E_INVOICE_CONTRACT_VERSION,
  E_INVOICE_CURRENCY_AUTHORITY,
  E_INVOICE_ROUTE,
} from "../../../ledger/canonical/einvoice.ts";
import { querySpendingRecognition } from "../../../ledger/canonical/spending-recognition.ts";
import {
  applyCanonicalTransactionTag,
  commitCanonicalAutomaticEnrichmentRun,
  commitCanonicalCounterpartyDisplay,
  createCanonicalTransactionTag,
} from "../../../ledger/canonical/canonical-enrichment.ts";
import { createCanonicalProjectionRuntime } from "../../../ledger/canonical/canonical-projection-runtime.ts";
import { openCanonicalDatabaseHandle } from "../../../ledger/canonical/canonical-database.ts";
import { blob, idToString } from "../../../ledger/canonical/canonical-local-identifier.ts";
import { seedMockLedger } from "../../../ledger/seed-mock-ledger-db.ts";
import {
  confirmSpendingCandidate,
  denySpendingCandidate,
  loadSpending,
  revokeSpendingLink,
} from "./store.ts";
import { applySpendingPurchaseReportPatch } from "../purchase-report-patch.ts";

function withActionReadCounts<T>(ledgerDir: string, operation: () => T): {
  result: T;
  fullProjectionCount: number;
  storeOpenCount: number;
} {
  const projectionDiagnostics = channel("octopus-beak.spending.full-projection");
  const storeDiagnostics = channel("octopus-beak.spending.canonical-store-open");
  let count = 0;
  let storeOpenCount = 0;
  const observer = (message: unknown) => {
    if ((message as { ledgerDir?: unknown }).ledgerDir === ledgerDir) count += 1;
  };
  const storeObserver = (message: unknown) => {
    if ((message as { ledgerDir?: unknown }).ledgerDir === ledgerDir) storeOpenCount += 1;
  };
  projectionDiagnostics.subscribe(observer);
  storeDiagnostics.subscribe(storeObserver);
  try {
    return { result: operation(), fullProjectionCount: count, storeOpenCount };
  } finally {
    projectionDiagnostics.unsubscribe(observer);
    storeDiagnostics.unsubscribe(storeObserver);
  }
}

test("Spending loader uses the canonical report and exposes eligibility gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spending-canonical-store-"));
  try {
    await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    const before = loadSpending(directory);
    assert.ok(before.canonical);
    assert.equal(before.canonical.policy.id, "gross-posted-outflow");
    assert.equal(before.canonical.policy.version, "v1");
    assert.equal(before.canonical.reportEligibility.status, "complete");
    assert.equal(before.canonical.reportEligibility.gapCount, 0);
    assert.deepEqual(
      before.canonical.reportEligibility.gapAmountByCurrency.map((amount) => amount.exact),
      [],
    );
    assert.deepEqual(
      before.canonical.unclassifiedByCurrency.map((amount) => amount.exact),
      [{ coefficient: "300", scale: 0 }],
    );

    const db = openCanonicalDatabaseHandle(directory, { readOnly: true });
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Spending loader returns an empty view for an initialized empty canonical database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spending-canonical-initialized-empty-"));
  try {
    const db = openCanonicalDatabaseHandle(directory);
    db.close();
    const loaded = loadSpending(directory);
    assert.ok(loaded.canonical);
    assert.equal(loaded.canonical.availability, "empty");
    assert.deepEqual(loaded.canonical.transactions, []);
    assert.deepEqual(loaded.canonical.totalsByCurrency, []);
    assert.equal(loaded.canonical.reportEligibility.status, "complete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a canonical E-Invoice admission is visible in Spending without legacy replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spending-canonical-einvoice-"));
  openCanonicalDatabaseHandle(directory).close();
  const store = createCanonicalSourceStore(directory);
  const digest = (suffix: string) => `sha256:${Buffer.from(suffix).toString("base64url")}`;
  const invoice = (
    stableInvoiceKey: string,
    invoiceNumber: string,
    itemComplete: boolean,
  ) => ({
    stableInvoiceKey,
    sourceRevisionKey: `revision:${stableInvoiceKey}:issued`,
    revisionNumber: 1,
    revisionKind: "issued" as const,
    sourceIdentifiers: { invoiceNumber, randomNumber: null },
    seller: { taxId: "11112222", name: "Deidentified Shop" },
    total: {
      coefficient: "120",
      scale: 0,
      currency: "TWD" as const,
      currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
    },
    occurrence: {
      value: "2026-09-10",
      precision: "date" as const,
      timeZone: "Asia/Taipei",
      origin: "source-reported" as const,
    },
    items: [{
      sequence: 1,
      completeness: itemComplete ? "complete" as const : "incomplete" as const,
      name: "Deidentified item",
      quantity: itemComplete ? { coefficient: "1", scale: 0 } : null,
      unitPrice: itemComplete ? {
        coefficient: "120",
        scale: 0,
        currency: "TWD" as const,
        currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
      } : null,
      amount: itemComplete ? {
        coefficient: "120",
        scale: 0,
        currency: "TWD" as const,
        currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
      } : null,
    }],
    authority: { routeKey: E_INVOICE_ROUTE, contractVersion: E_INVOICE_CONTRACT_VERSION },
    provenance: { kind: "fixture" as const, reference: `fixture:${stableInvoiceKey}` },
  });
  try {
    await commitCanonicalEInvoiceCapture(store, {
      captureId: "spending-einvoice-admission",
      sourceConnectionKey: digest("connection"),
      identityEpoch: digest("epoch"),
      subjectDigest: digest("subject"),
      observedAt: "2026-09-10T06:00:00Z",
      scope: {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        kind: "bounded-range",
        completeness: "complete-range",
        invoiceCompleteness: "complete",
        itemCompleteness: "incomplete",
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 2,
        terminal: true,
        metadata: { fixture: "deidentified" },
      }],
      invoices: [
        invoice("invoice-active", "AA00000002", false),
        invoice("invoice-to-revoke", "AA00000003", true),
      ],
    });
    await commitCanonicalEInvoiceCapture(store, {
      captureId: "spending-einvoice-revocation",
      sourceConnectionKey: digest("connection"),
      identityEpoch: digest("epoch"),
      subjectDigest: digest("subject"),
      observedAt: "2026-09-10T06:01:00Z",
      scope: {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        kind: "bounded-range",
        completeness: "complete-range",
        invoiceCompleteness: "complete",
        itemCompleteness: "complete",
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: { fixture: "deidentified-revocation" },
      }],
      invoices: [{
        ...invoice("invoice-to-revoke", "AA00000003", true),
        sourceRevisionKey: "revision:invoice-to-revoke:revoked",
        revisionNumber: 2,
        revisionKind: "revoked",
        total: null,
        items: [],
        provenance: { kind: "provider-revocation", reference: "fixture:revocation" },
        revocationReason: "provider-status:voided",
      }],
    });
  } finally {
    store.close();
  }

  try {
    const loaded = loadSpending(directory);
    assert.deepEqual(loaded.invoices.map((row) => row.invoiceId), ["AA00000002"]);
    assert.equal(loaded.invoices[0]?.items[0]?.completeness, "incomplete");
    assert.equal(loaded.invoices[0]?.items[0]?.paidAmount, null);
    assert.equal(loaded.canonical.transactions.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function seedPurchaseCandidate(directory: string, directOnly = false) {
  await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const db = openCanonicalDatabaseHandle(directory, { readOnly: true });
  const transactions = createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transactions"],
    scope: { startDate: "1900-01-01", endDate: "2999-12-31" },
  }).families.transactions;
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
  const sourceConnectionKey = String((db.prepare(`
    SELECT connection.source_connection_key
      FROM financial_transactions transaction_row
      JOIN financial_accounts account ON account.account_id = transaction_row.account_id
      JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
     LIMIT 1
  `).get() as { source_connection_key: string }).source_connection_key);
  db.close();

  await commitCanonicalAutomaticEnrichmentRun(directory, {
    sourceConnectionKey,
    stream: "domestic-deposit",
    ruleLineage: "test/spending/purchase-actions",
    declaredSubjects: sourceRows.map(({ transactionId }) => ({ transactionId, fields: ["kind"] })),
    outputs: sourceRows.map(({ transactionId, sourceRecordId }) => ({
      transactionId,
      field: "kind" as const,
      origin: "derived" as const,
      value: "purchase",
      confidenceBasisPoints: 10_000,
      evidence: {
        kind: "description" as const,
        sourceRecordId,
        sourceValue: "synthetic purchase candidate",
        contractVersion: "test/spending/purchase-actions/v1",
      },
    })),
  });

  if (directOnly) {
    // This store-level test needs a currency mismatch without coupling the
    // product command to a second provider fixture. Preserve and restore the
    // immutable guards around the one synthetic revision mutation.
    const fixtureDb = openCanonicalDatabaseHandle(directory);
    const triggers = fixtureDb.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'transaction_revisions'").all() as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) fixtureDb.exec(`DROP TRIGGER "${trigger.name}"`);
    fixtureDb.prepare("UPDATE transaction_revisions SET currency = 'USD' WHERE direction = 'outflow' AND amount_coefficient = '300'").run();
    for (const trigger of triggers) fixtureDb.exec(trigger.sql);
    fixtureDb.close();
  }

  const store = createCanonicalSourceStore(directory);
  try {
    await commitCanonicalEInvoiceCapture(store, {
      captureId: "spending-purchase-action-invoice",
      sourceConnectionKey: "sha256:spending-purchase-action-connection",
      identityEpoch: "sha256:spending-purchase-action-epoch",
      subjectDigest: "sha256:spending-purchase-action-subject",
      observedAt: "2026-07-02T02:00:00Z",
      scope: {
        startDate: directOnly ? "2026-06-01" : "2026-07-01",
        endDate: "2026-07-31",
        kind: "bounded-range",
        completeness: "complete-range",
        invoiceCompleteness: "complete",
        itemCompleteness: "incomplete",
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: { fixture: "purchase-action" },
      }],
      invoices: [{
        stableInvoiceKey: "purchase-action-invoice",
        sourceRevisionKey: "purchase-action-invoice-v1",
        revisionNumber: 1,
        revisionKind: "issued",
        sourceIdentifiers: { invoiceNumber: "PA00000001" },
        seller: { taxId: "11112222", name: "Synthetic Shop" },
        total: {
          coefficient: directOnly ? "301" : "300",
          scale: 0,
          currency: "TWD",
          currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
        },
        occurrence: {
          value: directOnly ? "2026-06-01" : "2026-07-02",
          precision: "date",
          timeZone: "Asia/Taipei",
          origin: "source-reported",
        },
        items: [{
          sequence: 1,
          completeness: "incomplete",
          name: "Synthetic item",
          quantity: null,
          unitPrice: null,
          amount: null,
        }],
        authority: { routeKey: E_INVOICE_ROUTE, contractVersion: E_INVOICE_CONTRACT_VERSION },
        provenance: { kind: "fixture", reference: "fixture:purchase-action" },
      }],
    });
  } finally {
    store.close();
  }
}

test("Spending user commands confirm, deny, and revoke only a current deterministic candidate", async () => {
  const confirmDirectory = await mkdtemp(join(tmpdir(), "spending-purchase-confirm-"));
  const denyDirectory = await mkdtemp(join(tmpdir(), "spending-purchase-deny-"));
  try {
    await seedPurchaseCandidate(confirmDirectory);
    const pending = loadSpending(confirmDirectory);
    assert.equal(pending.purchaseReport.totalStatus, "includes-pending-confirmation");
    assert.equal(pending.purchaseReport.records.filter((record) => record.possibleDuplicate).length, 2);
    assert.deepEqual(pending.purchaseReport.totalsByCurrency, [{
      currency: "TWD",
      coefficient: "600",
      scale: 0,
      count: 2,
    }]);
    const candidate = pending.purchaseReport.candidates.find((row) => row.status === "candidate");
    assert.ok(candidate);
    const candidateInvoice = pending.purchaseReport.records.find((record) =>
      record.invoice?.invoiceId !== undefined && record.candidateIds.includes(candidate.candidateId),
    );
    const candidateTransaction = pending.purchaseReport.records.find((record) =>
      record.transaction?.transactionId !== undefined && record.candidateIds.includes(candidate.candidateId),
    );
    assert.ok(candidateInvoice?.invoice);
    assert.ok(candidateTransaction?.transaction);

    const confirmation = withActionReadCounts(confirmDirectory, () =>
      confirmSpendingCandidate({
        kind: "candidate",
        invoiceIdentityId: candidateInvoice.invoice!.invoiceId,
        transactionIdentityId: candidateTransaction.transaction!.transactionId,
        idempotencyKey: "candidate-confirmation-1",
      }, confirmDirectory));
    assert.equal(confirmation.fullProjectionCount, 0, "confirmation does not perform a full Spending projection");
    assert.equal(confirmation.storeOpenCount, 1, "confirmation uses one canonical store lifecycle");
    const confirmed = applySpendingPurchaseReportPatch(pending.purchaseReport, confirmation.result.patch);
    assert.deepEqual(confirmed, loadSpending(confirmDirectory).purchaseReport,
      "confirmation patch reproduces the committed report");
    assert.deepEqual(Object.keys(confirmation.result).sort(), ["knowledgePoint", "patch"]);
    assert.equal("canonical" in confirmation.result, false);
    assert.equal("invoices" in confirmation.result, false);
    assert.equal("purchaseReport" in confirmation.result, false);
    if (confirmation.result.patch.kind !== "spending-recognition-patch") throw new Error("Expected a sparse recognition patch.");
    assert.equal(confirmation.result.patch.operation, "establish-link");
    assert.equal(confirmed.records.length, 1);
    const linked = confirmed.records[0];
    assert.equal(linked?.basis, "linked");
    assert.equal(linked?.amount?.coefficient, "300", "a link uses the bank amount");
    assert.equal(linked?.occurrence.value, "2026-07-02", "a link uses the invoice purchase date");
    assert.equal(linked?.occurrence.basis, "purchase-date");
    assert.equal(linked?.link?.origin, "user");
    assert.equal(linked?.link?.userId, "local-user");
    assert.deepEqual(confirmed.totalsByCurrency, [{
      currency: "TWD",
      coefficient: "300",
      scale: 0,
      count: 1,
    }]);
    const replay = confirmSpendingCandidate({
      kind: "candidate",
      invoiceIdentityId: candidateInvoice.invoice!.invoiceId,
      transactionIdentityId: candidateTransaction.transaction!.transactionId,
      idempotencyKey: "candidate-confirmation-1",
    }, confirmDirectory);
    assert.equal(replay.knowledgePoint, confirmation.result.knowledgePoint);
    assert.deepEqual(replay.patch, confirmation.result.patch);

    const revocation = withActionReadCounts(confirmDirectory, () => revokeSpendingLink({
      invoiceId: linked!.link!.invoiceId,
      transactionId: linked!.link!.transactionId,
      idempotencyKey: "candidate-revoke-1",
    }, confirmDirectory));
    assert.equal(revocation.fullProjectionCount, 0, "revocation does not perform a full Spending projection");
    assert.equal(revocation.storeOpenCount, 1, "revocation uses one canonical store lifecycle");
    const revoked = applySpendingPurchaseReportPatch(confirmed, revocation.result.patch);
    assert.deepEqual(revoked.records.map((record) => record.basis).sort(), [
      "bank-transaction",
      "invoice",
    ]);
    assert.equal(revoked.candidates.length, 0);
    assert.deepEqual(revoked.totalsByCurrency, loadSpending(confirmDirectory).purchaseReport.totalsByCurrency);
    const confirmStore = createCanonicalSourceStore(confirmDirectory);
    try {
      assert.deepEqual(querySpendingRecognition(confirmStore).candidates, []);
    } finally {
      confirmStore.close();
    }

    await seedPurchaseCandidate(denyDirectory);
    const denyPending = loadSpending(denyDirectory);
    const deniedCandidate = denyPending.purchaseReport.candidates.find((row) => row.status === "candidate");
    assert.ok(deniedCandidate);
    const deniedResult = denySpendingCandidate({ kind: "candidate", candidateId: deniedCandidate.candidateId }, denyDirectory);
    const denied = applySpendingPurchaseReportPatch(denyPending.purchaseReport, deniedResult.patch);
    assert.deepEqual(denied, loadSpending(denyDirectory).purchaseReport,
      "denial patch reproduces the committed report");
    assert.equal(denied.candidates.some((row) => row.status === "candidate"), false);
    assert.equal(denied.records.some((row) => row.possibleDuplicate), false);
    const denyStore = createCanonicalSourceStore(denyDirectory);
    try {
      const recognition = querySpendingRecognition(denyStore);
      assert.deepEqual(recognition.candidates.map((row) => row.status), ["denied"]);
      assert.deepEqual(recognition.denied, [{
        invoiceId: deniedCandidate.invoiceId,
        transactionId: deniedCandidate.transactionId,
      }]);
    } finally {
      denyStore.close();
    }
  } finally {
    await rm(confirmDirectory, { recursive: true, force: true });
    await rm(denyDirectory, { recursive: true, force: true });
  }
});

test("Spending directly pairs a user-selected cross-month, different-money payment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spending-purchase-direct-"));
  try {
    await seedPurchaseCandidate(directory, true);
    const before = loadSpending(directory);
    assert.equal(before.purchaseReport.candidates.length, 0, "manual pairing does not require a similarity hint");
    const invoice = before.purchaseReport.records.find((record) => record.basis === "invoice");
    const payment = before.purchaseReport.records.find((record) => record.basis === "bank-transaction");
    assert.ok(invoice?.invoice);
    assert.ok(payment?.transaction);
    assert.equal(invoice.amount?.currency, "TWD");
    assert.equal(payment.amount?.currency, "USD");
    assert.notEqual(invoice.occurrence.value.slice(0, 7), payment.occurrence.value.slice(0, 7));
    const invoiceIdentityId = invoice.invoice.invoiceId;
    const transactionIdentityId = payment.transaction.transactionId;
    assert.throws(() => confirmSpendingCandidate({
      kind: "direct",
      invoiceIdentityId,
      transactionIdentityId,
    }), /idempotency key is required/);

    const directConfirmation = withActionReadCounts(directory, () => confirmSpendingCandidate({
      kind: "direct",
      invoiceIdentityId,
      transactionIdentityId,
      idempotencyKey: "direct-confirmation-1",
    }, directory));
    assert.equal(directConfirmation.fullProjectionCount, 0, "direct confirmation does not perform a full Spending projection");
    assert.equal(directConfirmation.storeOpenCount, 1, "direct confirmation uses one canonical store lifecycle");
    if (directConfirmation.result.patch.kind !== "spending-recognition-patch") throw new Error("Expected a sparse recognition patch.");
    assert.equal(directConfirmation.result.knowledgePoint, directConfirmation.result.patch.knowledgeAt);
    const commandDb = openCanonicalDatabaseHandle(directory, { readOnly: true });
    try {
      const event = commandDb.prepare("SELECT decision_key FROM spending_dedup_decision_events WHERE event_id = ?")
        .get(blob(Buffer.from(directConfirmation.result.patch.eventId.replaceAll("-", ""), "hex"))) as { decision_key?: string } | undefined;
      assert.equal(event?.decision_key, "spending/command/v1/establish-link/direct-confirmation-1");
    } finally {
      commandDb.close();
    }
    const linkedReport = applySpendingPurchaseReportPatch(before.purchaseReport, directConfirmation.result.patch);
    const linked = linkedReport.records;
    assert.deepEqual(
      linkedReport,
      loadSpending(directory).purchaseReport,
      "direct confirmation patch reproduces the committed report",
    );
    assert.equal(linked.length, 1);
    assert.equal(linked[0]?.basis, "linked");
    assert.deepEqual(linked[0]?.amount, payment.amount);
    assert.equal(linked[0]?.occurrence.value, invoice.occurrence.value);
    assert.equal(linked[0]?.link?.origin, "user");
    assert.equal(linked[0]?.difference?.sameCurrency, false);
    assert.equal(linked[0]?.difference?.exactAmountEqual, false);
    assert.throws(() => confirmSpendingCandidate({
      kind: "direct",
      invoiceIdentityId: invoice.invoice!.invoiceId,
      transactionIdentityId: payment.transaction!.transactionId,
      idempotencyKey: "direct-confirmation-2",
    }, directory), /spending-pair-stale/);
    const revokeResult = revokeSpendingLink({
      invoiceId: invoiceIdentityId,
      transactionId: transactionIdentityId,
      idempotencyKey: "direct-revoke-1",
    }, directory);
    const unlinked = applySpendingPurchaseReportPatch(linkedReport, revokeResult.patch);
    assert.deepEqual(unlinked, loadSpending(directory).purchaseReport,
      "the sparse revoke patch reproduces the cross-currency report");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
