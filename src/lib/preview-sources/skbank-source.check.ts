import assert from "node:assert/strict";
import { constants, createHash, createHmac, generateKeyPairSync, privateDecrypt } from "node:crypto";
import test from "node:test";
import { fakeHttpOpener, jsonResponse, runPreviewSource, type FakeRoute } from "./preview-source-harness.ts";
import { createSkbankSource, skbankDate, skbankDeviceId } from "./skbank-source.ts";

const credentials = {
  PREVIEW_SKBANK_DEPOSIT_ID_NUMBER: "A000000001",
  PREVIEW_SKBANK_DEPOSIT_USER_ID: "alias01",
  PREVIEW_SKBANK_DEPOSIT_PASSWORD: "secret-pass",
};

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const hex = (base64url: string) => Buffer.from(base64url, "base64url").toString("hex").toUpperCase();
const decrypt = (value: string) => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value, "hex")).toString("utf8");

const envelope = (data: string, code = "0000", message = "成功") => `{"ReturnCode":"${code}","ReturnMessage":"${message}","Data":${data}}`;
const ok = (data: string, headers: Record<string, string> = {}): FakeRoute => () => jsonResponse(envelope(data), headers);

const row = (date: string, amount: string, memo = "轉帳") =>
  `{"TransactionDate":"${date}","Amount":${amount},"Balance":1000,"Memo":"${memo}","Summary":"跨行"}`;
const page = (rows: string[], pageNumber: number, total: number | string) =>
  envelope(`{"Details":[${rows.join(",")}],"Paging":{"Page":${pageNumber},"PageSize":100,"TotalCount":${total}},"Summary":{"Deposit":"0","Withdrawal":"0"}}`);

const twdSummary = `{"AccountList":[
  {"AccountNumber":"SK-7788","ProductCode":"F500002","ProductFullName":"綜合存款","Nickname":"薪轉","Details":[
    {"CurrencyCode":"TWD","DisplayGroup":["Demand"],"AccountBalance":1234.50,"AvailableBalance":1200.00,"AccountNumberDisplay":"SK-7788"},
    {"CurrencyCode":"USD","DisplayGroup":["Demand"],"AccountBalance":1}]},
  {"AccountNumber":"SK-9900","ProductCode":"F500001","Details":[
    {"CurrencyCode":"TWD","DisplayGroup":["TimeDeposit"],"TimeDepositBalance":50000,"AccountBalance":0}]}
]}`;
const fxSummary = `{"AccountList":[{"AccountNumber":"SK-5566","Details":[{"CurrencyCode":"usd","AccountBalance":"10.25"}]}]}`;

function routes(overrides: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
    "GET /api/v1/Common/GetAppConfig": ok(`{"PublicKey":{"Module":"${hex(jwk.n!)}","Exponent":"${hex(jwk.e!)}"}}`),
    "POST /api/v2/Authentication/Login": ok('{"AccessToken":"token-1"}'),
    "GET /api/v1/Foundation/GetUserInformation": ok("{}"),
    "GET /api/v1/Common/GetMegaMenuStatus": ok("{}"),
    "GET /api/v1/Account/GetAccountSummary": ok(twdSummary, { date: "Thu, 15 Oct 2026 01:59:00 GMT" }),
    "GET /api/v1/Account/GetForeignCurrencyAccountSummary": ok(fxSummary),
    "GET /api/v1/Account/FetchTransactionDetails": (_request, call) => jsonResponse(call === 0
      ? page([row("115/10/03 09:15:00", "-250.00"), row("115/10/03 09:15:00", "-250.00")], 1, 3)
      : page([row("2026/10/04", "1234.50", "薪資")], 2, 3)),
    "GET /api/v1/Account/FetchForeignCurrencyTransactionDetails": () =>
      jsonResponse(envelope("{}", "E001", "查無資料")),
    "POST /api/v1/Authentication/Logout": ok("{}"),
    ...overrides,
  };
}

async function run(overrides: Record<string, FakeRoute> = {}) {
  const http = fakeHttpOpener(routes(overrides));
  const result = await runPreviewSource(createSkbankSource({ http }), credentials);
  return { ...result, http };
}

