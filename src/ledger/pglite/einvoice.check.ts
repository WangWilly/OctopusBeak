import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import {
  commitPGliteCanonicalEInvoiceCapture,
  PGLITE_EINVOICE_CONTRACT_VERSION,
  PGLITE_EINVOICE_CURRENCY_AUTHORITY,
  PGLITE_EINVOICE_ROUTE,
  type PGliteCanonicalEInvoiceCommitResult,
} from "./einvoice.ts";
import { PGliteStore } from "./transaction.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import type { CanonicalEInvoiceCaptureInput, CanonicalEInvoiceInput } from "../canonical/einvoice-contract.ts";

const connection = "sha256:pglite-einvoice-check-connection";
const epoch = "sha256:pglite-einvoice-check-epoch";
const subject = "sha256:pglite-einvoice-check-subject";

function invoice(
  revisionNumber = 1,
  revisionKind: "issued" | "revised" | "revoked" = "issued",
): CanonicalEInvoiceInput {
  const revoked = revisionKind === "revoked";
  return {
    stableInvoiceKey: "AB12345678:2026-09-01",
    sourceRevisionKey: `provider-revision-${revisionNumber}`,
    revisionNumber,
    revisionKind,
    sourceIdentifiers: { invoiceNumber: "AB12345678", randomNumber: "2468" },
    seller: { taxId: "12345678", name: "測試商店" },
    total: revoked ? null : {
      coefficient: revisionNumber === 1 ? "1020" : "980",
      scale: 0,
      currency: "TWD",
      currencyAuthority: PGLITE_EINVOICE_CURRENCY_AUTHORITY,
    },
    occurrence: {
      value: "2026-09-01T13:45",
      precision: "minute",
      timeZone: "Asia/Taipei",
      origin: "source-reported",
    },
    items: revoked ? [] : revisionNumber === 1 ? [{
      sequence: 1,
      completeness: "complete",
      name: "午餐",
      quantity: { coefficient: "1", scale: 0 },
      unitPrice: { coefficient: "1020", scale: 0, currency: "TWD", currencyAuthority: PGLITE_EINVOICE_CURRENCY_AUTHORITY },
      amount: { coefficient: "1020", scale: 0, currency: "TWD", currencyAuthority: PGLITE_EINVOICE_CURRENCY_AUTHORITY },
      sourceFacts: { providerItemOrdinal: 1 },
    }] : [{
      sequence: 1,
      completeness: "incomplete",
      name: "午餐（來源未提供數量與單價）",
      sourceFacts: { providerItemOrdinal: 1, missing: ["quantity", "unitPrice"] },
    }],
    authority: { routeKey: PGLITE_EINVOICE_ROUTE, contractVersion: PGLITE_EINVOICE_CONTRACT_VERSION },
    provenance: revoked
      ? { kind: "provider-revocation", reference: `provider/revocation/${revisionNumber}` }
      : { kind: "provider-record", reference: `provider/invoice/${revisionNumber}`, sourceField: "invoiceList" },
    revocationReason: revoked ? "provider-declared-void" : null,
  };
}

function capture(captureId: string, invoices: readonly CanonicalEInvoiceInput[], itemCompleteness: "complete" | "incomplete" = "complete"): CanonicalEInvoiceCaptureInput {
  return {
    captureId,
    sourceConnectionKey: connection,
    identityEpoch: epoch,
    subjectDigest: subject,
    observedAt: `2026-09-0${Math.min(9, invoices[0]?.revisionNumber ?? 1)}T00:00:00Z`,
    scope: {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      kind: "bounded-range",
      completeness: "complete-range",
      invoiceCompleteness: "complete",
      itemCompleteness,
      absenceAuthority: "comparable-complete-range",
    },
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: invoices.length,
      terminal: true,
      metadata: { fixture: "pglite-einvoice-check" },
    }],
    invoices,
  };
}

async function counts(store: PGliteStore): Promise<Record<string, number>> {
  const tables = ["einvoice_invoices", "einvoice_invoice_revisions", "einvoice_items", "einvoice_revision_events", "einvoice_revision_observations"] as const;
  const result: Record<string, number> = {};
  for (const table of tables)
    result[table] = Number((await store.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0]?.count ?? 0);
  return result;
}

