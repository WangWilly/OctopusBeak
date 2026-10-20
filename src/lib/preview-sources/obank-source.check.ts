import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import test from "node:test";
import type { PreviewHttpRequest } from "./browser-http.ts";
import { createObankSource, obankDate } from "./obank-source.ts";
import type { PreviewTimeDepositCollection, PreviewWrite } from "../../ledger/pglite/preview-financial-data.ts";
import { blankPng, fakeHttpOpener, jsonResponse, runPreviewSource, depositCollection, scriptedOcrEngine, type FakeRoute } from "./preview-source-harness.ts";
import { calibratedCaptchaSolver, OBANK_CAPTCHA_FAMILY } from "./preview-captcha.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";
import { withPreviewStore } from "./preview-store-harness.ts";

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

const TD_TWD = { tdAccountNumber: "TD-0001-2345", currency: "TWD" };
const TD_USD = { tdAccountNumber: "TD-0009-8765", currency: "USD" };
const TD_DETAILS: Readonly<Record<string, Record<string, unknown>>> = {
  "TD-0001-2345": {
    ...TD_TWD, displayProductType: "一般定存", displayWorkingBalance: "100,000", displayRate: "1.725%",
    isTierIntrstFlg: false, contractDate: "2026/01/15", maturityDate: "2027/01/15",
  },
  "TD-0009-8765": {
    ...TD_USD, displayProductType: "外幣定存", displayWorkingBalance: "5,000.00", displayRate: "4.1%",
    isTierIntrstFlg: true, contractDate: "115/4/1", maturityDate: "116/4/1",
  },
};

function timeDepositRoute(repeats: readonly unknown[] | undefined, details = TD_DETAILS) {
  return ({ rqData }: Resource) => {
    if (rqData.page === "td") return jsonResponse(envelope(repeats === undefined ? { useCcyList: [] } : { repeats, useCcyList: [] }));
    const detail = details[String(rqData.tdAccountNumber)];
    if (!detail) throw new Error(`no fixture detail for ${String(rqData.tdAccountNumber)}`);
    return jsonResponse(envelope({ repeats, tdDetail: detail }), { date: "Thu, 15 Oct 2026 01:59:30 GMT" });
  };
}

const SECURE: ResourceRoutes = {
  "fao/FAO01022/020": timeDepositRoute([TD_TWD, TD_USD]),
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

async function run(overrides: Record<string, FakeRoute> = {}, secure: ResourceRoutes = {}, products: readonly PreviewWrite["product"][] = ["deposit"]) {
  const http = fakeHttpOpener(routes(overrides, secure));
  const result = await runPreviewSource(createObankSource({ http, solveCaptcha }), credentials, undefined, products);
  return { ...result, http };
}

const BOTH = ["deposit", "time_deposit"] as const;
const outcomes = (result: Awaited<ReturnType<typeof run>>) =>
  result.output?.products.map((product) => [product.typeId, product.status, product.errorCode ?? null]);
const timeDeposits = (writes: readonly PreviewWrite[]): PreviewTimeDepositCollection[] =>
  writes.flatMap((write) => write.product === "time_deposit" ? [write.collection] : []);

const loginBody = (requests: readonly PreviewHttpRequest[]) =>
  (JSON.parse(requests.find((request) => request.url.endsWith("/submitCredentials"))!.body!) as [{ rqData: Record<string, string> }])[0].rqData;

test("an O-Bank run writes each demand account item with its balances and three months of exact transactions", async () => {
  const { receipt, writes, observations, http } = await run();
  assert.deepEqual(receipt, { accounts: 2, balances: 4, transactions: 4, statements: 0, closedAccounts: 0 });
  const [twd, usd] = depositCollection(writes[0]!).accounts;
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

test("an unsupported O-Bank capture fails before credential sealing or sign-in", async () => {
  const http = fakeHttpOpener(routes());
  const result = await runPreviewSource(createObankSource({ http }), credentials);
  assert.equal(result.errorCode, "verification-configuration-failed");
  assert.ok(http.requests.length > 0);
  assert.ok(http.requests.every((request) => !/submitCredentials|sendAndReceive$/u.test(request.url)));
  assert.ok(!http.requests.some((request) => request.body?.includes("common/EndToEnd/020")));
  assert.ok(result.events.some((event) => event.code === "solver-challenge-unsupported"));
});

test("O-Bank calibrated disagreement stops before credentials, while agreement signs in once", async () => {
  for (const [second, accepted] of [["AB12", true], ["AB13", false], ["", false]] as const) {
    const http = fakeHttpOpener(routes({}, {}, {
      "common/CMN01001/010": () => jsonResponse(envelope({ img: `data:image/png;base64,${blankPng(152, 60).toString("base64")}` })),
    }));
    const engine = scriptedOcrEngine([{ text: "AB12", confidence: 1 }, { text: second, confidence: 1 }]);
    const result = await runPreviewSource(createObankSource({ http, solveCaptcha: calibratedCaptchaSolver(OBANK_CAPTCHA_FAMILY, engine) }), credentials);
    assert.equal(http.requests.filter((request) => request.url.endsWith("/submitCredentials")).length, accepted ? 1 : 0);
    if (!accepted) {
      assert.equal(result.errorCode, "verification-failed");
      assert.ok(!http.requests.some((request) => request.body?.includes("common/EndToEnd/020")));
      assert.equal(result.writes.length, 0);
    }
  }
});

test("O-Bank's default Node transport decodes a JPEG challenge to PNG before solving", async (t) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 152, height: 60 } });
    const jpeg = await page.screenshot({ type: "jpeg" });
    const transport = routes({}, {}, {
      "common/CMN01001/010": () => jsonResponse(envelope({ img: `data:image/jpeg;base64,${jpeg.toString("base64")}` })),
    });
    const requests: PreviewHttpRequest[] = [];
    t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const request = { method: init!.method as "GET" | "POST", url, body: init!.body as string, headers: Object.fromEntries(new Headers(init!.headers)) };
      requests.push(request);
      const reply = await transport[`${request.method} ${new URL(url).pathname}`]!(request, 0);
      return new Response(reply.text, { status: reply.status, headers: reply.headers });
    });
    let captured = false;
    const source = createObankSource({ solveCaptcha: async (_context, challenge) => {
      assert.ok("image" in challenge);
      assert.equal(challenge.image.readUInt32BE(16), 152);
      assert.equal(challenge.image.readUInt32BE(20), 60);
      assert.equal(challenge.image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      captured = true;
      return null;
    } });
    const context = { signal: new AbortController().signal, now: () => "2026-10-20T00:00:00Z", event: async () => {},
      browser: { withPage: async (use: (value: typeof page) => unknown) => use(page) }, preview: { observe: () => {} } } as unknown as PreviewWorkflowContext;
    await assert.rejects(source.run(context, { startUrl: source.startUrl, credentials: {}, products: source.products }));
    assert.ok(captured);
    assert.ok(!requests.some((request) => request.url.endsWith("/submitCredentials")));
    assert.equal(page.url(), "about:blank", "image decoding never opens the bank app");
  } finally {
    await browser.close();
  }
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

