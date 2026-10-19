import assert from "node:assert/strict";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import test from "node:test";
import type { PreviewCreditCollection } from "../../ledger/pglite/preview-financial-data.ts";
import { parsePreviewCreditCollection } from "../../ledger/pglite/preview-credit.ts";
import type { PreviewHttpRequest } from "./browser-http.ts";
import { CTBC_APP_VERSION, createCtbcCardSource, encryptCtbcPin } from "./ctbc-card-source.ts";
import { fakeHttpOpener, jsonResponse, runPreviewSource, type FakeRoute } from "./preview-source-harness.ts";

const credentials = {
  PREVIEW_CTBC_CREDIT_CARD_ID_NUMBER: "A000000001",
  PREVIEW_CTBC_CREDIT_CARD_USER_CODE: "user01",
  PREVIEW_CTBC_CREDIT_CARD_PASSWORD: "secret-pass",
};

const ok = (rsData: unknown, extra: Record<string, unknown> = {}) => ({ code: "0000", statusCode: "0000", success: true, rsData, ...extra });

type Summary = Record<string, unknown>;

function billsBody(options: Readonly<{ twd?: Summary; usd?: Summary; billed?: unknown[]; cards?: unknown }> = {}) {
  return ok({
    cardDataList: options.cards ?? [
      { cardNoSuffixFour: "1111", cardName: "LINE Pay卡", positiveOrAttached: "正卡" },
      { cardNo: "************2222", cardName: "英雄聯盟卡", positiveOrAttached: "附卡" },
    ],
    billData: {
      TWD: {
        "202608": { summary: { billDt: "081526", pmtExpDt: "090326", billAmt: "8000", pmtAmt: "8000", adjust: "0", minPmtAmt: "800" }, bills: [] },
        "202609": {
          summary: { billDt: "091526", pmtExpDt: "100326", billAmt: "12,000", pmtAmt: "2000", adjust: "0", minPmtAmt: "1200", currPmtAmt: "10000", ...options.twd },
          bills: options.billed ?? [
            { purchaseDt: "090126", postingDt: "090326", description: "全聯", ntAmt: "500", cardNoSuffixFour: "1111", authCode: "A11111" },
            { purchaseDt: "000000", postingDt: "091026", description: "繳款", ntAmt: "-8000" },
          ],
        },
      },
      USD: {
        "202609": {
          summary: { billDt: "091526", pmtExpDt: "繳款截止", billAmt: "-12.50", pmtAmt: "0", adjust: "0", ...options.usd },
          bills: [{ purchaseDt: "090526", postingDt: "090726", description: "AMAZON", foreignAmt: "25.00", ntAmt: "800", cardNoSuffixFour: "2222", authCode: "000000" }],
        },
      },
    },
  });
}

const UNBILLED_TWD = [
  { purchaseDt: "20261002", postingDt: "20261004", description: "誠品", purchaseAmt: "1,234.5", cardNoSuffixFour: "1111", authCode: "B22222" },
  { purchaseDt: "20261005", postingDt: "20261006", description: "退貨", purchaseAmt: "-200", cardNoSuffixFour: "1111" },
];

const REALTIME = [
  { txnDate: "20261014", txnDateTime: "2026/10/14 12:30:45", txnAmt: "300", merchName: "7-ELEVEN", cardNoSuffixFour: "1111", authCode: "C33333" },
  { txnDate: "20261015", txnAmt: "88", merchName: "UBER", cardNo: "****3333" },
];

type Envelope = Readonly<{ resource?: string; rqData: Record<string, unknown>; token?: string; appVer: string }>;
type ResourceRoute = (envelope: Envelope) => unknown;

const envelopeOf = (request: PreviewHttpRequest) => JSON.parse(request.body!) as Envelope;

