import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import {
  commitPGliteCanonicalEInvoiceCapture,
  PGLITE_EINVOICE_CONTRACT_VERSION,
  PGLITE_EINVOICE_CURRENCY_AUTHORITY,
  PGLITE_EINVOICE_ROUTE,
} from "./einvoice.ts";
import { writeEInvoiceItemUserCategory } from "./einvoice-item-categorization.ts";
import { PGliteStore } from "./transaction.ts";
import type { CanonicalEInvoiceCaptureInput, CanonicalEInvoiceInput, CanonicalEInvoiceItemInput } from "../canonical/einvoice-contract.ts";

const connection = "sha256:pglite-item-category-connection";
const epoch = "sha256:pglite-item-category-epoch";
const subject = "sha256:pglite-item-category-subject";

function money(coefficient: string) {
  return { coefficient, scale: 0, currency: "TWD" as const, currencyAuthority: PGLITE_EINVOICE_CURRENCY_AUTHORITY };
}

function item(sequence: number, name: string, amount: string): CanonicalEInvoiceItemInput {
  return {
    sequence,
    completeness: "complete",
    name,
    quantity: { coefficient: "1", scale: 0 },
    unitPrice: money(amount),
    amount: money(amount),
    sourceFacts: { providerItemOrdinal: sequence },
  };
}

function invoice(
  revisionNumber: number,
  items: readonly CanonicalEInvoiceItemInput[],
  options: Readonly<{ sellerName?: string | null; revoked?: boolean; stableKey?: string }> = {},
): CanonicalEInvoiceInput {
  const revoked = options.revoked === true;
  const total = items.reduce((sum, entry) => sum + BigInt(entry.amount?.coefficient ?? "0"), 0n).toString();
  return {
    stableInvoiceKey: options.stableKey ?? "AB12345678:2026-09-01",
    sourceRevisionKey: `provider-revision-${revisionNumber}`,
    revisionNumber,
    revisionKind: revoked ? "revoked" : revisionNumber === 1 ? "issued" : "revised",
    sourceIdentifiers: { invoiceNumber: "AB12345678", randomNumber: "2468" },
    seller: { taxId: "12345678", name: options.sellerName === undefined ? "測試商店" : options.sellerName },
    total: revoked ? null : money(total),
    occurrence: { value: "2026-09-01T13:45", precision: "minute", timeZone: "Asia/Taipei", origin: "source-reported" },
    items: revoked ? [] : items,
    authority: { routeKey: PGLITE_EINVOICE_ROUTE, contractVersion: PGLITE_EINVOICE_CONTRACT_VERSION },
    provenance: revoked
      ? { kind: "provider-revocation", reference: `provider/revocation/${revisionNumber}` }
      : { kind: "provider-record", reference: `provider/invoice/${revisionNumber}`, sourceField: "invoiceList" },
    revocationReason: revoked ? "provider-declared-void" : null,
  };
}

function capture(captureId: string, invoices: readonly CanonicalEInvoiceInput[]): CanonicalEInvoiceCaptureInput {
  return {
    captureId,
    sourceConnectionKey: connection,
    identityEpoch: epoch,
    subjectDigest: subject,
    observedAt: "2026-09-02T00:00:00Z",
    scope: {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      kind: "bounded-range",
      completeness: "complete-range",
      invoiceCompleteness: "complete",
      itemCompleteness: "complete",
      absenceAuthority: "comparable-complete-range",
    },
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: invoices.length, terminal: true, metadata: { fixture: "item-category-check" } }],
    invoices,
  };
}

type CurrentRow = Readonly<{ sequence: number; origin: string; code: string; routeId: string | null }>;

async function currentRows(store: PGliteStore): Promise<readonly CurrentRow[]> {
  const rows = await store.query<{ item_sequence: number | string; origin: string; category_code: string; route_id: string | null }>(
    "SELECT item_sequence, origin, category_code, route_id FROM current_einvoice_item_categorizations ORDER BY item_sequence",
  );
  return rows.rows.map((row) => ({ sequence: Number(row.item_sequence), origin: row.origin, code: row.category_code, routeId: row.route_id }));
}

