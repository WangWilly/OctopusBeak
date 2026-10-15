import assert from "node:assert/strict";
import test from "node:test";
import { fakeHttpOpener, jsonResponse, runPreviewSource, type FakeRoute } from "./preview-source-harness.ts";
import { createTaishinSource, type TaishinCredentials, type TaishinLoginForm } from "./taishin-source.ts";

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

function routes(overrides: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
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

function loginForm(dialog: string | null = null): TaishinLoginForm & { submitted: { credentials: TaishinCredentials; captcha: string }[] } {
  const submitted: { credentials: TaishinCredentials; captcha: string }[] = [];
  return {
    submitted,
    captcha: async () => ({ image: Buffer.from("jpeg"), charset: "digits", expectedLength: 6 }),
    submit: async (filled, captcha) => { submitted.push({ credentials: filled, captcha }); return dialog; },
  };
}

const solveCaptcha = async () => "123456";

async function run(overrides: Record<string, FakeRoute> = {}, form = loginForm()) {
  const http = fakeHttpOpener(routes(overrides));
  const result = await runPreviewSource(createTaishinSource({ http, solveCaptcha, loginForm: form }), credentials);
  return { ...result, http, form };
}

test("a Taishin run writes NT-dollar and foreign-currency accounts with exact amounts and in/out directions", async () => {
  const { receipt, writes, observations, http, form } = await run();
  assert.equal(writes.length, 1, `run failed: ${String(receipt)}`);
  assert.deepEqual(receipt, { accounts: 2, balances: 3, transactions: 3 });
  const [ntd, usd] = writes[0]!.collection.accounts;
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

test("without a calibrated CAPTCHA solver the run fails as verification-configuration-failed before any request", async () => {
  const http = fakeHttpOpener(routes());
  const result = await runPreviewSource(createTaishinSource({ http, loginForm: loginForm() }), credentials);
  assert.equal(result.errorCode, "verification-configuration-failed");
  assert.equal(http.requests.length, 0);
  assert.ok(result.events.some((event) => event.code === "solver-challenge-unsupported"));
  const production = await runPreviewSource(createTaishinSource({ http }), credentials);
  assert.equal(production.errorCode, "verification-configuration-failed");
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
  assert.equal(split.writes[0]!.collection.accounts[0]!.transactions.length, 1);

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
  const [ntd] = writes[0]!.collection.accounts;
  assert.deepEqual(ntd!.balances.map(({ kind, amount }) => ({ kind, amount })), [{ kind: "current", amount: "9999.00" }]);
  assert.equal(ntd!.transactions.length, 0);
  assert.ok(!http.requests.some((request) => request.url.endsWith("rb0102/query")));
});