function resources(overrides: Readonly<Record<string, ResourceRoute>> = {}): FakeRoute {
  let unbilledCurrency = "";
  const routes: Record<string, ResourceRoute> = {
    handshake: () => ({ success: true, appVersionValidate: 0, serverTime: 1, rsData: { seed: "" } }),
    "/twrbm-general/ot001/010": () => ok({}, { token: "t-login" }),
    "/twrbm-general/ot002/010": () => ok({}),
    "/twrbm-card/qu002/010": () => billsBody(),
    "/twrbm-card/qu046/010": () => ok({ ignored: "summary" }),
    "/twrbm-card/qu006/010": () => ok({ curOptions: [{ curCode: "NTD" }, { curCode: "USD" }] }),
    "/twrbm-card/qu006/011": ({ rqData }) => {
      unbilledCurrency = String(rqData.curCode);
      return unbilledCurrency === "TWD"
        ? ok({ allItems: [UNBILLED_TWD[0]], displayPaging: "Y", pageCount: 1, totalRow: 2 })
        : ok({ allItems: [], displayPaging: false });
    },
    "/twrbm-card/qu006/015": ({ rqData }) => {
      assert.equal(unbilledCurrency, "TWD");
      assert.deepEqual(rqData, { pageNum: 2 });
      return ok({ allItems: [UNBILLED_TWD[1]] });
    },
    "/twrbm-card/qu041/010": () => ok({ allItems: REALTIME, displayPaging: false, totalRow: 2 }),
    ...overrides,
  };
  return (request) => {
    const envelope = envelopeOf(request);
    const route = routes[envelope.resource ?? "handshake"];
    if (!route) throw new Error(`Unrouted CTBC resource: ${envelope.resource}`);
    return jsonResponse(route(envelope), { date: "Thu, 15 Oct 2026 01:59:00 GMT" });
  };
}

function routes(overrides: Readonly<Record<string, ResourceRoute>> = {}): Record<string, FakeRoute> {
  return {
    "POST /IMP/oauth/token": () => jsonResponse({ access_token: "access-1", expires_in: 3600, scope: "PUBLIC", token_type: "Bearer" }),
    "POST /IMP/main/init": () => jsonResponse({ statusCode: "0000", statusDesc: "" }),
    "POST /IMP/api/adapters/EBMW_Adapter/resource/ebmwResource": resources(overrides),
  };
}

async function run(overrides: Readonly<Record<string, ResourceRoute>> = {}, products?: readonly "credit_card"[]) {
  const http = fakeHttpOpener(routes(overrides));
  const result = await runPreviewSource(createCtbcCardSource({ http }), credentials, undefined, products);
  const sent = http.requests.filter((request) => request.url.endsWith("/ebmwResource")).map((request) => envelopeOf(request).resource ?? "handshake");
  return { ...result, http, sent };
}

function credit(writes: Awaited<ReturnType<typeof run>>["writes"]): PreviewCreditCollection {
  assert.equal(writes.length, 1);
  const write = writes[0]!;
  if (write.product !== "credit_card") throw new Error(`expected a credit write, got ${write.product}`);
  return parsePreviewCreditCollection(write.collection);
}

const failsBeforeWrite = (result: Awaited<ReturnType<typeof run>>, reason: RegExp, message: string) => {
  assert.equal(result.writes.length, 0, `${message}: nothing is written`);
  assert.match(String(result.error), reason, message);
  assert.ok(result.sent.includes("/twrbm-general/ot002/010"), `${message}: the session is still signed out`);
};

