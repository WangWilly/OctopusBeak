import assert from "node:assert/strict";
import test from "node:test";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import { applyPGliteSpendingPageAction, confirmPGliteSpendingStrongCandidates } from "./spending-command.ts";

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

async function decisionState(fixture: SpendingCategoryFixture) {
  const result = await fixture.store.query<{ commits: number | string; events: number | string; links: number | string }>(
    `SELECT (SELECT COUNT(*) FROM canonical_commits) AS commits,
            (SELECT COUNT(*) FROM spending_dedup_decision_events) AS events,
            (SELECT COUNT(*) FROM current_spending_dedup_links) AS links`,
  );
  const row = result.rows[0]!;
  return { commits: Number(row.commits), events: Number(row.events), links: Number(row.links) };
}

test("strong-match batch confirmation writes one commit with one evidence-bearing event per shown pair", async () => {
  const seeded = await seed();
  try {
    const query = createPGliteSpendingQuery(seeded.fixture.store);
    const shownKnowledgeAt = await seeded.fixture.knowledgeAt();
    const shown = await query.pendingOverview({ knowledgeAt: shownKnowledgeAt });
    await seeded.fixture.addTransaction({ amount: "999", date: "2026-11-20", description: "Unrelated" });
    const before = await decisionState(seeded.fixture);
    const result = await confirmPGliteSpendingStrongCandidates(seeded.fixture.store, { shownKnowledgeAt, pairs: shown.strongPairs });
    assert.equal(result.status, "committed", "an unrelated newer commit does not reject the batch");
    if (result.status !== "committed") return;
    const after = await decisionState(seeded.fixture);
    assert.deepEqual(after, { commits: before.commits + 1, events: before.events + 2, links: before.links + 2 });
    assert.equal(result.knowledgeAt, result.baseKnowledgeAt + 1);
    const events = (await seeded.fixture.store.query<{ evidence_json: string; event_kind: string }>(
      `SELECT event.evidence_json, event.event_kind
         FROM spending_dedup_decision_events event
         JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
        WHERE commit_row.commit_sequence = $1`,
      [result.knowledgeAt],
    )).rows;
    assert.equal(events.length, 2);
    for (const event of events) {
      const evidence = JSON.parse(event.evidence_json) as Record<string, unknown>;
      assert.equal(event.event_kind, "confirmed");
      assert.equal(evidence.decisionOrigin, "strong-match-batch");
      assert.equal(evidence.strength, "strong");
      assert.equal(evidence.shownKnowledgeAt, shownKnowledgeAt);
      assert.equal((evidence.reasons as Record<string, unknown>).merchantMatch, true);
    }
    const overview = await query.pendingOverview({ knowledgeAt: result.knowledgeAt });
    assert.equal(overview.strongCount, 0);
    assert.equal(overview.pendingCount, 3);
  } finally {
    await seeded.fixture.close();
  }
});

test("a shown pair that became ambiguous rejects the whole batch without writing and returns the recomputed strong set", async () => {
  const seeded = await seed();
  try {
    const query = createPGliteSpendingQuery(seeded.fixture.store);
    const shownKnowledgeAt = await seeded.fixture.knowledgeAt();
    const shown = await query.pendingOverview({ knowledgeAt: shownKnowledgeAt });
    assert.equal(shown.strongPairs.length, 2);
    await seeded.fixture.addTransaction({ amount: "100", date: "2026-09-04", description: "全家便利商店 信義店", card: { consumeDate: "2026-09-04" } });
    const before = await decisionState(seeded.fixture);
    const result = await confirmPGliteSpendingStrongCandidates(seeded.fixture.store, { shownKnowledgeAt, pairs: shown.strongPairs });
    assert.equal(result.status, "conflict");
    if (result.status !== "conflict") return;
    assert.deepEqual(await decisionState(seeded.fixture), before, "a rejected batch writes nothing");
    assert.deepEqual(result.conflicts.map((pair) => pair.invoiceIdentityId), [seeded.strongInvoice]);
    assert.deepEqual(result.strongPairs.map((pair) => `${pair.invoiceIdentityId}/${pair.transactionIdentityId}`), [`${seeded.crossMonthInvoice}/${seeded.crossMonthPayment}`]);
    const retry = await confirmPGliteSpendingStrongCandidates(seeded.fixture.store, { shownKnowledgeAt: result.knowledgeAt, pairs: result.strongPairs });
    assert.equal(retry.status, "committed", "the re-offered set confirms");
  } finally {
    await seeded.fixture.close();
  }
});

