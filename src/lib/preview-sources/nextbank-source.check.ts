import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewTimeDepositCollection, PreviewWrite } from "../../ledger/pglite/preview-financial-data.ts";
import { createNextBankSource, encryptNextBankPassword } from "./nextbank-source.ts";
import { fakeHttpOpener, jsonResponse, runPreviewSource, depositCollection, type FakeRoute } from "./preview-source-harness.ts";
import { withPreviewStore } from "./preview-store-harness.ts";

const credentials = {
  PREVIEW_NEXTBANK_DEPOSIT_ID_NUMBER: "A000000001",
  PREVIEW_NEXTBANK_DEPOSIT_USER_ID: "user01",
  PREVIEW_NEXTBANK_DEPOSIT_PASSWORD: "secret-pass",
};

const ok = (data: unknown, headers: Record<string, string> = {}) => jsonResponse({ success: true, data }, headers);

const trade = (id: string, amount: string, extra = "") =>
  `{"tradeID":"${id}","tradeAmount":${amount},"tradeChannel":"ATM"${extra},"detail":{"txnDateTime":"2026-10-03 09:15:00","deductionDate":"2026-10-03","descript":"轉帳"}}`;

const DEMAND = '{"depositType":"DEPOSIT","accNo":"P001","name":"旅遊","amount":300.10}';
const TD9 = '{"depositType":"TERMDEPOSIT","arrngId":"TD9","name":"定存","amount":50000}';
const TD8 = '{"depositType":"TERMDEPOSIT","arrngId":"TD8","amount":20000.50}';
const POCKETS = [DEMAND, TD9, TD8];

const pocketInfo = (pockets: readonly string[], termTotal: string | null) =>
  `{"success":true,"data":{"pocketDetails":[${pockets.join(",")}],"depositTotalAmount":300.10${termTotal === null ? "" : `,"termDepositTotalAmount":${termTotal}`}}}`;

const withPockets = (pockets: readonly string[], termTotal: string | null): Record<string, FakeRoute> =>
  ({ "POST /ap1/api/v3.0/AppMainPage/PocketInfo": () => jsonResponse(pocketInfo(pockets, termTotal)) });

function routes(overrides: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
    "POST /ap2/open/common/v1.0/Captcha": () => ok({ uuid: "captcha-1", captchaAudio: Array.from({ length: 5 }, () => Buffer.from("clip").toString("base64")) }),
    "POST /ap2/api/v1.1/membership/CaptchaLogin": () => ok({ acstkn: "token-1" }),
    "POST /ap2/api/v2.1/membership/AllInOne": () => jsonResponse(
      '{"success":true,"data":{"mainAccount":{"accountId":"NB-7788","workingBalance":1234.50,"availableBalance":1200.00}}}',
      { date: "Thu, 15 Oct 2026 01:59:00 GMT" },
    ),
    "POST /ap1/api/v3.0/AppMainPage/CurrentDepositDetail": (_request, call) => jsonResponse(
      call === 0 ? `{"success":true,"data":{"trades":[${trade("T1", "-250.00")},${trade("T2", "1000")}]}}` : '{"success":true,"data":{"trades":[]}}',
    ),
    "POST /ap1/api/v3.0/AppMainPage/PocketInfo": () => jsonResponse(pocketInfo(POCKETS, "70000.50")),
    "POST /ap1/api/v2.3/termdeposit/GetTermDepositDetail": (request) => jsonResponse(JSON.parse(request.body!).arrngId === "TD9"
      ? '{"success":true,"data":{"startDate":"2026-04-15","endDate":1807718400000}}'
      : '{"success":true,"data":{"startDate":"2026-09-01"}}'),
    "POST /ap1/api/v1.0/demandDeposit/GetPocketTxDetail": (_request, call) => jsonResponse(call === 0
      ? `{"success":true,"data":{"trades":[${trade("P1", "100.10")}],"pageInfo":{"hasNext":true,"pageToken":"pt-2","lastTradeID":"P1"}}}`
      : `{"success":true,"data":{"trades":[${trade("P2", "200")}],"pageInfo":{"hasNext":false}}}`),
    "POST /ap2/api/v1.0/membership/Logout": () => ok(null),
    ...overrides,
  };
}

const solveCaptcha = async () => "12345";

async function run(overrides: Record<string, FakeRoute> = {}, products?: readonly PreviewWrite["product"][]) {
  const http = fakeHttpOpener(routes(overrides));
  const result = await runPreviewSource(createNextBankSource({ http, solveCaptcha }), credentials, undefined, products);
  return { ...result, http };
}