async function lineage(store: PGliteStore): Promise<readonly Readonly<{ sequence: number; origin: string; code: string; events: readonly string[] }>[]> {
  const rows = await store.query<{ item_sequence: number | string; origin: string; value_text: string; events: string[] }>(
    `SELECT assertion.item_sequence, assertion.origin, assertion.value_text,
            ARRAY(SELECT transition.event_kind FROM assertion_transitions transition
                   JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
                  WHERE transition.assertion_id = assertion.assertion_id
                  ORDER BY commit_row.commit_sequence, transition.event_kind) AS events
       FROM assertions assertion
       JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
      WHERE assertion.target_kind = 'einvoice_item'
      ORDER BY assertion.item_sequence, assertion.origin, created.commit_sequence`,
  );
  return rows.rows.map((row) => ({ sequence: Number(row.item_sequence), origin: row.origin, code: row.value_text, events: row.events }));
}

async function invoiceId(store: PGliteStore): Promise<Uint8Array> {
  return (await store.query<{ invoice_id: Uint8Array }>("SELECT invoice_id FROM einvoice_invoices LIMIT 1")).rows[0]!.invoice_id;
}

async function userCommit(store: PGliteStore): Promise<Uint8Array> {
  const commitId = Uint8Array.from(Buffer.from(crypto.randomUUID().replaceAll("-", ""), "hex"));
  const sequence = Number((await store.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) + 1 AS value FROM canonical_commits")).rows[0]!.value);
  await store.query(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, $2, $3, 'user/local', 'user_assertion')",
    [commitId, sequence, Date.now() * 1000],
  );
  return commitId;
}

test("a committed capture derives item categories by name first, then seller, and re-derives per revision", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalEInvoiceCapture(store, capture("item-category-issued", [invoice(1, [
      item(1, "拿鐵", "120"),
      item(2, "Unlabelled", "80"),
      item(3, "衛生紙", "99"),
    ], { sellerName: "台灣中油股份有限公司" })]));
    assert.deepEqual(await currentRows(store), [
      { sequence: 1, origin: "derived", code: "dining", routeId: "einvoice/personal-invoices/item-category-enrichment/v1/category" },
      { sequence: 2, origin: "derived", code: "transportation", routeId: "einvoice/personal-invoices/item-category-enrichment/v1/category" },
      { sequence: 3, origin: "derived", code: "household_goods_and_services", routeId: "einvoice/personal-invoices/item-category-enrichment/v1/category" },
    ]);
    const runs = await store.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM enrichment_runs WHERE producer_id = 'einvoice/item-category-enrichment'");
    assert.equal(Number(runs.rows[0]?.count), 1, "one complete enrichment run per invoice sync");

    await commitPGliteCanonicalEInvoiceCapture(store, capture("item-category-repeated", [invoice(1, [
      item(1, "拿鐵", "120"),
      item(2, "Unlabelled", "80"),
      item(3, "衛生紙", "99"),
    ], { sellerName: "台灣中油股份有限公司" })]));
    assert.equal(Number((await store.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM enrichment_runs")).rows[0]?.count), 1,
      "a duplicate observation with unchanged facts writes nothing");

    await commitPGliteCanonicalEInvoiceCapture(store, capture("item-category-revised", [invoice(2, [
      item(1, "拿鐵", "120"),
      item(2, "汽油", "80"),
    ], { sellerName: "台灣中油股份有限公司" })]));
    assert.deepEqual(await currentRows(store), [
      { sequence: 1, origin: "derived", code: "dining", routeId: "einvoice/personal-invoices/item-category-enrichment/v1/category" },
      { sequence: 2, origin: "derived", code: "transportation", routeId: "einvoice/personal-invoices/item-category-enrichment/v1/category" },
    ], "a revision re-derives: unchanged item keeps its assertion, renamed item keeps its code, removed item disappears");
    assert.deepEqual(await lineage(store), [
      { sequence: 1, origin: "derived", code: "dining", events: ["observed"] },
      { sequence: 2, origin: "derived", code: "transportation", events: ["observed", "superseded"] },
      { sequence: 2, origin: "derived", code: "transportation", events: ["observed"] },
      { sequence: 3, origin: "derived", code: "household_goods_and_services", events: ["observed", "withdrawn"] },
    ]);

    await commitPGliteCanonicalEInvoiceCapture(store, capture("item-category-revoked", [invoice(3, [], { revoked: true })]));
    assert.deepEqual(await currentRows(store), [], "a revoked invoice has no current item categorization");
  } finally {
    await store.close();
  }
});

