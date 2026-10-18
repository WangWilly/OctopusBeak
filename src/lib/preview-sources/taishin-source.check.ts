import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewHttpOpener } from "./browser-http.ts";
import { calibratedCaptchaSolver, TAISHIN_CAPTCHA_FAMILY } from "./preview-captcha.ts";
import type { PreviewCreditCollection, PreviewProduct, PreviewWrite } from "../../ledger/pglite/preview-financial-data.ts";
import { blankPng, fakeHttpOpener, jsonResponse, runPreviewSource, depositCollection, scriptedOcrEngine, type FakeRoute } from "./preview-source-harness.ts";
import { createTaishinSource, type TaishinCredentials, type TaishinLoginForm, type TaishinSessionOpener } from "./taishin-source.ts";

const credentials = {
  PREVIEW_TAISHIN_DEPOSIT_ID_NUMBER: "A000000001",
  PREVIEW_TAISHIN_DEPOSIT_USER_CODE: "user01",
  PREVIEW_TAISHIN_DEPOSIT_PASSWORD: "secret-pass",
};

const P = "POST /TIBNetBank/svc";
const twd = (output: string, headers: Record<string, string> = {}) => jsonResponse(`{"RESULT":"NORMAL","OUTPUTDATA":${output}}`, headers);
const fx = (data: string, headers: Record<string, string> = {}) => jsonResponse(`{"error":null,"data":${data}}`, headers);

const twdRow = (procSeq: string, inAmount: string, outAmount: string, extra = "") =>
  `{"sysdate":"2026/10/03 09:15:00","dateNew":"2026/10/03","txnamt":"1","txnamtIn":${inAmount},"txnamtOut":${outAmount},"newbal":5000,"memo":"轉帳<br>存入","message":"薪資","procSeq":${procSeq}${extra}}`;
const twdList = (rows: readonly string[], inNo = rows.length, outNo = 0) => twd(`{"userList":[${rows.join(",")}],"inNo":"${inNo}","outNo":${outNo}}`);

const fxRow = (time: string, dep: string, drw: string, ccy = '"USD"') =>
  `{"TRANSACTION_DATE_TIME":"x","TRANSACTION_DATE_TIME_DSC":"${time}","TX_DATE":"2026/10/05","CCY_CODE":${ccy},"DRWAMT":${drw},"DEPAMT":${dep},"ACCT_BAL":"812.34","REMARKS":"外幣轉入"}`;

const card = (value: unknown, headers: Record<string, string> = {}) => jsonResponse({ error: null, value }, headers);
const realtimeRow = (amount: string, result = "成功", time = "09:15:30") => ["2026/10/14", time, "DEMO SHOP", amount, "TW", result, "DEMO SHOP TAIPEI"];
const unbilledRow = (date: string, description: string, amount: string, currency = "TWD") => [date, "2026/10/13", description, amount, "", "TW", "", currency];
const bill = (period: string, closing: string, due: string, balance: string, details: unknown[] = []) => card({
  showAccoutnYM: period, showStmtDate: closing, showDueDate: due, showCbalance: balance, showMinPay: "100",
  newAcctDetailList: details.length === 0 ? [] : [{ order: "測試信用卡 ****1234", detail: details }],
});
const billDetail = (amount: string, currency = "TWD") =>
  ({ showOutTXNDate: "2026/10/01", showOutPostDate: "2026/10/02", showOutDesc: "STORE A", showOutAmt: amount, showOutCurrency: currency, showOutCountry: "TW" });

