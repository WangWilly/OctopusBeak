import assert from "node:assert/strict";
import test from "node:test";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import { applyPGliteSpendingPageAction } from "./spending-command.ts";

type Seeded = Readonly<{
  fixture: SpendingCategoryFixture;
  strongInvoice: string;
  strongPayment: string;
  fallbackInvoice: string;
  fallbackPayment: string;
  sharedInvoice: string;
  sharedPaymentA: string;
  sharedPaymentB: string;
  linkedInvoice: string;
  linkedPayment: string;
  deniedInvoice: string;
  deniedPayment: string;
  crossMonthInvoice: string;
  crossMonthPayment: string;
}>;

async function seed(): Promise<Seeded> {
  const fixture = await createSpendingCategoryFixture();
  const strongInvoice = await fixture.commitInvoice({ stableKey: "ST00000001:2026-09-03", date: "2026-09-03", sellerName: "全家便利商店", items: [{ sequence: 1, name: "飯糰", amount: "100" }] });
  const strongPayment = await fixture.addTransaction({ amount: "100", date: "2026-09-04", description: "全家便利商店 信義店", card: { consumeDate: "2026-09-03", cardMask: "4311-****-****-5512" } });
  const fallbackInvoice = await fixture.commitInvoice({ stableKey: "FB00000001:2026-09-05", date: "2026-09-05", sellerName: "Shop", items: [{ sequence: 1, name: "Item", amount: "200" }] });
  const fallbackPayment = await fixture.addTransaction({ amount: "200", date: "2026-09-05", description: "Shop", card: { consumeDate: null, cardMask: "****5512" } });
  const sharedInvoice = await fixture.commitInvoice({ stableKey: "SH00000001:2026-09-10", date: "2026-09-10", sellerName: "Cafe", items: [{ sequence: 1, name: "Latte", amount: "300" }] });
  const sharedPaymentA = await fixture.addTransaction({ amount: "300", date: "2026-09-10", description: "Cafe", card: { consumeDate: "2026-09-10" } });
  const sharedPaymentB = await fixture.addTransaction({ amount: "300", date: "2026-09-11", description: "Cafe", card: { consumeDate: "2026-09-11" } });
  const linkedInvoice = await fixture.commitInvoice({ stableKey: "LK00000001:2026-09-15", date: "2026-09-15", sellerName: "Books", items: [{ sequence: 1, name: "Book", amount: "400" }] });
  const linkedPayment = await fixture.addTransaction({ amount: "400", date: "2026-09-15", description: "Books", card: { consumeDate: "2026-09-15" } });
  await fixture.addTransaction({ amount: "400", date: "2026-09-16", description: "Books", card: { consumeDate: "2026-09-16" } });
  await fixture.commitInvoice({ stableKey: "LK00000002:2026-09-08", date: "2026-09-08", sellerName: "Books", items: [{ sequence: 1, name: "Book", amount: "400" }] });
  await fixture.link(linkedInvoice, linkedPayment);
  const deniedInvoice = await fixture.commitInvoice({ stableKey: "DN00000001:2026-09-20", date: "2026-09-20", sellerName: "Deli", items: [{ sequence: 1, name: "Sandwich", amount: "500" }] });
  const deniedPayment = await fixture.addTransaction({ amount: "500", date: "2026-09-20", description: "Deli", card: { consumeDate: "2026-09-20" } });
  const crossMonthInvoice = await fixture.commitInvoice({ stableKey: "CM00000001:2026-09-30", date: "2026-09-30", sellerName: "Bakery", items: [{ sequence: 1, name: "Bread", amount: "600" }] });
  const crossMonthPayment = await fixture.addTransaction({ amount: "600", date: "2026-10-02", description: "Bakery", card: { consumeDate: "2026-10-01" } });
  const query = createPGliteSpendingQuery(fixture.store);
  const knowledgeAt = await fixture.knowledgeAt();
  const page = await query.candidatePage({ knowledgeAt, month: null, limit: 100 });
  const denied = page.items.find((item) => item.candidate.invoiceId === deniedInvoice && item.candidate.transactionId === deniedPayment);
  assert.ok(denied, "the denied pair is pending before the denial");
  await applyPGliteSpendingPageAction(fixture.store, {
    action: "deny", kind: "candidate", candidateId: denied.candidate.candidateId,
    invoiceIdentityId: deniedInvoice, transactionIdentityId: deniedPayment, dataVersion: knowledgeAt,
  });
  return { fixture, strongInvoice, strongPayment, fallbackInvoice, fallbackPayment, sharedInvoice, sharedPaymentA, sharedPaymentB, linkedInvoice, linkedPayment, deniedInvoice, deniedPayment, crossMonthInvoice, crossMonthPayment };
}

const pairsOf = (items: readonly { candidate: { invoiceId: string; transactionId: string } }[]) =>
  items.map((item) => `${item.candidate.invoiceId}/${item.candidate.transactionId}`).sort();

