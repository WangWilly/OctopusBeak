import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewHttpOpener } from "./browser-http.ts";
import { fakeHttpOpener, jsonResponse, runPreviewSource, type FakeRoute } from "./preview-source-harness.ts";
import { createKgibankSource, type KgibankLoginForm, type KgibankLoginSignal, type KgibankSessionOpener } from "./kgibank-source.ts";

const credentials = {
  PREVIEW_KGIBANK_DEPOSIT_ID_NUMBER: "A000000001",
  PREVIEW_KGIBANK_DEPOSIT_USER_CODE: "user01",
  PREVIEW_KGIBANK_DEPOSIT_PASSWORD: "secret-pass",
};

const AUTH = { authorization: "Bearer token-1", "ocp-apim-subscription-key": "sub-key", "x-c-channel": "IB", "x-c-sid": "sid-1" };
const API = "/gateway/prod-aggregators/api/Deposit/TwdDemandDepositDetail";
const LOGOUT = "POST /gateway/prod-oidc/Account/AccountLogout/Logout";

const token = (status: number, body: unknown): KgibankLoginSignal => ({ kind: "token", status, text: JSON.stringify(body) });
const accepted = token(200, { access_token: "x", isSSOExsit: false });
const ssoExists = token(200, { isSSOExsit: true });

const txn = (time: string, amount: string, balance: string, extra = "") =>
  `{"txnDateTime":"${time}","effectDateTime":"2026-10-03T00:00:00+08:00","txnAmt":${amount},"acctBal":${balance},"txnTypeName":"跨行轉入","desc":"薪資"${extra}}`;
const list = (items: readonly string[], extra = "") => jsonResponse(`{"items":[${items.join(",")}]${extra}}`);

function routes(overrides: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
    [`GET ${API}/AcctQuery`]: () => jsonResponse(
      '{"items":[{"acctNo":"KG-7788","acctTypeName":"活期儲蓄存款","acctNickName":"","acctBal":1234.50,"availBal":"1,200.00"}]}',
      { date: "Thu, 15 Oct 2026 01:59:00 GMT" },
    ),
    [`GET ${API}/TxnQuery`]: () => list([
      txn("2026-10-03T09:15:20.43+08:00", "-250.5", "1234.50"),
      txn("2026-10-03T09:15:20.91+08:00", "-250.5", "1234.50"),
      txn("2026-09-28T23:59:59Z", '"1,000"', '"1485.00"'),
    ]),
    [LOGOUT]: () => jsonResponse(""),
    ...overrides,
  };
}

type FakeForm = KgibankLoginForm & { calls: string[] };

function loginForm(signals: readonly (KgibankLoginSignal | null)[] = [accepted]): FakeForm {
  const calls: string[] = [];
  let next = 0;
  const signal = () => signals[next++] ?? null;
  return {
    calls,
    captcha: async () => { calls.push("captcha"); return { image: Buffer.from("png"), charset: "digits", expectedLength: 6 }; },
    submit: async (filled, captcha) => { calls.push(`submit:${filled.idNumber}:${filled.userCode}:${captcha}`); return signal() ?? { kind: "timeout" }; },
    confirmTakeover: async () => { calls.push("takeover"); return signal(); },
    authHeaders: async () => { calls.push("headers"); return AUTH; },
  };
}

function session(http: PreviewHttpOpener, form: KgibankLoginForm, opened: string[] = []): KgibankSessionOpener {
  return (context, startUrl, use) => {
    opened.push(startUrl);
    return http(context, { pageUrl: startUrl }, (transport) => use({ http: transport, form }));
  };
}

const solveCaptcha = async () => "123456";

async function run(overrides: Record<string, FakeRoute> = {}, form = loginForm()) {
  const http = fakeHttpOpener(routes(overrides));
  const result = await runPreviewSource(createKgibankSource({ open: session(http, form), solveCaptcha }), credentials);
  const paths = http.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
  return { ...result, http, form, paths };
}

