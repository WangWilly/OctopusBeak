import assert from "node:assert/strict";
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import test from "node:test";
import { createMegaSource, encryptMegaLogin, megaVirtualDevice } from "./mega-source.ts";
import { calibratedCaptchaSolver, MEGA_CAPTCHA_FAMILY } from "./preview-captcha.ts";
import { blankPng, fakeHttpOpener, jsonResponse, runPreviewSource, depositCollection, scriptedOcrEngine, type FakeRoute } from "./preview-source-harness.ts";
import { PreviewSourceFailure, type PreviewFailureReason } from "./source-kit.ts";
import type { PreviewHttpRequest, PreviewHttpResponse } from "./browser-http.ts";
import type { PreviewProduct, PreviewWrite } from "../../ledger/pglite/preview-financial-data.ts";
import { parsePreviewCreditCollection } from "../../ledger/pglite/preview-credit.ts";
import type { PreviewRunOutput } from "./product-collection.ts";

const credentials = {
  PREVIEW_MEGA_DEPOSIT_ID_NUMBER: "a000000001",
  PREVIEW_MEGA_DEPOSIT_USER_CODE: "user01",
  PREVIEW_MEGA_DEPOSIT_PASSWORD: "secret-pass",
};

const testKey = generateKeyPairSync("rsa", { modulusLength: 1024 });
const jwk = testKey.publicKey.export({ format: "jwk" });
const SESSION_KEY = "0123456789abcdeffedcba9876543210"; // gitleaks:allow synthetic test key
const cipherToken = {
  SessionKey: SESSION_KEY,
  RSAPublicKeyModulus: Buffer.from(jwk.n!, "base64url").toString("hex"),
  RSAPublicKeyExponent: Buffer.from(jwk.e!, "base64url").toString("hex"),
};

const ADAPTER = "POST /ixtein/v2/adapters/ibmb/imp-pmb-adapter/resource";
const ok = (rsData: string) => jsonResponse(`{"code":"0000","rsData":${rsData}}`);
type ResourceRoute = (rqData: Record<string, unknown>, call: number) => PreviewHttpResponse;

const row = (txDate: string, drcr: string, amount: string, item = "轉帳") =>
  `{"txDate":"${txDate}","DRCR":"${drcr}","amount":${amount},"paymentItem":"${item}","serialNo":"1"}`;

const CARD_A = "0000000000006789";
const CARD_B = "0000000000004321";
const CARD_UNLISTED = "0000000000009999";
const bill = (type: string, month: string, currency: string, total: string, paid: string) =>
  `{"ACCT_TYPE":"${type}","ACCT_MON":"${month}","CURR_CODE":"${currency}","THIS_TTL_AMT":${total},"PAYMENT_AMT":${paid}}`;
const purchase = (fields: Record<string, string>) =>
  JSON.stringify({ cardNo: CARD_A, sourceCurr: "TWD", destinationCurr: "TWD", ...fields });

