import assert from "node:assert/strict";
import test from "node:test";
import { createNextBankSource, encryptNextBankPassword } from "./nextbank-source.ts";
import { fakeHttpOpener, jsonResponse, runPreviewSource, type FakeRoute } from "./preview-source-harness.ts";

const credentials = {
  PREVIEW_NEXTBANK_DEPOSIT_ID_NUMBER: "A000000001",
  PREVIEW_NEXTBANK_DEPOSIT_USER_ID: "user01",
  PREVIEW_NEXTBANK_DEPOSIT_PASSWORD: "secret-pass",
};

const ok = (data: unknown, headers: Record<string, string> = {}) => jsonResponse({ success: true, data }, headers);

const trade = (id: string, amount: string, extra = "") =>
  `{"tradeID":"${id}","tradeAmount":${amount},"tradeChannel":"ATM"${extra},"detail":{"txnDateTime":"2026-10-03 09:15:00","deductionDate":"2026-10-03","descript":"轉帳"}}`;

function routes(overrides: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
    "POST /ap2/open/common/v1.0/Captcha": () => ok({ uuid: "captcha-1", captchaImage: Buffer.from("png").toString("base64") }),
    "POST /ap2/api/v1.1/membership/CaptchaLogin": () => ok({ acstkn: "token-1" }),
    "POST /ap2/api/v2.1/membership/AllInOne": () => jsonResponse(
      '{"success":true,"data":{"mainAccount":{"accountId":"NB-7788","workingBalance":1234.50,"availableBalance":1200.00}}}',
      { date: "Thu, 15 Oct 2026 01:59:00 GMT" },
    ),
    "POST /ap1/api/v3.0/AppMainPage/CurrentDepositDetail": (_request, call) => jsonResponse(
      call === 0 ? `{"success":true,"data":{"trades":[${trade("T1", "-250.00")},${trade("T2", "1000")}]}}` : '{"success":true,"data":{"trades":[]}}',
    ),
    "POST /ap1/api/v3.0/AppMainPage/PocketInfo": () => jsonResponse(
      '{"success":true,"data":{"pocketDetails":[{"depositType":"DEPOSIT","accNo":"P001","name":"旅遊","amount":300.10},{"depositType":"TERMDEPOSIT","arrngId":"TD9","name":"定存","amount":50000}]}}',
    ),
    "POST /ap1/api/v1.0/demandDeposit/GetPocketTxDetail": (_request, call) => jsonResponse(call === 0
      ? `{"success":true,"data":{"trades":[${trade("P1", "100.10")}],"pageInfo":{"hasNext":true,"pageToken":"pt-2","lastTradeID":"P1"}}}`
      : `{"success":true,"data":{"trades":[${trade("P2", "200")}],"pageInfo":{"hasNext":false}}}`),
    "POST /ap2/api/v1.0/membership/Logout": () => ok(null),
    ...overrides,
  };
}

const solveCaptcha = async () => "AB12";

async function run(overrides: Record<string, FakeRoute> = {}) {
  const http = fakeHttpOpener(routes(overrides));
  const result = await runPreviewSource(createNextBankSource({ http, solveCaptcha }), credentials);
  return { ...result, http };
}