test("a KGI run writes the NT-dollar demand account with exact amounts, seconds-precision row keys, and an unknown direction", async () => {
  const { receipt, writes, observations, http, form, paths } = await run();
  assert.deepEqual(receipt, { accounts: 1, balances: 2, transactions: 3 });
  const [account] = writes[0]!.collection.accounts;
  assert.equal(account!.sourceAccountKey, "7788:TWD");
  assert.equal(account!.displayLabel, "凱基銀行 活期儲蓄存款 7788");
  assert.deepEqual(account!.balances, [
    { kind: "current", amount: "1234.50", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
    { kind: "available", amount: "1200.00", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
  ], "the JSON number lexeme 1234.50 survives, TWD comes from the endpoint, and the HTTP Date is the as-of time");
  assert.deepEqual(account!.transactions, [
    { sourceRowKey: "7788:2026-10-03T09:15:20:-250.5:1234.50:1", amount: "-250.5", currency: "TWD", direction: "unknown", postedAt: { precision: "day", value: "2026-10-03" }, description: "跨行轉入 · 薪資" },
    { sourceRowKey: "7788:2026-10-03T09:15:20:-250.5:1234.50:2", amount: "-250.5", currency: "TWD", direction: "unknown", postedAt: { precision: "day", value: "2026-10-03" }, description: "跨行轉入 · 薪資" },
    { sourceRowKey: "7788:2026-09-29T07:59:59:1000:1485.00:1", amount: "1000", currency: "TWD", direction: "unknown", postedAt: { precision: "day", value: "2026-10-03" }, description: "跨行轉入 · 薪資" },
  ], "fractional seconds are dropped, a UTC time is read in Taipei, and identical rows are told apart by occurrence");

  assert.deepEqual(form.calls, ["captcha", "submit:A000000001:user01:123456", "headers"]);
  assert.deepEqual(paths, [`GET ${API}/AcctQuery`, `GET ${API}/TxnQuery`, LOGOUT], "the run signs out last");
  const query = new URL(http.requests[1]!.url).searchParams;
  assert.deepEqual(Object.fromEntries(query), {
    acctNo: "7788", startDate: "2026-08-01T00:00:00.000+08:00", endDate: "2026-10-15T23:59:59.999+08:00", refresh: "true",
  });
  for (const request of http.requests) {
    assert.ok(request.url.startsWith("https://ib.kgibank.com.tw/gateway/"));
    assert.equal(request.headers?.authorization, "Bearer token-1", "the page's own authorization header is replayed");
    assert.equal(request.headers?.["ocp-apim-subscription-key"], "sub-key");
    assert.equal(request.headers?.["x-c-sid"], "sid-1");
  }
  assert.deepEqual(observations.map(({ endpoint, status }) => `${status} ${endpoint}`), [
    "200 /gateway/prod-oidc/connect/token",
    `200 ${API}/AcctQuery`,
    `200 ${API}/TxnQuery`,
    "200 /gateway/prod-oidc/Account/AccountLogout/Logout",
  ], "every response is observed");
});

test("production refuses the KGI CAPTCHA before opening a page or sending a request", async () => {
  const http = fakeHttpOpener(routes());
  const form = loginForm();
  const opened: string[] = [];
  const result = await runPreviewSource(createKgibankSource({ open: session(http, form, opened) }), credentials);
  assert.equal(result.errorCode, "verification-configuration-failed");
  assert.match(String(result.error), /kgibank-image-captcha/u);
  assert.ok(result.events.some((event) => event.code === "solver-challenge-unsupported"));
  assert.deepEqual(opened, [], "no page is opened");
  assert.deepEqual(form.calls, []);
  assert.equal(http.requests.length, 0);
  assert.equal(result.writes.length, 0);
});

test("when connect/token reports another session, the run confirms 繼續登入 once, collects, and still signs out", async () => {
  const form = loginForm([ssoExists, accepted]);
  const { writes, paths, observations } = await run({}, form);
  assert.equal(writes.length, 1);
  assert.deepEqual(form.calls, ["captcha", "submit:A000000001:user01:123456", "takeover", "headers"]);
  assert.equal(paths.at(-1), LOGOUT);
  assert.equal(observations.filter((entry) => entry.endpoint === "/gateway/prod-oidc/connect/token").length, 2);

  const failing = await run({ [`GET ${API}/TxnQuery`]: () => list([], ',"hasMore":true') }, loginForm([ssoExists, accepted]));
  assert.equal(failing.errorCode, "source-collection-failed");
  assert.equal(failing.paths.at(-1), LOGOUT, "a failed run after takeover still signs out");

  const repeated = await run({}, loginForm([ssoExists, ssoExists]));
  assert.equal(repeated.errorCode, "authentication-failed");
  assert.match(String(repeated.error), /session-conflict/u);
  assert.equal(repeated.form.calls.filter((call) => call === "takeover").length, 1, "takeover is confirmed at most once");

  const noButton = await run({}, loginForm([ssoExists, null]));
  assert.equal(noButton.errorCode, "source-validation-failed");
  assert.equal(noButton.writes.length, 0);
});

test("a rejected sign-in ends the run at once and is never resubmitted", async () => {
  const cases: Record<string, readonly [KgibankLoginSignal, string]> = {
    "token 400": [token(400, { error: "invalid_grant" }), "authentication-failed"],
    "password message": [{ kind: "message", text: "密碼錯誤，連續錯誤三次將停用", tokenRequested: true }, "authentication-failed"],
    "lock message": [{ kind: "message", text: "您的帳號已鎖定", tokenRequested: false }, "authentication-failed"],
    "captcha before credentials": [{ kind: "message", text: "驗證碼有誤", tokenRequested: false }, "verification-failed"],
    "captcha after token request": [{ kind: "message", text: "驗證碼有誤", tokenRequested: true }, "source-validation-failed"],
    "token 503": [token(503, {}), "source-validation-failed"],
    timeout: [{ kind: "timeout" }, "source-validation-failed"],
  };
  for (const [name, [signal, code]] of Object.entries(cases)) {
    const result = await run({}, loginForm([signal, accepted]));
    assert.equal(result.errorCode, code, name);
    assert.equal(result.form.calls.filter((call) => call.startsWith("submit")).length, 1, `${name} submits once`);
    assert.equal(result.form.calls.filter((call) => call === "captcha").length, 1, `${name} reads one CAPTCHA`);
    assert.ok(!result.paths.some((path) => path.includes("TwdDemandDepositDetail")), `${name} collects nothing`);
    assert.equal(result.writes.length, 0);
  }
});

test("a missing currency, a malformed amount, and an incomplete page fail before write", async () => {
  const cases: Record<string, readonly [Record<string, FakeRoute>, string, RegExp]> = {
    "blank account currency": [{ [`GET ${API}/AcctQuery`]: () => list(['{"acctNo":"7788","acctBal":"1","currency":""}']) }, "source-validation-failed", /missing-currency/u],
    "malformed txnAmt": [{ [`GET ${API}/TxnQuery`]: () => list([txn("2026-10-03T09:15:20+08:00", '"1.2.3"', '"1"')]) }, "source-validation-failed", /malformed-amount/u],
    "malformed acctBal": [{ [`GET ${API}/AcctQuery`]: () => list(['{"acctNo":"7788","acctBal":"N/A"}']) }, "source-validation-failed", /malformed-amount/u],
    "hasMore page": [{ [`GET ${API}/TxnQuery`]: () => list([txn("2026-10-03T09:15:20+08:00", '"1"', '"1"')], ',"hasMore":true') }, "source-collection-failed", /incomplete-data/u],
    "short totalCount": [{ [`GET ${API}/TxnQuery`]: () => list([txn("2026-10-03T09:15:20+08:00", '"1"', '"1"')], ',"totalCount":2') }, "source-collection-failed", /incomplete-data/u],
    "next cursor": [{ [`GET ${API}/AcctQuery`]: () => list(['{"acctNo":"7788","acctBal":"1"}'], ',"nextKey":"p2"') }, "source-collection-failed", /incomplete-data/u],
    "minute-only time": [{ [`GET ${API}/TxnQuery`]: () => list([txn("2026-10-03T09:15+08:00", '"1"', '"1"')]) }, "source-validation-failed", /no seconds/u],
  };
  for (const [name, [overrides, code, reason]] of Object.entries(cases)) {
    const result = await run(overrides);
    assert.equal(result.errorCode, code, name);
    assert.match(String(result.error), reason, name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.ok(result.observations.some((entry) => entry.endpoint.endsWith("Query")), `${name} keeps observed responses for a structure report`);
    assert.equal(result.paths.at(-1), LOGOUT, `${name} still signs out`);
  }
});

test("a currency the source sends wins over the endpoint's TWD", async () => {
  const { writes } = await run({
    [`GET ${API}/AcctQuery`]: () => list(['{"acctNo":"7788","acctBal":"5","currency":"NTD"}']),
    [`GET ${API}/TxnQuery`]: () => list([txn("2026-10-03T09:15:20+08:00", '"1"', '"5"', ',"currency":"USD"')]),
  });
  const [account] = writes[0]!.collection.accounts;
  assert.equal(account!.currency, "TWD");
  assert.equal(account!.transactions[0]!.currency, "USD");
});

test("a failed sign-out does not change the run's outcome", async () => {
  const success = await run({ [LOGOUT]: () => ({ status: 500, headers: {}, text: "" }) });
  assert.deepEqual(success.receipt, { accounts: 1, balances: 2, transactions: 3 });
  const failure = await run({
    [LOGOUT]: () => { throw new Error("network down"); },
    [`GET ${API}/TxnQuery`]: () => list([], ',"hasMore":true'),
  });
  assert.equal(failure.errorCode, "source-collection-failed", "the collection failure is reported, not the sign-out error");
});