const depositOnly = (overrides: Record<string, FakeRoute>) => run(overrides, ["deposit"]);
const outcomes = (result: Awaited<ReturnType<typeof run>>) => result.output?.products.map((product) => [product.typeId, product.status]);
const timeDeposits = (writes: readonly PreviewWrite[]): PreviewTimeDepositCollection[] =>
  writes.flatMap((write) => write.product === "time_deposit" ? [write.collection] : []);
const COLLECTED = { at: "2026-10-15T02:00:00.000Z", source: "collection-time" } as const;

test("a NextBank run writes the main account and demand pockets as deposits and the term pockets as time deposits", async () => {
  const { receipt, writes, observations, http, output } = await run();
  assert.deepEqual(output?.products.map((product) => [product.typeId, product.status, product.itemCount]), [["deposit", "success", 2], ["time_deposit", "success", 2]]);
  assert.deepEqual(receipt, { accounts: 4, balances: 5, transactions: 4, statements: 0, closedAccounts: 0 });
  assert.deepEqual(writes.map((write) => write.product), ["deposit", "time_deposit"]);
  const deposits = depositCollection(writes[0]!).accounts;
  assert.deepEqual(deposits.map((account) => account.sourceAccountKey), ["main:NB-7788", "pocket:P001"], "term pockets leave the deposit product");
  const [main, pocket] = deposits;
  assert.deepEqual(main!.balances, [
    { kind: "current", amount: "1234.50", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
    { kind: "available", amount: "1200.00", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
  ], "the JSON number lexeme survives, and the HTTP Date is the as-of time");
  assert.deepEqual(main!.transactions.map(({ sourceRowKey, amount, direction, postedAt }) => ({ sourceRowKey, amount, direction, postedAt })), [
    { sourceRowKey: "2026-10-03:T1", amount: "-250.00", direction: "unknown", postedAt: { precision: "day", value: "2026-10-03" } },
    { sourceRowKey: "2026-10-03:T2", amount: "1000", direction: "unknown", postedAt: { precision: "day", value: "2026-10-03" } },
  ], "NextBank sends no direction field, so the signed amount is kept and the direction stays unknown");
  assert.deepEqual(pocket!.transactions.map((row) => row.amount), ["100.10", "200"]);
  assert.deepEqual(pocket!.balances[0]!.observedAt, COLLECTED);

  const [term] = timeDeposits(writes);
  assert.equal(term!.completeness, "complete");
  assert.deepEqual(term!.deposits, [
    {
      sourceAccountKey: "term:TD9",
      displayLabel: "將來銀行 定存",
      currency: "TWD",
      balances: [{ kind: "current", amount: "50000", currency: "TWD", observedAt: COLLECTED }],
      principal: "50000",
      interestRate: null,
      maturityDate: "2027-04-15",
    },
    {
      sourceAccountKey: "term:TD8",
      displayLabel: "將來銀行 定存口袋",
      currency: "TWD",
      balances: [{ kind: "current", amount: "20000.50", currency: "TWD", observedAt: COLLECTED }],
      principal: "20000.50",
      interestRate: null,
      maturityDate: null,
    },
  ], "the pocket amount is the principal and the balance, endDate is the Taipei maturity date, and no rate is documented");

  const pocketPages = http.requests.filter((request) => request.url.endsWith("GetPocketTxDetail")).map((request) => JSON.parse(request.body!).paging);
  assert.deepEqual(pocketPages, [
    { pageToken: "", startTradeID: "", pageSize: 10 },
    { pageToken: "pt-2", startTradeID: "P1", pageSize: 10 },
  ]);
  assert.equal(http.requests.filter((request) => request.url.endsWith("CurrentDepositDetail")).length, 3, "one query per month in the 3-month window");
  assert.deepEqual(http.requests.filter((request) => request.url.endsWith("GetTermDepositDetail")).map((request) => JSON.parse(request.body!)),
    [{ arrngId: "TD9" }, { arrngId: "TD8" }]);
  const seen = (endpoint: string) => observations.filter((entry) => entry.endpoint === endpoint && entry.status === 200).length;
  assert.equal(seen("/ap2/api/v2.1/membership/AllInOne"), 1);
  assert.equal(seen("/ap1/api/v3.0/AppMainPage/CurrentDepositDetail"), 3);
  assert.equal(seen("/ap1/api/v1.0/demandDeposit/GetPocketTxDetail"), 2);
  assert.equal(seen("/ap1/api/v3.0/AppMainPage/PocketInfo"), 1, "both products share one PocketInfo response");
  assert.equal(seen("/ap1/api/v2.3/termdeposit/GetTermDepositDetail"), 2);
  assert.ok(http.requests.at(-1)!.url.endsWith("/Logout"), "the session is signed out after collection");
});

test("the password leaves only RSA-encrypted and the user code only base64-encoded", async () => {
  const { http } = await run();
  const login = JSON.parse(http.requests.find((request) => request.url.endsWith("CaptchaLogin"))!.body!);
  assert.equal(login.identity, "A000000001");
  assert.equal(login.userId, Buffer.from("user01").toString("base64"));
  assert.equal(login.captchaResult, "12345");
  assert.equal(login.captchaUuid, "captcha-1");
  assert.match(login.passwd, /^[0-9A-F]{512}$/u);
  assert.ok(!JSON.stringify(http.requests).includes("secret-pass"));
  assert.notEqual(encryptNextBankPassword("x"), encryptNextBankPassword("x"), "PKCS#1 v1.5 padding is randomized");
});

test("the production solver requests the CAPTCHA as audio and fails closed when the clip is missing", async () => {
  const { http } = await run();
  const captcha = JSON.parse(http.requests.find((request) => request.url.endsWith("/Captcha"))!.body!);
  assert.equal(captcha.isAudio, true, "the source requests the spoken CAPTCHA");
  const missing = await run({ "POST /ap2/open/common/v1.0/Captcha": () => ok({ uuid: "captcha-1" }) });
  assert.equal(missing.errorCode, "source-validation-failed");
  assert.ok(missing.observations.length > 0, "the response is kept for a structure report");
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
    const result = await depositOnly({ "POST /ap1/api/v1.0/demandDeposit/GetPocketTxDetail": route });
    assert.equal(result.errorCode, "source-collection-failed", name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.ok(result.observations.length > 0, `${name} keeps observed responses for a structure report`);
  }
});

test("a main-account page that reports more pages fails instead of truncating", async () => {
  const result = await depositOnly({
    "POST /ap1/api/v3.0/AppMainPage/CurrentDepositDetail": () => jsonResponse(`{"success":true,"data":{"trades":[${trade("T1", "1")}],"pageInfo":{"hasNext":true}}}`),
  });
  assert.equal(result.errorCode, "source-collection-failed");
  assert.equal(result.writes.length, 0);
});

test("a non-ISO currency and a malformed amount are refused before write", async () => {
  const currency = await depositOnly({
    "POST /ap1/api/v3.0/AppMainPage/CurrentDepositDetail": () => jsonResponse(`{"success":true,"data":{"trades":[${trade("T1", "1", ',"currency":""')}]}}`),
  });
  assert.equal(currency.errorCode, "source-validation-failed");
  assert.equal(currency.writes.length, 0);
  const amount = await depositOnly({
    "POST /ap2/api/v2.1/membership/AllInOne": () => ok({ mainAccount: { accountId: "1", workingBalance: "1.2.3", availableBalance: "1" } }),
  });
  assert.equal(amount.errorCode, "source-validation-failed");
  assert.equal(amount.writes.length, 0);
});

test("a USD currency reported by the source is kept instead of the TWD endpoint default", async () => {
  const { writes } = await run(withPockets(['{"depositType":"TERMDEPOSIT","arrngId":"TD9","amount":10.5,"currency":"usd"}'], "10.5"));
  assert.deepEqual(timeDeposits(writes)[0]!.deposits[0]!.balances.map(({ amount, currency }) => ({ amount, currency })), [{ amount: "10.5", currency: "USD" }]);
});

test("a term pocket list that fails validation or reconciliation fails only time_deposit, before its write", async () => {
  const cases = {
    "missing currency": [withPockets([DEMAND, '{"depositType":"TERMDEPOSIT","arrngId":"TD9","amount":50000,"currency":""}'], "50000"), "source-validation-failed"],
    "malformed amount": [withPockets([DEMAND, '{"depositType":"TERMDEPOSIT","arrngId":"TD9","amount":"5,00.0"}'], "50000"), "source-validation-failed"],
    "missing balance": [withPockets([DEMAND, '{"depositType":"TERMDEPOSIT","arrngId":"TD9"}'], "50000"), "source-validation-failed"],
    "failed detail": [{ "POST /ap1/api/v2.3/termdeposit/GetTermDepositDetail": () => jsonResponse({ success: false, error: { errorCode: "SYSTEM_ERROR" } }) }, "source-validation-failed"],
    "missing total": [withPockets(POCKETS, null), "source-collection-failed"],
    "total mismatch": [withPockets(POCKETS, "70000.49"), "source-collection-failed"],
    "mixed currencies": [withPockets([TD9, '{"depositType":"TERMDEPOSIT","arrngId":"TD7","amount":1,"currency":"USD"}'], "50001"), "source-collection-failed"],
  } as const;
  for (const [name, [overrides, code]] of Object.entries(cases)) {
    const result = await run(overrides);
    assert.deepEqual(result.output?.products.map((product) => [product.typeId, product.status, product.errorCode ?? null]),
      [["deposit", "success", null], ["time_deposit", "failed", code]], name);
    assert.deepEqual(result.writes.map((write) => write.product), ["deposit"], `${name} writes no time deposit and keeps the deposit write`);
  }
});

test("time deposits are not_held only for a reconciled empty list", async () => {
  const empty = await run(withPockets([DEMAND], "0"));
  assert.deepEqual(outcomes(empty), [["deposit", "success"], ["time_deposit", "not_held"]]);
  assert.deepEqual(timeDeposits(empty.writes), [{ collectedAt: "2026-10-15T02:00:00.000Z", completeness: "complete", deposits: [] }],
    "the empty complete list is written, so it closes earlier deposits");
  const unreconciled = await run(withPockets([DEMAND], null));
  assert.deepEqual(outcomes(unreconciled), [["deposit", "success"], ["time_deposit", "failed"]], "a list without its total is no evidence of holding nothing");
});

test("a deposit failure leaves the time_deposit outcome intact", async () => {
  const result = await run({ "POST /ap2/api/v2.1/membership/AllInOne": () => ok({ mainAccount: { accountId: "1", workingBalance: "1.2.3", availableBalance: "1" } }) });
  assert.deepEqual(outcomes(result), [["deposit", "failed"], ["time_deposit", "success"]]);
  assert.deepEqual(result.writes.map((write) => write.product), ["time_deposit"]);
});

const TIME_DEPOSITS = { visible: [{ sourceId: "nextbank-deposit", product: "time_deposit" as const }] };

test("a term pocket absent from the next complete list is closed, and an incomplete list closes nothing", async () => {
  await withPreviewStore(async (port) => {
    const closedAt = async () => Object.fromEntries((await port.accounts(TIME_DEPOSITS)).map((account) => [account.displayLabel, account.timeDeposit?.closedAt ?? null]));
    const collect = async (overrides: Record<string, FakeRoute>) => {
      const result = await run(overrides, ["time_deposit"]);
      for (const write of result.writes) await port.write(write);
      return result;
    };
    await collect({});
    assert.deepEqual(await closedAt(), { "將來銀行 定存": null, "將來銀行 定存口袋": null });
    const incomplete = await collect(withPockets([DEMAND, TD9], "70000.50"));
    assert.equal(incomplete.writes.length, 0);
    assert.deepEqual(await closedAt(), { "將來銀行 定存": null, "將來銀行 定存口袋": null }, "an unreconciled list closes nothing");
    await collect(withPockets([DEMAND, TD9], "50000"));
    assert.deepEqual(await closedAt(), { "將來銀行 定存": null, "將來銀行 定存口袋": "2026-10-15T02:00:00.000Z" }, "TD8 left the complete list");
  });
});

test("a term pocket that v1 wrote as a deposit becomes a time deposit and keeps its balance history", async () => {
  await withPreviewStore(async (port) => {
    await port.write({
      sourceId: "nextbank-deposit",
      institution: "bank-823",
      product: "deposit",
      collection: {
        collectedAt: "2026-10-01T02:00:00.000Z",
        accounts: [{
          sourceAccountKey: "term:TD9", displayLabel: "將來銀行 定存", currency: "TWD", type: "depository", transactions: [],
          balances: [{ kind: "current", amount: "49000", currency: "TWD", observedAt: { at: "2026-10-01T02:00:00.000Z", source: "collection-time" } }],
        }],
      },
    });
    const DEPOSITS = { visible: [{ sourceId: "nextbank-deposit", product: "deposit" as const }] };
    const [v1] = await port.accounts(DEPOSITS);
    for (const write of (await run({}, ["time_deposit"])).writes) await port.write(write);
    assert.deepEqual(await port.accounts(DEPOSITS), [], "no deposit row is left for the term pocket");
    const moved = (await port.accounts(TIME_DEPOSITS)).find((account) => account.displayLabel === "將來銀行 定存")!;
    assert.equal(moved.previewAccountId, v1!.previewAccountId, "the same row, so its earlier balance observations stay attached");
    assert.deepEqual(moved.timeDeposit, { principal: "50000", interestRate: null, maturityDate: "2027-04-15", closedAt: null });
    assert.deepEqual(moved.latestBalance?.amount, "50000");
  });
});