const cardRoutes = {
  [`${P}/web4/rb0708rwd/doXTPA`]: () => card({ "001": { "OUT-DTE-LST-STMT": "20261010", "OUT-CRLIMIT-PERM": "100,000", "OUT-STMT-BALANCE": "1000" } }),
  [`${P}/web4/rb0708rwd/init`]: (request: { body?: string }) => {
    const { bmonth } = JSON.parse(request.body!);
    if (bmonth === "10") return bill("2026/10", "2026/10/10", "2026/10/25", "1,000", [billDetail("1000")]);
    if (bmonth === "09") return bill("2026/09", "2026/09/10", "2026/09/25", "800");
    return card({ showAccoutnYM: "" });
  },
  [`${P}/web4/rb0760/getCardOverviewData`]: () => card({ carInfoList: { "001": { BillYear: "2026", BillMon: "10", StmtBalance: "1,000", LstPymtAmt: "400" } } }),
  [`${P}/web4/rb0708rwd/queryRealTime`]: () => card({ fmtRealTxListMap: [{ cardname: "測試信用卡 ****1234", txlist: [
    realtimeRow('<font color="red" >252</font>'), realtimeRow("900", "未成功"), realtimeRow("0"),
  ] }] }),
  [`${P}/web4/rb0708rwd/qryUnposted`]: () => card({ showRB0712_SUBTOTAL: "1,430", unpostedTx: { "001TWD": { data: [{ cardname: "測試信用卡 ****1234", txlist: [
    unbilledRow("2026/10/12", "DEMO SHOP", "1,442.50"), unbilledRow("2026/10/11", "退款", "-12.50"),
    ["2026/10/01", "2026/10/02", "STORE A", "1000", "", "TW", "", "TWD"],
  ] }] } } }, { date: "Thu, 15 Oct 2026 01:58:00 GMT" }),
} satisfies Record<string, FakeRoute>;

function routes(overrides: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
    ...cardRoutes,
    [`${P}/web/common/sessioncheck`]: () => jsonResponse({ RESULT: "NORMAL", DBSESSIONID: "session-1" }),
    [`${P}/web1/rb0100/query`]: () => twd('{"SavingAccount":[{"accountNo":"TS-7788","accountTypeName":"綜合存款","balance":"9,999.00"}]}'),
    [`${P}/web1/rb0102/listaccount`]: () => twd('[{"value":"TS7788"}]'),
    [`${P}/web1/rb0101/query`]: () => twd('{"balance":1234.50,"availbalance":"1,200.00"}', { date: "Thu, 15 Oct 2026 01:59:00 GMT" }),
    [`${P}/web1/rb0102/query`]: () => twdList([twdRow("123", '"1,000.00"', '"-"'), twdRow('"0000124"', '"-"', "250.5")], 1, 1),
    [`${P}/web2/rb0800/getRB08000100Data`]: () => fx('{"FCS_ACCOUNT":{"k1":{"ACCOUNT_NO":"TS-9900","ACCOUNT_NAME":"外幣綜存","FCS_ACCOUNT_DETAIL":[{"CURRENCY_CODE":"USD","BALANCE":"812.34"},{"CURRENCY_CODE":"","BALANCE":"0"}]}}}'),
    [`${P}/web2/rb0812/getRB08120100Options`]: () => fx('{"ACCOUNT_OPTION":[{"value":"TS9900"}],"EMAIL":null,"NEXT_NEXT_WORK_DAY":"20261019","RB0802_ORDER_TYPE":0}'),
    [`${P}/web2/rb0800/getRB08000100QueryRealtimeBalance`]: () => fx('[{"ACCT_NO":"TS-9900","CURRENCY_CODE":"美元","BALANCE":812.34}]'),
    [`${P}/web2/rb0802/getRB08020100ForeignTranDetail`]: () => fx(`{"TRANS_DETAILS":[${fxRow("2026/10/05 10:00:00", '"12.30"', '"-"')}]}`),
    ...overrides,
  };
}

function loginForm(dialog: string | null = null, image: Buffer = Buffer.from("jpeg")): TaishinLoginForm & { submitted: { credentials: TaishinCredentials; captcha: string }[] } {
  const submitted: { credentials: TaishinCredentials; captcha: string }[] = [];
  return {
    submitted,
    captcha: async () => ({ image, charset: "digits", expectedLength: 6 }),
    submit: async (filled, captcha) => { submitted.push({ credentials: filled, captcha }); return dialog; },
  };
}