test("a CTBC run writes each card currency with its cards, used credit, statements, and purchases", async () => {
  const { writes, output, observations, sent } = await run();
  assert.deepEqual(output?.products.map(({ typeId, status }) => ({ typeId, status })), [{ typeId: "credit_card", status: "success" }]);
  const collection = credit(writes);
  assert.deepEqual(collection.accounts.map((account) => account.sourceAccountKey), ["TWD", "USD"]);
  const [twd, usd] = collection.accounts;
  assert.deepEqual(twd!.cards, [
    { sourceCardKey: "card-1111", cardMask: "****-1111", displayLabel: "LINE Pay卡 正卡" },
    { sourceCardKey: "card-2222", cardMask: "****-2222", displayLabel: "英雄聯盟卡 附卡" },
    { sourceCardKey: "card-3333", cardMask: "****-3333", displayLabel: null },
  ], "a card named only by a purchase still gets a card row");
  const asOf = { at: "2026-10-15T01:59:00.000Z", source: "reported" };
  assert.deepEqual(twd!.balances, [{
    amount: "11034.5",
    currency: "TWD",
    observedAt: asOf,
    basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "12000", paidAmount: "2000", unbilledAmount: "1034.5" },
  }], "used credit is billAmt minus pmtAmt plus the exact sum of the unbilled rows");
  assert.deepEqual(usd!.balances, [{
    amount: "-12.50",
    currency: "USD",
    observedAt: asOf,
    basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: "-12.50", paidAmount: "0", unbilledAmount: "0" },
  }], "an overpaid card stays negative, and an offered currency with no unbilled rows adds zero");

  assert.deepEqual(twd!.statements.map(({ statementKey, cycleStart, cycleEnd, closingDate, dueDate, amount, minimumPayment, paidAmount, paid }) =>
    ({ statementKey, cycleStart, cycleEnd, closingDate, dueDate, amount, minimumPayment, paidAmount, paid })), [
    { statementKey: "2026-08", cycleStart: "2026-07-16", cycleEnd: "2026-08-15", closingDate: "2026-08-15", dueDate: "2026-09-03", amount: "8000", minimumPayment: "800", paidAmount: "8000", paid: null },
    { statementKey: "2026-09", cycleStart: "2026-08-16", cycleEnd: "2026-09-15", closingDate: "2026-09-15", dueDate: "2026-10-03", amount: "12000", minimumPayment: "1200", paidAmount: "2000", paid: null },
  ]);
  assert.deepEqual(usd!.statements, [], "a due date given only as status text means the statement is not written");

  const purchase = (rows: typeof twd.purchases) => rows.map(({ amount, direction, posting, consumedAt, sourceCardKey, statementKey, bankReference, description }) =>
    ({ amount, direction, posting, consumedAt: consumedAt.value, sourceCardKey, statementKey, bankReference, description }));
  assert.deepEqual(purchase(twd!.purchases), [
    { amount: "500", direction: "outflow", posting: { status: "posted", billing: "billed", postingDate: "2026-09-03" }, consumedAt: "2026-09-01", sourceCardKey: "card-1111", statementKey: "2026-09", bankReference: "A11111", description: "全聯" },
    { amount: "-8000", direction: "inflow", posting: { status: "posted", billing: "billed", postingDate: "2026-09-10" }, consumedAt: "2026-09-10", sourceCardKey: null, statementKey: "2026-09", bankReference: null, description: "繳款" },
    { amount: "1234.5", direction: "outflow", posting: { status: "posted", billing: "unbilled", postingDate: "2026-10-04" }, consumedAt: "2026-10-02", sourceCardKey: "card-1111", statementKey: null, bankReference: "B22222", description: "誠品" },
    { amount: "-200", direction: "inflow", posting: { status: "posted", billing: "unbilled", postingDate: "2026-10-06" }, consumedAt: "2026-10-05", sourceCardKey: "card-1111", statementKey: null, bankReference: null, description: "退貨" },
    { amount: "300", direction: "outflow", posting: { status: "pending" }, consumedAt: "2026-10-14T12:30:45", sourceCardKey: "card-1111", statementKey: null, bankReference: "C33333", description: "7-ELEVEN" },
    { amount: "88", direction: "outflow", posting: { status: "pending" }, consumedAt: "2026-10-15", sourceCardKey: "card-3333", statementKey: null, bankReference: null, description: "UBER" },
  ], "the authorization code is the bank reference on pending and posted rows, and a direction follows the sign only because both signs occur");
  assert.deepEqual(purchase(usd!.purchases), [
    { amount: "25.00", direction: "outflow", posting: { status: "posted", billing: "billed", postingDate: "2026-09-07" }, consumedAt: "2026-09-05", sourceCardKey: "card-2222", statementKey: "2026-09", bankReference: null, description: "AMAZON" },
  ], "a foreign bill row keeps its foreign amount, and an all-zero authorization code is no reference");
  assert.equal(new Set(twd!.purchases.map((row) => row.sourceRowKey)).size, 6);

  assert.deepEqual(observations.map((entry) => entry.endpoint), [
    "oauth/token", "main/init", "ebmwResource handshakewb",
    "/twrbm-general/ot001/010", "/twrbm-card/qu002/010", "/twrbm-card/qu046/010", "/twrbm-card/qu006/010",
    "/twrbm-card/qu006/011", "/twrbm-card/qu006/015", "/twrbm-card/qu006/011", "/twrbm-card/qu041/010", "/twrbm-general/ot002/010",
  ], "observe() saw every response");
  assert.equal(sent.at(-1), "/twrbm-general/ot002/010", "the run signs out");
});

