import assert from "node:assert/strict";
import { constants, createHash, createHmac, generateKeyPairSync, privateDecrypt } from "node:crypto";
import test from "node:test";
import type { PreviewCreditCollection, PreviewProduct, PreviewWrite } from "../../ledger/pglite/preview-financial-data.ts";
import { fakeHttpOpener, jsonResponse, runPreviewSource, depositCollection, type FakeRoute } from "./preview-source-harness.ts";
import { createSkbankSource, skbankDate, skbankDeviceId } from "./skbank-source.ts";
import { decimalDifference } from "./source-kit.ts";

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

const cardSummaryFields = {
  CurrentCredit: "100000",
  AvailableCredit: '"87,654.50"',
  CurrentStatementBalance: "9876",
  MinimumPaymentDue: "988",
  PaymentDueDate: '"115/10/24"',
  ClosingDate: '"8"',
  StatementMonth: "10",
};
const cardSummary = (fields: Record<string, string | undefined> = {}) =>
  `{${Object.entries({ ...cardSummaryFields, ...fields }).flatMap(([name, value]) => value === undefined ? [] : [`"${name}":${value}`]).join(",")}}`;
const cardList = `{"CreditCardList":[
  {"CardNumber":"4000-00**-****-1234","CardName":"新光 Visa 卡"},
  {"CardNumber":"5200********5678","CardName":"Mastercard"}]}`;
const billingHistory = `{"Bills":[{"Year":115,"Month":9,"StatementBalance":5000},{"Year":115,"Month":10,"StatementBalance":9876}]}`;

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
    "GET /api/v1/Account/GetAssetsOverview": ok('{"HasValidCreditCard":true}'),
    "GET /api/v1/CreditCard/GetSummary": ok(cardSummary(), { date: "Thu, 15 Oct 2026 01:58:00 GMT" }),
    "GET /api/v1/CreditCard/GetMyCreditCardsInformation": ok(cardList),
    "GET /api/v1/CreditCard/GetBillingHistory": ok(billingHistory),
    "GET /api/v1/CreditCard/GetRemainingDue": ok('{"RemainingDue":"3876"}'),
    "POST /api/v1/Authentication/Logout": ok("{}"),
    ...overrides,
  };
}

async function run(overrides: Record<string, FakeRoute> = {}, products: readonly PreviewProduct[] = ["deposit", "credit_card"]) {
  const http = fakeHttpOpener(routes(overrides));
  const result = await runPreviewSource(createSkbankSource({ http }), credentials, undefined, products);
  return { ...result, http };
}

const depositOnly = (overrides: Record<string, FakeRoute> = {}) => run(overrides, ["deposit"]);
const cardsOnly = (overrides: Record<string, FakeRoute> = {}) => run(overrides, ["credit_card"]);

function creditCollection(write: PreviewWrite): PreviewCreditCollection {
  if (write.product !== "credit_card") throw new Error(`expected a credit write, got ${write.product}`);
  return write.collection;
}

test("an SKBank run writes TWD, time-deposit, and foreign accounts with exact amounts and source currencies", async () => {
  const { receipt, writes, observations, http, error } = await depositOnly();
  assert.equal(error, null);
  assert.deepEqual(receipt, { accounts: 3, balances: 4, transactions: 3, statements: 0, closedAccounts: 0 });
  const [demand, term, foreign] = depositCollection(writes[0]!).accounts;
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
  const result = await depositOnly({ "POST /api/v2/Authentication/Login": () => jsonResponse(envelope("null", "MB001", "密碼錯誤")) });
  assert.equal(result.errorCode, "authentication-failed");
  assert.equal(result.writes.length, 0);
  assert.ok(!result.http.requests.some((request) => request.url.includes("GetAccountSummary")));
  const outdated = await depositOnly({ "POST /api/v2/Authentication/Login": () => jsonResponse(envelope("null", "MB433", "請更新版本")) });
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
    const result = await depositOnly({ "GET /api/v1/Account/FetchTransactionDetails": route });
    assert.equal(result.errorCode, "source-collection-failed", name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.ok(result.observations.length > 0, `${name} keeps observed responses for a structure report`);
  }
});

test("an account detail without a currency is refused before write instead of defaulting to TWD", async () => {
  const result = await depositOnly({
    "GET /api/v1/Account/GetAccountSummary": ok('{"AccountList":[{"AccountNumber":"SK-7788","Details":[{"AccountBalance":"1"}]}]}'),
  });
  assert.equal(result.errorCode, "source-validation-failed");
  assert.match(String((result.error as Error).message), /missing-currency/u);
  assert.equal(result.writes.length, 0);
});

