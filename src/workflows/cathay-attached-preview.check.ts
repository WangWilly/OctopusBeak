import assert from "node:assert/strict";
import test from "node:test";
import { originProvenance } from "../lib/shared-ledger/provenance.ts";
import { parsePreviewWrite } from "../ledger/pglite/preview-financial-data.ts";
import type { PreviewCreditCollection, PreviewTimeDepositCollection } from "../ledger/pglite/preview-financial-data.ts";
import { PreviewSourceFailure } from "../lib/preview-sources/source-kit.ts";
import type { PreviewLoanCollection } from "../ledger/pglite/preview-loan.ts";
import {
  collectCathayCreditCards,
  collectCathayLoans,
  collectCathayTimeDeposits,
  type CathayLoanOverview,
} from "./cathay-attached-preview.ts";
import {
  CATHAY_CARD_OVERVIEW_TEXT as OVERVIEW_TEXT,
  CATHAY_LOAN_OVERVIEW as LOAN_OVERVIEW,
  CATHAY_PREVIEW_NOW as NOW,
  CATHAY_PREVIEW_RESPONSES as RESPONSES,
  cathayCardTotals,
  cathayEnvelope as envelope,
  fakeCathayAttachedPreviewPort as fakePort,
} from "./cathay-attached-preview.fixtures.ts";

const written = (collection: PreviewCreditCollection | PreviewTimeDepositCollection, product: "credit_card" | "time_deposit") =>
  parsePreviewWrite({ sourceId: "cathay", institution: "cathay", product, collection } as Parameters<typeof parsePreviewWrite>[0]);

async function rejectsWith(promise: Promise<unknown>, reason: PreviewSourceFailure["reason"]) {
  await assert.rejects(promise, (error: unknown) => error instanceof PreviewSourceFailure && error.reason === reason);
}


test("Cathay credit cards write one NT-dollar account with balance, cards, billed purchases, and a statement per currency", async () => {
  const { port, seen } = fakePort();
  const collection = await collectCathayCreditCards(port, NOW);
  assert.ok(!("absent" in collection));
  written(collection, "credit_card");
  assert.deepEqual(seen, [
    "cardStatus", "latestBill", "C_BILL_Q_RecentBillInfo", "C_BILL_Q_BillInfo", "C_BILL_Q_HistoryBillList",
    "detail:2026-09-20", "detail:2026-08-20",
  ]);
  assert.deepEqual(collection.accounts.map((account) => [account.sourceAccountKey, account.currency]), [["card-portfolio:TWD", "TWD"]],
    "the foreign bill writes no account of its own");
  const [twd] = collection.accounts;
  assert.deepEqual(twd!.cards.map((card) => card.cardMask), ["****-1234", "****-5678"]);
  assert.equal(twd!.creditLimit, "100000");
  assert.deepEqual(twd!.balances, [{
    amount: "1234.5",
    currency: "TWD",
    observedAt: { at: "2026-10-18T01:59:58.000Z", source: "reported" },
    basis: { kind: "credit-limit-minus-available", creditLimit: "100000", availableCredit: "98765.5" },
  }]);
  assert.deepEqual(twd!.purchases.map((purchase) => [purchase.amount, purchase.direction, purchase.consumedAt.value, purchase.statementKey]), [
    ["500", "outflow", "2026-09-01", "2026-09"],
    ["500", "outflow", "2026-09-01", "2026-09"],
    ["-120.50", "inflow", "2026-09-03", "2026-09"],
  ]);
  assert.equal(new Set(twd!.purchases.map((purchase) => purchase.sourceRowKey)).size, 3);
  assert.ok(twd!.purchases.every((purchase) => purchase.posting.status === "posted" && purchase.posting.billing === "billed"));
  assert.deepEqual(twd!.statements, [{
    statementKey: "2026-09",
    cycleStart: "2026-08-21",
    cycleEnd: "2026-09-20",
    closingDate: "2026-09-20",
    dueDate: "2026-10-05",
    amount: "1234.5",
    currency: "TWD",
    minimumPayment: "1000",
    billingPeriod: "2026-09",
    paidAmount: "34.5",
    paid: false,
    noPaymentNeeded: null,
  }, {
    statementKey: "2026-09:USD",
    cycleStart: "2026-08-21",
    cycleEnd: "2026-09-20",
    closingDate: "2026-09-20",
    dueDate: "2026-10-05",
    amount: "12.30",
    currency: "USD",
    minimumPayment: "12.30",
    billingPeriod: "2026-09",
    paidAmount: "0",
    paid: false,
    noPaymentNeeded: null,
  }]);
  assert.deepEqual(cathayCardTotals(collection).net, { provenance: originProvenance("preview") }, "the foreign bill leaves the totals complete");
});