test("PGlite E-Invoice preserves recurrent revisions, item order, revocation, and Spending reads", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const issued = await commitPGliteCanonicalEInvoiceCapture(store, capture("pglite-einvoice-issued", [invoice()]));
    assert.equal(issued.invoiceCount, 1);
    assert.equal(issued.insertedInvoiceCount, 1);
    assert.equal(issued.insertedRevisionCount, 1);
    assert.equal(issued.itemCount, 1);
    const repeated = await commitPGliteCanonicalEInvoiceCapture(store, capture("pglite-einvoice-repeated", [invoice()]));
    assert.equal(repeated.observedDuplicateCount, 1);
    assert.equal(repeated.insertedRevisionCount, 0);
    const revised = await commitPGliteCanonicalEInvoiceCapture(store, capture("pglite-einvoice-revised", [invoice(2, "revised")], "incomplete"));
    assert.equal(revised.insertedRevisionCount, 1);
    assert.equal(revised.itemCount, 1);
    const revoked = await commitPGliteCanonicalEInvoiceCapture(store, capture("pglite-einvoice-revoked", [invoice(3, "revoked")]));
    assert.equal(revoked.insertedRevisionCount, 1);
    const rows = await store.query<{ state: string; revision_number: number; revocation_reason: string | null }>(`SELECT state, revision_number, revocation_reason
      FROM einvoice_invoice_revisions ORDER BY revision_number`);
    assert.deepEqual(rows.rows.map((row) => ({ state: row.state, revision: Number(row.revision_number), reason: row.revocation_reason })), [
      { state: "active", revision: 1, reason: null },
      { state: "active", revision: 2, reason: null },
      { state: "revoked", revision: 3, reason: "provider-declared-void" },
    ]);
    const items = await store.query<{ sequence: number; name: string | null }>(`SELECT item.sequence, item.name
      FROM einvoice_items item
      JOIN einvoice_invoice_revisions revision ON revision.revision_id = item.revision_id
      ORDER BY revision.revision_number, item.sequence`);
    assert.deepEqual(items.rows.map((row) => ({ sequence: Number(row.sequence), name: row.name })), [
      { sequence: 1, name: "午餐" },
      { sequence: 1, name: "午餐（來源未提供數量與單價）" },
    ]);
    const currentSpending = await createPGliteSpendingQuery(store).current();
    assert.equal(currentSpending.invoices.length, 1);
    assert.equal(currentSpending.invoices[0]?.revision.state, "revoked");
    const historicalSpending = await createPGliteSpendingQuery(store).historical({ financialAt: "2026-09-02", knowledgeAt: issued.knowledgeAt });
    assert.equal(historicalSpending.status, "ok");
    const historicalInvoice = await store.query<{ revision_number: number }>(`SELECT revision_number
      FROM einvoice_invoice_revisions revision
      JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
      WHERE commit_row.commit_sequence <= $1
      ORDER BY revision.revision_number DESC LIMIT 1`, [issued.knowledgeAt]);
    assert.equal(Number(historicalInvoice.rows[0]?.revision_number), 1);
    assert.deepEqual(await counts(store), {
      einvoice_invoices: 1,
      einvoice_invoice_revisions: 3,
      einvoice_items: 2,
      einvoice_revision_events: 6,
      einvoice_revision_observations: 4,
    });
  } finally {
    await store.close();
  }
});

test("PGlite E-Invoice rejects changed revision evidence atomically", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalEInvoiceCapture(store, capture("pglite-einvoice-conflict-seed", [invoice()]));
    const original = invoice();
    const conflicting: CanonicalEInvoiceInput = { ...original, seller: { ...original.seller, name: "不同商店" } };
    await assert.rejects(
      commitPGliteCanonicalEInvoiceCapture(store, capture("pglite-einvoice-conflict", [conflicting])),
      /occurrence|conflict|changed/iu,
    );
    assert.deepEqual(await counts(store), {
      einvoice_invoices: 1,
      einvoice_invoice_revisions: 1,
      einvoice_items: 1,
      einvoice_revision_events: 1,
      einvoice_revision_observations: 1,
    });
  } finally {
    await store.close();
  }
});
