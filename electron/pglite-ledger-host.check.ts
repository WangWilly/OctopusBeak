import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import { createLocalDateClock } from "./pglite-financial-live-dependencies.ts";
import { createPGliteLedgerHost } from "./pglite-ledger-host.ts";
import { fixtureInvoice } from "../src/ledger/pglite/spending-test-fixture.ts";
import { installFinancialStore } from "../src/ledger/pglite/store-layout.ts";
import type { SpendingPageDto } from "../src/lib/spending/model.ts";

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a page action run through the host's registry is what its Spending view publishes", async () => {
  const db = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  const store = await installFinancialStore(db as unknown as PGlite);
  const { registry, spendingPageActions, views } = createPGliteLedgerHost(db, store, {
    clock: createLocalDateClock(() => "2026-10-01"),
  });
  const pages: SpendingPageDto[] = [];
  let stop: (() => Promise<void>) | null = null;
  try {
    assert.equal(spendingPageActions, registry.spendingPageActions);
    stop = await views.subscribe("financial.spending.current", {}, (value) => pages.push(value as SpendingPageDto));
    await registry["financial.einvoice.commit"]([{
      captureId: "host-category-invoice",
      sourceConnectionKey: "sha256:host-category-connection",
      identityEpoch: "sha256:host-category-epoch",
      subjectDigest: "sha256:host-category-subject",
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
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { fixture: "host-category" } }],
      invoices: [fixtureInvoice({ stableKey: "AB44444444:2026-09-03", sellerName: "全聯實業股份有限公司", items: [{ sequence: 1, name: "鮮奶", amount: "90" }] })],
    } as never]);
    await waitFor(() => (pages.at(-1)?.purchaseReport.summary?.monthTotals.length ?? 0) > 0, "the committed invoice");
    const before = pages.at(-1)!.purchaseReport;
    const month = before.summary!.monthTotals[0]!.month;
    const read = await registry["financial.spending.recordPage"]([{ knowledgeAt: before.knowledgeAt, month, limit: 50 }]);
    assert.ok(!("stale" in read));
    const purchase = read.records.find((record) => record.basis === "invoice");
    assert.ok(purchase);

    const result = await registry["financial.spending.pageAction"]([{
      action: "categorize",
      kind: "category",
      purchaseId: purchase.purchaseId,
      categoryCode: "dining",
      dataVersion: before.knowledgeAt,
    }]);
    if (result.status !== "committed") assert.fail("a category change cannot conflict");
    // Only the view watching the registry's own actions has published by the
    // time the action returns; a full re-read waits for the live query.
    assert.equal(pages.at(-1)!.purchaseReport.knowledgeAt, result.knowledgeAt, "the view published the action's result as it settled");
    const full = await registry["financial.spending.current"]([{}]);
    assert.deepEqual(pages.at(-1)!.purchaseReport.summary, full.purchaseReport.summary);
  } finally {
    await stop?.();
    await store.close();
  }
});