test("a Cathay bill without a foreign part writes only the NT-dollar statement", async () => {
  const collection = await collectCathayCreditCards(fakePort({
    C_BILL_Q_RecentBillInfo: RESPONSES.C_BILL_Q_RecentBillInfo.replace(/,"foreignBillInfo":\{[^}]*\}/u, ""),
  }).port, NOW);
  assert.ok(!("absent" in collection));
  assert.deepEqual(collection.accounts.flatMap((account) => account.statements.map((statement) => statement.statementKey)), ["2026-09"]);
});

test("Cathay card row keys are stable across collections", async () => {
  const first = await collectCathayCreditCards(fakePort().port, NOW);
  const second = await collectCathayCreditCards(fakePort().port, "2026-10-19T02:00:00.000Z");
  assert.ok(!("absent" in first) && !("absent" in second));
  assert.deepEqual(first.accounts[0]!.purchases.map((row) => row.sourceRowKey), second.accounts[0]!.purchases.map((row) => row.sourceRowKey));
});

test("a single-signed purchase list keeps every direction unknown", async () => {
  const { port } = fakePort({
    "detail:2026-09-20": envelope({ twdBillDetailInfo: [{ detailType: "Consume", tradeData: [{ consumeDate: "2026-09-01", transDesc: "x", amount: "500", currency: "TWD" }] }] }),
  });
  const collection = await collectCathayCreditCards(port, NOW);
  assert.ok(!("absent" in collection));
  assert.deepEqual(collection.accounts[0]!.purchases.map((purchase) => purchase.direction), ["unknown"]);
});

test("only cardStatus Invalid reports not_held", async () => {
  const invalid = fakePort({ cardStatus: `{"returnCode":"0000","content":{"cardStatus":"Invalid"}}`, overviewText: "信用卡總覽 立即線上辦卡" });
  assert.deepEqual(await collectCathayCreditCards(invalid.port, NOW), { absent: "not_held" });
  assert.deepEqual(invalid.seen, ["cardStatus", "latestBill"]);
  await rejectsWith(collectCathayCreditCards(fakePort({ overviewText: "信用卡總覽 立即線上辦卡" }).port, NOW), "unexpected-response");
  await rejectsWith(collectCathayCreditCards(fakePort({ cardStatus: `{"returnCode":"9999","content":{"cardStatus":"Invalid"}}` }).port, NOW), "unexpected-response");
  await rejectsWith(collectCathayCreditCards(fakePort({ cardStatus: `{"returnCode":"0000","content":{"cardStatus":"Gone"}}` }).port, NOW), "unexpected-response");
});

test("a missing currency fails the card product before its write", async () => {
  await rejectsWith(collectCathayCreditCards(fakePort({
    "detail:2026-09-20": envelope({ twdBillDetailInfo: [{ detailType: "Consume", tradeData: [{ consumeDate: "2026-09-01", transDesc: "x", amount: "500" }] }] }),
  }).port, NOW), "missing-currency");
  await rejectsWith(collectCathayCreditCards(fakePort({ overviewText: OVERVIEW_TEXT.replace("永久信用額度 TWD", "永久信用額度") }).port, NOW), "missing-currency");
  await rejectsWith(collectCathayCreditCards(fakePort({
    C_BILL_Q_RecentBillInfo: RESPONSES.C_BILL_Q_RecentBillInfo.replace(`"currency":"USD",`, ""),
  }).port, NOW), "missing-currency");
});