test("an O-Bank run writes the complete time-deposit list with each deposit's balance, rate, and maturity", async () => {
  const result = await run({}, {}, BOTH);
  assert.deepEqual(outcomes(result), [["deposit", "success", null], ["time_deposit", "success", null]]);
  assert.deepEqual(result.writes.map((write) => write.product), ["deposit", "time_deposit"]);
  const asOf = { at: "2026-10-15T01:59:30.000Z", source: "reported" } as const;
  assert.deepEqual(timeDeposits(result.writes), [{
    collectedAt: "2026-10-15T02:00:00.000Z",
    completeness: "complete",
    deposits: [
      {
        sourceAccountKey: "td:TD-0001-2345",
        displayLabel: "王道銀行 一般定存 2345",
        currency: "TWD",
        balances: [{ kind: "current", amount: "100000", currency: "TWD", observedAt: asOf }],
        principal: null,
        interestRate: "1.725",
        maturityDate: "2027-01-15",
      },
      {
        sourceAccountKey: "td:TD-0009-8765",
        displayLabel: "王道銀行 外幣定存 8765 (USD)",
        currency: "USD",
        balances: [{ kind: "current", amount: "5000.00", currency: "USD", observedAt: asOf }],
        principal: null,
        interestRate: null,
        maturityDate: "2027-04-01",
      },
    ],
  }], "the detail's working balance as of its HTTP Date, its rate unless tiered, and its maturity in Gregorian");
  const tdQueries = result.http.requests.filter((request) => request.url.endsWith("/sendAndReceive"))
    .map(resourceOf).filter((request) => request.resource === "fao/FAO01022/020").map((request) => request.rqData);
  assert.deepEqual(tdQueries, [
    { page: "td", linkFromTxnId: "FAO01012_010" },
    { tdAccountNumber: "TD-0001-2345", linkFromTxnId: "FAO01012_010" },
    { tdAccountNumber: "TD-0009-8765", linkFromTxnId: "FAO01012_010" },
  ], "one list query, then one detail query per listed deposit");
  assert.equal(result.observations.filter((entry) => entry.endpoint === "fao/FAO01022/020" && entry.status === 200).length, 3,
    "observe() saw the list and both details");
});

