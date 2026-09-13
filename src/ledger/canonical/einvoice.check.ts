import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSourceRouteRegistration } from "./canonical-source-route-registry.ts";
import {
  createCanonicalSourceStore,
  submitCanonicalContractPurge,
} from "./canonical-source-store.ts";
import {
  ADVERTISED_E_INVOICE_READINESS,
  evaluateAdvertisedEInvoiceReadiness,
  isAdvertisedEInvoiceEntryReleaseReady,
} from "./einvoice-readiness.ts";
import {
  CanonicalEInvoiceAdmissionError,
  E_INVOICE_COMPLETENESS_RULE_VERSION,
  E_INVOICE_CONTRACT_VERSION,
  E_INVOICE_CURRENCY_AUTHORITY,
  E_INVOICE_ROUTE,
  commitCanonicalEInvoiceCapture,
  queryCanonicalEInvoiceCurrent,
  queryCanonicalEInvoiceHistorical,
  queryCanonicalEInvoiceLineage,
  type CanonicalEInvoiceCaptureInput,
  type CanonicalEInvoiceInput,
} from "./einvoice.ts";

const connection = "sha256:einvoice-check-connection";
const epoch = "sha256:einvoice-check-epoch";
const subject = "sha256:einvoice-check-subject";

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
    total: revoked
      ? null
      : {
          coefficient: revisionNumber === 1 ? "1020" : "980",
          scale: 0,
          currency: "TWD",
          currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
        },
    occurrence: {
      value: "2026-09-01T13:45",
      precision: "minute",
      timeZone: "Asia/Taipei",
      origin: "source-reported",
    },
    items: revoked
      ? []
      : revisionNumber === 1
        ? [
            {
              sequence: 1,
              completeness: "complete",
              name: "午餐",
              quantity: { coefficient: "1", scale: 0 },
              unitPrice: {
                coefficient: "1020",
                scale: 0,
                currency: "TWD",
                currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
              },
              amount: {
                coefficient: "1020",
                scale: 0,
                currency: "TWD",
                currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
              },
              sourceFacts: { providerItemOrdinal: 1 },
            },
          ]
        : [
            {
              sequence: 1,
              completeness: "incomplete",
              name: "午餐（來源未提供數量與單價）",
              sourceFacts: { providerItemOrdinal: 1, missing: ["quantity", "unitPrice"] },
            },
          ],
    authority: { routeKey: E_INVOICE_ROUTE, contractVersion: E_INVOICE_CONTRACT_VERSION },
    provenance: revoked
      ? { kind: "provider-revocation", reference: `provider/revocation/${revisionNumber}` }
      : { kind: "provider-record", reference: `provider/invoice/${revisionNumber}`, sourceField: "invoiceList" },
    revocationReason: revoked ? "provider-declared-void" : null,
  };
}

function capture(
  captureId: string,
  invoices: readonly CanonicalEInvoiceInput[],
  overrides: Partial<CanonicalEInvoiceCaptureInput> = {},
): CanonicalEInvoiceCaptureInput {
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
      itemCompleteness: invoices.some((entry) => entry.items.some((item) => item.completeness === "incomplete"))
        ? "incomplete"
        : "complete",
      absenceAuthority: "comparable-complete-range",
    },
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: invoices.length,
      terminal: true,
      metadata: { fixture: "canonical-einvoice-check" },
    }],
    invoices,
    ...overrides,
  };
}

async function fixture<T>(run: (store: ReturnType<typeof createCanonicalSourceStore>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "canonical-einvoice-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    return await run(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("E-Invoice route and executable readiness manifest are canonical and release-ready", () => {
  evaluateAdvertisedEInvoiceReadiness();
  assert.equal(ADVERTISED_E_INVOICE_READINESS.length, 1);
  assert.equal(isAdvertisedEInvoiceEntryReleaseReady(ADVERTISED_E_INVOICE_READINESS[0]!), true);
  assert.deepEqual(canonicalSourceRouteRegistration(E_INVOICE_ROUTE), {
    routeKey: E_INVOICE_ROUTE,
    integrationNamespace: "einvoice",
    stream: "personal-invoices",
    contractVersions: [E_INVOICE_CONTRACT_VERSION],
    completenessRuleVersions: [E_INVOICE_COMPLETENESS_RULE_VERSION],
  });
});

