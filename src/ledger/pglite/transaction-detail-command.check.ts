import assert from "node:assert/strict";
import test from "node:test";
import { readCashFlowPage } from "./cash-flow-page.ts";
import { applyPgliteCashFlowTransferSchema } from "./cash-flow-transfer.ts";
import { readKnowledgePoint } from "./knowledge-point.ts";
import { applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { applyPGliteFinancialPageAction, commitPGliteSpendingRefundRevision, confirmPGliteSpendingDedupLink } from "./spending-command.ts";
import { purchaseRecordsByIdentity } from "./purchase-report.ts";
import { BANK_ROUTE } from "./spending-test-fixture.ts";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import type { PGliteStore } from "./transaction.ts";
import type { FinancialCommittingPageActionRequest, FinancialPageActionResult } from "../../lib/financial/page-actions.ts";
import type { CashFlowRow } from "../../lib/cash-flow/model.ts";

const SEPTEMBER = { startDate: "2026-09-01", endDate: "2026-09-30" } as const;
const twd = (coefficient: string, scale = 0) => ({ coefficient, scale, currency: "TWD" });

async function withFixture(run: (fixture: SpendingCategoryFixture) => Promise<void>) {
  const fixture = await createSpendingCategoryFixture();
  try {
    await applyPgliteManualAssetsSchema(fixture.store);
    await applyPgliteCashFlowTransferSchema(fixture.store);
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

type Without<R> = R extends unknown ? Omit<R, "dataVersion"> : never;

/** Send one page action at the current data version, as the page would. */
async function act(store: PGliteStore, request: Without<FinancialCommittingPageActionRequest>): Promise<FinancialPageActionResult> {
  return applyPGliteFinancialPageAction(store, { ...request, dataVersion: await readKnowledgePoint(store) } as FinancialCommittingPageActionRequest);
}

async function rowOf(fixture: SpendingCategoryFixture, transactionId: string): Promise<CashFlowRow> {
  const page = await readCashFlowPage(fixture.store, SEPTEMBER);
  const row = page.transactions.find((entry) => entry.transactionId === transactionId);
  assert.ok(row, "the row is on the page");
  return row;
}

const emptyDelta = { before: [], after: [] };

test("a note is set, replaced and cleared as one user lineage, and Spending gets an empty delta", async () => {
  await withFixture(async (fixture) => {
    const id = await fixture.addTransaction({ amount: "320", date: "2026-09-08", description: "Lunch" });
    const base = await fixture.knowledgeAt();

    const set = await act(fixture.store, { action: "annotate", kind: "note", transactionId: id, note: "  和同事分攤午餐 " });
    assert.equal(set.knowledgeAt, base + 1);
    assert.deepEqual(set.summaryDelta, emptyDelta, "Spending shows no note");
    assert.deepEqual(set.subject, { invoiceIds: [], transactionIds: [] });
    let row = await rowOf(fixture, id);
    assert.equal(row.details.note, "和同事分攤午餐", "the note is stored trimmed");
    assert.equal(row.details.edit?.userNote, true);

    assert.equal((await act(fixture.store, { action: "annotate", kind: "note", transactionId: id, note: "和同事分攤午餐" })).knowledgeAt, base + 1, "the same note again writes nothing");
    await act(fixture.store, { action: "annotate", kind: "note", transactionId: id, note: "團購" });
    assert.equal((await rowOf(fixture, id)).details.note, "團購");

    const cleared = await act(fixture.store, { action: "annotate", kind: "note", transactionId: id, note: null });
    assert.equal(cleared.knowledgeAt, base + 3);
    row = await rowOf(fixture, id);
    assert.equal(row.details.note, null);
    assert.equal(row.details.edit?.userNote, false);
    assert.equal((await act(fixture.store, { action: "annotate", kind: "note", transactionId: id, note: "   " })).knowledgeAt, base + 3, "a blank note clears, and there is nothing left to clear");

    const lineage = await fixture.store.query<{ value_text: string; events: string[] }>(
      `SELECT assertion.value_text, ARRAY(SELECT transition.event_kind FROM assertion_transitions transition
                JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
               WHERE transition.assertion_id = assertion.assertion_id ORDER BY commit_row.commit_sequence) AS events
         FROM assertions assertion JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
        WHERE assertion.field_name = 'note' AND assertion.origin = 'user' ORDER BY created.commit_sequence`,
    );
    assert.deepEqual(lineage.rows.map((entry) => [entry.value_text, entry.events]), [
      ["和同事分攤午餐", ["observed", "superseded"]],
      ["團購", ["observed", "withdrawn"]],
    ]);
  });
});

test("a note write is refused on a stale version, a non-canonical row or an overlong note, and writes nothing", async () => {
  await withFixture(async (fixture) => {
    const id = await fixture.addTransaction({ amount: "320", date: "2026-09-08" });
    const base = await fixture.knowledgeAt();
    await assert.rejects(applyPGliteFinancialPageAction(fixture.store, { action: "annotate", kind: "note", transactionId: id, note: "x", dataVersion: base - 1 }), /stale/u);
    await assert.rejects(act(fixture.store, { action: "annotate", kind: "note", transactionId: "00000000-0000-4000-8000-000000000000", note: "x" }), /not a current canonical transaction/u);
    await assert.rejects(act(fixture.store, { action: "annotate", kind: "note", transactionId: id, note: "長".repeat(501) }), /too long/u);
    assert.equal(await fixture.knowledgeAt(), base);
  });
});

test("an allocation splits the purchase in Spending and Cash flow, supersedes a single category, and clearing falls back to automatic", async () => {
  await withFixture(async (fixture) => {
    const id = await fixture.addTransaction({ amount: "1000", date: "2026-09-08", description: "Costco" });
    const purchaseId = `transaction:${id}`;
    assert.equal((await rowOf(fixture, id)).details.edit?.purchaseId, purchaseId, "a bank-only row names its Spending purchase");

    const single = await act(fixture.store, { action: "categorize", kind: "category", purchaseId, categoryCode: "dining" });
    assert.equal(single.summaryDelta.after[0]?.category.mode, "single", "a category from Cash flow is Spending's own category action");

    const base = await fixture.knowledgeAt();
    const allocated = await act(fixture.store, {
      action: "allocate", kind: "allocation", purchaseId,
      components: [{ categoryCode: "food_and_groceries", amount: twd("600") }, { categoryCode: "household_goods_and_services", amount: twd("400") }],
    });
    assert.equal(allocated.knowledgeAt, base + 1, "single to allocated is one commit");
    assert.deepEqual(allocated.subject, { invoiceIds: [], transactionIds: [id] });
    assert.deepEqual(allocated.summaryDelta.before.map((line) => line.category.mode), ["single"]);
    const split = allocated.summaryDelta.after[0]?.category;
    assert.equal(split?.mode, "split", "Spending gets the split as its exact delta");
    assert.deepEqual(split?.mode === "split" && split.components.map((component) => [component.categoryCode, component.amount]), [
      ["food_and_groceries", twd("600")],
      ["household_goods_and_services", twd("400")],
    ]);

    let row = await rowOf(fixture, id);
    assert.deepEqual(row.cashFlow.class === "outflow" && row.cashFlow.categories.map((share) => [share.category, share.amount]), [
      ["food_and_groceries", { coefficient: "600", scale: 0 }],
      ["household_goods_and_services", { coefficient: "400", scale: 0 }],
    ]);
    assert.deepEqual(row.details.edit?.categorization, {
      mode: "allocated",
      components: [
        { categoryCode: "food_and_groceries", amount: { coefficient: "600", scale: 0 } },
        { categoryCode: "household_goods_and_services", amount: { coefficient: "400", scale: 0 } },
      ],
    });

    const again = await act(fixture.store, {
      action: "allocate", kind: "allocation", purchaseId,
      components: [{ categoryCode: "food_and_groceries", amount: twd("6000", 1) }, { categoryCode: "household_goods_and_services", amount: twd("400") }],
    });
    assert.equal(again.knowledgeAt, base + 1, "the same allocation, written at another scale, writes nothing");

    const cleared = await act(fixture.store, { action: "categorize", kind: "category", purchaseId, categoryCode: null });
    assert.equal(cleared.summaryDelta.after[0]?.category.mode, "absent", "clearing the user lineage returns to the automatic result");
    row = await rowOf(fixture, id);
    assert.deepEqual(row.details.edit?.categorization, { mode: "absent" });
    const lineage = await fixture.store.query<{ mode: string; events: string[] }>(
      `SELECT value.mode, ARRAY(SELECT transition.event_kind FROM assertion_transitions transition
                JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
               WHERE transition.assertion_id = value.assertion_id ORDER BY commit_row.commit_sequence) AS events
         FROM transaction_categorization_values value JOIN canonical_commits created ON created.commit_id = value.created_commit_id
        ORDER BY created.commit_sequence`,
    );
    assert.deepEqual(lineage.rows.map((entry) => [entry.mode, entry.events]), [
      ["single", ["observed", "superseded"]],
      ["allocated", ["observed", "withdrawn"]],
    ]);
  });
});

test("an incomplete allocation, or one the Kind does not admit, is refused without a commit", async () => {
  await withFixture(async (fixture) => {
    const id = await fixture.addTransaction({ amount: "1000", date: "2026-09-08" });
    const income = await fixture.addTransaction({ amount: "500", date: "2026-09-09", direction: "inflow" });
    await fixture.store.query(
      "UPDATE current_transaction_enrichment SET taxonomy_code = 'income.interest', value_text = 'income.interest' WHERE field_name = 'kind' AND transaction_id = decode(replace($1, '-', ''), 'hex')",
      [income],
    );
    const purchaseId = `transaction:${id}`;
    const base = await fixture.knowledgeAt();
    const refused = [
      [[{ categoryCode: "dining", amount: twd("1000") }], /too_few/u],
      [[{ categoryCode: "dining", amount: twd("600") }, { categoryCode: "travel", amount: twd("300") }], /sum/u],
      [[{ categoryCode: "dining", amount: twd("500") }, { categoryCode: "dining", amount: twd("500") }], /duplicate_category/u],
      [[{ categoryCode: "dining", amount: twd("1000") }, { categoryCode: "travel", amount: twd("0") }], /not_positive/u],
      [[{ categoryCode: "dining", amount: twd("9995", 1) }, { categoryCode: "travel", amount: twd("5", 1) }], /too_precise/u],
      [[{ categoryCode: "dining", amount: { ...twd("500"), currency: "USD" } }, { categoryCode: "travel", amount: twd("500") }], /currency/u],
      [[{ categoryCode: "other", amount: twd("500") }, { categoryCode: "travel", amount: twd("500") }], /unknown_category/u],
    ] as const;
    for (const [components, message] of refused)
      await assert.rejects(act(fixture.store, { action: "allocate", kind: "allocation", purchaseId, components }), message);
    assert.equal((await rowOf(fixture, income)).details.edit?.categorizable, false, "an interest inflow admits no category");
    await assert.rejects(act(fixture.store, {
      action: "allocate", kind: "allocation", purchaseId: `transaction:${income}`,
      components: [{ categoryCode: "dining", amount: twd("250") }, { categoryCode: "travel", amount: twd("250") }],
    }), /incompatible with Kind income.interest/u);
    assert.equal(await fixture.knowledgeAt(), base);
  });
});

test("a Tag is created by label, reused by its normalized label, and removed without touching the note", async () => {
  await withFixture(async (fixture) => {
    const first = await fixture.addTransaction({ amount: "320", date: "2026-09-08" });
    const second = await fixture.addTransaction({ amount: "180", date: "2026-09-09" });
    await act(fixture.store, { action: "annotate", kind: "note", transactionId: first, note: "午餐" });
    const base = await fixture.knowledgeAt();

    const added = await act(fixture.store, { action: "add", kind: "tag_add", transactionId: first, label: "  出差  台中 " });
    assert.equal(added.knowledgeAt, base + 1);
    assert.deepEqual(added.summaryDelta, emptyDelta, "Spending shows no Tag");
    const page = await readCashFlowPage(fixture.store, SEPTEMBER);
    assert.deepEqual(page.userTags.map((tag) => tag.label), ["出差 台中"]);
    const tagId = page.userTags[0]!.tagId;
    let row = await rowOf(fixture, first);
    assert.deepEqual(row.details.edit?.tags, [{ tagId, label: "出差 台中" }]);
    assert.equal(row.details.note, "午餐", "a Tag is not the note");

    assert.equal((await act(fixture.store, { action: "add", kind: "tag_add", transactionId: first, label: "出差 台中" })).knowledgeAt, base + 1, "a tag already on the row writes nothing");
    await act(fixture.store, { action: "add", kind: "tag_add", transactionId: second, label: "出差　台中" });
    assert.deepEqual((await rowOf(fixture, second)).details.edit?.tags, [{ tagId, label: "出差 台中" }], "a full-width space is the same label, so the same User Tag");
    assert.equal(Number((await fixture.store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM user_tags")).rows[0]!.count), 1);

    const removed = await act(fixture.store, { action: "remove", kind: "tag_remove", transactionId: first, tagId });
    assert.deepEqual(removed.summaryDelta, emptyDelta);
    row = await rowOf(fixture, first);
    assert.deepEqual(row.details.edit?.tags, []);
    assert.deepEqual((await rowOf(fixture, second)).details.edit?.tags, [{ tagId, label: "出差 台中" }], "removal withdraws only that association");
    assert.equal((await act(fixture.store, { action: "remove", kind: "tag_remove", transactionId: first, tagId })).knowledgeAt, removed.knowledgeAt, "removing an absent tag writes nothing");

    // Clearing the note reselects the note among the row's user 'note' assertions; a Tag association must never be chosen.
    await act(fixture.store, { action: "add", kind: "tag_add", transactionId: first, label: "代墊" });
    await act(fixture.store, { action: "annotate", kind: "note", transactionId: first, note: null });
    row = await rowOf(fixture, first);
    assert.equal(row.details.note, null);
    assert.deepEqual(row.details.edit?.tags.map((tag) => tag.label), ["代墊"]);
    await assert.rejects(act(fixture.store, { action: "add", kind: "tag_add", transactionId: first, label: "   " }), /Tag label/u);
  });
});

test("only a row Spending lists as a purchase says its category shows on Spending; another categorizable row changes Spending nothing", async () => {
  await withFixture(async (fixture) => {
    const purchase = await fixture.addTransaction({ amount: "320", date: "2026-09-08" });
    const refund = await fixture.addTransaction({ amount: "90", date: "2026-09-09", direction: "inflow" });
    const purchaseRow = await rowOf(fixture, purchase);
    const refundRow = await rowOf(fixture, refund);
    assert.equal(refundRow.kind?.code, "refund");
    assert.deepEqual([purchaseRow.details.edit?.categorizable, purchaseRow.details.edit?.spendingPurchase], [true, true]);
    assert.deepEqual([refundRow.details.edit?.categorizable, refundRow.details.edit?.spendingPurchase], [true, false],
      "a refund takes a category, but Spending has no purchase record for it");
    const categorized = await act(fixture.store, { action: "categorize", kind: "category", purchaseId: refundRow.details.edit!.purchaseId, categoryCode: "dining" });
    assert.deepEqual(categorized.summaryDelta, emptyDelta, "the write lands, and Spending moves nothing");
    const after = await rowOf(fixture, refund);
    assert.deepEqual(after.details.edit?.categorization, { mode: "single", origin: "user", categoryCode: "dining" }, "Cash flow shows it");
  });
});

test("a split on a Spending-linked purchase lands on the bank transaction and Spending's delta shows the split", async () => {
  await withFixture(async (fixture) => {
    const bank = await fixture.addTransaction({ amount: "350", date: "2026-09-10" });
    const invoice = await fixture.commitInvoice({ stableKey: "AB10000461:2026-09-10", date: "2026-09-10", items: [{ sequence: 1, name: "汽油", amount: "350" }] });
    const linkedAt = await fixture.knowledgeAt();
    await fixture.store.transaction((transaction) => confirmPGliteSpendingDedupLink(transaction, {
      invoiceId: invoice,
      transactionId: bank,
      decisionKey: `check/allocation-linked/${invoice}/${bank}`,
      origin: { kind: "user", userId: "local-user" },
      evidenceKnowledgeSequence: linkedAt,
      evidence: { check: true },
    }));
    const row = await rowOf(fixture, bank);
    const purchaseId = row.details.edit?.purchaseId ?? "";
    assert.match(purchaseId, /^link:/u, "a linked row names its link, as Spending does");
    assert.equal(row.details.edit?.spendingPurchase, true);

    const result = await act(fixture.store, {
      action: "allocate", kind: "allocation", purchaseId,
      components: [{ categoryCode: "transportation", amount: twd("300") }, { categoryCode: "food_and_groceries", amount: twd("50") }],
    });
    assert.deepEqual(result.affectedRecords.map((record) => [record.purchaseId, record.basis]), [[purchaseId, "linked"]]);
    const split = result.summaryDelta.after[0]?.category;
    assert.deepEqual(split?.mode === "split" && split.components.map((component) => [component.categoryCode, component.amount]), [
      ["transportation", twd("300")],
      ["food_and_groceries", twd("50")],
    ]);
    const stored = await fixture.store.query<{ transaction_id: string }>(
      "SELECT encode(transaction_id, 'hex') AS transaction_id FROM transaction_categorization_values WHERE mode = 'allocated'",
    );
    assert.deepEqual(stored.rows.map((entry) => entry.transaction_id), [bank.replaceAll("-", "")], "the allocation is the bank transaction's");
  });
});

test("an archived Tag applied again is active on every transaction it was on, and the latest revision decides its lifecycle", async () => {
  await withFixture(async (fixture) => {
    const first = await fixture.addTransaction({ amount: "320", date: "2026-09-08" });
    const second = await fixture.addTransaction({ amount: "180", date: "2026-09-09" });
    const third = await fixture.addTransaction({ amount: "60", date: "2026-09-10" });
    await act(fixture.store, { action: "add", kind: "tag_add", transactionId: first, label: "旅行" });
    await act(fixture.store, { action: "add", kind: "tag_add", transactionId: second, label: "旅行" });
    const tagId = (await readCashFlowPage(fixture.store, SEPTEMBER)).userTags[0]!.tagId;
    const tagBytes = Buffer.from(tagId.replaceAll("-", ""), "hex");

    /** A commit the way an archive writer would make one, then its revision row. */
    const commit = async () => {
      const id = Buffer.from(crypto.randomUUID().replaceAll("-", ""), "hex");
      await fixture.store.query(
        "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, $2, $3, 'user/local', 'user_assertion')",
        [id, await fixture.knowledgeAt() + 1, Date.now() * 1000],
      );
      return id;
    };
    // Active by a status revision, then archived by a newer label revision: the newer one wins.
    await fixture.store.query("INSERT INTO user_tag_status_revisions(status_revision_id, tag_id, user_id, lifecycle, created_commit_id) VALUES ($1, $2, 'local-user', 'active', $3)",
      [Buffer.from(crypto.randomUUID().replaceAll("-", ""), "hex"), tagBytes, await commit()]);
    await fixture.store.query(
      `INSERT INTO user_tag_label_revisions(label_revision_id, tag_id, user_id, display_label, normalized_label, lifecycle, created_commit_id)
       VALUES ($1, $2, 'local-user', '旅行', '旅行', 'archived', $3)`,
      [Buffer.from(crypto.randomUUID().replaceAll("-", ""), "hex"), tagBytes, await commit()]);
    // Archiving hides the tag's rows, as an archive writer would.
    await fixture.store.query("DELETE FROM current_transaction_tags WHERE tag_id = $1", [tagBytes]);
    assert.deepEqual((await readCashFlowPage(fixture.store, SEPTEMBER)).userTags, [], "an archived tag is not suggested");
    assert.deepEqual((await rowOf(fixture, first)).details.edit?.tags, []);

    await act(fixture.store, { action: "add", kind: "tag_add", transactionId: third, label: "旅行" });
    const page = await readCashFlowPage(fixture.store, SEPTEMBER);
    assert.deepEqual(page.userTags, [{ tagId, label: "旅行" }], "the same User Tag is active again");
    for (const id of [first, second, third])
      assert.deepEqual(page.transactions.find((entry) => entry.transactionId === id)?.details.edit?.tags, [{ tagId, label: "旅行" }], id);
  });
});

test("a row's Spending purchase id and listing agree with the Purchase report: bank-only, refunded, linked, and linked to a voided invoice", async () => {
  await withFixture(async (fixture) => {
    const plain = await fixture.addTransaction({ amount: "320", date: "2026-09-08" });
    const refunded = await fixture.addTransaction({ amount: "300", date: "2026-09-09" });
    const linked = await fixture.addTransaction({ amount: "350", date: "2026-09-10" });
    const voided = await fixture.addTransaction({ amount: "410", date: "2026-09-11" });
    const inflow = await fixture.addTransaction({ amount: "90", date: "2026-09-12", direction: "inflow" });
    await fixture.store.transaction((transaction) => commitPGliteSpendingRefundRevision(transaction, {
      stableRefundKey: `refund/${refunded}`, transactionId: refunded, sourceRevisionKey: "refund-v1", revisionNumber: 1, revisionKind: "asserted",
      amount: { coefficient: "-100", scale: 0, currency: "TWD" },
      occurrence: { value: "2026-09-13", precision: "date", timeZone: "Asia/Taipei", basis: "source-occurrence" },
      authorityRoute: BANK_ROUTE, provenanceReference: "check/refund/1", evidence: { sourceProvesRefund: true },
    }));
    const linkedInvoice = await fixture.commitInvoice({ stableKey: "AB10000470:2026-09-10", date: "2026-09-10", items: [{ sequence: 1, name: "汽油", amount: "350" }] });
    const voidedInvoice = await fixture.commitInvoice({ stableKey: "AB10000471:2026-09-11", date: "2026-09-11", items: [{ sequence: 1, name: "書", amount: "410" }] });
    const linkEvent = await fixture.link(linkedInvoice, linked);
    await fixture.link(voidedInvoice, voided);
    await fixture.commitInvoice({ stableKey: "AB10000471:2026-09-11", revisionNumber: 2, revoked: true, date: "2026-09-11", items: [] });

    const ids = [plain, refunded, linked, voided, inflow];
    const knowledgeAt = await fixture.knowledgeAt();
    const report = await purchaseRecordsByIdentity(fixture.store, knowledgeAt,
      { invoiceIds: [linkedInvoice, voidedInvoice], transactionIds: ids }, { candidates: "none" });
    const listed = new Set(report.records.map((record) => record.purchaseId));
    const page = await readCashFlowPage(fixture.store, SEPTEMBER);
    const derived = ids.map((id) => {
      const edit = page.transactions.find((row) => row.transactionId === id)?.details.edit;
      return [edit?.purchaseId, edit?.spendingPurchase];
    });
    assert.deepEqual(derived, ids.map((id) => {
      const record = report.records.find((entry) => entry.transaction?.transactionId === id && entry.basis !== "refund");
      return [record?.purchaseId ?? `transaction:${id}`, record !== undefined && listed.has(record.purchaseId)];
    }), "the cheap derivation says what the Purchase report says");
    assert.deepEqual(derived, [
      [`transaction:${plain}`, true],
      [`transaction:${refunded}`, false],
      [`link:${linkEvent}`, true],
      [`transaction:${voided}`, true],
      [`transaction:${inflow}`, false],
    ]);

    const result = await act(fixture.store, { action: "categorize", kind: "category", purchaseId: `transaction:${voided}`, categoryCode: "education" });
    assert.equal(result.summaryDelta.after[0]?.category.mode, "single", "a link to a voided invoice no longer blocks the bank-only purchase's category");
  });
});