test("the global pending set excludes linked sides and decided pairs and classifies strength over every month", async () => {
  const seeded = await seed();
  try {
    const query = createPGliteSpendingQuery(seeded.fixture.store);
    const knowledgeAt = await seeded.fixture.knowledgeAt();
    const all = await query.candidatePage({ knowledgeAt, month: null, limit: 100 });
    assert.deepEqual(pairsOf(all.items), [
      `${seeded.strongInvoice}/${seeded.strongPayment}`,
      `${seeded.fallbackInvoice}/${seeded.fallbackPayment}`,
      `${seeded.sharedInvoice}/${seeded.sharedPaymentA}`,
      `${seeded.sharedInvoice}/${seeded.sharedPaymentB}`,
      `${seeded.crossMonthInvoice}/${seeded.crossMonthPayment}`,
    ].sort());
    assert.equal(all.month, null);
    assert.equal(all.totalCandidateCount, 5);
    assert.equal(all.strongCandidateCount, 2);
    const byPair = new Map(all.items.map((item) => [`${item.candidate.invoiceId}/${item.candidate.transactionId}`, item.candidate]));
    assert.deepEqual(
      { strength: byPair.get(`${seeded.strongInvoice}/${seeded.strongPayment}`)?.strength, reasons: byPair.get(`${seeded.strongInvoice}/${seeded.strongPayment}`)?.reasons },
      { strength: "strong", reasons: { amountEqual: true, dayDistance: 0, merchantMatch: true } },
    );
    assert.deepEqual(
      { strength: byPair.get(`${seeded.crossMonthInvoice}/${seeded.crossMonthPayment}`)?.strength, reasons: byPair.get(`${seeded.crossMonthInvoice}/${seeded.crossMonthPayment}`)?.reasons },
      { strength: "strong", reasons: { amountEqual: true, dayDistance: 1, merchantMatch: true } },
    );
    assert.equal(byPair.get(`${seeded.fallbackInvoice}/${seeded.fallbackPayment}`)?.strength, "possible", "a posting-date fallback is never strong");
    assert.equal(byPair.get(`${seeded.sharedInvoice}/${seeded.sharedPaymentA}`)?.strength, "possible", "two pending payments for one invoice are both possible");
    assert.equal(byPair.get(`${seeded.sharedInvoice}/${seeded.sharedPaymentB}`)?.strength, "possible");

    const september = await query.candidatePage({ knowledgeAt, month: "2026-09", limit: 100 });
    const october = await query.candidatePage({ knowledgeAt, month: "2026-10", limit: 100 });
    assert.equal(september.totalCandidateCount, 5, "the month count keeps invoice-or-payment month membership");
    assert.equal(october.totalCandidateCount, 1);
    assert.equal(october.items[0]?.candidate.strength, "strong", "a month slice keeps the global strength");

    const overview = await query.pendingOverview({ knowledgeAt });
    assert.equal(overview.pendingCount, 5);
    assert.equal(overview.strongCount, 2);
    assert.deepEqual(overview.strongPairs.map((pair) => `${pair.invoiceIdentityId}/${pair.transactionIdentityId}`).sort(), [
      `${seeded.strongInvoice}/${seeded.strongPayment}`,
      `${seeded.crossMonthInvoice}/${seeded.crossMonthPayment}`,
    ].sort());
    assert.deepEqual(overview.affectedByCurrency, [{ currency: "TWD", coefficient: "1200", scale: 0, count: 4 }],
      "affected money counts each pending invoice once: 100 + 200 + 300 + 600");
    await assert.rejects(query.pendingOverview({ knowledgeAt: knowledgeAt - 1 }), /data version is stale/u);
  } finally {
    await seeded.fixture.close();
  }
});

test("a revoked link returns neither its pair nor anything else to the pending set", async () => {
  const seeded = await seed();
  try {
    const query = createPGliteSpendingQuery(seeded.fixture.store);
    const knowledgeAt = await seeded.fixture.knowledgeAt();
    await applyPGliteSpendingPageAction(seeded.fixture.store, {
      action: "revoke", kind: "revoke", invoiceIdentityId: seeded.linkedInvoice, transactionIdentityId: seeded.linkedPayment, dataVersion: knowledgeAt,
    });
    const after = await query.candidatePage({ knowledgeAt: await seeded.fixture.knowledgeAt(), month: null, limit: 100 });
    const pairs = pairsOf(after.items);
    assert.equal(pairs.includes(`${seeded.linkedInvoice}/${seeded.linkedPayment}`), false, "a decided pair stays out of the pending set");
    assert.equal(after.totalCandidateCount, 7, "the revoked sides pair with their other unlinked same-amount neighbors");
  } finally {
    await seeded.fixture.close();
  }
});