function session(http: PreviewHttpOpener, form: TaishinLoginForm): TaishinSessionOpener {
  return (context, startUrl, use) => http(context, { pageUrl: startUrl }, (transport) => use({ http: transport, form }));
}

const solveCaptcha = async () => "123456";

async function run(overrides: Record<string, FakeRoute> = {}, form = loginForm(), products: readonly PreviewProduct[] = ["deposit"]) {
  const http = fakeHttpOpener(routes(overrides));
  const result = await runPreviewSource(createTaishinSource({ open: session(http, form), solveCaptcha }), credentials, undefined, products);
  return { ...result, http, form };
}

test("a Taishin run writes NT-dollar and foreign-currency accounts with exact amounts and in/out directions", async () => {
  const { receipt, writes, observations, http, form } = await run();
  assert.equal(writes.length, 1, `run failed: ${String(receipt)}`);
  assert.deepEqual(receipt, { accounts: 2, balances: 3, transactions: 3, statements: 0, closedAccounts: 0 });
  const [ntd, usd] = depositCollection(writes[0]!).accounts;
  assert.equal(ntd!.sourceAccountKey, "TS7788:TWD");
  assert.deepEqual(ntd!.balances, [
    { kind: "current", amount: "1234.50", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
    { kind: "available", amount: "1200.00", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
  ], "the JSON number lexeme 1234.50 survives, and the HTTP Date is the as-of time");
  assert.deepEqual(ntd!.transactions, [
    { sourceRowKey: "2026-10-03:0000123", amount: "1000.00", direction: "inflow", currency: "TWD", postedAt: { precision: "day", value: "2026-10-03" }, description: "轉帳 存入 · 薪資" },
    { sourceRowKey: "2026-10-03:0000124", amount: "250.5", direction: "outflow", currency: "TWD", postedAt: { precision: "day", value: "2026-10-03" }, description: "轉帳 存入 · 薪資" },
  ], "the direction comes from the column that is set, and procSeq keys the row");
  assert.equal(usd!.currency, "USD");
  assert.deepEqual(usd!.balances.map(({ amount, currency, observedAt }) => ({ amount, currency, source: observedAt.source })), [
    { amount: "812.34", currency: "USD", source: "collection-time" },
  ]);
  assert.deepEqual(usd!.transactions.map(({ amount, direction, currency }) => ({ amount, direction, currency })), [
    { amount: "12.30", direction: "inflow", currency: "USD" },
  ], "a foreign-currency row keeps the currency the source sent");

  const detail = JSON.parse(http.requests.find((request) => request.url.endsWith("ForeignTranDetail"))!.body!);
  assert.deepEqual(
    { acct: detail.requestAcctNo, ccy: detail.requestCurrency, start: detail.requestStartDate, end: detail.requestEndDate, type: detail.requestDateType },
    { acct: "TS9900", ccy: "USD", start: "20260801", end: "20261015", type: "I" },
  );
  assert.equal(http.requests.filter((request) => request.url.endsWith("QueryRealtimeBalance")).length, 1, "the blank-currency placeholder is not queried");
  assert.equal(http.requests.find((request) => request.url.endsWith("rb0100/query"))!.body, "", "a parameterless call sends an empty body");
  assert.ok(http.requests.every((request) => request.url.startsWith("https://my.taishinbank.com.tw/TIBNetBank/svc/")));
  assert.deepEqual(form.submitted, [{ credentials: { idNumber: "A000000001", userCode: "user01", password: "secret-pass" }, captcha: "123456" }]);
  assert.equal(observations.length, http.requests.length, "every response is observed");
  assert.ok(observations.some((entry) => entry.endpoint === "/web1/rb0102/query" && entry.status === 200));
});

async function runCalibrated(results: readonly { text: string; confidence: number }[], image = blankPng(120, 36)) {
  const http = fakeHttpOpener(routes());
  const form = loginForm(null, image);
  const engine = scriptedOcrEngine(results);
  const result = await runPreviewSource(createTaishinSource({ open: session(http, form), solveCaptcha: calibratedCaptchaSolver(TAISHIN_CAPTCHA_FAMILY, engine) }), credentials, undefined, ["deposit"]);
  return { ...result, http, form, engine };
}

test("the calibrated solver submits an accepted answer once and nothing when no candidate is accepted", async () => {
  const accepted = await runCalibrated([{ text: "135790", confidence: 0.81 }, { text: "135799", confidence: 0.62 }]);
  assert.equal(accepted.writes.length, 1);
  assert.deepEqual(accepted.form.submitted.map(({ captcha }) => captcha), ["135790"]);

  const unsure = await runCalibrated([{ text: "135790", confidence: 0.49 }, { text: "13579", confidence: 0.99 }]);
  assert.equal(unsure.errorCode, "verification-failed");
  assert.ok(unsure.events.some((event) => event.code === "verification-solver-exhausted"));
  assert.deepEqual(unsure.form.submitted, [], "Taishin has no refresh evidence, so one unaccepted challenge ends the round");
  assert.equal(unsure.http.requests.length, 0);
});

test("the production factory reads the CAPTCHA and refuses one outside the Taishin family without submitting", async () => {
  const http = fakeHttpOpener(routes());
  const form = loginForm(null, blankPng(120, 40));
  const result = await runPreviewSource(createTaishinSource({ open: session(http, form) }), credentials);
  assert.equal(result.errorCode, "verification-configuration-failed");
  assert.ok(result.events.some((event) => event.code === "solver-challenge-unsupported"));
  assert.deepEqual(form.submitted, []);
  assert.equal(http.requests.length, 0);
});

test("login dialogs are typed: rejected credentials, a wrong CAPTCHA, and a session already online", async () => {
  const cases = {
    "authentication-failed": "使用者代碼或密碼錯誤",
    "verification-failed": "圖形驗證碼錯誤，請重新輸入",
  } as const;
  for (const [code, dialog] of Object.entries(cases)) {
    const result = await run({}, loginForm(dialog));
    assert.equal(result.errorCode, code, dialog);
    assert.equal(result.http.requests.length, 0, `${dialog} sends no query`);
  }
  assert.equal((await run({}, loginForm("USER 正在線上，無法登入"))).errorCode, "authentication-failed");
  const expired = await run({ [`${P}/web/common/sessioncheck`]: () => jsonResponse({ RESULT: "EXPIRED" }) });
  assert.equal(expired.errorCode, "source-validation-failed", "an unconfirmed login does not collect");
  assert.match(String(expired.error), /login outcome is unknown/u);
  assert.equal(expired.writes.length, 0);
});

test("a truncated NT-dollar list is split and requeried, and a short single day fails closed", async () => {
  const split = await run({
    [`${P}/web1/rb0102/query`]: (request) => {
      const { start, end } = JSON.parse(request.body!);
      if (start !== end) return twdList([twdRow("1", '"5"', '"-"')], 2, 0);
      return twdList(start === "20261003" ? [twdRow("1", '"5"', '"-"')] : []);
    },
  });
  assert.equal(split.writes.length, 1);
  assert.equal(depositCollection(split.writes[0]!).accounts[0]!.transactions.length, 1);

  const short = await run({ [`${P}/web1/rb0102/query`]: () => twdList([twdRow("1", '"5"', '"-"')], 3, 0) });
  assert.equal(short.errorCode, "source-collection-failed");
  assert.equal(short.writes.length, 0);
  assert.ok(short.observations.length > 0, "observed responses stay for a structure report");
});

test("a foreign-currency row or balance without a currency is refused before write", async () => {
  const row = await run({
    [`${P}/web2/rb0802/getRB08020100ForeignTranDetail`]: () => fx(`{"TRANS_DETAILS":[${fxRow("2026/10/05 10:00:00", '"1"', '"-"', '""')}]}`),
  });
  assert.equal(row.errorCode, "source-validation-failed");
  assert.match(String(row.error), /missing-currency/u);
  assert.equal(row.writes.length, 0);
  const placeholder = await run({
    [`${P}/web2/rb0800/getRB08000100Data`]: () => fx('{"FCS_ACCOUNT":[{"ACCOUNT_NO":"TS-9900","FCS_ACCOUNT_DETAIL":[{"CURRENCY_CODE":" ","BALANCE":"3.00"}]}]}'),
  });
  assert.equal(placeholder.errorCode, "source-validation-failed");
  assert.match(String(placeholder.error), /missing-currency/u);
  assert.equal(placeholder.writes.length, 0);
});

test("a malformed amount and a row with both or neither column set are refused before write", async () => {
  const cases = {
    "malformed amount": [twdRow("1", '"1.2.3"', '"-"'), /malformed-amount/u],
    "both columns": [twdRow("1", '"5"', '"6"'), /exactly one of its in\/out columns/u],
    "neither column": [twdRow("1", '"-"', '"0.00"'), /exactly one of its in\/out columns/u],
  } as const;
  for (const [name, [row, reason]] of Object.entries(cases)) {
    const result = await run({ [`${P}/web1/rb0102/query`]: () => twdList([row]) });
    assert.equal(result.errorCode, "source-validation-failed", name);
    assert.match(String(result.error), reason, name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
  }
});

test("a procSeq that repeats with different content fails", async () => {
  const result = await run({ [`${P}/web1/rb0102/query`]: () => twdList([twdRow("7", '"5"', '"-"'), twdRow("7", '"6"', '"-"')], 2) });
  assert.equal(result.errorCode, "source-validation-failed");
  assert.match(String(result.error), /row key repeats/u);
  assert.equal(result.writes.length, 0);
});

test("an account online banking cannot query (EBF0015) keeps its overview balance and skips details", async () => {
  const { writes, http } = await run({
    [`${P}/web1/rb0101/query`]: () => jsonResponse({ RESULT: "ERROR", ERRORMSG: "(EBF0015)無交易權限" }),
  });
  const [ntd] = depositCollection(writes[0]!).accounts;
  assert.deepEqual(ntd!.balances.map(({ kind, amount }) => ({ kind, amount })), [{ kind: "current", amount: "9999.00" }]);
  assert.equal(ntd!.transactions.length, 0);
  assert.ok(!http.requests.some((request) => request.url.endsWith("rb0102/query")));
});

function creditCollection(writes: readonly PreviewWrite[]): PreviewCreditCollection | undefined {
  const write = writes.find((entry) => entry.product === "credit_card");
  return write?.product === "credit_card" ? write.collection : undefined;
}

const outcomes = (result: Awaited<ReturnType<typeof run>>) =>
  result.output?.products.map(({ typeId, status, errorCode }) => ({ typeId, status, ...errorCode ? { errorCode } : {} }));

const BOTH: readonly PreviewProduct[] = ["deposit", "credit_card"];
const CARD_ONLY: readonly PreviewProduct[] = ["credit_card"];

test("one Taishin sign-in writes deposits and the card account with statement-minus-paid-plus-unbilled used credit", async () => {
  const result = await run({}, loginForm(), BOTH);
  assert.equal(result.errorCode, null, String(result.error));
  assert.deepEqual(result.writes.map((write) => write.product), ["deposit", "credit_card"]);
  assert.deepEqual(outcomes(result), [{ typeId: "deposit", status: "success" }, { typeId: "credit_card", status: "success" }]);
  assert.equal(result.form.submitted.length, 1, "both products share one sign-in");
  const [account, ...others] = creditCollection(result.writes)!.accounts;
  assert.equal(others.length, 0);
  const { purchases, ...rest } = account!;
  assert.deepEqual(rest, {
    sourceAccountKey: "cards:TWD",
    displayLabel: "台新銀行 信用卡",
    currency: "TWD",
    creditLimit: "100000",
    cards: [{ sourceCardKey: "1234", cardMask: "****1234", displayLabel: "測試信用卡 ****1234" }],
    balances: [{
      amount: "2030",
      currency: "TWD",
      observedAt: { at: "2026-10-15T01:58:00.000Z", source: "reported" },
      basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "1000", paidAmount: "400", unbilledAmount: "1430" },
    }],
    statements: [{
      statementKey: "2026-10", cycleStart: "2026-09-11", cycleEnd: "2026-10-10", closingDate: "2026-10-10", dueDate: "2026-10-25",
      amount: "1000", currency: "TWD", minimumPayment: "100", billingPeriod: "2026-10", paidAmount: "400", paid: null, noPaymentNeeded: null,
    }],
  }, "1000 - 400 + 1430 from the source lexemes; 2026-09 has no earlier closing date read, so it is not a statement");
  assert.deepEqual(purchases.map(({ amount, direction, posting, consumedAt, sourceCardKey, statementKey, description }) =>
    ({ amount, direction, posting, consumedAt: consumedAt.value, sourceCardKey, statementKey, description })), [
    { amount: "252", direction: "outflow", posting: { status: "pending" }, consumedAt: "2026-10-14T09:15:30", sourceCardKey: "1234", statementKey: null, description: "DEMO SHOP TAIPEI" },
    { amount: "1442.50", direction: "outflow", posting: { status: "posted", billing: "unbilled", postingDate: "2026-10-13" }, consumedAt: "2026-10-12", sourceCardKey: "1234", statementKey: null, description: "DEMO SHOP" },
    { amount: "-12.50", direction: "inflow", posting: { status: "posted", billing: "unbilled", postingDate: "2026-10-13" }, consumedAt: "2026-10-11", sourceCardKey: "1234", statementKey: null, description: "退款" },
    { amount: "1000", direction: "outflow", posting: { status: "posted", billing: "billed", postingDate: "2026-10-02" }, consumedAt: "2026-10-01", sourceCardKey: "1234", statementKey: "2026-10", description: "STORE A" },
  ], "only 成功 authorizations count, the zero authorization is skipped, the unbilled copy of a billed row is dropped, and both signs give the direction");
  const endpoints = new Set(result.observations.map((entry) => entry.endpoint));
  for (const path of ["/web4/rb0708rwd/doXTPA", "/web4/rb0708rwd/init", "/web4/rb0760/getCardOverviewData", "/web4/rb0708rwd/queryRealTime", "/web4/rb0708rwd/qryUnposted"])
    assert.ok(endpoints.has(path), `${path} is observed`);
  assert.equal(result.observations.length, result.http.requests.length, "every response is observed");
  const months = result.http.requests.filter((request) => request.url.endsWith("/rb0708rwd/init")).map((request) => JSON.parse(request.body!));
  assert.deepEqual(months.map(({ org, byear, bmonth }) => `${org}:${byear}-${bmonth}`), ["001:2026-10", "001:2026-09", "001:2026-08", "001:2026-07"]);
});

test("a card row key stays the same across collections, and identical rows take an occurrence", async () => {
  const twice = { [`${P}/web4/rb0708rwd/queryRealTime`]: () => card({ fmtRealTxListMap: [{ cardname: "測試信用卡 ****1234", txlist: [realtimeRow("252"), realtimeRow("252")] }] }) };
  const first = creditCollection((await run(twice, loginForm(), CARD_ONLY)).writes)!;
  const second = creditCollection((await run(twice, loginForm(), CARD_ONLY)).writes)!;
  const keys = (collection: PreviewCreditCollection) => collection.accounts[0]!.purchases.map((purchase) => purchase.sourceRowKey);
  assert.deepEqual(keys(first), keys(second));
  const pending = keys(first).filter((key) => key.startsWith("pending:"));
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((key) => key.split(":").at(-1)), ["1", "2"]);
});

test("without both signs in the collection, card directions are unknown", async () => {
  const result = await run({
    [`${P}/web4/rb0708rwd/qryUnposted`]: () => card({ showRB0712_SUBTOTAL: "1,442.50", unpostedTx: { "001TWD": { data: [{ cardname: "測試信用卡 ****1234", txlist: [unbilledRow("2026/10/12", "DEMO SHOP", "1,442.50")] }] } } }),
  }, loginForm(), CARD_ONLY);
  const purchases = creditCollection(result.writes)!.accounts[0]!.purchases;
  assert.ok(purchases.length > 0);
  assert.ok(purchases.every((purchase) => purchase.direction === "unknown"));
});

test("an unbilled foreign-currency group is its own account without a used-credit balance", async () => {
  const result = await run({
    [`${P}/web4/rb0708rwd/qryUnposted`]: () => card({ showRB0712_SUBTOTAL: "1,430", unpostedTx: {
      "001TWD": { ErrMsg: "(CRXTIKE004)無消費資料" },
      USD: { data: [{ cardname: "測試卡 ****5678", txlist: [unbilledRow("2026/10/04", "退款", "-12.50", "USD")] }] },
    } }),
  }, loginForm(), CARD_ONLY);
  const [twd, usd] = creditCollection(result.writes)!.accounts;
  assert.equal(twd!.balances.length, 1);
  assert.deepEqual({ key: usd!.sourceAccountKey, currency: usd!.currency, balances: usd!.balances, statements: usd!.statements, cards: usd!.cards.map((entry) => entry.sourceCardKey) },
    { key: "cards:USD", currency: "USD", balances: [], statements: [], cards: ["5678"] });
  assert.deepEqual(usd!.purchases.map(({ amount, currency }) => ({ amount, currency })), [{ amount: "-12.50", currency: "USD" }]);
});

test("a no-consumption subtotal is a zero unbilled operand", async () => {
  const result = await run({
    [`${P}/web4/rb0708rwd/qryUnposted`]: () => card({ showRB0712_SUBTOTAL: "(CRXTIKE004)無消費資料", unpostedTx: {} }),
  }, loginForm(), CARD_ONLY);
  assert.equal(result.errorCode, null, String(result.error));
  assert.deepEqual(creditCollection(result.writes)!.accounts[0]!.balances.map(({ amount, basis }) => ({ amount, basis })), [{
    amount: "600",
    basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "1000", paidAmount: "400", unbilledAmount: "0" },
  }]);
});