test("a malformed amount is refused before write", async () => {
  const balance = await depositOnly({
    "GET /api/v1/Account/GetAccountSummary": ok('{"AccountList":[{"AccountNumber":"SK-7788","Details":[{"CurrencyCode":"TWD","AccountBalance":"1.2.3"}]}]}'),
  });
  assert.equal(balance.errorCode, "source-validation-failed");
  assert.equal(balance.writes.length, 0);
  const amount = await depositOnly({ "GET /api/v1/Account/FetchTransactionDetails": () => jsonResponse(page([row("2026/10/04", '"NA"')], 1, 1)) });
  assert.equal(amount.errorCode, "source-validation-failed");
  assert.match(String((amount.error as Error).message), /malformed-amount/u);
  assert.equal(amount.writes.length, 0);
});

test("SKBank dates accept the ROC year and unpadded parts", () => {
  assert.deepEqual(skbankDate("115/1/3", "d"), { precision: "day", value: "2026-01-03" });
  assert.deepEqual(skbankDate("2026.10.04 23:59:59", "d"), { precision: "second", value: "2026-10-04T23:59:59" });
  assert.throws(() => skbankDate("115/13/01", "d"));
});

test("SKBank credit cards are collected in the same sign-in, with limit-minus-available used credit and the current statement", async () => {
  const { writes, output, observations, http, error } = await run();
  assert.equal(error, null);
  assert.deepEqual(output!.products.map(({ typeId, status }) => [typeId, status]), [["deposit", "success"], ["credit_card", "success"]]);
  assert.equal(http.requests.filter((request) => request.url.endsWith("/Login")).length, 1, "both products share one sign-in");
  assert.deepEqual(writes.map((write) => write.product), ["deposit", "credit_card"]);
  assert.deepEqual(creditCollection(writes[1]!), {
    collectedAt: "2026-10-15T02:00:00.000Z",
    accounts: [{
      sourceAccountKey: "credit:TWD",
      displayLabel: "新光銀行 信用卡",
      currency: "TWD",
      creditLimit: "100000",
      cards: [
        { sourceCardKey: "1234", cardMask: "****-1234", displayLabel: "新光 Visa 卡" },
        { sourceCardKey: "5678", cardMask: "****-5678", displayLabel: "Mastercard" },
      ],
      balances: [{
        amount: "12345.50",
        currency: "TWD",
        observedAt: { at: "2026-10-15T01:58:00.000Z", source: "reported" },
        basis: { kind: "credit-limit-minus-available", creditLimit: "100000", availableCredit: "87654.50" },
      }],
      purchases: [],
      statements: [{
        statementKey: "2026-10",
        cycleStart: "2026-09-09",
        cycleEnd: "2026-10-08",
        closingDate: "2026-10-08",
        dueDate: "2026-10-24",
        amount: "9876",
        currency: "TWD",
        minimumPayment: "988",
        billingPeriod: "2026-10",
        paidAmount: null,
        paid: false,
        noPaymentNeeded: null,
      }],
    }],
  });
  for (const endpoint of ["GetAssetsOverview", "GetSummary", "GetMyCreditCardsInformation", "GetBillingHistory", "GetRemainingDue"])
    assert.ok(observations.some((entry) => entry.endpoint.endsWith(`/${endpoint}`) && entry.status === 200), `${endpoint} is observed`);
});

test("an overpaid card keeps its negative used credit, and a zero RemainingDue marks the statement paid", async () => {
  const { writes } = await cardsOnly({
    "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ AvailableCredit: '"100200"' })),
    "GET /api/v1/CreditCard/GetRemainingDue": ok('{"RemainingDue":"0"}'),
  });
  const [account] = creditCollection(writes[0]!).accounts;
  assert.equal(account!.balances[0]!.amount, "-200", "overpayment is not clamped");
  assert.equal(account!.statements[0]!.paid, true);
});

test("「本期帳單無欠款」 means no statement debt, not no card", async () => {
  const { writes, output } = await cardsOnly({ "GET /api/v1/CreditCard/GetRemainingDue": ok(`{"RemainingDue":"本期帳單無欠款"}`) });
  assert.deepEqual(output!.products.map(({ status }) => status), ["skipped", "success"]);
  const [account] = creditCollection(writes[0]!).accounts;
  assert.equal(account!.balances[0]!.amount, "12345.50", "used credit still comes from the limit and available credit");
  assert.deepEqual([account!.statements[0]!.noPaymentNeeded, account!.statements[0]!.paid], [true, null]);
});

test("not_held comes only from HasValidCreditCard false", async () => {
  const none = await run({ "GET /api/v1/Account/GetAssetsOverview": ok('{"HasValidCreditCard":false}') });
  assert.deepEqual(none.output!.products.map(({ typeId, status }) => [typeId, status]), [["deposit", "success"], ["credit_card", "not_held"]]);
  assert.deepEqual(none.writes.map((write) => write.product), ["deposit"], "no credit account and no zero balance are written");
  assert.ok(!none.http.requests.some((request) => request.url.includes("/CreditCard/")), "no card endpoint is queried");
  for (const flag of ["{}", '{"HasValidCreditCard":"false"}', "null"]) {
    const unknown = await run({ "GET /api/v1/Account/GetAssetsOverview": ok(flag) });
    assert.deepEqual(unknown.output!.products.map(({ status }) => status), ["success", "failed"], `${flag} is not a no-card signal`);
  }
});

