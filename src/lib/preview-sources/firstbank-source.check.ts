import assert from "node:assert/strict";
import test from "node:test";
import { parsePreviewCreditCollection } from "../../ledger/pglite/preview-credit.ts";
import type { PreviewCreditCollection, PreviewProduct, PreviewWrite } from "../../ledger/pglite/preview-financial-data.ts";
import {
  createFirstbankSource,
  type FirstbankCapture,
  type FirstbankCardPages,
  type FirstbankPage,
  type FirstbankPageOpener,
  type FirstbankQueryAccount,
  type FirstbankSignInOutcome,
} from "./firstbank-source.ts";
import { blankPng, depositCollection, runPreviewSource, scriptedOcrEngine } from "./preview-source-harness.ts";
import { calibratedCaptchaSolver, FIRSTBANK_CAPTCHA_FAMILY } from "./preview-captcha.ts";

const credentials = {
  PREVIEW_FIRSTBANK_DEPOSIT_ID_NUMBER: "A000000001",
  PREVIEW_FIRSTBANK_DEPOSIT_USER_CODE: "user01",
  PREVIEW_FIRSTBANK_DEPOSIT_PASSWORD: "secret-pass",
};

const row = (...cells: readonly string[]) => `<tr class="ResultContent">${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;

const overviewRows = {
  salary: row("活期儲蓄存款", "123-45-678901（薪轉）", "新臺幣", "12,345.50", "12,000.00"),
  dollar: row("外匯活期存款", "123-45-999999", "USD", "812.34", "-"),
  term: row("定期存款", "123-45-555555", "新臺幣", "100,000", "&nbsp;"),
  card: row("VISA金融卡", "123-45-678901", "-", "-", "-"),
};

const overview = (rows: readonly string[] = Object.values(overviewRows), extra = "") =>
  `<html><body>${extra}<table><tr class="ResultHeader"><th>帳戶類別</th><th>帳號(暱稱)</th><th>幣別</th><th>帳面餘額</th><th>可用餘額</th></tr>${rows.join("")}</table></body></html>`;

const historyHeader = "<tr class=\"ResultHeader\"><th>交易日期</th><th>支出金額</th><th>存入金額</th><th>幣別</th><th>餘額</th><th>摘要</th><th>備註</th></tr>";

const history = (account: string, rows: readonly string[], extra = "") =>
  `<html><body><div>帳號：${account}</div>${extra}<table>${historyHeader}${rows.join("")}</table></body></html>`;

const histories = {
  A1: history("123-45-678901", [
    row("115/10/03 09:15:00", "-", "1,000.00", "", "12,345.50", "跨行轉入", "薪資"),
    row("2026/09/20", "250.5", "0", "", "11,345.50", "提款", "&nbsp;"),
  ]),
  A2: history("123-45-999999", [row("2026/10/05", "", "12.30", "美金", "812.34", "外幣轉入", "")]),
} as Record<string, string>;

const QUERY: readonly FirstbankQueryAccount[] = [
  { value: "A1", label: "123-45-678901 薪轉" },
  { value: "A2", label: "123-45-999999" },
];

const cms = (code: string, content: unknown, head: Record<string, string> = {}) =>
  ({ HEAD: { MSGID: `CMSQRY${code}`, RETURNCODE: "0000", ...head }, CONTENT: content });

const billRecord = (overrides: Record<string, unknown> = {}) => ({
  CardNo: "4000-00XX-XXXX-1234",
  Currency: "TWD",
  BillingPeriod: "2026/09",
  BillDate: "2026/09/07",
  PayEndDate: "2026/09/25",
  TotalAmount: "5,040",
  MinAmount: "504",
  CreditAmount: "80,000",
  Records: [
    { TransDate: "2026/08/20", AcctDate: "2026/08/22", AcctAmount: "4,800", TransDetail: "合成商店" },
    { CardNo: "4000-00XX-XXXX-5678", TransDate: "2026/08/28", AcctDate: "2026/08/29", AcctAmount: "300", TransDetail: "合成超市" },
    { TransDate: "2026/09/01", AcctDate: "2026/09/02", AcctAmount: "60-", TransDetail: "合成退貨" },
    { TransDetail: "本期金額合計", AcctAmount: "5,040" },
  ],
  ...overrides,
});

const unbilledRecord = (overrides: Record<string, unknown> = {}) =>
  ({ CardNo: "1234", Currency: "TWD", TransDate: "2026/10/14", AcctAmount: "99", TransDetail: "合成咖啡", ...overrides });

const UNBILLED_RECORDS = [
  unbilledRecord({ TransDate: "115/10/10", AcctDate: "2026/10/11", AcctAmount: "1,250.50", TransDetail: "合成餐廳", Currency: "新臺幣" }),
  unbilledRecord({ TransDate: "2026/10/14 18:30", AcctAmount: "(200)", TransDetail: "合成退款" }),
  unbilledRecord(),
  unbilledRecord(),
  unbilledRecord({ TransDate: "2026/10/12", AcctAmount: "15.20", TransDetail: "Synthetic store", Currency: "USD" }),
];

const card = (code: string, body: unknown, status = 200): FirstbankCapture =>
  ({ endpoint: `/cmsweb/Common/sendCMSQRY${code}`, status, date: null, text: typeof body === "string" ? body : JSON.stringify(body) });
const LOGOUT: FirstbankCapture = { endpoint: "/cmsweb/Home/Logout", status: 200, date: null, text: "<html><body>您已登出信用卡會員服務系統</body></html>" };

const cardCaptures = (parts: Readonly<{ dates?: unknown; bill?: unknown; payments?: readonly unknown[]; unbilled?: unknown }> = {}) => [
  card("9999", parts.dates ?? cms("9999", { ResultCount: "1", Result: "2026/09/07" })),
  ...(parts.bill === null ? [] : [card("0014", parts.bill ?? cms("0014", { BillRecords: [billRecord()] }))]),
  ...(parts.payments ?? [
    cms("0006", { Records: [{ PayDate: "2026/09/20", Amount: "3,000", Currency: "TWD" }] }),
    cms("0006", { Records: [{ PayDate: "2026/08/20", Amount: "1,000", Currency: "TWD" }] }),
  ]).map((body) => card("0006", body)),
  ...(parts.unbilled === null ? [] : [card("0008", parts.unbilled ?? cms("0008", { Records: UNBILLED_RECORDS }))]),
];

type Script = Readonly<{
  image?: Buffer;
  signIn?: FirstbankSignInOutcome;
  overview?: string;
  query?: readonly FirstbankQueryAccount[];
  histories?: Readonly<Record<string, string>>;
  cards?: FirstbankCardPages;
  signOutFails?: boolean;
}>;

function fakePage(script: Script = {}) {
  const calls: string[] = [];
  let opens = 0;
  const capture = (endpoint: string, text: string, date: string | null = null): FirstbankCapture => ({ endpoint, status: 200, date, text });
  const page: FirstbankPage = {
    async captchaImage() { calls.push("captcha"); return script.image ?? Buffer.from("png"); },
    async signIn(input) { calls.push(`signIn:${input.idNumber}:${input.userCode}:${input.captcha}`); return script.signIn ?? { kind: "signed-in" }; },
    async depositOverview() {
      calls.push("overview");
      return capture("/NetBank/ajax/acntReview1.html", script.overview ?? overview(), "Thu, 15 Oct 2026 01:59:00 GMT");
    },
    async queryAccounts() { calls.push("queryAccounts"); return script.query ?? QUERY; },
    async transactions(account, range) {
      calls.push(`transactions:${account.value}:${range.start}-${range.end}`);
      return capture("/NetBank/2/010103.html", (script.histories ?? histories)[account.value]!);
    },
    async cardPages() {
      calls.push("cardPages");
      return script.cards ?? { captures: cardCaptures(), notice: null };
    },
    async signOut() {
      calls.push("signOut");
      if (script.signOutFails) throw new Error("logout failed");
    },
  };
  const opener: FirstbankPageOpener = async (_context, _url, use) => { opens += 1; return use(page); };
  return { opener, calls, opens: () => opens };
}

const solveCaptcha = async () => "1234";

async function run(script: Script = {}, products: readonly PreviewProduct[] = ["deposit"]) {
  const fake = fakePage(script);
  const result = await runPreviewSource(createFirstbankSource({ page: fake.opener, solveCaptcha }), credentials, undefined, products);
  return { ...result, fake };
}

test("a First Bank run writes each deposit account with exact balances and three months of column-directed transactions", async () => {
  const { receipt, writes, observations, fake } = await run();
  assert.deepEqual(receipt, { accounts: 3, balances: 4, transactions: 3, statements: 0, closedAccounts: 0 });
  assert.equal(writes.length, 1, "an unselected card product is not collected");
  const asOf = { at: "2026-10-15T01:59:00.000Z", source: "reported" };
  const [salary, dollar, term] = depositCollection(writes[0]!).accounts;
  assert.deepEqual(
    [salary, dollar, term].map((account) => ({ key: account!.sourceAccountKey, label: account!.displayLabel, currency: account!.currency, balances: account!.balances })),
    [
      {
        key: "demand:12345678901:TWD",
        label: "第一銀行 薪轉 8901",
        currency: "TWD",
        balances: [
          { kind: "current", amount: "12345.50", currency: "TWD", observedAt: asOf },
          { kind: "available", amount: "12000.00", currency: "TWD", observedAt: asOf },
        ],
      },
      { key: "demand:12345999999:USD", label: "第一銀行 存款 9999 USD", currency: "USD", balances: [{ kind: "current", amount: "812.34", currency: "USD", observedAt: asOf }] },
      { key: "term:12345555555:TWD", label: "第一銀行 定存 5555", currency: "TWD", balances: [{ kind: "current", amount: "100000", currency: "TWD", observedAt: asOf }] },
    ],
    "the card row is skipped, the 幣別 cell names the currency, and the HTTP Date is the as-of time",
  );
  assert.deepEqual(salary!.transactions.map(({ amount, currency, direction, postedAt, description }) => ({ amount, currency, direction, postedAt, description })), [
    { amount: "1000.00", currency: "TWD", direction: "inflow", postedAt: { precision: "second", value: "2026-10-03T09:15:00" }, description: "跨行轉入 · 薪資" },
    { amount: "250.5", currency: "TWD", direction: "outflow", postedAt: { precision: "day", value: "2026-09-20" }, description: "提款" },
  ], "the ROC year is converted, and the direction comes from the debit and credit columns");
  assert.match(salary!.transactions[0]!.sourceRowKey, /^2026-10-03:[0-9a-f]{16}:1$/u);
  assert.deepEqual(dollar!.transactions.map(({ amount, currency, direction }) => ({ amount, currency, direction })), [{ amount: "12.30", currency: "USD", direction: "inflow" }]);
  assert.deepEqual(term!.transactions, [], "a time deposit is balance-only");
  assert.deepEqual(fake.calls, [
    "captcha", "signIn:A000000001:user01:1234", "overview", "queryAccounts",
    "transactions:A1:2026/08/01-2026/10/15", "transactions:A2:2026/08/01-2026/10/15", "signOut",
  ]);
  assert.deepEqual(observations.map((entry) => [entry.endpoint, entry.status]), [
    ["/NetBank/ajax/acntReview1.html", 200], ["/NetBank/2/010103.html", 200], ["/NetBank/2/010103.html", 200],
  ], "every captured response is observed");
});

test("a deposit row without a currency is refused before write", async () => {
  const result = await run({ overview: overview([overviewRows.salary, row("活期存款", "123-45-999999", "", "812.34", "-")]) });
  assert.equal(result.errorCode, "source-validation-failed");
  assert.match(String(result.error), /missing-currency/u);
  assert.equal(result.writes.length, 0);
  assert.equal(result.observations.length, 1, "the overview stays observed for a structure report");
});

test("a malformed amount is refused before write", async () => {
  const result = await run({ histories: { ...histories, A2: history("123-45-999999", [row("2026/10/05", "", "1.2.3", "USD", "1", "x", "")]) } });
  assert.equal(result.errorCode, "source-validation-failed");
  assert.match(String(result.error), /malformed-amount/u);
  assert.equal(result.writes.length, 0);
});

test("an incomplete page or account list fails as incomplete-data before write", async () => {
  const cases: Record<string, Script> = {
    "a next-page link": { histories: { ...histories, A1: history("123-45-678901", [], "<a href=\"#\">下一頁</a>") } },
    "a row-limit notice": { overview: overview(undefined, "<p>僅顯示 50 筆資料</p>") },
    "more than ten query accounts": {
      overview: overview(Array.from({ length: 11 }, (_, index) => row("活期存款", `123-45-${String(100000 + index)}`, "TWD", "1", "1"))),
      query: Array.from({ length: 11 }, (_, index) => ({ value: `Q${index}`, label: `123-45-${String(100000 + index)}` })),
    },
    "a demand account missing from the query list": { query: [QUERY[0]!] },
  };
  for (const [name, script] of Object.entries(cases)) {
    const result = await run(script);
    assert.equal(result.errorCode, "source-collection-failed", name);
    assert.match(String(result.error), /incomplete-data/u, name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.ok(result.fake.calls.includes("signOut"), `${name} still signs out`);
  }
});

test("a row that sets both or neither column, or a page for another account, fails before write", async () => {
  const both = await run({ histories: { ...histories, A1: history("123-45-678901", [row("2026/10/03", "1", "2", "", "1", "x", "")]) } });
  assert.equal(both.errorCode, "source-validation-failed");
  const neither = await run({ histories: { ...histories, A1: history("123-45-678901", [row("2026/10/03", "-", "0.00", "", "1", "x", "")]) } });
  assert.equal(neither.errorCode, "source-validation-failed");
  const other = await run({ histories: { ...histories, A1: history("123-45-000000", []) } });
  assert.equal(other.errorCode, "source-validation-failed");
  assert.equal(both.writes.length + neither.writes.length + other.writes.length, 0);
});

const creditOf = (writes: readonly PreviewWrite[]): PreviewCreditCollection => {
  const write = writes.find((candidate) => candidate.product === "credit_card");
  if (write?.product !== "credit_card") throw new Error("no credit card write");
  return write.collection;
};

const bothProducts = (script: Script = {}) => run(script, ["deposit", "credit_card"]);
const cardsOnly = (cards: FirstbankCardPages) => run({ cards }, ["credit_card"]);
const outcomes = (output: { products: readonly { typeId: string; status: string; errorCode?: string }[] } | null) =>
  output?.products.map(({ typeId, status, errorCode }) => errorCode ? `${typeId}:${status}:${errorCode}` : `${typeId}:${status}`);

test("one sign-in collects deposits, then the card bill, payments, and unbilled list as one account per currency", async () => {
  const { writes, output, observations, fake } = await bothProducts();
  assert.deepEqual(outcomes(output), ["deposit:success", "credit_card:success"]);
  assert.deepEqual(writes.map((write) => write.product), ["deposit", "credit_card"]);
  assert.doesNotThrow(() => parsePreviewCreditCollection(creditOf(writes)), "the preview port accepts the collection");
  assert.deepEqual(fake.calls.slice(-2), ["cardPages", "signOut"], "the card pages come after the deposit pages, in the same session");
  const [twd, usd] = creditOf(writes).accounts;
  assert.deepEqual(
    { key: twd!.sourceAccountKey, label: twd!.displayLabel, currency: twd!.currency, limit: twd!.creditLimit, cards: twd!.cards, balances: twd!.balances },
    {
      key: "card:TWD",
      label: "第一銀行 信用卡",
      currency: "TWD",
      limit: "80000",
      cards: [
        { sourceCardKey: "1234", cardMask: "****-1234", displayLabel: null },
        { sourceCardKey: "5678", cardMask: "****-5678", displayLabel: null },
      ],
      balances: [{
        amount: "3288.50",
        currency: "TWD",
        observedAt: { at: "2026-10-15T02:00:00.000Z", source: "collection-time" },
        basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "5040", paidAmount: "3000", unbilledAmount: "1248.50" },
      }],
    },
    "5040 - 3000 (paid after the 09/07 closing) + 1248.50 (1250.50 - 200 + 99 + 99); the 08/20 payment predates the statement",
  );
  assert.deepEqual(twd!.statements, [{
    statementKey: "2026-09",
    cycleStart: "2026-08-08",
    cycleEnd: "2026-09-07",
    closingDate: "2026-09-07",
    dueDate: "2026-09-25",
    amount: "5040",
    currency: "TWD",
    minimumPayment: "504",
    billingPeriod: "2026-09",
    paidAmount: "3000",
    paid: false,
    noPaymentNeeded: null,
  }]);
  assert.deepEqual(twd!.purchases.map(({ amount, direction, posting, consumedAt, sourceCardKey, statementKey, description }) =>
    ({ amount, direction, posting, consumedAt: consumedAt.value, sourceCardKey, statementKey, description })), [
    { amount: "4800", direction: "outflow", posting: { status: "posted", billing: "billed", postingDate: "2026-08-22" }, consumedAt: "2026-08-20", sourceCardKey: "1234", statementKey: "2026-09", description: "合成商店" },
    { amount: "300", direction: "outflow", posting: { status: "posted", billing: "billed", postingDate: "2026-08-29" }, consumedAt: "2026-08-28", sourceCardKey: "5678", statementKey: "2026-09", description: "合成超市" },
    { amount: "60", direction: "inflow", posting: { status: "posted", billing: "billed", postingDate: "2026-09-02" }, consumedAt: "2026-09-01", sourceCardKey: "1234", statementKey: "2026-09", description: "合成退貨" },
    { amount: "1250.50", direction: "outflow", posting: { status: "posted", billing: "unbilled", postingDate: "2026-10-11" }, consumedAt: "2026-10-10", sourceCardKey: "1234", statementKey: null, description: "合成餐廳" },
    { amount: "200", direction: "inflow", posting: { status: "pending" }, consumedAt: "2026-10-14T18:30", sourceCardKey: "1234", statementKey: null, description: "合成退款" },
    { amount: "99", direction: "outflow", posting: { status: "pending" }, consumedAt: "2026-10-14", sourceCardKey: "1234", statementKey: null, description: "合成咖啡" },
    { amount: "99", direction: "outflow", posting: { status: "pending" }, consumedAt: "2026-10-14", sourceCardKey: "1234", statementKey: null, description: "合成咖啡" },
  ], "the summary line is skipped, a trailing minus and parentheses read as negative, and both signs present allow direction from the sign");
  const [first, second] = twd!.purchases.slice(-2).map((purchase) => purchase.sourceRowKey);
  assert.equal(first!.replace(/:1$/u, ":2"), second, "identical rows differ only by their occurrence count");
  assert.deepEqual({ key: usd!.sourceAccountKey, label: usd!.displayLabel, balances: usd!.balances, statements: usd!.statements, amounts: usd!.purchases.map((purchase) => purchase.amount) },
    { key: "card:USD", label: "第一銀行 信用卡 USD", balances: [], statements: [], amounts: ["15.20"] }, "a currency without a statement has no balance rather than a zero one");
  assert.deepEqual(observations.map((entry) => entry.endpoint).slice(3), [
    "/cmsweb/Common/sendCMSQRY9999", "/cmsweb/Common/sendCMSQRY0014", "/cmsweb/Common/sendCMSQRY0006", "/cmsweb/Common/sendCMSQRY0006", "/cmsweb/Common/sendCMSQRY0008",
  ], "every card response is observed");
  const again = await bothProducts();
  assert.deepEqual(creditOf(again.writes).accounts.flatMap((account) => account.purchases.map((purchase) => purchase.sourceRowKey)),
    [twd!, usd!].flatMap((account) => account.purchases.map((purchase) => purchase.sourceRowKey)), "row keys are stable across collections");
});

test("a card collection with only one sign keeps the signed amounts with an unknown direction", async () => {
  const result = await cardsOnly({ captures: cardCaptures({
    bill: cms("0014", { BillRecords: [billRecord({ TotalAmount: "300", Records: [{ TransDate: "2026/08/28", AcctAmount: "300", TransDetail: "合成超市" }] })] }),
    unbilled: cms("0008", { Records: [unbilledRecord()] }),
  }), notice: null });
  const [account] = creditOf(result.writes).accounts;
  assert.deepEqual(account!.purchases.map(({ amount, direction }) => [amount, direction]), [["300", "unknown"], ["99", "unknown"]]);
  const refunds = await cardsOnly({ captures: cardCaptures({ bill: null, dates: cms("9999", { ResultCount: "0", Result: "" }), unbilled: cms("0008", { Records: [unbilledRecord({ AcctAmount: "99-" })] }) }), notice: null });
  assert.deepEqual(creditOf(refunds.writes).accounts[0]!.purchases.map(({ amount, direction }) => [amount, direction]), [["-99", "unknown"]]);
});

test("an overpaid card gives a negative used credit, never clamped", async () => {
  const result = await cardsOnly({ captures: cardCaptures({
    bill: cms("0014", { BillRecords: [billRecord({ TotalAmount: "(1,200)", Records: [] })] }),
    payments: [cms("0006", { Records: [{ PayDate: "2026/09/10", Amount: "300", Currency: "TWD" }] })],
    unbilled: cms("0008", { Records: [unbilledRecord({ AcctAmount: "450.5" })] }),
  }), notice: null });
  const [twd] = creditOf(result.writes).accounts;
  assert.deepEqual(twd!.balances.map(({ amount, basis }) => ({ amount, basis })), [{
    amount: "-1049.5",
    basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "-1200", paidAmount: "300", unbilledAmount: "450.5" },
  }]);
  assert.equal(twd!.statements[0]!.paid, true, "a paid amount at or above a credit statement means paid");
});

test("an empty bill-date list means no statement: purchases are written and the balance stays unknown", async () => {
  const result = await cardsOnly({ captures: cardCaptures({ bill: null, dates: cms("9999", { ResultCount: "0", Result: "" }) }), notice: null });
  assert.deepEqual(outcomes(result.output), ["deposit:skipped", "credit_card:success"]);
  const [twd] = creditOf(result.writes).accounts;
  assert.deepEqual([twd!.balances, twd!.statements, twd!.purchases.length], [[], [], 4]);
});

test("a due date given only as a status text keeps the balance but writes no statement", async () => {
  const result = await cardsOnly({ captures: cardCaptures({ bill: cms("0014", { BillRecords: [billRecord({ PayEndDate: "免繳" })] }) }), notice: null });
  const [twd] = creditOf(result.writes).accounts;
  assert.deepEqual(twd!.statements, []);
  assert.equal(twd!.balances[0]!.amount, "3288.50");
});

test("not_held needs an explicit no-card signal", async () => {
  const signals: Record<string, FirstbankCardPages> = {
    "CMSQRY0006 REFRETURNDESC 查無卡人": { captures: [card("9999", cms("9999", { ResultCount: "0", Result: "" })), card("0006", cms("0006", null, { REFRETURNDESC: "查無卡人" })), card("0008", cms("0008", null, { RETURNDESC: "查無卡片資訊" }))], notice: null },
    "the card member logout before any card answer": { captures: [LOGOUT], notice: null },
    "a no-card notice": { captures: [], notice: "您目前沒有本行信用卡。" },
  };
  for (const [name, cards] of Object.entries(signals)) {
    const result = await cardsOnly(cards);
    assert.deepEqual(outcomes(result.output), ["deposit:skipped", "credit_card:not_held"], name);
    assert.equal(result.writes.length, 0, `${name} writes no account and no zero balance`);
  }
  const empty = await cardsOnly({ captures: cardCaptures({ bill: null, dates: cms("9999", { ResultCount: "0", Result: "" }), payments: [cms("0006", { Records: [] })], unbilled: cms("0008", { Records: [] }) }), notice: null });
  assert.equal(empty.errorCode, null);
  assert.deepEqual(outcomes(empty.output), ["deposit:skipped", "credit_card:no_data"], "empty lists without a no-card signal are not not_held");
  const refusals: Record<string, readonly [FirstbankCardPages, RegExp]> = {
    "a logout after a card answer": [{ captures: [card("0014", cms("0014", { BillRecords: [] })), LOGOUT], notice: null }, /incomplete-data.*CMSQRY0006/u],
    "an unrecognized notice": [{ captures: [], notice: "系統忙碌中，請稍後再試" }, /unrecognized message/u],
    "a membership hint": [{ captures: [], notice: "未申請網服會員" }, /unrecognized message/u],
    "no card pages at all": [{ captures: [], notice: null }, /incomplete-data/u],
    "a no-card answer beside card data": [{ captures: [...cardCaptures(), card("0006", cms("0006", null, { REFRETURNDESC: "查無卡人" }))], notice: null }, /no card and card data together/u],
  };
  for (const [name, [cards, reason]] of Object.entries(refusals)) {
    const result = await cardsOnly(cards);
    assert.match(String(result.error), reason, name);
    assert.equal(result.writes.length, 0, name);
  }
});

test("card data that is missing, malformed, or incomplete fails the card product before write and keeps the deposits", async () => {
  const cases: Record<string, readonly [FirstbankCardPages, RegExp]> = {
    "an unbilled row without a currency": [{ captures: cardCaptures({ unbilled: cms("0008", { Records: [unbilledRecord({ Currency: "" })] }) }), notice: null }, /missing-currency/u],
    "a statement without a currency": [{ captures: cardCaptures({ bill: cms("0014", { BillRecords: [billRecord({ Currency: undefined })] }) }), notice: null }, /missing-currency/u],
    "a malformed statement amount": [{ captures: cardCaptures({ bill: cms("0014", { BillRecords: [billRecord({ TotalAmount: "5.040.00" })] }) }), notice: null }, /malformed-amount/u],
    "a malformed purchase amount": [{ captures: cardCaptures({ unbilled: cms("0008", { Records: [unbilledRecord({ AcctAmount: "NT$99" })] }) }), notice: null }, /malformed-amount/u],
    "a zero purchase amount": [{ captures: cardCaptures({ unbilled: cms("0008", { Records: [unbilledRecord({ AcctAmount: "0" })] }) }), notice: null }, /malformed-amount/u],
    "a statement without its amount operand": [{ captures: cardCaptures({ bill: cms("0014", { BillRecords: [billRecord({ TotalAmount: "" })] }) }), notice: null }, /unexpected-response.*statement amount/u],
    "a payment without its amount operand": [{ captures: cardCaptures({ payments: [cms("0006", { Records: [{ PayDate: "2026/09/20", Currency: "TWD" }] })] }), notice: null }, /malformed-amount/u],
    "no payment list (the paid operand)": [{ captures: cardCaptures({ payments: [] }), notice: null }, /incomplete-data.*CMSQRY0006/u],
    "no unbilled list (the unbilled operand)": [{ captures: cardCaptures({ unbilled: null }), notice: null }, /incomplete-data.*CMSQRY0008/u],
    "no statement although bill dates exist": [{ captures: cardCaptures({ bill: null }), notice: null }, /incomplete-data.*CMSQRY0014/u],
    "an unbilled response without its list": [{ captures: cardCaptures({ unbilled: cms("0008", {}) }), notice: null }, /unexpected-response.*Records/u],
    "a failed card query": [{ captures: cardCaptures({ unbilled: cms("0008", { Records: [] }, { RETURNCODE: "E999" }) }), notice: null }, /unexpected-response.*E999/u],
    "an HTTP error": [{ captures: [...cardCaptures({ unbilled: null }), card("0008", "<html>error</html>", 500)], notice: null }, /HTTP 500/u],
    "a repeated billing period": [{ captures: cardCaptures({ bill: cms("0014", { BillRecords: [billRecord(), billRecord({ CardNo: "5678", TotalAmount: "1" })] }) }), notice: null }, /repeats a TWD billing period/u],
  };
  for (const [name, [cards, reason]] of Object.entries(cases)) {
    const result = await bothProducts({ cards });
    assert.deepEqual(outcomes(result.output), ["deposit:success", `credit_card:failed:${/incomplete-data/u.test(reason.source) ? "source-collection-failed" : "source-validation-failed"}`], name);
    assert.deepEqual(result.writes.map((write) => write.product), ["deposit"], `${name} writes no card data and keeps the deposits`);
    const failure = await cardsOnly(cards);
    assert.match(String(failure.error), reason, name);
  }
});

test("a deposit failure leaves the card product collected in the same run", async () => {
  const result = await bothProducts({ overview: overview([row("活期存款", "123-45-999999", "", "812.34", "-")]) });
  assert.deepEqual(outcomes(result.output), ["deposit:failed:source-validation-failed", "credit_card:success"]);
  assert.deepEqual(result.writes.map((write) => write.product), ["credit_card"]);
  assert.ok(result.fake.calls.includes("cardPages"));
});

test("production refuses an unsupported First Bank capture without sign-in or logout", async () => {
  const fake = fakePage();
  const injected = await runPreviewSource(createFirstbankSource({ page: fake.opener }), credentials);
  assert.equal(injected.errorCode, "verification-configuration-failed");
  assert.ok(injected.events.some((event) => event.code === "solver-challenge-unsupported"));
  assert.equal(fake.opens(), 1);
  assert.deepEqual(fake.calls, ["captcha"]);
});

test("First Bank submits once after calibrated acceptance and never submits a low-confidence answer", async () => {
  for (const confidence of [0.97, 0.969]) {
    const fake = fakePage({ image: blankPng(67, 29) });
    const engine = scriptedOcrEngine([{ text: "AB12", confidence }, { text: "", confidence: 0 }, { text: "", confidence: 0 }]);
    const result = await runPreviewSource(createFirstbankSource({ page: fake.opener,
      solveCaptcha: calibratedCaptchaSolver(FIRSTBANK_CAPTCHA_FAMILY, engine) }), credentials, undefined, ["deposit"]);
    assert.equal(fake.calls.filter((call) => call.startsWith("signIn:")).length, confidence >= 0.97 ? 1 : 0);
    if (confidence < 0.97) {
      assert.equal(result.errorCode, "verification-failed");
      assert.deepEqual(fake.calls, ["captcha"]);
      assert.equal(result.writes.length, 0);
    } else assert.equal(result.errorCode, null);
  }
});

test("sign-in refusals are typed, collect nothing, and still attempt the logout", async () => {
  const outcomes = {
    MULTI_SESSION_LOGIN: /session-conflict/u,
    "您的帳號已在其他地方登入，請勿重複登入": /session-conflict/u,
    "圖形驗證碼錯誤！": /verification-rejected/u,
    "使用者代號或密碼錯誤": /sign-in-rejected/u,
  };
  for (const [message, reason] of Object.entries(outcomes)) {
    const result = await run({ signIn: { kind: "refused", message } });
    assert.match(String(result.error), reason, message);
    assert.ok(!result.fake.calls.includes("overview"), `${message} collects nothing`);
    assert.equal(result.fake.calls.at(-1), "signOut", `${message} still signs out`);
  }
  assert.equal((await run({ signIn: { kind: "no-outcome" } })).errorCode, "source-validation-failed");
});

test("a failed logout does not override the result", async () => {
  const result = await run({ signOutFails: true });
  assert.equal(result.errorCode, null);
  assert.equal(result.writes.length, 1);
});