test("a NextBank run writes the main account, pockets, and paged pocket transactions with exact amounts", async () => {
  const { receipt, writes, observations, http } = await run();
  assert.deepEqual(receipt, { accounts: 3, balances: 4, transactions: 4 });
  const [main, pocket, term] = writes[0]!.collection.accounts;
  assert.deepEqual(main!.balances, [
    { kind: "current", amount: "1234.50", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
    { kind: "available", amount: "1200.00", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
  ], "the JSON number lexeme survives, and the HTTP Date is the as-of time");
  assert.deepEqual(main!.transactions.map(({ sourceRowKey, amount, direction, postedAt }) => ({ sourceRowKey, amount, direction, postedAt })), [
    { sourceRowKey: "2026-10-03:T1", amount: "-250.00", direction: "unknown", postedAt: { precision: "day", value: "2026-10-03" } },
    { sourceRowKey: "2026-10-03:T2", amount: "1000", direction: "unknown", postedAt: { precision: "day", value: "2026-10-03" } },
  ], "NextBank sends no direction field, so the signed amount is kept and the direction stays unknown");
  assert.deepEqual(pocket!.transactions.map((row) => row.amount), ["100.10", "200"]);
  assert.deepEqual(pocket!.balances[0]!.observedAt, { at: "2026-10-15T02:00:00.000Z", source: "collection-time" });
  assert.equal(term!.balances[0]!.amount, "50000");
  assert.equal(term!.transactions.length, 0);

  const pocketPages = http.requests.filter((request) => request.url.endsWith("GetPocketTxDetail")).map((request) => JSON.parse(request.body!).paging);
  assert.deepEqual(pocketPages, [
    { pageToken: "", startTradeID: "", pageSize: 10 },
    { pageToken: "pt-2", startTradeID: "P1", pageSize: 10 },
  ]);
  assert.equal(http.requests.filter((request) => request.url.endsWith("CurrentDepositDetail")).length, 3, "one query per month in the 3-month window");
  assert.ok(observations.some((entry) => entry.endpoint === "/ap2/api/v2.1/membership/AllInOne" && entry.status === 200));
  assert.ok(observations.some((entry) => entry.endpoint === "/ap1/api/v1.0/demandDeposit/GetPocketTxDetail"));
  assert.ok(http.requests.at(-1)!.url.endsWith("/Logout"), "the session is signed out after collection");
});

test("the password leaves only RSA-encrypted and the user code only base64-encoded", async () => {
  const { http } = await run();
  const login = JSON.parse(http.requests.find((request) => request.url.endsWith("CaptchaLogin"))!.body!);
  assert.equal(login.identity, "A000000001");
  assert.equal(login.userId, Buffer.from("user01").toString("base64"));
  assert.equal(login.captchaResult, "AB12");
  assert.equal(login.captchaUuid, "captcha-1");
  assert.match(login.passwd, /^[0-9A-F]{512}$/u);
  assert.ok(!JSON.stringify(http.requests).includes("secret-pass"));
  assert.notEqual(encryptNextBankPassword("x"), encryptNextBankPassword("x"), "PKCS#1 v1.5 padding is randomized");
});

test("without a calibrated CAPTCHA solver the run fails as verification-configuration-failed before any request", async () => {
  const http = fakeHttpOpener(routes());
  const result = await runPreviewSource(createNextBankSource({ http }), credentials);
  assert.equal(result.errorCode, "verification-configuration-failed");
  assert.equal(http.requests.length, 0);
  assert.ok(result.events.some((event) => event.code === "solver-challenge-unsupported"));
});

test("a rejected sign-in and a rejected CAPTCHA are typed", async () => {
  const fail = (errorCode: string) => () => jsonResponse({ success: false, error: { errorCode } });
  assert.equal((await run({ "POST /ap2/api/v1.1/membership/CaptchaLogin": fail("LOGIN_ERROR") })).errorCode, "authentication-failed");
  assert.equal((await run({ "POST /ap2/api/v1.1/membership/CaptchaLogin": fail("CAPTCHA_ERROR") })).errorCode, "verification-failed");
});

test("pocket paging fails closed on a missing hasNext, a repeated cursor, or more pages after an empty page", async () => {
  const page = (body: string): FakeRoute => () => jsonResponse(body);
  const cases = {
    "missing hasNext": page(`{"success":true,"data":{"trades":[${trade("P1", "1")}],"pageInfo":{}}}`),
    "repeated cursor": page(`{"success":true,"data":{"trades":[${trade("P1", "1")}],"pageInfo":{"hasNext":true,"pageToken":"same","lastTradeID":"P1"}}}`),
    "empty page with more": page('{"success":true,"data":{"trades":[],"pageInfo":{"hasNext":true,"pageToken":"x","lastTradeID":"y"}}}'),
  };
  for (const [name, route] of Object.entries(cases)) {
    const result = await run({ "POST /ap1/api/v1.0/demandDeposit/GetPocketTxDetail": route });
    assert.equal(result.errorCode, "source-collection-failed", name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.ok(result.observations.length > 0, `${name} keeps observed responses for a structure report`);
  }
});

test("a main-account page that reports more pages fails instead of truncating", async () => {
  const result = await run({
    "POST /ap1/api/v3.0/AppMainPage/CurrentDepositDetail": () => jsonResponse(`{"success":true,"data":{"trades":[${trade("T1", "1")}],"pageInfo":{"hasNext":true}}}`),
  });
  assert.equal(result.errorCode, "source-collection-failed");
  assert.equal(result.writes.length, 0);
});

test("a non-ISO currency and a malformed amount are refused before write", async () => {
  const currency = await run({
    "POST /ap1/api/v3.0/AppMainPage/CurrentDepositDetail": () => jsonResponse(`{"success":true,"data":{"trades":[${trade("T1", "1", ',"currency":""')}]}}`),
  });
  assert.equal(currency.errorCode, "source-validation-failed");
  assert.equal(currency.writes.length, 0);
  const amount = await run({
    "POST /ap2/api/v2.1/membership/AllInOne": () => ok({ mainAccount: { accountId: "1", workingBalance: "1.2.3", availableBalance: "1" } }),
  });
  assert.equal(amount.errorCode, "source-validation-failed");
  assert.equal(amount.writes.length, 0);
});

test("a USD currency reported by the source is kept instead of the TWD endpoint default", async () => {
  const { writes } = await run({
    "POST /ap1/api/v3.0/AppMainPage/PocketInfo": () => jsonResponse('{"success":true,"data":{"pocketDetails":[{"depositType":"TERMDEPOSIT","arrngId":"TD9","amount":10.5,"currency":"usd"}]}}'),
  });
  assert.deepEqual(writes[0]!.collection.accounts[1]!.balances.map(({ amount, currency }) => ({ amount, currency })), [{ amount: "10.5", currency: "USD" }]);
});
