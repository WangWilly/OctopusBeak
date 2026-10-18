import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import test from "node:test";
import type { PreviewHttpRequest } from "./browser-http.ts";
import { createObankSource, obankDate } from "./obank-source.ts";
import { fakeHttpOpener, jsonResponse, runPreviewSource, type FakeRoute } from "./preview-source-harness.ts";

const credentials = {
  PREVIEW_OBANK_DEPOSIT_ID_NUMBER: "A000000001",
  PREVIEW_OBANK_DEPOSIT_USER_CODE: "user01",
  PREVIEW_OBANK_DEPOSIT_PASSWORD: "secret-pass",
};

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
const TIME_FACTOR = "2026-10-15 10:00:00";
const CAPTCHA_PNG = Buffer.from("89504e470d0a1a0a", "hex");

const envelope = (rsData: unknown, token = "") =>
  ({ isSuccessful: true, statusCode: "0000", statusDesc: "", token, validateError: { messages: {}, showOnGlobal: false }, rsData });

const LIST = `{"isSuccessful":true,"statusCode":"0000","token":"t-list","rsData":{"userAccounts":[
  {"accountNo":"XX-8901","accountItems":[
    {"accountItemNo":"ITEM-TWD","curr":"TWD","aliasName":"活存","displayActBalNoCurr":"12,000.50","displayWorkBalNoCurr":"12,345.50"},
    {"accountItemNo":"ITEM-USD","curr":"USD","aliasName":"外幣活存","displayActBalNoCurr":"100.25","displayWorkBalNoCurr":"100.25"}]}],
  "despositTxnDetails":[]}}`;

const row = (date: string, amount: string, desc: string, balance = "1,000") =>
  `{"txnDate":"${date}","txnDesc":"${desc}","displayMemo":"備註","diplayAcct":"","displayTxnAmount":"${amount}","displayClsBal":"${balance}"}`;

function history(rows: string, extra = "") {
  return `{"isSuccessful":true,"statusCode":"0000","rsData":{"startDate":"2026/08/01","endDate":"2026/10/15"${extra},"despositTxnDetails":[${rows}]}}`;
}

type Resource = Readonly<{ resource: string; rqData: Record<string, unknown> }>;
type ResourceRoutes = Readonly<Record<string, (request: Resource) => ReturnType<FakeRoute>>>;

function resourceOf(request: PreviewHttpRequest): Resource {
  const [resource, metadata] = JSON.parse(request.body!) as [string, { rqData: Record<string, unknown> }];
  return { resource, rqData: metadata.rqData };
}

function byResource(routes: ResourceRoutes): FakeRoute {
  return (request) => {
    const parsed = resourceOf(request);
    const route = routes[parsed.resource];
    if (!route) throw new Error(`Unrouted O-Bank resource: ${parsed.resource}`);
    return route(parsed);
  };
}

const NO_SEC: ResourceRoutes = {
  "common/CMN01003/010": () => jsonResponse(envelope({ params: { e2e: PUBLIC_PEM } }, "t-0")),
  "fco/FCO02001/012": () => jsonResponse(envelope({ badgeCount: 0, message: false })),
  "common/CMN01004/010": () => jsonResponse(envelope({})),
  "common/CMN01001/010": () => jsonResponse(envelope({ img: `data:image/png;base64,${CAPTCHA_PNG.toString("base64")}` })),
  "common/EndToEnd/020": () => jsonResponse(envelope({ timeFactor: TIME_FACTOR })),
};

const SECURE: ResourceRoutes = {
  "fao/FAO01012/010": ({ rqData }) => {
    if (rqData.initQuery === "Y") return jsonResponse(LIST, { date: "Thu, 15 Oct 2026 01:59:00 GMT" });
    return jsonResponse(rqData.curry === "TWD"
      ? history(`${row("2026/10/03", "-250.00", "轉帳")},${row("2026/10/03", "-250.00", "轉帳")},${row("115/9/1", "1,000", "薪資", "1,250")}`)
      : history(row("2026/09/20", "10.25", "利息", "100.25")));
  },
};