test("an SKBank run writes TWD, time-deposit, and foreign accounts with exact amounts and source currencies", async () => {
  const { receipt, writes, observations, http, error } = await run();
  assert.equal(error, null);
  assert.deepEqual(receipt, { accounts: 3, balances: 4, transactions: 3 });
  const [demand, term, foreign] = writes[0]!.collection.accounts;
  const reported = { at: "2026-10-15T01:59:00.000Z", source: "reported" };
  assert.deepEqual(demand!.balances, [
    { kind: "current", amount: "1234.50", currency: "TWD", observedAt: reported },
    { kind: "available", amount: "1200.00", currency: "TWD", observedAt: reported },
  ], "the JSON number lexeme survives, and the HTTP Date is the as-of time");
  assert.equal(demand!.sourceAccountKey, "SK-7788:TWD");
  assert.deepEqual(demand!.transactions.map(({ amount, currency, direction, postedAt }) => ({ amount, currency, direction, postedAt })), [
    { amount: "-250.00", currency: "TWD", direction: "unknown", postedAt: { precision: "second", value: "2026-10-03T09:15:00" } },
    { amount: "-250.00", currency: "TWD", direction: "unknown", postedAt: { precision: "second", value: "2026-10-03T09:15:00" } },
    { amount: "1234.50", currency: "TWD", direction: "unknown", postedAt: { precision: "day", value: "2026-10-04" } },
  ], "SKBank rows carry no direction field, so the signed amount is kept and the direction stays unknown");
  assert.equal(new Set(demand!.transactions.map((entry) => entry.sourceRowKey)).size, 3, "identical rows keep distinct keys by occurrence");
  assert.deepEqual(term!.balances.map(({ amount }) => amount), ["50000"], "a time deposit reports TimeDepositBalance");
  assert.equal(term!.transactions.length, 0);
  assert.deepEqual(foreign!.balances.map(({ amount, currency, observedAt }) => ({ amount, currency, source: observedAt.source })), [
    { amount: "10.25", currency: "USD", source: "collection-time" },
  ]);

  const pages = http.requests.filter((request) => request.url.includes("FetchTransactionDetails")).map((request) => new URL(request.url).searchParams);
  assert.deepEqual(pages.map((query) => [query.get("AccountNumber"), query.get("Page"), query.get("BeginDate"), query.get("EndDate")]), [
    ["SK-7788", "1", "2026/08/01", "2026/10/15"],
    ["SK-7788", "2", "2026/08/01", "2026/10/15"],
  ], "only the demand account is paged; the time deposit is not queried");
  const fxQuery = new URL(http.requests.find((request) => request.url.includes("FetchForeignCurrency"))!.url).searchParams;
  assert.equal(fxQuery.get("CurrencyCode"), "USD");
  for (const endpoint of ["/api/v1/Account/GetAccountSummary", "/api/v1/Account/FetchTransactionDetails", "/api/v1/Account/FetchForeignCurrencyTransactionDetails"])
    assert.ok(observations.some((entry) => entry.endpoint === endpoint && entry.status === 200), `${endpoint} is observed`);
  assert.ok(http.requests.at(-1)!.url.endsWith("/Logout"), "the session is signed out after collection");
});