test("a malformed amount fails the card product before its write", async () => {
  await rejectsWith(collectCathayCreditCards(fakePort({
    "detail:2026-09-20": RESPONSES["detail:2026-09-20"].replace(`"amount":500,`, `"amount":"5 00",`),
  }).port, NOW), "malformed-amount");
  await rejectsWith(collectCathayCreditCards(fakePort({
    C_BILL_Q_RecentBillInfo: RESPONSES.C_BILL_Q_RecentBillInfo.replace(`"unPaidAmount":1200`, `"unPaidAmount":null`),
  }).port, NOW), "malformed-amount");
});

test("a missing balance operand fails the card product before its write", async () => {
  await rejectsWith(collectCathayCreditCards(fakePort({ overviewText: OVERVIEW_TEXT.replace(/剩餘可用額度.*/u, "") }).port, NOW), "incomplete-data");
  await rejectsWith(collectCathayCreditCards(fakePort({ overviewText: OVERVIEW_TEXT.replace(/永久信用額度.*/u, "") }).port, NOW), "incomplete-data");
});

test("a statement without a due date is not written", async () => {
  const collection = await collectCathayCreditCards(fakePort({ latestBill: null }).port, NOW);
  assert.ok(!("absent" in collection));
  assert.deepEqual(collection.accounts.map((account) => account.statements.length), [0]);
});

test("Cathay time deposits write the complete NT-dollar list", async () => {
  const { port, seen } = fakePort();
  const collection = await collectCathayTimeDeposits(port, NOW);
  written(collection, "time_deposit");
  assert.deepEqual(seen, ["domesticOverview"]);
  assert.equal(collection.completeness, "complete");
  assert.deepEqual(collection.deposits.map((deposit) => [
    deposit.sourceAccountKey, deposit.currency, deposit.balances[0]!.amount, deposit.interestRate, deposit.maturityDate, deposit.principal,
  ]), [
    ["time-deposit:fixture-td-0001", "TWD", "100000.00", "1.725", "2027-03-01", null],
    ["time-deposit:fixture-td-0002", "TWD", "50000", null, null, null],
  ]);
  assert.deepEqual(collection.deposits[0]!.balances[0]!.observedAt, { at: "2026-10-18T01:59:58.000Z", source: "reported" });
});

test("an explicit NoData answer is a complete empty time-deposit list", async () => {
  const collection = await collectCathayTimeDeposits(fakePort({
    domesticOverview: `{"success":true,"content":{"timeDepositData":{"queryStatus":"NoData","datas":[]}}}`,
  }).port, NOW);
  assert.deepEqual(collection.deposits, []);
});

test("a time-deposit list that cannot be shown complete fails before its write", async () => {
  const overview = RESPONSES.domesticOverview;
  await rejectsWith(collectCathayTimeDeposits(fakePort({ domesticOverview: overview.replace(`"timeDepositData":{"queryStatus":"Success"`, `"timeDepositData":{"queryStatus":"Fail"`) }).port, NOW), "incomplete-data");
  await rejectsWith(collectCathayTimeDeposits(fakePort({ domesticOverview: overview.replace("150000.00", "250000.00") }).port, NOW), "incomplete-data");
  await rejectsWith(collectCathayTimeDeposits(fakePort({
    domesticOverview: `{"success":true,"content":{"timeDepositData":[{"accountNo":"fixture-td-0001","accountBalance":1}]}}`,
  }).port, NOW), "unexpected-response");
  await rejectsWith(collectCathayTimeDeposits(fakePort({
    domesticOverview: `{"success":true,"content":{"timeDepositData":{"queryStatus":"NoData","datas":[{"accountNo":"fixture-td-0001","accountBalance":1}]}}}`,
  }).port, NOW), "incomplete-data");
  await rejectsWith(collectCathayTimeDeposits(fakePort({ domesticOverview: `{"success":true,"content":{}}` }).port, NOW), "unexpected-response");
});

test("a malformed or unknown-currency time deposit fails before its write", async () => {
  const overview = RESPONSES.domesticOverview;
  await rejectsWith(collectCathayTimeDeposits(fakePort({ domesticOverview: overview.replace(`"accountBalance":50000`, `"accountBalance":"5O000"`) }).port, NOW), "malformed-amount");
  await rejectsWith(collectCathayTimeDeposits(fakePort({ domesticOverview: overview.replace(`"accountBalance":50000`, `"accountBalance":50000,"currency":"??"`) }).port, NOW), "missing-currency");
});

