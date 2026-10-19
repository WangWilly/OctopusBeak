import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewCreditCollection, PreviewWrite } from "../ledger/pglite/preview-financial-data.ts";
import { ProductCollectionInterruptedError } from "../lib/automation/product-collection.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import { ATTACHED_PREVIEW_PRODUCTS, collectAttachedPreviewProducts } from "../lib/preview-sources/attached-products.ts";
import { previewReceipt } from "../lib/preview-sources/preview-source-harness.ts";
import type { PreviewProductRun } from "../lib/preview-sources/product-collection.ts";
import type { PreviewResponseObservation } from "../lib/preview-sources/workflow.ts";
import {
  collectHncbCreditCards,
  type HncbCardPage,
  type HncbCardRange,
} from "./hncb-credit-card.ts";
import { hncbRunOutput, runHncbProviderWorkflow } from "./hncb-statements.ts";

const NOW = "2026-10-15T02:00:00.000Z";
const DATE = "Thu, 15 Oct 2026 02:00:00 GMT";

const currentHeader = "<tr><th>No.</th><th>消費日</th><th>入帳日</th><th>說明</th><th>國別</th><th>幣別</th><th>外幣金額</th><th>台幣金額</th><th>卡號</th></tr>";
const currentRow = (no: number, consume: string, post: string, description: string, amount: string, card: string) =>
  `<tr><td>${no}</td><td>${consume}</td><td>${post}</td><td>${description}</td><td>TW</td><td>TWD</td><td>-</td><td>${amount}</td><td>${card}</td></tr>`;

const CURRENT = `<html><body><p>信用額度：100,000</p><p>本期未出帳金額：1,530</p><table>${currentHeader}${
  currentRow(1, "10/12", "", "合成超商", "230", "正卡/1234")
}${currentRow(2, "10/10", "10/11", "合成餐廳", "1,500", "正卡/1234")
}${currentRow(3, "10/09", "10/10", "合成退款", "-200", "附卡/5678")}</table></body></html>`;

const bill = (period: string, closing: string, due: string, amount: string, paid: string | null, rows: string) =>
  `<html><body><p>帳單年月：${period}</p><p>帳單結帳日：${closing}</p><p>繳款截止日：${due}</p><p>本期應繳總額：${amount}</p>${
    paid === null ? "" : `<p>本期已繳金額：${paid}</p>`
  }<p>最低應繳金額：300</p><p>信用額度：100,000</p><table><tr><th>消費日</th><th>入帳日</th><th>說明</th><th>新臺幣金額</th></tr>${rows}<tr><td></td><td></td><td>消費小計</td><td>${amount}</td></tr></table></body></html>`;
const billRow = (consume: string, post: string, description: string, amount: string) =>
  `<tr><td>${consume}</td><td>${post}</td><td>${description}</td><td>${amount}</td></tr>`;

const BILL_SEP = bill("115/09", "2026/09/25", "2026/10/10", "3,000", "1,000",
  `<tr><td colspan="4">卡號：****1234</td></tr>${billRow("09/01", "09/02", "合成書店", "2,000")}${billRow("09/01", "09/02", "合成書店", "500")}${billRow("09/01", "09/02", "合成書店", "500")}`);
const BILL_AUG = bill("115/08", "2026/08/25", "2026/09/10", "1,000", "1,000",
  `<tr><td colspan="4">卡號：****5678</td></tr>${billRow("08/20", "08/21", "合成藥局", "1,000")}`);
const NO_BILL = "<html><body><p>查無資料</p></body></html>";

type Pages = Record<HncbCardRange, string>;
const PAGES: Pages = { 0: CURRENT, 1: BILL_SEP, 2: BILL_AUG, 3: NO_BILL };

function reader(pages: Pages, dialog: string | null = null) {
  const reads: HncbCardRange[] = [];
  const read = async (range: HncbCardRange): Promise<HncbCardPage> => {
    reads.push(range);
    return { range, status: 200, html: pages[range], date: DATE, dialog: range === "0" ? dialog : null };
  };
  return { read, reads };
}

