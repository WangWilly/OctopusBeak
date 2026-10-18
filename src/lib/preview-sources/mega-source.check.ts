import assert from "node:assert/strict";
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import test from "node:test";
import { createMegaSource, encryptMegaLogin, megaVirtualDevice } from "./mega-source.ts";
import { calibratedCaptchaSolver, MEGA_CAPTCHA_FAMILY } from "./preview-captcha.ts";
import { blankPng, fakeHttpOpener, jsonResponse, runPreviewSource, depositCollection, scriptedOcrEngine, type FakeRoute } from "./preview-source-harness.ts";
import { PreviewSourceFailure, type PreviewFailureReason } from "./source-kit.ts";
import type { PreviewHttpRequest, PreviewHttpResponse } from "./browser-http.ts";

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

async function run(overrides: Record<string, ResourceRoute> = {}, extra: Record<string, FakeRoute> = {}) {
  const http = fakeHttpOpener(routes(overrides, extra));
  const result = await runPreviewSource(createMegaSource({ http, solveCaptcha }), credentials);
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
  const result = await runPreviewSource(createMegaSource({ http, solveCaptcha: calibratedCaptchaSolver(MEGA_CAPTCHA_FAMILY, engine) }), credentials);
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
  const result = await runPreviewSource(createMegaSource({ http }), credentials);
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