test("each card defect fails the card product before write and keeps the deposit write", async () => {
  const cases: Record<string, [Record<string, FakeRoute>, string, RegExp]> = {
    "missing currency": [{ [`${P}/web4/rb0708rwd/init`]: (request) => JSON.parse(request.body!).bmonth === "10"
      ? bill("2026/10", "2026/10/10", "2026/10/25", "1000", [billDetail("1000", "")]) : card({ showAccoutnYM: "" }) },
    "source-validation-failed", /missing-currency/u],
    "malformed amount": [{ [`${P}/web4/rb0708rwd/queryRealTime`]: () => card({ fmtRealTxListMap: [{ cardname: "卡 ****1234", txlist: [realtimeRow("1.2.3")] }] }) },
      "source-validation-failed", /malformed-amount/u],
    "missing paid operand": [{ [`${P}/web4/rb0760/getCardOverviewData`]: () => card({ carInfoList: { "001": { BillYear: "2026", BillMon: "10", StmtBalance: "1000" } } }) },
      "source-validation-failed", /LstPymtAmt/u],
    "non-decimal subtotal": [{ [`${P}/web4/rb0708rwd/qryUnposted`]: () => card({ showRB0712_SUBTOTAL: "(CRXTIKE999)查詢失敗", unpostedTx: {} }) },
      "source-validation-failed", /SUBTOTAL/u],
    "overview for another bill": [{ [`${P}/web4/rb0760/getCardOverviewData`]: () => card({ carInfoList: { "001": { BillYear: "2026", BillMon: "09", StmtBalance: "1000", LstPymtAmt: "0" } } }) },
      "source-validation-failed", /not the current bill/u],
    "incomplete unbilled list": [{ [`${P}/web4/rb0708rwd/qryUnposted`]: () => card({ showRB0712_SUBTOTAL: "1,430", unpostedTx: { "001TWD": { ErrMsg: "無法取得資料" } } }) },
      "source-collection-failed", /could not be read/u],
    "realtime list missing": [{ [`${P}/web4/rb0708rwd/queryRealTime`]: () => card({}) }, "source-validation-failed", /fmtRealTxListMap is not a list/u],
  };
  for (const [name, [overrides, errorCode, reason]] of Object.entries(cases)) {
    const result = await run(overrides, loginForm(), BOTH);
    assert.equal(result.errorCode, null, `${name}: the deposit success keeps the run`);
    assert.deepEqual(outcomes(result), [{ typeId: "deposit", status: "success" }, { typeId: "credit_card", status: "failed", errorCode }], name);
    assert.deepEqual(result.writes.map((write) => write.product), ["deposit"], `${name} writes no card data`);
    const alone = await run(overrides, loginForm(), CARD_ONLY);
    assert.match(String(alone.error), reason, name);
  }
});