test("the CTBC client sends the pinned App envelope, signs each body, and encrypts both sign-in secrets", async () => {
  const { http } = await run();
  const resourceRequests = http.requests.filter((request) => request.url.endsWith("/ebmwResource"));
  for (const request of resourceRequests) {
    assert.equal(request.headers!.checksum, createHash("sha256").update(request.body!, "utf8").digest("hex"));
    assert.equal(request.headers!.Origin, undefined, "the native App sends no Origin");
    assert.equal(envelopeOf(request).appVer, CTBC_APP_VERSION);
  }
  const login = resourceRequests.find((request) => envelopeOf(request).resource === "/twrbm-general/ot001/010")!;
  assert.equal(login.headers!["X-Request-Type"], "preLogin");
  const rqData = envelopeOf(login).rqData;
  assert.equal(rqData.custId, "A000000001");
  assert.equal(rqData.version, CTBC_APP_VERSION);
  assert.equal(rqData.twoStageVerify, true);
  assert.equal(rqData.dupLoginCheckTimestamp, undefined);
  for (const secret of [rqData.userId, rqData.pin]) {
    assert.match(String(secret), /^[0-9a-f]+\|[0-9a-f]{512}$/u);
    assert.doesNotMatch(String(secret), /user01|secret-pass/u);
  }
  const query = resourceRequests.find((request) => envelopeOf(request).resource === "/twrbm-card/qu002/010")!;
  assert.equal(query.headers!["X-Request-Type"], undefined, "queries after sign-in are not pre-login");
  assert.equal(envelopeOf(query).token, "t-login", "the transaction token from sign-in is carried forward");
});

test("encryptCtbcPin XORs the value with random digits and seals it with AES-CBC under a PBKDF2 key", () => {
  let counter = 0;
  const random = (size: number) => Buffer.from(Array.from({ length: size }, () => (counter += 7) % 256));
  const sealed = encryptCtbcPin("ab1", random);
  counter = 0;
  const xorKey = [...random(3)].map((byte) => String(byte % 10)).join("");
  const password = [...random(10)].map((byte) => String(byte % 10)).join("");
  const key = pbkdf2Sync(password, random(16), 1, 32, "sha1");
  const decipher = createDecipheriv("aes-256-cbc", key, Buffer.alloc(16));
  const clear = Buffer.concat([decipher.update(Buffer.from(sealed.split("|")[0]!, "hex")), decipher.final()]).toString("utf8");
  assert.equal(clear.slice(0, 2), "03");
  assert.equal(clear.slice(2, 5), xorKey);
  const xorText = clear.slice(5);
  assert.equal([...xorText].map((char, index) => String.fromCharCode(char.charCodeAt(0) ^ xorKey.charCodeAt(index))).join(""), "ab1");
  assert.equal(sealed.split("|")[1]!.length, 512);
});