test("a time-deposit list or detail that cannot be read in full fails only time_deposit, before its write", async () => {
  const td = (route: (request: Resource) => ReturnType<FakeRoute>): ResourceRoutes => ({ "fao/FAO01022/020": route });
  const detail = (patch: Record<string, unknown>) =>
    td(timeDepositRoute([TD_TWD, TD_USD], { ...TD_DETAILS, "TD-0009-8765": { ...TD_DETAILS["TD-0009-8765"], ...patch } }));
  const cases: Record<string, readonly [ResourceRoutes, string]> = {
    "missing currency": [td(timeDepositRoute([TD_TWD, { tdAccountNumber: "TD-0009-8765" }])), "source-validation-failed"],
    "malformed amount": [detail({ displayWorkingBalance: "5.000,00" }), "source-validation-failed"],
    "missing balance": [detail({ displayWorkingBalance: undefined }), "source-validation-failed"],
    "malformed rate": [detail({ isTierIntrstFlg: false, displayRate: "見公告" }), "source-validation-failed"],
    "detail for another deposit": [detail({ tdAccountNumber: "TD-0001-2345" }), "source-validation-failed"],
    "detail in another currency": [detail({ currency: "JPY" }), "source-validation-failed"],
    "failed detail": [td(({ rqData }) => rqData.page === "td"
      ? jsonResponse(envelope({ repeats: [TD_TWD, TD_USD] }))
      : jsonResponse({ isSuccessful: false, statusCode: "9999", statusDesc: "系統忙碌" })), "source-validation-failed"],
    "missing list": [td(timeDepositRoute(undefined)), "source-validation-failed"],
    "repeated deposit": [td(timeDepositRoute([TD_TWD, TD_TWD])), "source-validation-failed"],
  };
  for (const [name, [secure, code]] of Object.entries(cases)) {
    const result = await run({}, secure, BOTH);
    assert.deepEqual(outcomes(result), [["deposit", "success", null], ["time_deposit", "failed", code]], name);
    assert.deepEqual(result.writes.map((write) => write.product), ["deposit"], `${name} writes no time deposit and keeps the deposit write`);
  }
});

test("time deposits are not_held only for an explicit empty list", async () => {
  const empty = await run({}, { "fao/FAO01022/020": timeDepositRoute([]) }, BOTH);
  assert.deepEqual(outcomes(empty), [["deposit", "success", null], ["time_deposit", "not_held", null]]);
  assert.deepEqual(timeDeposits(empty.writes), [{ collectedAt: "2026-10-15T02:00:00.000Z", completeness: "complete", deposits: [] }],
    "the empty complete list is written, so it closes earlier deposits");
  const missing = await run({}, { "fao/FAO01022/020": timeDepositRoute(undefined) }, BOTH);
  assert.equal(outcomes(missing)![1]![1], "failed", "a response without repeats is no evidence of holding nothing");
});

test("a deposit failure leaves the time_deposit outcome intact", async () => {
  const result = await run({}, { "fao/FAO01012/010": () => jsonResponse(LIST.replace('"curr":"USD",', "")) }, BOTH);
  assert.deepEqual(outcomes(result), [["deposit", "failed", "source-validation-failed"], ["time_deposit", "success", null]]);
  assert.deepEqual(result.writes.map((write) => write.product), ["time_deposit"]);
});

test("a time deposit absent from the next complete list is closed, and an incomplete list closes nothing", async () => {
  await withPreviewStore(async (port) => {
    const visible = { visible: [{ sourceId: "obank-deposit", product: "time_deposit" as const }] };
    const closedAt = async () => Object.fromEntries((await port.accounts(visible)).map((account) => [account.displayLabel, account.timeDeposit?.closedAt ?? null]));
    const collect = async (secure: ResourceRoutes) => {
      const result = await run({}, secure, ["time_deposit"]);
      for (const write of result.writes) await port.write(write);
      return result;
    };
    await collect({});
    const open = { "王道銀行 一般定存 2345": null, "王道銀行 外幣定存 8765 (USD)": null };
    assert.deepEqual(await closedAt(), open);
    const incomplete = await collect({
      "fao/FAO01022/020": timeDepositRoute([TD_TWD], { "TD-0001-2345": { ...TD_DETAILS["TD-0001-2345"], tdAccountNumber: "TD-0009-8765" } }),
    });
    assert.equal(incomplete.writes.length, 0);
    assert.deepEqual(await closedAt(), open, "a list whose detail failed closes nothing");
    await collect({ "fao/FAO01022/020": timeDepositRoute([TD_TWD]) });
    assert.deepEqual(await closedAt(), { "王道銀行 一般定存 2345": null, "王道銀行 外幣定存 8765 (USD)": "2026-10-15T02:00:00.000Z" },
      "the USD deposit left the complete list");
  });
});