test("a deposit failure leaves the card write in place", async () => {
  const result = await run({ [`${P}/web1/rb0102/query`]: () => twdList([twdRow("1", '"5"', '"-"')], 3, 0) }, loginForm(), BOTH);
  assert.equal(result.errorCode, null);
  assert.deepEqual(outcomes(result), [{ typeId: "deposit", status: "failed", errorCode: "source-collection-failed" }, { typeId: "credit_card", status: "success" }]);
  assert.deepEqual(result.writes.map((write) => write.product), ["credit_card"]);
});

test("not_held only on an explicit no-card message; no consumption is an empty list", async () => {
  const noCard = await run({ [`${P}/web4/rb0708rwd/doXTPA`]: () => jsonResponse({ error: { message: "您目前沒有本行信用卡。" }, value: null }) }, loginForm(), BOTH);
  assert.deepEqual(outcomes(noCard), [{ typeId: "deposit", status: "success" }, { typeId: "credit_card", status: "not_held" }]);
  assert.deepEqual(noCard.writes.map((write) => write.product), ["deposit"]);

  const hint = await run({ [`${P}/web4/rb0708rwd/doXTPA`]: () => jsonResponse({ error: "未持有信用卡者請先申辦", value: null }) }, loginForm(), BOTH);
  assert.deepEqual(outcomes(hint), [{ typeId: "deposit", status: "success" }, { typeId: "credit_card", status: "failed", errorCode: "source-validation-failed" }],
    "an application hint is not a no-card answer");

  const quiet = await run({
    [`${P}/web4/rb0708rwd/queryRealTime`]: () => jsonResponse({ error: "(CRXTIKE004)無消費資料" }),
  }, loginForm(), CARD_ONLY);
  const account = creditCollection(quiet.writes)!.accounts[0]!;
  assert.equal(account.purchases.filter((purchase) => purchase.posting.status === "pending").length, 0);
  assert.equal(account.balances.length, 1, "no consumption is a complete empty realtime list, not no card");
});

test("a statement whose due date is a status text is not written, and a session lost before the card product ends the run", async () => {
  const status = await run({ [`${P}/web4/rb0708rwd/init`]: (request) => JSON.parse(request.body!).bmonth === "10"
    ? bill("2026/10", "2026/10/10", "已繳清", "1000", [billDetail("1000")])
    : JSON.parse(request.body!).bmonth === "09" ? bill("2026/09", "2026/09/10", "2026/09/25", "800") : card({ showAccoutnYM: "" }) }, loginForm(), CARD_ONLY);
  assert.deepEqual(creditCollection(status.writes)!.accounts[0]!.statements, []);

  const lost = await run({
    [`${P}/web/common/sessioncheck`]: (_request, call) => jsonResponse(call < 2 ? { RESULT: "NORMAL", DBSESSIONID: "session-1" } : { RESULT: "EXPIRED" }),
  }, loginForm(), BOTH);
  assert.equal(lost.errorCode, "authentication-failed");
  assert.deepEqual(lost.writes.map((write) => write.product), ["deposit"], "the deposit written before the session loss stays");
});