async function attachedRun(pages: Pages, dialog: string | null = null, selected: readonly ("credit_card")[] = ["credit_card"]) {
  const writes: PreviewWrite[] = [];
  const observations: PreviewResponseObservation[] = [];
  const { read, reads } = reader(pages, dialog);
  const run = await collectAttachedPreviewProducts({
    context: {
      previewWrite: { write: async (input) => { writes.push(input); return previewReceipt(input); } },
      signal: new AbortController().signal,
      event: async () => undefined,
    },
    source: ATTACHED_PREVIEW_PRODUCTS.hncb,
    selected,
    collectors: { credit_card: () => collectHncbCreditCards(read, { now: NOW, observe: (response) => observations.push(response) }) },
  });
  return { run, writes, observations, reads };
}

const creditCollection = (write: PreviewWrite | undefined): PreviewCreditCollection => {
  assert.equal(write?.product, "credit_card");
  return (write as Extract<PreviewWrite, { product: "credit_card" }>).collection;
};


test("HNCB card collection writes the portfolio through the HNCB-bound preview writer", async () => {
  const { run, writes, observations } = await attachedRun(PAGES);
  assert.deepEqual(run.products, [{ typeId: "credit_card", status: "success", itemCount: 1, committedCount: 1 }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.sourceId, "hncb", "attached rows read back as the verified source");
  assert.equal(writes[0]!.institution, "hncb");
  const [account] = creditCollection(writes[0]).accounts;
  assert.ok(account);
  assert.equal(account.sourceAccountKey, "credit-card:TWD");
  assert.equal(account.currency, "TWD");
  assert.equal(account.creditLimit, "100000");
  assert.deepEqual(account.cards.map((card) => [card.sourceCardKey, card.cardMask]), [["card-1234", "****1234"], ["card-5678", "****5678"]]);
  assert.deepEqual(account.balances, [{
    amount: "3530",
    currency: "TWD",
    observedAt: { at: "2026-10-15T02:00:00.000Z", source: "reported" },
    basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "3000", paidAmount: "1000", unbilledAmount: "1530" },
  }]);
  const purchases = account.purchases.map((purchase) => ({
    key: purchase.sourceRowKey.replace(/:[0-9a-f]{12}#/u, "#"),
    amount: purchase.amount,
    direction: purchase.direction,
    posting: purchase.posting,
    consumedAt: purchase.consumedAt.value,
    card: purchase.sourceCardKey,
    statementKey: purchase.statementKey,
  }));
  assert.deepEqual(purchases, [
    { key: "pending:1234:2026-10-12:-:230#0", amount: "230", direction: "outflow", posting: { status: "pending" }, consumedAt: "2026-10-12", card: "card-1234", statementKey: null },
    { key: "posted:1234:2026-10-10:2026-10-11:1500#0", amount: "1500", direction: "outflow", posting: { status: "posted", billing: "unbilled", postingDate: "2026-10-11" }, consumedAt: "2026-10-10", card: "card-1234", statementKey: null },
    { key: "posted:5678:2026-10-09:2026-10-10:-200#0", amount: "-200", direction: "inflow", posting: { status: "posted", billing: "unbilled", postingDate: "2026-10-10" }, consumedAt: "2026-10-09", card: "card-5678", statementKey: null },
    { key: "posted:1234:2026-09-01:2026-09-02:2000#0", amount: "2000", direction: "outflow", posting: { status: "posted", billing: "billed", postingDate: "2026-09-02" }, consumedAt: "2026-09-01", card: "card-1234", statementKey: "2026-09" },
    { key: "posted:1234:2026-09-01:2026-09-02:500#0", amount: "500", direction: "outflow", posting: { status: "posted", billing: "billed", postingDate: "2026-09-02" }, consumedAt: "2026-09-01", card: "card-1234", statementKey: "2026-09" },
    { key: "posted:1234:2026-09-01:2026-09-02:500#1", amount: "500", direction: "outflow", posting: { status: "posted", billing: "billed", postingDate: "2026-09-02" }, consumedAt: "2026-09-01", card: "card-1234", statementKey: "2026-09" },
    { key: "posted:5678:2026-08-20:2026-08-21:1000#0", amount: "1000", direction: "outflow", posting: { status: "posted", billing: "billed", postingDate: "2026-08-21" }, consumedAt: "2026-08-20", card: "card-5678", statementKey: "2026-08" },
  ]);
  assert.deepEqual(account.statements, [{
    statementKey: "2026-09",
    cycleStart: "2026-08-26",
    cycleEnd: "2026-09-25",
    closingDate: "2026-09-25",
    dueDate: "2026-10-10",
    amount: "3000",
    currency: "TWD",
    minimumPayment: "300",
    billingPeriod: "2026-09",
    paidAmount: "1000",
    paid: null,
    noPaymentNeeded: null,
  }], "the oldest statement has no previous closing date, so it is not written");
  assert.deepEqual(observations.map((observation) => [observation.endpoint, observation.status]), [
    ["CrdDetailInq RANGE=0", 200], ["CrdDetailInq RANGE=1", 200], ["CrdDetailInq RANGE=2", 200], ["CrdDetailInq RANGE=3", 200],
  ]);
});

test("row keys are stable across collections", async () => {
  const first = await attachedRun(PAGES);
  const second = await attachedRun(PAGES);
  const keys = (writes: PreviewWrite[]) => creditCollection(writes[0]).accounts[0]!.purchases.map((purchase) => purchase.sourceRowKey);
  assert.deepEqual(keys(first.writes), keys(second.writes));
});

test("a layout table around the card table reads the same rows", async () => {
  const nested = CURRENT.replace("<table>", "<table><tr><td>華南銀行信用卡消費明細<table>").replace("</table>", "</table></td></tr><tr><td>注意事項</td></tr></table>");
  const plain = await attachedRun(PAGES);
  const wrapped = await attachedRun({ ...PAGES, 0: nested });
  assert.deepEqual(creditCollection(wrapped.writes[0]), creditCollection(plain.writes[0]));
});

test("direction stays unknown when the collection holds one sign only", async () => {
  const { writes } = await attachedRun({ ...PAGES, 0: CURRENT.replace("-200", "200") });
  assert.ok(creditCollection(writes[0]).accounts[0]!.purchases.every((purchase) => purchase.direction === "unknown"));
});

const failsBeforeWrite = async (pages: Pages, errorCode: string, reason: RegExp) => {
  const { run, writes } = await attachedRun(pages);
  assert.equal(writes.length, 0, `${reason}: nothing written`);
  assert.deepEqual(run.products, [{ typeId: "credit_card", status: "failed", itemCount: 0, committedCount: 0, errorCode }], String(reason));
  assert.match((run.firstFailure as Error).message, reason);
};

test("a missing currency fails before write", async () => {
  await failsBeforeWrite({ ...PAGES, 1: BILL_SEP.replace("新臺幣金額", "金額") }, "source-validation-failed", /missing-currency.*names no currency/u);
});

test("a malformed amount fails before write", async () => {
  await failsBeforeWrite({ ...PAGES, 0: CURRENT.replace(">230<", ">23O<") }, "source-validation-failed", /malformed-amount.*card row amount/u);
  await failsBeforeWrite({ ...PAGES, 1: BILL_SEP.replace("本期已繳金額：1,000", "本期已繳金額：1,0,00") }, "source-validation-failed", /malformed-amount.*本期已繳金額/u);
});

test("a zero card amount fails before write", async () => {
  await failsBeforeWrite({ ...PAGES, 0: CURRENT.replace(">230<", ">0<") }, "source-validation-failed", /malformed-amount.*is zero/u);
});

test("a missing balance operand fails before write", async () => {
  await failsBeforeWrite({ ...PAGES, 1: BILL_SEP.replace("<p>本期已繳金額：1,000</p>", "") }, "source-validation-failed", /no paid amount/u);
  await failsBeforeWrite({ ...PAGES, 1: BILL_SEP.replace("<p>本期已繳金額：1,000</p>", "<p>已繳款金額：1,000</p>") }, "source-validation-failed", /no paid amount/u);
  await failsBeforeWrite({ ...PAGES, 0: CURRENT.replace("<p>本期未出帳金額：1,530</p>", "") }, "source-validation-failed", /no 未出帳金額/u);
  await failsBeforeWrite({ ...PAGES, 1: BILL_SEP.replace("本期應繳總額：3,000", "應繳：3,000") }, "source-validation-failed", /no 本期應繳總額/u);
  await failsBeforeWrite({ ...PAGES, 1: NO_BILL, 2: NO_BILL }, "source-validation-failed", /no statement page/u);
});

test("an incomplete list fails before write", async () => {
  await failsBeforeWrite({ ...PAGES, 0: CURRENT.replace("</table>", "</table><a href=\"#\">下一頁</a>") }, "source-collection-failed", /incomplete-data.*RANGE=0/u);
  await failsBeforeWrite({ ...PAGES, 2: BILL_AUG.replace("</table>", "</table><a href=\"#\">下一頁</a>") }, "source-collection-failed", /incomplete-data.*RANGE=2/u);
});

test("not_held only on an explicit no-card signal", async () => {
  const message = await attachedRun({ ...PAGES, 0: "<html><body><div>您目前沒有本行信用卡。</div></body></html>" });
  assert.equal(message.run.products[0]?.status, "not_held");
  assert.equal(message.writes.length, 0);
  assert.deepEqual(message.reads, ["0"], "no statement page is read after a no-card notice");

  const dialog = await attachedRun(PAGES, "9001：您尚未持有本行信用卡。");
  assert.equal(dialog.run.products[0]?.status, "not_held");
  assert.equal(dialog.writes.length, 0);

  const offer = await attachedRun({ ...PAGES, 0: "<html><body><div>如您尚未持有本行信用卡，歡迎申辦。</div></body></html>" });
  assert.equal(offer.run.products[0]?.status, "failed", "an application offer is not a no-card notice");

  const empty = await attachedRun({ ...PAGES, 0: NO_BILL });
  assert.equal(empty.run.products[0]?.status, "failed", "an empty current page is not a no-card notice");

  const otherDialog = await attachedRun(PAGES, "系統忙碌中");
  assert.equal(otherDialog.run.products[0]?.status, "failed");
});

test("attachedPreviewProducts [] collects nothing", async () => {
  const { run, writes, reads } = await attachedRun(PAGES, null, []);
  assert.deepEqual(reads, []);
  assert.equal(writes.length, 0);
  assert.deepEqual(run.products, [{ typeId: "credit_card", status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_selected" }]);
});

const depositResult = { dateRange: { startDate: "2025/10/15", endDate: "2026/10/15" }, usedExistingSession: false, count: 2, status: "source-only" } as const;
const failedCard: PreviewProductRun = {
  products: [{ typeId: "credit_card", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-validation-failed" }],
  receipts: [],
  interrupted: null,
  firstFailure: new Error("card page changed"),
};

test("an attached card failure leaves the deposit outcome intact", () => {
  const output = hncbRunOutput(false, depositResult, failedCard);
  assert.deepEqual(output.products, [
    { typeId: "deposit", status: "success", itemCount: 2, committedCount: 2 },
    failedCard.products[0],
  ]);
  assert.equal(output.status, "source-only");
  assert.deepEqual(output.dateRange, depositResult.dateRange);
});

test("a session loss in the card product ends the run and keeps the deposit outcome", () => {
  const interrupted: PreviewProductRun = { ...failedCard, interrupted: { errorCode: "authentication-failed", error: new Error("session ended") } };
  assert.throws(() => hncbRunOutput(false, depositResult, interrupted), (error: unknown) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "authentication-failed");
    assert.deepEqual(error.summary.products[0], { typeId: "deposit", status: "success", itemCount: 2, committedCount: 2 });
    assert.equal(error.summary.status, "partial");
    return true;
  });
});

test("a card-only selection fails when the card fails and succeeds without a deposit", () => {
  assert.throws(() => hncbRunOutput(false, null, failedCard), /card page changed/u);
  const output = hncbRunOutput(false, null, {
    products: [{ typeId: "credit_card", status: "success", itemCount: 1, committedCount: 1 }],
    receipts: [],
    interrupted: null,
    firstFailure: null,
  });
  assert.deepEqual(output.products[0], { typeId: "deposit", status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_selected" });
  assert.equal(output.status, "completed");
  assert.equal(output.dateRange, undefined);
});

test("the input accepts a card-only selection and refuses an empty one", async () => {
  const context = {
    signal: new AbortController().signal,
    financialCommit: { execute: async () => { throw new Error("no commit"); } },
    event: async () => undefined,
    browser: { withPage: async () => { throw new Error("page opened"); } },
  } as unknown as WorkflowContext;
  const credentials = { hncb_user_id: "synthetic-user", hncb_account: "synthetic-account", hncb_password: "synthetic-password" };
  await assert.rejects(runHncbProviderWorkflow(context, { credentials, statementTypes: [], attachedPreviewProducts: ["credit_card"] }), /page opened/u);
  await assert.rejects(runHncbProviderWorkflow(context, { credentials, statementTypes: [], attachedPreviewProducts: [] }), /input or sign-in details/u);
  await assert.rejects(runHncbProviderWorkflow(context, { credentials }), /page opened/u, "absent selections keep the deposit default");
});