test("a handshake that rejects the pinned App version ends the run as provider-protocol-outdated before sign-in", async () => {
  const result = await run({ handshake: () => ({ success: true, appVersionValidate: 2, rsData: {} }) });
  assert.equal(result.errorCode, "provider-protocol-outdated");
  assert.deepEqual(result.sent, ["handshake"], "no credentials are sent");
  const prompt = await run({ "/twrbm-general/ot001/010": () => ({ code: "9999", desc: "請更新至最新版本後再使用" }) });
  assert.equal(prompt.errorCode, "provider-protocol-outdated", "an update prompt on sign-in is a protocol change too");
});

test("another signed-in session stops the run and is never confirmed", async () => {
  const result = await run({ "/twrbm-general/ot001/010": () => ok({ dupLoginCheckTimestamp: "20261015100000" }) });
  assert.equal(result.errorCode, "authentication-failed");
  assert.match(String(result.error), /session-conflict/u);
  assert.deepEqual(result.sent.filter((resource) => resource === "/twrbm-general/ot001/010"), ["/twrbm-general/ot001/010"], "the login is sent once, never with the duplicate-login confirmation");
});

test("two-stage, device, and contact verification end the run as device-registration-required", async () => {
  for (const rsData of [{ isTwoStageLogin: true }, { deviceBindBlackListCheckTimestamp: "x" }, { verifyData: { verify: "21" } }]) {
    const result = await run({ "/twrbm-general/ot001/010": () => ok(rsData) });
    assert.equal(result.errorCode, "device-registration-required", JSON.stringify(rsData));
    assert.equal(result.writes.length, 0);
  }
  const password = await run({ "/twrbm-general/ot001/010": () => ok({ forcePwdChange: "Y" }) });
  assert.equal(password.errorCode, "authentication-failed");
  assert.equal(password.sent.at(-1), "/twrbm-general/ot002/010", "a session that must change its password is signed out");
});

test("a missing currency fails the product before its write", async () => {
  failsBeforeWrite(await run({ "/twrbm-card/qu006/010": () => ok({ curOptions: [{ curCode: "" }] }) }), /missing-currency/u, "an unbilled currency option without a code");
  failsBeforeWrite(await run({ "/twrbm-card/qu002/010": () => ok({ cardDataList: [{ cardNoSuffixFour: "1111" }], billData: { "": {} } }) }), /missing-currency/u, "a bill group without a currency");
  failsBeforeWrite(await run({ "/twrbm-card/qu041/010": () => ok({ allItems: [{ ...REALTIME[1], isDoubleCoinCard: true }] }) }), /missing-currency/u, "a dual-currency authorization without a currency");
});

test("a malformed or zero amount fails the product before its write", async () => {
  failsBeforeWrite(await run({ "/twrbm-card/qu002/010": () => billsBody({ billed: [{ purchaseDt: "090126", ntAmt: "12a", cardNoSuffixFour: "1111" }] }) }), /malformed-amount/u, "a malformed bill row");
  failsBeforeWrite(await run({ "/twrbm-card/qu041/010": () => ok({ allItems: [{ ...REALTIME[0], txnAmt: "0" }] }) }), /malformed-amount/u, "a zero authorization");
});

test("a missing balance operand fails the product instead of writing zero", async () => {
  failsBeforeWrite(await run({ "/twrbm-card/qu002/010": () => billsBody({ twd: { pmtAmt: undefined } }) }), /malformed-amount.*pmtAmt/u, "pmtAmt missing");
  failsBeforeWrite(await run({ "/twrbm-card/qu002/010": () => billsBody({ twd: { billAmt: null } }) }), /malformed-amount.*billAmt/u, "billAmt null");
  failsBeforeWrite(await run({ "/twrbm-card/qu002/010": () => billsBody({ usd: { billAmt: null } }) }), /malformed-amount.*billAmt/u, "billAmt null on a statement that is not written");
  failsBeforeWrite(await run({ "/twrbm-card/qu002/010": () => billsBody({ usd: { adjust: undefined } }) }), /malformed-amount.*adjust/u, "adjust missing");
  failsBeforeWrite(await run({ "/twrbm-card/qu002/010": () => billsBody({ twd: { adjust: "-100" } }) }), /adjust is nonzero/u, "a nonzero adjustment the basis cannot carry");
});