test("the login is RSA-encrypted, HMAC-signed, and sent from a stable derived device", async () => {
  const { http } = await run();
  const login = http.requests.find((request) => request.url.endsWith("/Login"))!;
  const body = JSON.parse(login.body!);
  assert.equal(decrypt(body.Payload.Alias), "alias01");
  assert.equal(decrypt(body.Payload.Password), "secret-pass");
  assert.equal(body.Payload.NationalIdNumber, "A000000001");
  const secret = createHash("sha256").update("A000000001").digest("hex");
  assert.equal(body.Signature, createHmac("sha256", secret).update(JSON.stringify({ Payload: body.Payload })).digest("base64"));
  assert.ok(!JSON.stringify(http.requests).includes("secret-pass"), "the password never leaves in plaintext");
  assert.ok(!JSON.stringify(http.requests).includes("alias01"), "the user ID never leaves in plaintext");

  const deviceId = skbankDeviceId("A000000001", "alias01");
  assert.match(deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.ok(http.requests.every((request) => request.headers?.["Device-Id"] === deviceId), "every request presents the same device");
  assert.notEqual(skbankDeviceId("A000000002", "alias01"), deviceId);
  assert.equal(http.requests.find((request) => request.url.includes("GetAccountSummary"))!.headers?.Authorization, "bearer token-1");
});

test("a rejected sign-in is typed and collects nothing", async () => {
  const result = await run({ "POST /api/v2/Authentication/Login": () => jsonResponse(envelope("null", "MB001", "密碼錯誤")) });
  assert.equal(result.errorCode, "authentication-failed");
  assert.equal(result.writes.length, 0);
  assert.ok(!result.http.requests.some((request) => request.url.includes("GetAccountSummary")));
  const outdated = await run({ "POST /api/v2/Authentication/Login": () => jsonResponse(envelope("null", "MB433", "請更新版本")) });
  assert.equal(outdated.errorCode, "source-validation-failed", "an App-version rejection is not reported as wrong credentials");
});

test("transaction paging fails closed and writes nothing when rows do not reach TotalCount", async () => {
  const cases: Record<string, FakeRoute> = {
    "TotalCount above the rows on a final empty page": (_request, call) =>
      jsonResponse(call === 0 ? page([row("2026/10/04", "1")], 1, 2) : page([], 2, 2)),
    "TotalCount below the rows": () => jsonResponse(page([row("2026/10/04", "1"), row("2026/10/05", "2")], 1, 1)),
    "TotalCount changes between pages": (_request, call) =>
      jsonResponse(call === 0 ? page([row("2026/10/04", "1")], 1, 3) : page([row("2026/10/05", "2")], 2, 2)),
    "the server repeats page 1": () => jsonResponse(page([row("2026/10/04", "1")], 1, 5)),
    "TotalCount is not a count": () => jsonResponse(page([row("2026/10/04", "1")], 1, '"many"')),
    "a later page reports no data": (_request, call) =>
      jsonResponse(call === 0 ? page([row("2026/10/04", "1")], 1, 2) : envelope("{}", "E001", "查無資料")),
    "the page bound is exceeded": (_request, call) => jsonResponse(page([row("2026/10/04", String(call))], call + 1, 1000)),
  };
  for (const [name, route] of Object.entries(cases)) {
    const result = await run({ "GET /api/v1/Account/FetchTransactionDetails": route });
    assert.equal(result.errorCode, "source-collection-failed", name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.ok(result.observations.length > 0, `${name} keeps observed responses for a structure report`);
  }
});

test("an account detail without a currency is refused before write instead of defaulting to TWD", async () => {
  const result = await run({
    "GET /api/v1/Account/GetAccountSummary": ok('{"AccountList":[{"AccountNumber":"SK-7788","Details":[{"AccountBalance":"1"}]}]}'),
  });
  assert.equal(result.errorCode, "source-validation-failed");
  assert.match(String((result.error as Error).message), /missing-currency/u);
  assert.equal(result.writes.length, 0);
});

test("a malformed amount is refused before write", async () => {
  const balance = await run({
    "GET /api/v1/Account/GetAccountSummary": ok('{"AccountList":[{"AccountNumber":"SK-7788","Details":[{"CurrencyCode":"TWD","AccountBalance":"1.2.3"}]}]}'),
  });
  assert.equal(balance.errorCode, "source-validation-failed");
  assert.equal(balance.writes.length, 0);
  const amount = await run({ "GET /api/v1/Account/FetchTransactionDetails": () => jsonResponse(page([row("2026/10/04", '"NA"')], 1, 1)) });
  assert.equal(amount.errorCode, "source-validation-failed");
  assert.match(String((amount.error as Error).message), /malformed-amount/u);
  assert.equal(amount.writes.length, 0);
});

test("SKBank dates accept the ROC year and unpadded parts", () => {
  assert.deepEqual(skbankDate("115/1/3", "d"), { precision: "day", value: "2026-01-03" });
  assert.deepEqual(skbankDate("2026.10.04 23:59:59", "d"), { precision: "second", value: "2026-10-04T23:59:59" });
  assert.throws(() => skbankDate("115/13/01", "d"));
});