test("a shown pair that is no longer pending, or was only possible, rejects the batch", async () => {
  const seeded = await seed();
  try {
    const query = createPGliteSpendingQuery(seeded.fixture.store);
    const shownKnowledgeAt = await seeded.fixture.knowledgeAt();
    const page = await query.candidatePage({ knowledgeAt: shownKnowledgeAt, month: null, limit: 100 });
    const strongItem = page.items.find((item) => item.candidate.invoiceId === seeded.strongInvoice)!;
    const possibleItem = page.items.find((item) => item.candidate.invoiceId === seeded.fallbackInvoice)!;
    const ref = (item: typeof strongItem) => ({ candidateId: item.candidate.candidateId, invoiceIdentityId: item.candidate.invoiceId, transactionIdentityId: item.candidate.transactionId });
    const before = await decisionState(seeded.fixture);
    const possible = await confirmPGliteSpendingStrongCandidates(seeded.fixture.store, { shownKnowledgeAt, pairs: [ref(strongItem), ref(possibleItem)] });
    assert.equal(possible.status, "conflict");
    assert.deepEqual(await decisionState(seeded.fixture), before);
    await applyPGliteSpendingPageAction(seeded.fixture.store, {
      action: "deny", kind: "candidate", candidateId: strongItem.candidate.candidateId,
      invoiceIdentityId: seeded.strongInvoice, transactionIdentityId: seeded.strongPayment, dataVersion: shownKnowledgeAt,
    });
    const afterDeny = await decisionState(seeded.fixture);
    const denied = await confirmPGliteSpendingStrongCandidates(seeded.fixture.store, { shownKnowledgeAt, pairs: [ref(strongItem)] });
    assert.equal(denied.status, "conflict");
    assert.deepEqual(await decisionState(seeded.fixture), afterDeny);
    assert.throws(() => confirmPGliteSpendingStrongCandidates(seeded.fixture.store, { shownKnowledgeAt, pairs: [] }), /at least one/u);
  } finally {
    await seeded.fixture.close();
  }
});

test("links expose their decision time and the merge log pages decisions newest first with both sides", async () => {
  const seeded = await seed();
  try {
    const query = createPGliteSpendingQuery(seeded.fixture.store);
    const linkedAt = await seeded.fixture.knowledgeAt();
    const recorded = (await seeded.fixture.store.query<{ recorded_at_utc_us: number | string }>(
      `SELECT commit_row.recorded_at_utc_us FROM spending_dedup_decision_events event
         JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
        WHERE event.event_kind = 'confirmed'`,
    )).rows[0]!;
    const page = await query.recordPage({ knowledgeAt: linkedAt, month: "2026-09" });
    const linked = page.records.find((record) => record.basis === "linked");
    assert.equal(linked?.link?.decidedAt, new Date(Math.floor(Number(recorded.recorded_at_utc_us) / 1000)).toISOString());
    assert.equal(linked?.link?.origin, "user");

    await applyPGliteSpendingPageAction(seeded.fixture.store, {
      action: "revoke", kind: "revoke", invoiceIdentityId: seeded.linkedInvoice, transactionIdentityId: seeded.linkedPayment, dataVersion: linkedAt,
    });
    const knowledgeAt = await seeded.fixture.knowledgeAt();
    const first = await query.mergeLog({ knowledgeAt, limit: 2 });
    assert.deepEqual(first.entries.map((entry) => entry.kind), ["revoked", "denied"]);
    assert.ok(first.nextCursor);
    const second = await query.mergeLog({ knowledgeAt, cursor: first.nextCursor, limit: 2 });
    assert.deepEqual(second.entries.map((entry) => entry.kind), ["confirmed"]);
    assert.equal(second.nextCursor, null);
    const revoked = first.entries[0]!;
    assert.deepEqual(revoked.invoice, {
      invoiceId: seeded.linkedInvoice, invoiceNumber: "LK00000001", sellerName: "Books",
      occurrence: "2026-09-15T13:45", amount: { coefficient: "400", scale: 0, currency: "TWD" },
    });
    assert.deepEqual(revoked.payment, {
      transactionId: seeded.linkedPayment, description: "Books", date: "2026-09-15",
      amount: { coefficient: "400", scale: 0, currency: "TWD" },
    });
    assert.ok(revoked.commitSequence > second.entries[0]!.commitSequence);
    await assert.rejects(query.mergeLog({ knowledgeAt: knowledgeAt - 1 }), /data version is stale/u);
  } finally {
    await seeded.fixture.close();
  }
});