const defaults: Record<string, ResourceRoute> = {
  "/fco/fco00001/initialize": () => ok("{}"),
  "/fco/fco00001/captcha": () => ok(JSON.stringify({ image: `data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}` })),
  "/fco/fco00001/e2ee": () => ok(JSON.stringify({ isE2EE: true, cipherToken: JSON.stringify(cipherToken) })),
  "/fco/fco02003/login": () => ok('{"resultType":"0","secondFactorFlag":"N","isHighIpFar":false}'),
  "/fco/fco10001/home": () => jsonResponse(
    '{"code":"0000","rsData":{"depositInfoList":[{"DRACT":"MG-7788","DRCUR":"TWD","AVLBA":1234.50,"NAME":"活期儲蓄存款"},{"DRACT":"MG-7788","DRCUR":"usd","AVLBA":"10.25","NAME":"外幣活存"}]}}',
    { date: "Thu, 15 Oct 2026 01:59:00 GMT" },
  ),
  "/fao/fao01001/query": (rqData) => ok(rqData.tsqName === ""
    ? `{"list":[${row("2026/10/03", "D", "250.00")},${row("2026/10/03", "D", "250.00")}],"tsqName":"Q2"}`
    : `{"list":[${row("20261004", "C", "1000", "薪資")}],"tsqName":""}`),
  "/fco/fco02011/logout": () => ok("{}"),
  "/fco/fco10007/home": () => jsonResponse(`{"code":"0000","rsData":{"creditCardBillInfoList":[${[
    bill("01", "202609", "TWD", '"1,000"', "200"),
    bill("01", "202608", "TWD", "900", "900"),
    bill("01", "999912", "TWD", "300.50", "0"),
    bill("05", "202609", "TWD", "200", "0"),
    bill("05", "999912", "TWD", "0", "0"),
    bill("01", "202609", "USD", '"10.25"', '"20"'),
    bill("01", "999912", "USD", '"0"', '"0"'),
  ].join(",")}]}}`, { date: "Thu, 15 Oct 2026 01:58:00 GMT" }),
  "/fao/fao01010/home": () => ok(`{"cardNumbers":[{"cardNo":"${CARD_A}","cardName":"測試正卡"},{"cardNo":"${CARD_B}","cardName":"測試副卡"}]}`),
  "/fao/fao01010/query": () => ok(`{"detailList":[{"cardNo":"${CARD_A}","detailList":[${[
    purchase({ purchaseDate: "2026/10/03", merchantChiName: "測試商店", destinationAmt: "300", acctMon: "999912" }),
    purchase({ purchaseDate: "2026/10/03", merchantChiName: "測試商店", destinationAmt: "300", acctMon: "999912" }),
    purchase({ purchaseDate: "2026/09/24", merchantChiName: "測試退款", destinationAmt: "-50", acctMon: "202609", postDate: "2026/09/26" }),
  ].join(",")}]},${purchase({ cardNo: CARD_B, purchaseDate: "2026/10/05", merchantChiName: "海外商店", sourceAmt: "12", sourceCurr: "USD", destinationAmt: "12.00", destinationCurr: "USD", acctMon: "999912" })}]}`),
};

function routes(overrides: Record<string, ResourceRoute> = {}, extra: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  const table = { ...defaults, ...overrides };
  const calls = new Map<string, number>();
  const dispatch: FakeRoute = (request: PreviewHttpRequest) => {
    const body = JSON.parse(request.body!);
    const route = table[body.resource];
    if (!route) throw new Error(`Unrouted Mega resource ${body.resource}`);
    const call = calls.get(body.resource) ?? 0;
    calls.set(body.resource, call + 1);
    return route(body.rqData, call);
  };
  return {
    "POST /ixtein/oauth/token": () => jsonResponse({ access_token: "at-1" }),
    "POST /ixtein/main/init": () => jsonResponse({ statusCode: "0000" }),
    [`${ADAPTER}/ixtein-pmbinit`]: dispatch,
    [`${ADAPTER}/prelogin`]: dispatch,
    [`${ADAPTER}/megapmb`]: dispatch,
    [`${ADAPTER}/login`]: () => jsonResponse({}, { "x-auth-token": "xa-1" }),
    ...extra,
  };
}

const solveCaptcha = async () => "12345";

async function run(overrides: Record<string, ResourceRoute> = {}, extra: Record<string, FakeRoute> = {}, products: readonly PreviewProduct[] = ["deposit"]) {
  const http = fakeHttpOpener(routes(overrides, extra));
  const result = await runPreviewSource(createMegaSource({ http, solveCaptcha }), credentials, undefined, products);
  const resources = http.requests.map((request) => request.body?.startsWith("{") ? JSON.parse(request.body).resource : undefined);
  return { ...result, http, resources };
}