function routes(overrides: Record<string, FakeRoute> = {}, secure: ResourceRoutes = {}, noSec: ResourceRoutes = {}): Record<string, FakeRoute> {
  return {
    "GET /ebank/ixtein/v2/adapters/ebank/ChannelAdapter/getChannel": () => jsonResponse({ channel: "" }),
    "POST /ebank/ixtein/oauth/token": () => jsonResponse({ access_token: "access-1", expires_in: 3600, scope: "PUBLIC", token_type: "bearer" }),
    "POST /ebank/ixtein/v2/adapters/ebank/AuthenticationAdapter/sendAndReceiveNoSec": byResource({ ...NO_SEC, ...noSec }),
    "POST /ebank/ixtein/v2/adapters/ebank/AuthenticationAdapter/emptyLogin": () => jsonResponse({ auth: "x", authStatus: "required" }),
    "POST /ebank/ixtein/v2/adapters/ebank/AuthenticationAdapter/submitCredentials": () => jsonResponse({ authStatus: "complete", token: "t-login" }),
    "POST /ebank/ixtein/v2/adapters/ebank/AuthenticationAdapter/sendAndReceive": byResource({ ...SECURE, ...secure }),
    "GET /ebank/ixtein/v2/adapters/ebank/BankingServicesAdapter/invalidateSession": () => jsonResponse({}),
    ...overrides,
  };
}

const solveCaptcha = async () => "AB12";

async function run(overrides: Record<string, FakeRoute> = {}, secure: ResourceRoutes = {}) {
  const http = fakeHttpOpener(routes(overrides, secure));
  const result = await runPreviewSource(createObankSource({ http, solveCaptcha }), credentials);
  return { ...result, http };
}

const loginBody = (requests: readonly PreviewHttpRequest[]) =>
  (JSON.parse(requests.find((request) => request.url.endsWith("/submitCredentials"))!.body!) as [{ rqData: Record<string, string> }])[0].rqData;

test("an O-Bank run writes each demand account item with its balances and three months of exact transactions", async () => {
  const { receipt, writes, observations, http } = await run();
  assert.deepEqual(receipt, { accounts: 2, balances: 4, transactions: 4 });
  const [twd, usd] = writes[0]!.collection.accounts;
  const asOf = { at: "2026-10-15T01:59:00.000Z", source: "reported" };
  assert.equal(twd!.sourceAccountKey, "ITEM-TWD:TWD");
  assert.equal(twd!.displayLabel, "王道銀行 活存 8901");
  assert.deepEqual(twd!.balances, [
    { kind: "current", amount: "12345.50", currency: "TWD", observedAt: asOf },
    { kind: "available", amount: "12000.50", currency: "TWD", observedAt: asOf },
  ], "帳上餘額 is the current balance, 可用餘額 the available one, as of the HTTP Date");
  assert.deepEqual(twd!.transactions.map(({ amount, currency, direction, postedAt, description }) => ({ amount, currency, direction, postedAt, description })), [
    { amount: "-250.00", currency: "TWD", direction: "unknown", postedAt: { precision: "day", value: "2026-10-03" }, description: "轉帳 · 備註" },
    { amount: "-250.00", currency: "TWD", direction: "unknown", postedAt: { precision: "day", value: "2026-10-03" }, description: "轉帳 · 備註" },
    { amount: "1000", currency: "TWD", direction: "unknown", postedAt: { precision: "day", value: "2026-09-01" }, description: "薪資 · 備註" },
  ], "O-Bank sends no direction field, and an ROC date is read as Gregorian");
  const keys = twd!.transactions.map((row) => row.sourceRowKey);
  assert.equal(new Set(keys).size, 3, "identical rows on one day keep distinct keys");
  assert.match(keys[1]!, /:2$/u);
  assert.deepEqual(usd!.balances.map(({ amount, currency }) => ({ amount, currency })), [{ amount: "100.25", currency: "USD" }, { amount: "100.25", currency: "USD" }]);
  assert.deepEqual(usd!.transactions.map(({ amount, currency }) => ({ amount, currency })), [{ amount: "10.25", currency: "USD" }]);

  const queries = http.requests.filter((request) => request.url.endsWith("/sendAndReceive")).map((request) => resourceOf(request).rqData);
  assert.deepEqual(queries.slice(1), [
    { queryType: "customDisplay", startDate: "2026/08/01", endDate: "2026/10/15", subAccountItemNo: "ITEM-TWD", curry: "TWD", initQuery: "N" },
    { queryType: "customDisplay", startDate: "2026/08/01", endDate: "2026/10/15", subAccountItemNo: "ITEM-USD", curry: "USD", initQuery: "N" },
  ], "one history query per account item over the three-month Taipei window");
  assert.deepEqual(observations.map((entry) => `${entry.status} ${entry.endpoint}`), [
    "200 ChannelAdapter/getChannel",
    "200 oauth/token",
    "200 common/CMN01003/010",
    "200 AuthenticationAdapter/emptyLogin",
    "200 fco/FCO02001/012",
    "200 common/CMN01004/010",
    "200 common/CMN01001/010",
    "200 common/EndToEnd/020",
    "200 common/EndToEnd/020",
    "200 AuthenticationAdapter/submitCredentials",
    "200 fao/FAO01012/010",
    "200 fao/FAO01012/010",
    "200 fao/FAO01012/010",
    "200 BankingServicesAdapter/invalidateSession",
  ], "observe() saw every response, the account list and both histories included");
  assert.ok(http.requests.at(-1)!.url.endsWith("/invalidateSession"), "the session is signed out after collection");
});