const loanWritten = (collection: PreviewLoanCollection) =>
  parsePreviewWrite({ sourceId: "cathay", institution: "cathay", product: "loan", collection });
const loanOverview = (changes: Partial<CathayLoanOverview>): CathayLoanOverview => ({ ...LOAN_OVERVIEW, ...changes });

test("Cathay loans map the L0101 overview and reconcile with 貸款總餘額", async () => {
  const { port, seen } = fakePort();
  const collection = await collectCathayLoans(port, NOW);
  loanWritten(collection);
  assert.deepEqual(seen, ["loanOverview"]);
  assert.equal(collection.completeness, "complete");
  assert.deepEqual(collection.loans[0], {
    sourceAccountKey: "100200301",
    displayLabel: "國泰世華貸款 0301",
    currency: "TWD",
    category: "housing",
    outstandingBalance: { amount: "1000000", observedAt: { at: "2026-10-18T01:59:58.000Z", source: "reported" } },
    originalAmount: null,
    interestRate: "1.37",
    paymentAmount: "12345",
    nextPaymentDate: "2026-11-05",
    installmentsPaid: 17,
    installmentsTotal: 180,
    openedOn: null,
    maturityDate: null,
  });
  const other = collection.loans[1]!;
  assert.deepEqual([other.displayLabel, other.category, other.interestRate, other.nextPaymentDate, other.installmentsPaid],
    ["國泰世華貸款 0302", null, null, null, null], "其他貸款 names no category, and a payment status is no date");
});

test("a 貸款類別 value names the category, and an ROC 扣款日 is read as a Gregorian date", async () => {
  const [row] = LOAN_OVERVIEW.rows;
  const collection = await collectCathayLoans(fakePort({}, loanOverview({
    totalBalance: "1,000,000",
    rows: [{ ...row!, section: null, category: "房屋貸款", paymentDue: "115/11/05" }],
  })).port, NOW);
  assert.equal(collection.loans[0]!.category, "housing");
  assert.equal(collection.loans[0]!.nextPaymentDate, "2026-11-05");
});

test("an L0101 page that says it holds no loan is a complete empty loan list", async () => {
  const collection = await collectCathayLoans(fakePort({}, loanOverview({ rows: [], noLoanMessage: true, currency: null, totalBalance: null })).port, NOW);
  loanWritten(collection);
  assert.deepEqual(collection, { collectedAt: NOW, completeness: "complete", loans: [] });
});

test("a Cathay loan list that does not reconcile with 貸款總餘額 fails before its write", async () => {
  await rejectsWith(collectCathayLoans(fakePort({}, loanOverview({ totalBalance: "NT$ 2,234,567" })).port, NOW), "incomplete-data");
  await rejectsWith(collectCathayLoans(fakePort({}, loanOverview({ totalBalance: null })).port, NOW), "incomplete-data");
  await rejectsWith(collectCathayLoans(fakePort({}, loanOverview({ rows: LOAN_OVERVIEW.rows.slice(0, 1) })).port, NOW), "incomplete-data");
  await rejectsWith(collectCathayLoans(fakePort({}, loanOverview({ rows: [] })).port, NOW), "incomplete-data");
});

test("a Cathay loan without its full account number or a readable page fails the product", async () => {
  const [first, second] = LOAN_OVERVIEW.rows;
  await rejectsWith(collectCathayLoans(fakePort({}, loanOverview({ rows: [{ ...first!, accountNumber: "****0301" }, second!] })).port, NOW), "unexpected-response");
  await rejectsWith(collectCathayLoans(fakePort({}, loanOverview({ rows: [{ ...first!, accountNumber: null }, second!] })).port, NOW), "unexpected-response");
  await rejectsWith(collectCathayLoans(fakePort({}, loanOverview({ recognized: false })).port, NOW), "unexpected-response");
  await rejectsWith(collectCathayLoans(fakePort({}, loanOverview({ currency: null })).port, NOW), "missing-currency");
  await rejectsWith(collectCathayLoans(fakePort({}, loanOverview({ rows: [{ ...first!, balance: "一百萬" }, second!] })).port, NOW), "malformed-amount");
});