test("E-Invoice preserves a legitimate empty HTTP 204 page and rejects rows under 204", async () => {
  await fixture(async (store) => {
    const empty204 = capture("capture-empty-204", []);
    const committed = await commitCanonicalEInvoiceCapture(store, {
      ...empty204,
      pages: [{ ...empty204.pages[0]!, responseCode: "204" }],
    });
    assert.equal(committed.invoiceCount, 0);
    const sourcePage = store.db
      .prepare(
        `SELECT response_code, row_count
           FROM capture_scope_pages page
           JOIN capture_scopes scope ON scope.scope_id = page.scope_id
           JOIN source_captures capture ON capture.capture_id = scope.capture_id
          WHERE capture.capture_key = ?`,
      )
      .get("capture-empty-204") as Record<string, unknown>;
    assert.deepEqual(
      { responseCode: String(sourcePage.response_code), rowCount: Number(sourcePage.row_count) },
      { responseCode: "204", rowCount: 0 },
    );
    const invalid204 = capture("capture-invalid-204", [invoice()]);
    await assert.rejects(
      commitCanonicalEInvoiceCapture(store, {
        ...invalid204,
        pages: [{ ...invalid204.pages[0]!, responseCode: "204" }],
      }),
      (error: unknown) => error instanceof CanonicalEInvoiceAdmissionError && error.reason === "invalid-contract",
    );
  });
});

test("E-Invoice admits revisions atomically, keeps exact facts, and exposes current/historical/lineage", async () => {
  await fixture(async (store) => {
    const issued = await commitCanonicalEInvoiceCapture(store, capture("capture-issued", [invoice()]));
    assert.deepEqual(
      {
        invoices: issued.invoiceCount,
        identities: issued.insertedInvoiceCount,
        revisions: issued.insertedRevisionCount,
        items: issued.itemCount,
      },
      { invoices: 1, identities: 1, revisions: 1, items: 1 },
    );
    const historical = queryCanonicalEInvoiceHistorical(store, { knowledgeAt: issued.knowledgeAt });
    assert.equal(historical.invoices[0]?.revision.total?.coefficient, "1020");
    assert.equal(historical.invoices[0]?.revision.total?.currencyAuthority, E_INVOICE_CURRENCY_AUTHORITY);
    assert.equal(historical.invoices[0]?.revision.items[0]?.quantity?.coefficient, "1");

    const recollected = await commitCanonicalEInvoiceCapture(store, capture("capture-recollected", [invoice()]));
    assert.equal(recollected.insertedRevisionCount, 0);
    assert.equal(recollected.observedDuplicateCount, 1);

    const revised = await commitCanonicalEInvoiceCapture(store, capture("capture-revised", [invoice(2, "revised")]));
    assert.equal(revised.insertedInvoiceCount, 0);
    assert.equal(revised.insertedRevisionCount, 1);
    const currentAfterRevision = queryCanonicalEInvoiceCurrent(store);
    assert.equal(currentAfterRevision.invoices.length, 1);
    assert.equal(currentAfterRevision.invoices[0]?.revision.total?.coefficient, "980");
    const incompleteItem = currentAfterRevision.invoices[0]?.revision.items[0];
    assert.equal(incompleteItem?.completeness, "incomplete");
    assert.equal(incompleteItem?.name, "午餐（來源未提供數量與單價）");
    assert.equal(incompleteItem?.quantity, null);
    assert.equal(incompleteItem?.unitPrice, null);
    assert.equal(incompleteItem?.amount, null);

    await commitCanonicalEInvoiceCapture(store, capture("capture-revoked", [invoice(3, "revoked")]));
    const current = queryCanonicalEInvoiceCurrent(store);
    assert.equal(current.invoices[0]?.revision.state, "revoked");
    assert.equal(current.invoices[0]?.revision.total, null);
    assert.equal(current.invoices[0]?.revision.revocationReason, "provider-declared-void");

    const lineage = queryCanonicalEInvoiceLineage(store, {
      sourceConnectionKey: connection,
      identityEpoch: epoch,
      subjectDigest: subject,
      stableInvoiceKey: "AB12345678:2026-09-01",
    });
    assert.equal(lineage.revisions.length, 3);
    assert.equal(lineage.observations.length, 4);
    assert.equal(lineage.provenanceComplete, true);
    assert.deepEqual(
      [...new Set(lineage.events.map((event) => event.kind))].sort(),
      ["issued", "observed", "revised", "revoked", "superseded"].sort(),
    );
  });
});