test("an incomplete list fails the product before its write", async () => {
  const short = await run({ "/twrbm-card/qu041/010": () => ok({ allItems: REALTIME, displayPaging: "Y", pageCount: 10, totalRow: 5 }) });
  failsBeforeWrite(short, /incomplete-data/u, "a paged list shorter than its row count");
  assert.equal(short.errorCode, "source-collection-failed");
  failsBeforeWrite(await run({ "/twrbm-card/qu041/010": () => ok({ allItems: REALTIME, totalRow: 3 }) }), /incomplete-data/u, "an unpaged list shorter than its row count");
  failsBeforeWrite(await run({ "/twrbm-card/qu041/010": () => ok({ allItems: [], displayPaging: true, pageCount: 1, totalRow: 21 }) }), /incomplete-data.*21 pages/u, "more pages than the cap");
  failsBeforeWrite(await run({ "/twrbm-card/qu006/011": () => ok({ displayPaging: false }) }), /unexpected-response.*allItems/u, "a list without its items");
});

test("not_held comes only from an explicit no-card message or a complete empty list", async () => {
  const message = await run({ "/twrbm-card/qu002/010": () => ({ code: "1234", message: "1234：您目前尚未持有本行信用卡。" }) });
  assert.deepEqual(message.output?.products.map(({ status }) => status), ["not_held"]);
  assert.equal(message.writes.length, 0);
  assert.ok(!message.sent.includes("/twrbm-card/qu046/010"), "no card means no further card queries");
  const empty = await run({ "/twrbm-card/qu002/010": () => ok({ cardDataList: [], billData: {} }) });
  assert.deepEqual(empty.output?.products.map(({ status }) => status), ["not_held"]);
  failsBeforeWrite(await run({ "/twrbm-card/qu002/010": () => ok({ billData: {} }) }), /unexpected-response.*cardDataList/u, "a missing card list is not evidence");
  const billsOnly = await run({ "/twrbm-card/qu002/010": () => billsBody({ cards: [] }) });
  assert.deepEqual(billsOnly.output?.products.map(({ status }) => status), ["success"], "an empty card list beside bills is not evidence of no card");
  failsBeforeWrite(await run({ "/twrbm-card/qu002/010": () => ({ code: "1234", message: "查無帳單資料" }) }), /unexpected-response/u, "a failure message that does not say no card");
});

test("a card product failure stays a typed product outcome and still signs out; an unselected product sends nothing", async () => {
  const failed = await run({ "/twrbm-card/qu041/010": () => ok({ allItems: [{ ...REALTIME[0], txnAmt: "x" }] }) });
  assert.equal(failed.errorCode, "source-validation-failed");
  assert.equal(failed.writes.length, 0);
  assert.equal(failed.sent.at(-1), "/twrbm-general/ot002/010");
  const unselected = await run({}, []);
  assert.deepEqual(unselected.http.requests, [], "a run with no selected product never signs in");
});

test("a collection with one sign keeps every direction unknown", async () => {
  const result = await run({
    "/twrbm-card/qu002/010": () => billsBody({ billed: [{ purchaseDt: "090126", postingDt: "090326", description: "全聯", ntAmt: "500", cardNoSuffixFour: "1111" }] }),
    "/twrbm-card/qu006/011": ({ rqData }) => ok({ allItems: rqData.curCode === "TWD" ? [UNBILLED_TWD[0]] : [] }),
  });
  const directions = credit(result.writes).accounts.flatMap((account) => account.purchases.map((row) => row.direction));
  assert.equal(directions.length, 5);
  assert.ok(directions.every((direction) => direction === "unknown"), "the sign decides nothing without both signs in the collection");
});