test("a card failure fails only the card product, before its write", async () => {
  const cases: Record<string, Record<string, FakeRoute>> = {
    "RemainingDue NA has no documented meaning": { "GET /api/v1/CreditCard/GetRemainingDue": ok('{"RemainingDue":"NA"}') },
    "unrecognized RemainingDue text": { "GET /api/v1/CreditCard/GetRemainingDue": ok('{"RemainingDue":"處理中"}') },
    "a missing AvailableCredit operand": { "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ AvailableCredit: undefined })) },
    "a blank CurrentCredit operand": { "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ CurrentCredit: '""' })) },
    "a malformed AvailableCredit": { "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ AvailableCredit: '"1.2.3"' })) },
    "a malformed history StatementBalance": { "GET /api/v1/CreditCard/GetBillingHistory": ok('{"Bills":[{"Year":115,"Month":10,"StatementBalance":"NA"}]}') },
    "a currency field without an ISO code": { "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ CurrencyCode: '""' })) },
    "a missing card list": { "GET /api/v1/CreditCard/GetMyCreditCardsInformation": ok("{}") },
    "a missing billing history list": { "GET /api/v1/CreditCard/GetBillingHistory": ok("{}") },
    "a card without four digits": { "GET /api/v1/CreditCard/GetMyCreditCardsInformation": ok('{"CreditCardList":[{"CardNumber":"****"}]}') },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const result = await run(overrides);
    assert.equal(result.error, null, name);
    assert.deepEqual(result.output!.products.map(({ typeId, status, errorCode }) => [typeId, status, errorCode]), [
      ["deposit", "success", undefined],
      ["credit_card", "failed", "source-validation-failed"],
    ], name);
    assert.deepEqual(result.writes.map((write) => write.product), ["deposit"], `${name} writes no credit rows and keeps the deposit write`);
  }
  const missing = await cardsOnly({ "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ AvailableCredit: undefined })) });
  assert.match(String((missing.error as Error).message), /AvailableCredit is missing/u);
  const currency = await cardsOnly({ "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ CurrencyCode: '""' })) });
  assert.match(String((currency.error as Error).message), /missing-currency/u);
  const malformed = await cardsOnly({ "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ AvailableCredit: '"1.2.3"' })) });
  assert.match(String((malformed.error as Error).message), /malformed-amount/u);
});

test("a deposit failure leaves the card product's write in place", async () => {
  const result = await run({ "GET /api/v1/Account/FetchTransactionDetails": () => jsonResponse(page([row("2026/10/04", "1")], 1, 5)) });
  assert.deepEqual(result.output!.products.map(({ typeId, status, errorCode }) => [typeId, status, errorCode]), [
    ["deposit", "failed", "source-collection-failed"],
    ["credit_card", "success", undefined],
  ]);
  assert.deepEqual(result.writes.map((write) => write.product), ["credit_card"]);
});

test("a statement is written only with a dated due date and a matching history month", async () => {
  const cases: Record<string, Record<string, FakeRoute>> = {
    "a status-text due date": { "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ PaymentDueDate: '"已繳清"' })) },
    "no statement month": { "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ StatementMonth: '""' })) },
    "no history bill for the statement month": { "GET /api/v1/CreditCard/GetBillingHistory": ok('{"Bills":[{"Year":115,"Month":9,"StatementBalance":5000}]}') },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const { writes, output } = await cardsOnly(overrides);
    assert.equal(output!.products[1]!.status, "success", name);
    const [account] = creditCollection(writes[0]!).accounts;
    assert.deepEqual(account!.statements, [], `${name} writes no statement`);
    assert.equal(account!.balances.length, 1, `${name} still writes the used credit`);
  }
  const blank = await cardsOnly({ "GET /api/v1/CreditCard/GetSummary": ok(cardSummary({ CurrentStatementBalance: '""', ClosingDate: '"31"' })) });
  const [statement] = creditCollection(blank.writes[0]!).accounts[0]!.statements;
  assert.equal(statement!.amount, "9876", "a blank summary amount falls back to the history bill");
  assert.deepEqual([statement!.cycleStart, statement!.closingDate], ["2026-10-01", "2026-10-31"], "a day-31 closing clamps to month end");
});

test("decimalDifference subtracts exact lexemes without rounding", () => {
  assert.equal(decimalDifference("100000", "87654.50"), "12345.50");
  assert.equal(decimalDifference("100", "100.25"), "-0.25");
  assert.equal(decimalDifference("0.1", "0.3"), "-0.2");
  assert.equal(decimalDifference("-5", "-5"), "0");
});