test("items with no matching rule stay uncategorized without a fallback assertion", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalEInvoiceCapture(store, capture("item-category-unknown", [invoice(1, [item(1, "Unlabelled", "50")], { sellerName: "網路家庭國際資訊" })]));
    assert.deepEqual(await currentRows(store), []);
    assert.deepEqual(await lineage(store), []);
    assert.equal(Number((await store.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM enrichment_runs")).rows[0]?.count), 0);
  } finally {
    await store.close();
  }
});

test("a user item assertion survives a revision that keeps the item's facts and is withdrawn when they change (check 22)", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalEInvoiceCapture(store, capture("item-category-issued", [invoice(1, [
      item(1, "拿鐵", "120"),
      item(2, "Unlabelled", "80"),
    ], { sellerName: "台灣中油股份有限公司" })]));
    const invoice1 = await invoiceId(store);
    const setCommit = await userCommit(store);
    await store.transaction((transaction) => writeEInvoiceItemUserCategory(transaction, {
      invoiceId: invoice1, commitId: setCommit, userId: "local-user", categoryCode: "gifts_and_donations",
    }));
    assert.deepEqual((await currentRows(store)).map((row) => [row.sequence, row.origin, row.code]), [
      [1, "user", "gifts_and_donations"],
      [2, "user", "gifts_and_donations"],
    ]);

    await commitPGliteCanonicalEInvoiceCapture(store, capture("item-category-revised", [invoice(2, [
      item(1, "拿鐵", "120"),
      item(2, "Unlabelled", "85"),
    ], { sellerName: "台灣中油股份有限公司" })]));
    assert.deepEqual((await currentRows(store)).map((row) => [row.sequence, row.origin, row.code]), [
      [1, "user", "gifts_and_donations"],
      [2, "derived", "transportation"],
    ], "item 1 keeps the user category; item 2 changed amount and falls back to the Derived result");

    await commitPGliteCanonicalEInvoiceCapture(store, capture("item-category-shrunk", [invoice(3, [
      item(2, "Unlabelled", "85"),
    ], { sellerName: "台灣中油股份有限公司" })]));
    assert.deepEqual((await currentRows(store)).map((row) => [row.sequence, row.origin, row.code]), [
      [2, "derived", "transportation"],
    ], "an item that disappears loses its user assertion");
    const userEvents = (await lineage(store)).filter((row) => row.origin === "user");
    assert.deepEqual(userEvents, [
      { sequence: 1, origin: "user", code: "gifts_and_donations", events: ["observed", "withdrawn"] },
      { sequence: 2, origin: "user", code: "gifts_and_donations", events: ["observed", "withdrawn"] },
    ]);
  } finally {
    await store.close();
  }
});

test("clearing a user item categorization falls back to the routed Derived result (check 24)", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalEInvoiceCapture(store, capture("item-category-issued", [invoice(1, [item(1, "拿鐵", "120")])]));
    const invoice1 = await invoiceId(store);
    const setCommit = await userCommit(store);
    await store.transaction((transaction) => writeEInvoiceItemUserCategory(transaction, { invoiceId: invoice1, commitId: setCommit, userId: "local-user", categoryCode: "healthcare" }));
    assert.deepEqual((await currentRows(store)).map((row) => [row.origin, row.code]), [["user", "healthcare"]]);
    const clearCommit = await userCommit(store);
    const cleared = await store.transaction((transaction) => writeEInvoiceItemUserCategory(transaction, { invoiceId: invoice1, commitId: clearCommit, userId: "local-user", categoryCode: null }));
    assert.deepEqual(cleared, { written: 0, withdrawn: 1 });
    assert.deepEqual(await currentRows(store), [
      { sequence: 1, origin: "derived", code: "dining", routeId: "einvoice/personal-invoices/item-category-enrichment/v1/category" },
    ]);
    const secondClearCommit = await userCommit(store);
    const again = await store.transaction((transaction) => writeEInvoiceItemUserCategory(transaction, { invoiceId: invoice1, commitId: secondClearCommit, userId: "local-user", categoryCode: null }));
    assert.deepEqual(again, { written: 0, withdrawn: 0 }, "clearing twice converges");
  } finally {
    await store.close();
  }
});