test("the user code and password leave only RSA-sealed with the server time factor, and the CAPTCHA answer is sent", async () => {
  const { http } = await run();
  const login = loginBody(http.requests);
  assert.equal(login.no, "A000000001");
  assert.equal(login.captcha, "AB12");
  assert.equal(login.force, "0");
  const open = (sealed: string) => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(sealed, "base64")).toString("utf8");
  assert.equal(open(login.uno!), `user01${TIME_FACTOR}`);
  assert.equal(open(login.sec!), `secret-pass${TIME_FACTOR}`);
  assert.ok(!JSON.stringify(http.requests).includes("secret-pass"));
  const adapterCall = http.requests.find((request) => request.url.endsWith("/submitCredentials"))!;
  assert.equal(adapterCall.headers!.Authorization, "Bearer access-1");
  assert.match(adapterCall.headers!.checksum!, /^[0-9a-f]{32}$/u);
});

test("without a calibrated CAPTCHA solver the run fails as verification-configuration-failed before any request", async () => {
  const http = fakeHttpOpener(routes());
  const result = await runPreviewSource(createObankSource({ http }), credentials);
  assert.equal(result.errorCode, "verification-configuration-failed");
  assert.equal(http.requests.length, 0);
  assert.ok(result.events.some((event) => event.code === "solver-challenge-unsupported"));
});

test("another signed-in session ends the run as session-conflict without forcing a takeover", async () => {
  const result = await run({
    "POST /ebank/ixtein/v2/adapters/ebank/AuthenticationAdapter/submitCredentials": () => jsonResponse({ authStatus: "required", rsData: { resultType: "3" } }),
  });
  assert.equal(result.errorCode, "authentication-failed");
  assert.match(String(result.error), /session-conflict/u);
  const logins = result.http.requests.filter((request) => request.url.endsWith("/submitCredentials"));
  assert.equal(logins.length, 1, "no second login with force 1");
  assert.equal(result.writes.length, 0);
});

test("a rejected sign-in and a rejected CAPTCHA are typed", async () => {
  const login = (body: unknown) => ({ "POST /ebank/ixtein/v2/adapters/ebank/AuthenticationAdapter/submitCredentials": () => jsonResponse(body) });
  assert.equal((await run(login({ authStatus: "required", rsData: { resultType: "2" } }))).errorCode, "authentication-failed");
  assert.equal((await run(login({ authStatus: "required", statusDesc: "驗證碼錯誤", rsData: {} }))).errorCode, "verification-failed");
});

test("a missing currency, a malformed amount, and a cut-short history each fail before write", async () => {
  const cases = {
    "missing currency": [{}, { "fao/FAO01012/010": () => jsonResponse(LIST.replace('"curr":"USD",', "")) }, "source-validation-failed"],
    "malformed amount": [{}, {
      "fao/FAO01012/010": ({ rqData }: Resource) => jsonResponse(rqData.initQuery === "Y" ? LIST : history(row("2026/10/03", "1.2.3", "x"))),
    }, "source-validation-failed"],
    "incomplete page": [{}, {
      "fao/FAO01012/010": ({ rqData }: Resource) => jsonResponse(rqData.initQuery === "Y" ? LIST : history(row("2026/10/03", "1", "x")).replace('"startDate":"2026/08/01"', '"startDate":"2026/09/15"')),
    }, "source-collection-failed"],
  } as const;
  for (const [name, [overrides, secure, code]] of Object.entries(cases)) {
    const result = await run(overrides, secure as ResourceRoutes);
    assert.equal(result.errorCode, code, name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.ok(result.observations.length > 0, `${name} keeps observed responses for a structure report`);
  }
});

test("a history answer in another currency or without its row list fails", async () => {
  const listOr = (body: string) => ({ "fao/FAO01012/010": ({ rqData }: Resource) => jsonResponse(rqData.initQuery === "Y" ? LIST : body) });
  assert.equal((await run({}, listOr(history(row("2026/10/03", "1", "x"), ',"curry":"JPY"')))).errorCode, "source-validation-failed");
  assert.equal((await run({}, listOr('{"isSuccessful":true,"statusCode":"0000","rsData":{}}'))).errorCode, "source-validation-failed");
});

test("O-Bank dates accept Gregorian and ROC years with unpadded parts", () => {
  assert.deepEqual(obankDate("2026/10/03", "d"), { precision: "day", value: "2026-10-03" });
  assert.deepEqual(obankDate("115/1/2", "d"), { precision: "day", value: "2026-01-02" });
});