test("a Mega run writes each account and currency with exact amounts, DRCR directions, and paged NT-dollar history", async () => {
  const { receipt, writes, observations, http, resources } = await run();
  assert.deepEqual(receipt, { accounts: 2, balances: 2, transactions: 3, statements: 0, closedAccounts: 0 });
  const [twd, usd] = depositCollection(writes[0]!).accounts;
  assert.equal(twd!.sourceAccountKey, "MG-7788:TWD");
  assert.deepEqual(twd!.balances, [
    { kind: "available", amount: "1234.50", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
  ], "the JSON number lexeme survives, and the HTTP Date is the as-of time");
  assert.deepEqual(twd!.transactions.map(({ sourceRowKey, amount, currency, direction, postedAt }) => ({ sourceRowKey, amount, currency, direction, postedAt })), [
    { sourceRowKey: "2026-10-03:D:250.00:轉帳#0", amount: "250.00", currency: "TWD", direction: "outflow", postedAt: { precision: "day", value: "2026-10-03" } },
    { sourceRowKey: "2026-10-03:D:250.00:轉帳#1", amount: "250.00", currency: "TWD", direction: "outflow", postedAt: { precision: "day", value: "2026-10-03" } },
    { sourceRowKey: "2026-10-04:C:1000:薪資#0", amount: "1000", currency: "TWD", direction: "inflow", postedAt: { precision: "day", value: "2026-10-04" } },
  ], "D is an outflow, C an inflow, and identical same-day rows stay distinct");
  assert.deepEqual(usd!.balances.map(({ amount, currency }) => ({ amount, currency })), [{ amount: "10.25", currency: "USD" }]);
  assert.equal(usd!.currency, "USD");
  assert.deepEqual(usd!.transactions, []);

  const pages = http.requests.filter((request) => request.body?.includes("/fao/fao01001/query")).map((request) => JSON.parse(request.body!).rqData);
  assert.deepEqual(pages.map(({ tsqName, currency, startDate, endDate }) => ({ tsqName, currency, startDate, endDate })), [
    { tsqName: "", currency: "TWD", startDate: "2026/08/01", endDate: "2026/10/15" },
    { tsqName: "Q2", currency: "TWD", startDate: "2026/08/01", endDate: "2026/10/15" },
  ], "only the NT-dollar account is queried, following its tsqName cursor");
  assert.ok(observations.some((entry) => entry.endpoint === "/fco/fco10001/home" && entry.status === 200));
  assert.ok(observations.some((entry) => entry.endpoint === "/fao/fao01001/query"));
  assert.equal(resources.at(-1), "/fco/fco02011/logout", "the session is signed out after collection");
  const query = http.requests.find((request) => request.body?.includes("/fco/fco10001/home"))!;
  assert.equal(query.headers!["x-auth-token"], "xa-1", "the adapter login's x-auth-token is sent on later resources");
  assert.equal(query.headers!.Authorization, "Bearer at-1");
});

test("the password leaves only inside the RSA-wrapped 3DES envelope", async () => {
  const { http } = await run();
  assert.ok(!JSON.stringify(http.requests).includes("secret-pass"));
  const login = JSON.parse(http.requests.find((request) => request.body?.includes("/fco/fco02003/login"))!.body!);
  assert.equal(login.rqData.captchaCode, "12345");
  assert.equal(login.rqData.pxdLength, 11);
  assert.equal(login.rqData.isDeviceBinded, false);

  const plain = privateDecrypt({ key: testKey.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(login.rqData.e2eeData.padStart(256, "0"), "hex"));
  const prefix = Buffer.from("A000000001|USER01/");
  assert.deepEqual(plain.subarray(0, prefix.length), prefix, "the identifiers are upper-cased and precede the 3DES block");
  const key = Buffer.from(SESSION_KEY, "hex");
  const des = createDecipheriv("des-ede3-cbc", Buffer.concat([key, key.subarray(0, 8)]), Buffer.alloc(8));
  const password = Buffer.concat([des.update(plain.subarray(prefix.length)), des.final()]).toString("utf8");
  assert.equal(password, "secret-pass     ", "the password is space-padded to 16 characters before 3DES");
  assert.notEqual(encryptMegaLogin("A", "B", "x", cipherToken), encryptMegaLogin("A", "B", "x", cipherToken), "PKCS#1 v1.5 padding is randomized");
});

test("the virtual device is stable per sign-in identifier and sent on every resource", async () => {
  const device = megaVirtualDevice("A000000001", "USER01");
  assert.deepEqual(device, megaVirtualDevice("A000000001", "USER01"));
  assert.notEqual(device.deviceCode, megaVirtualDevice("A000000001", "USER02").deviceCode);
  assert.match(device.deviceCode, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u);
  const { http } = await run();
  const bodies = http.requests.filter((request) => request.url.includes("/resource/") && !request.url.endsWith("/resource/login")).map((request) => JSON.parse(request.body!));
  assert.ok(bodies.every((body) => body.deviceIxd === device.deviceCode && body.deviceUKey === device.deviceUKey && body.seed === device.seed));
});

const captchaImage = (png: Buffer): ResourceRoute => () => ok(JSON.stringify({ image: `data:image/png;base64,${png.toString("base64")}` }));
const unsure = { text: "12345", confidence: 0.9 };

async function runCalibrated(results: readonly { text: string; confidence: number }[], image = blankPng(100, 49)) {
  const engine = scriptedOcrEngine(results);
  const http = fakeHttpOpener(routes({ "/fco/fco00001/captcha": captchaImage(image) }));
  const result = await runPreviewSource(createMegaSource({ http, solveCaptcha: calibratedCaptchaSolver(MEGA_CAPTCHA_FAMILY, engine) }), credentials, undefined, ["deposit"]);
  const resources = http.requests.map((request) => request.body?.startsWith("{") ? JSON.parse(request.body).resource : undefined);
  return { ...result, http, engine, resources };
}

const SIGN_IN_RESOURCES = new Set(["/fco/fco00001/captcha", "/fco/fco00001/e2ee", "/fco/fco02003/login"]);
const signInResources = (resources: readonly unknown[]) => resources.filter((resource) => SIGN_IN_RESOURCES.has(resource as string));

test("an unaccepted CAPTCHA is refreshed through the captcha API without a login, and e2ee follows the accepted one", async () => {
  const { receipt, engine, resources, http } = await runCalibrated([
    unsure, unsure, unsure,
    unsure, unsure, unsure,
    { text: "24680", confidence: 0.995 }, unsure, unsure,
  ]);
  assert.deepEqual(receipt, { accounts: 2, balances: 2, transactions: 3, statements: 0, closedAccounts: 0 });
  assert.equal(engine.calls.length, 9, "three strategies on each of three challenges");
  assert.deepEqual(signInResources(resources), [
    "/fco/fco00001/captcha", "/fco/fco00001/captcha", "/fco/fco00001/captcha", "/fco/fco00001/e2ee", "/fco/fco02003/login",
  ], "no login between refreshes, and the cipherToken is fetched after the last challenge");
  const login = JSON.parse(http.requests.find((request) => request.body?.includes("/fco/fco02003/login"))!.body!);
  assert.equal(login.rqData.captchaCode, "24680");
});

test("five unaccepted challenges end the round as verification-failed without a login", async () => {
  const { errorCode, events, resources, writes, engine } = await runCalibrated(Array.from({ length: 15 }, () => unsure));
  assert.equal(errorCode, "verification-failed");
  assert.ok(events.some((event) => event.code === "verification-solver-exhausted"));
  assert.deepEqual(signInResources(resources), Array.from({ length: 5 }, () => "/fco/fco00001/captcha"), "no e2ee and no login");
  assert.equal(engine.calls.length, 15);
  assert.equal(writes.length, 0);
});

test("a CAPTCHA outside the Mega family is refused after the captcha request and before any login", async () => {
  const http = fakeHttpOpener(routes({ "/fco/fco00001/captcha": captchaImage(blankPng(120, 40)) }));
  const result = await runPreviewSource(createMegaSource({ http }), credentials, undefined, ["deposit"]);
  assert.equal(result.errorCode, "verification-configuration-failed");
  assert.ok(result.events.some((event) => event.code === "solver-challenge-unsupported"));
  const resources = http.requests.map((request) => request.body?.startsWith("{") ? JSON.parse(request.body).resource : undefined);
  assert.deepEqual(signInResources(resources), ["/fco/fco00001/captcha"], "the production factory solves instead of refusing up front");
});

test("a rejected sign-in and a rejected CAPTCHA are typed", async () => {
  const login = (code: string) => ({ "/fco/fco02003/login": () => jsonResponse({ code, rsData: {} }) });
  const rejected = await run(login("E001"));
  assert.equal(rejected.errorCode, "authentication-failed");
  assert.equal(rejected.writes.length, 0);
  assert.equal((await run(login("0113"))).errorCode, "verification-failed");
});

test("a second factor or an SMS gate after a remote sign-in ends as device-registration-required", async () => {
  const secondFactor = await run({ "/fco/fco02003/login": () => ok('{"secondFactorFlag":"Y","isHighIpFar":false}') });
  assert.equal(secondFactor.errorCode, "device-registration-required");
  assert.equal(secondFactor.writes.length, 0);
  assert.equal(secondFactor.resources.at(-1), "/fco/fco02011/logout");

  const sms = await run({
    "/fco/fco02003/login": () => ok('{"secondFactorFlag":"N","isHighIpFar":true}'),
    "/fco/fco10001/home": () => jsonResponse({ code: "SYS014" }),
  });
  assert.equal(sms.errorCode, "device-registration-required");
  assert.ok(!sms.resources.includes("/fco/fco00001/getverifycode"), "no SMS is requested");

  const local = await run({ "/fco/fco10001/home": () => jsonResponse({ code: "SYS014" }) });
  assert.equal(local.errorCode, "source-validation-failed", "SYS014 without the remote flag is not an SMS gate");
});

test("history paging fails closed on a repeated cursor or past the page bound", async () => {
  const cases: Record<string, ResourceRoute> = {
    "repeated cursor": () => ok(`{"list":[${row("2026/10/03", "D", "1")}],"tsqName":"SAME"}`),
    "page bound": (_rqData, call) => ok(`{"list":[${row("2026/10/03", "D", "1")}],"tsqName":"Q${call + 1}"}`),
    "non-text cursor": () => ok(`{"list":[],"tsqName":5}`),
  };
  for (const [name, route] of Object.entries(cases)) {
    const result = await run({ "/fao/fao01001/query": route });
    assert.equal(result.errorCode, "source-collection-failed", name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.ok(result.observations.length > 0, `${name} keeps observed responses for a structure report`);
    if (name === "repeated cursor") assert.equal(result.resources.filter((resource) => resource === "/fao/fao01001/query").length, 2, "a repeated cursor stops at once");
  }
});

test("a missing currency, a malformed amount, a signed amount, and an unknown DRCR are refused before write", async () => {
  const cases: Record<string, readonly [PreviewFailureReason, Record<string, ResourceRoute>]> = {
    "missing currency": ["missing-currency", { "/fco/fco10001/home": () => ok('{"depositInfoList":[{"DRACT":"MG-7788","AVLBA":"1"}]}') }],
    "malformed amount": ["malformed-amount", { "/fco/fco10001/home": () => ok('{"depositInfoList":[{"DRACT":"MG-7788","DRCUR":"TWD","AVLBA":"1.2.3"}]}') }],
    "malformed row amount": ["malformed-amount", { "/fao/fao01001/query": () => ok(`{"list":[${row("2026/10/03", "D", '"12a"')}],"tsqName":""}`) }],
    "signed amount": ["unexpected-response", { "/fao/fao01001/query": () => ok(`{"list":[${row("2026/10/03", "D", "-5")}],"tsqName":""}`) }],
    "unknown DRCR": ["unexpected-response", { "/fao/fao01001/query": () => ok(`{"list":[${row("2026/10/03", "X", "5")}],"tsqName":""}`) }],
    "conflicting duplicate account": ["unexpected-response", { "/fco/fco10001/home": () => ok('{"depositInfoList":[{"DRACT":"MG-7788","DRCUR":"TWD","AVLBA":"1"},{"DRACT":"MG-7788","DRCUR":"TWD","AVLBA":"2"}]}') }],
  };
  for (const [name, [reason, overrides]] of Object.entries(cases)) {
    const result = await run(overrides);
    assert.equal(result.errorCode, "source-validation-failed", name);
    assert.equal((result.error as PreviewSourceFailure).reason, reason, name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
  }
});

const BOTH: readonly PreviewProduct[] = ["deposit", "credit_card"];
const creditWrites = (writes: readonly PreviewWrite[]) => writes.flatMap((write) => write.product === "credit_card" ? [write.collection] : []);
const outcomes = (output: PreviewRunOutput | null) => Object.fromEntries((output?.products ?? []).map((product) => [product.typeId, product.status]));

test("one Mega sign-in writes deposits and a credit account per currency with an unclamped statement-minus-paid-plus-unbilled balance", async () => {
  const { writes, output, observations, http, resources } = await run({}, {}, BOTH);
  assert.deepEqual(outcomes(output), { deposit: "success", credit_card: "success" });
  assert.equal(resources.filter((resource) => resource === "/fco/fco02003/login").length, 1, "one sign-in serves both products");
  const [collection] = creditWrites(writes);
  assert.ok(collection, "a credit collection is written");
  assert.deepEqual(parsePreviewCreditCollection(collection), collection, "the collection satisfies the preview credit contract");
  assert.equal(collection.collectedAt, "2026-10-15T02:00:00.000Z");
  const [twd, usd] = collection.accounts;
  assert.equal(twd!.sourceAccountKey, "credit:TWD");
  assert.deepEqual(twd!.balances, [{
    amount: "1300.50",
    currency: "TWD",
    observedAt: { at: "2026-10-15T01:58:00.000Z", source: "reported" },
    basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "1200", paidAmount: "200", unbilledAmount: "300.50" },
  }], "each ACCT_TYPE contributes its latest billed month and its 999912 row; the older 202608 bill is ignored");
  assert.deepEqual(usd!.balances.map(({ amount, basis }) => ({ amount, basis })), [{
    amount: "-9.75",
    basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "10.25", paidAmount: "20", unbilledAmount: "0" },
  }], "an overpaid account stays negative");
  assert.deepEqual(twd!.statements, [], "no statement is written without source cycle dates");
  assert.deepEqual(twd!.cards.map(({ cardMask, displayLabel }) => ({ cardMask, displayLabel })), [
    { cardMask: "****-6789", displayLabel: "測試正卡" },
    { cardMask: "****-4321", displayLabel: "測試副卡" },
  ]);
  assert.ok(!JSON.stringify(collection).includes(CARD_A) && !JSON.stringify(collection).includes(CARD_B), "full card numbers are never written");
  const cardA = twd!.cards[0]!.sourceCardKey;
  const unbilled = { status: "posted", billing: "unbilled", postingDate: null } as const;
  assert.deepEqual(twd!.purchases.map(({ sourceRowKey, amount, direction, posting, consumedAt, sourceCardKey, description }) => ({ sourceRowKey, amount, direction, posting, consumedAt, sourceCardKey, description })), [
    { sourceRowKey: `${cardA}:2026-10-03:TWD::TWD:300:測試商店#0`, amount: "300", direction: "outflow", posting: unbilled, consumedAt: { precision: "day", value: "2026-10-03" }, sourceCardKey: cardA, description: "測試商店" },
    { sourceRowKey: `${cardA}:2026-10-03:TWD::TWD:300:測試商店#1`, amount: "300", direction: "outflow", posting: unbilled, consumedAt: { precision: "day", value: "2026-10-03" }, sourceCardKey: cardA, description: "測試商店" },
    {
      sourceRowKey: `${cardA}:2026-09-24:TWD::TWD:-50:測試退款#0`, amount: "-50", direction: "inflow",
      posting: { status: "posted", billing: "billed", postingDate: "2026-09-26" }, consumedAt: { precision: "day", value: "2026-09-24" }, sourceCardKey: cardA, description: "測試退款",
    },
  ], "999912 is unbilled, a billing month is billed, identical rows take an occurrence, and the sign is the direction because both signs occur");
  assert.deepEqual(usd!.purchases.map(({ amount, currency, direction, sourceCardKey }) => ({ amount, currency, direction, sourceCardKey })), [
    { amount: "12.00", currency: "USD", direction: "outflow", sourceCardKey: twd!.cards[1]!.sourceCardKey },
  ], "a flat row is its own card group and lands in its settlement currency's account");
  const query = http.requests.map((request) => request.body?.startsWith("{") ? JSON.parse(request.body) : null).find((body) => body?.resource === "/fao/fao01010/query");
  assert.deepEqual(query.rqData, { cardNo: "0", flag: "0", startDate: "2026/08/01", endDate: "2026/10/15" });
  for (const endpoint of ["/fco/fco10007/home", "/fao/fao01010/home", "/fao/fao01010/query"])
    assert.ok(observations.some((entry) => entry.endpoint === endpoint && entry.status === 200), `observe() saw ${endpoint}`);
});

test("card row keys survive volatile sequence fields and billing", async () => {
  const keys = async (seq: string, month: string) => {
    const { writes } = await run({
      "/fao/fao01010/query": () => ok(`{"detailList":[${purchase({ purchaseDate: "2026/10/03", merchantChiName: "測試商店", destinationAmt: "300", acctMon: month, seqNo: seq, serialNo: seq })}]}`),
    }, {}, ["credit_card"]);
    return creditWrites(writes)[0]!.accounts[0]!.purchases.map((row) => row.sourceRowKey);
  };
  const unbilled = await keys("1", "999912");
  assert.equal(unbilled.length, 1);
  assert.deepEqual(await keys("7", "999912"), unbilled, "a renumbered sequence keeps the key");
  assert.deepEqual(await keys("2", "202610"), unbilled, "billing moves acctMon but keeps the key");
});

test("card directions stay unknown unless the collection holds both signs", async () => {
  const { writes } = await run({
    "/fao/fao01010/query": () => ok(`{"detailList":[${purchase({ purchaseDate: "2026/10/03", destinationAmt: "300", acctMon: "999912" })},${purchase({ purchaseDate: "2026/10/04", destinationAmt: "20", acctMon: "999912" })}]}`),
  }, {}, ["credit_card"]);
  assert.deepEqual(creditWrites(writes)[0]!.accounts[0]!.purchases.map((row) => row.direction), ["unknown", "unknown"]);
});

test("an empty card overview is not_held, while a missing list or an empty card list fails", async () => {
  const empty = await run({ "/fco/fco10007/home": () => ok('{"creditCardBillInfoList":[]}') }, {}, BOTH);
  assert.deepEqual(outcomes(empty.output), { deposit: "success", credit_card: "not_held" });
  assert.deepEqual(creditWrites(empty.writes), [], "not_held writes no credit account and no zero balance");
  assert.ok(!empty.resources.includes("/fao/fao01010/home"), "no card list is read without cards");

  for (const body of ["{}", '{"creditCardBillInfoList":null}']) {
    const missing = await run({ "/fco/fco10007/home": () => ok(body) }, {}, BOTH);
    assert.deepEqual(outcomes(missing.output), { deposit: "success", credit_card: "failed" }, body);
  }
  const noCards = await run({ "/fao/fao01010/home": () => ok('{"cardNumbers":[]}') }, {}, BOTH);
  assert.deepEqual(outcomes(noCards.output), { deposit: "success", credit_card: "failed" }, "bills without a card list are not a no-card signal");
});

const overview = (...rows: string[]): ResourceRoute => () => ok(`{"creditCardBillInfoList":[${rows.join(",")}]}`);
const query = (...rows: string[]): ResourceRoute => () => ok(`{"detailList":[${rows.join(",")}]}`);

test("card failures stop before the credit write and leave the deposit write in place", async () => {
  const cases: Record<string, readonly [PreviewFailureReason, Record<string, ResourceRoute>]> = {
    "missing overview currency": ["missing-currency", { "/fco/fco10007/home": overview(bill("01", "202609", "", "1", "0"), bill("01", "999912", "TWD", "0", "0")) }],
    "missing purchase currency": ["missing-currency", { "/fao/fao01010/query": query(purchase({ purchaseDate: "2026/10/03", destinationAmt: "5", destinationCurr: "", acctMon: "999912" })) }],
    "malformed statement amount": ["malformed-amount", { "/fco/fco10007/home": overview(bill("01", "202609", "TWD", '"1.2.3"', "0"), bill("01", "999912", "TWD", "0", "0")) }],
    "malformed purchase amount": ["malformed-amount", { "/fao/fao01010/query": query(purchase({ purchaseDate: "2026/10/03", destinationAmt: "12a", acctMon: "999912" })) }],
    "missing paid operand": ["malformed-amount", { "/fco/fco10007/home": overview('{"ACCT_TYPE":"01","ACCT_MON":"202609","CURR_CODE":"TWD","THIS_TTL_AMT":"1"}', bill("01", "999912", "TWD", "0", "0")) }],
    "missing unbilled operand": ["incomplete-data", { "/fco/fco10007/home": overview(bill("01", "202609", "TWD", "1", "0")) }],
    "missing statement operand": ["incomplete-data", { "/fco/fco10007/home": overview(bill("01", "999912", "TWD", "1", "0")) }],
    "unknown billing month": ["unexpected-response", { "/fco/fco10007/home": overview(bill("01", "2026-09", "TWD", "1", "0"), bill("01", "999912", "TWD", "0", "0")) }],
    "incomplete purchase list": ["unexpected-response", { "/fao/fao01010/query": () => ok("{}") }],
    "zero purchase amount": ["unexpected-response", { "/fao/fao01010/query": query(purchase({ purchaseDate: "2026/10/03", destinationAmt: "0.00", acctMon: "999912" })) }],
    "unlisted card": ["unexpected-response", { "/fao/fao01010/query": query(purchase({ cardNo: CARD_UNLISTED, purchaseDate: "2026/10/03", destinationAmt: "5", acctMon: "999912" })) }],
    "purchase currency without an account": ["unexpected-response", { "/fao/fao01010/query": query(purchase({ purchaseDate: "2026/10/03", destinationAmt: "5", destinationCurr: "JPY", acctMon: "999912" })) }],
  };
  for (const [name, [reason, overrides]] of Object.entries(cases)) {
    const result = await run(overrides, {}, BOTH);
    assert.deepEqual(outcomes(result.output), { deposit: "success", credit_card: "failed" }, name);
    assert.deepEqual(creditWrites(result.writes), [], `${name} writes no credit collection`);
    assert.equal(result.deposits.length, 1, `${name} keeps the deposit write`);
    const alone = await run(overrides, {}, ["credit_card"]);
    assert.equal((alone.error as PreviewSourceFailure).reason, reason, name);
  }
});

test("a deposit failure leaves the credit write in place", async () => {
  const result = await run({ "/fco/fco10001/home": () => ok('{"depositInfoList":[{"DRACT":"MG-7788","AVLBA":"1"}]}') }, {}, BOTH);
  assert.deepEqual(outcomes(result.output), { deposit: "failed", credit_card: "success" });
  assert.equal(result.output!.status, "partial");
  assert.equal(creditWrites(result.writes).length, 1);
  assert.equal(result.deposits.length, 0);
});