test("E-Invoice identity is connection-scoped and a complete empty capture is queryable", async () => {
  await fixture(async (store) => {
    const empty = await commitCanonicalEInvoiceCapture(store, capture("capture-empty", []));
    assert.equal(empty.invoiceCount, 0);
    assert.deepEqual(queryCanonicalEInvoiceCurrent(store).invoices, []);

    await commitCanonicalEInvoiceCapture(store, capture("capture-a", [invoice()]));
    await commitCanonicalEInvoiceCapture(store, capture("capture-b", [invoice()], {
      sourceConnectionKey: "sha256:einvoice-check-other-connection",
    }));
    const current = queryCanonicalEInvoiceCurrent(store);
    assert.equal(current.invoices.length, 2);
    assert.notEqual(current.invoices[0]?.invoiceId, current.invoices[1]?.invoiceId);
  });
});

test("E-Invoice rejects missing required facts and rolls back the entire source capture", async () => {
  await fixture(async (store) => {
    const valid = invoice();
    const invalid: CanonicalEInvoiceInput = {
      ...invoice(2, "revised"),
      sourceIdentifiers: { invoiceNumber: "" },
    };
    await assert.rejects(
      commitCanonicalEInvoiceCapture(store, capture("capture-invalid", [valid, invalid])),
      (error: unknown) => error instanceof CanonicalEInvoiceAdmissionError && error.reason === "required-data",
    );
    assert.deepEqual(queryCanonicalEInvoiceCurrent(store).invoices, []);
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS value FROM source_captures WHERE capture_key = ?").get("capture-invalid") as { value: number }).value),
      0,
    );
  });
});

test("E-Invoice rejects conflicting recollection without changing admitted history", async () => {
  await fixture(async (store) => {
    await commitCanonicalEInvoiceCapture(store, capture("capture-original", [invoice()]));
    const conflict: CanonicalEInvoiceInput = {
      ...invoice(),
      total: {
        coefficient: "999",
        scale: 0,
        currency: "TWD",
        currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
      },
    };
    await assert.rejects(commitCanonicalEInvoiceCapture(store, capture("capture-conflict", [conflict])));
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS value FROM source_captures WHERE capture_key = ?").get("capture-conflict") as { value: number }).value),
      0,
    );
    const current = queryCanonicalEInvoiceCurrent(store);
    assert.equal(current.invoices[0]?.revision.total?.coefficient, "1020");
    assert.equal(current.invoices[0]?.revision.revisionNumber, 1);
  });
});

test("E-Invoice tables participate in source-scoped canonical purge", async () => {
  await fixture(async (store) => {
    await commitCanonicalEInvoiceCapture(store, capture("capture-to-purge", [invoice()]));
    const result = await submitCanonicalContractPurge(store, {
      scope: { integrationNamespace: "einvoice", sourceConnectionKey: connection },
      reason: "wrong-contract",
    });
    assert.equal(result.scrub.status, "completed");
    for (const table of [
      "einvoice_captures",
      "einvoice_invoices",
      "einvoice_invoice_revisions",
      "einvoice_items",
      "einvoice_revision_observations",
      "einvoice_revision_events",
    ])
      assert.ok((result.deletedTableCounts[table] ?? 0) > 0, `${table} belongs to the purge closure`);
    assert.deepEqual(queryCanonicalEInvoiceCurrent(store).invoices, []);
    await assert.rejects(
      commitCanonicalEInvoiceCapture(store, capture("capture-after-purge", [invoice()])),
      /purged.*disabled/iu,
    );
  });
});
