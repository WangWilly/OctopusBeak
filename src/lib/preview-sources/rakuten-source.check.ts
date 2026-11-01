import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewProduct } from "../../ledger/pglite/preview-financial-data.ts";
import { blankPng, depositCollection, productCollections, runPreviewSource, scriptedOcrEngine } from "./preview-source-harness.ts";
import { calibratedCaptchaSolver, RAKUTEN_CAPTCHA_FAMILY } from "./preview-captcha.ts";
import { createRakutenSource, playwrightRakutenPage, type RakutenCapture, type RakutenPage, type RakutenPageOpener, type RakutenSignInOutcome } from "./rakuten-source.ts";
import { PreviewSourceFailure } from "./source-kit.ts";

const credentials = {
  PREVIEW_RAKUTEN_DEPOSIT_ID_NUMBER: "A000000001",
  PREVIEW_RAKUTEN_DEPOSIT_USER_ID: "user01",
  PREVIEW_RAKUTEN_DEPOSIT_PASSWORD: "secret-pass",
};

const row = (pk: string, amt: string, extra = "") =>
  `{"sysDate":"2026/10/03","sysTime":"09:15","amtSign":true,"amt":${amt},"txDesc":"跨行轉入","memo":"薪資","pk":"${pk}"${extra}}`;

const month = (rows: readonly string[], display = '{"dataEnd":true,"dataLimit":false,"noData":false}', extra = "") =>
  `{"statusCode":"0000","rsData":{"display":${display},"queryAccountNo":"RK-7788","accounts":[{"acctNo":"RK-7788","balance":1234.50}${extra}],"txDetails":[${rows.join(",")}]}}`;

const PK = { a: "20261003091500001", b: "20261003091500002", c: "20260915120000003" } as const;

// Derived, unverified: no live CLNQU0001 sample exists. Field names follow all-set-tw's Rakuten parser
// (commit d217135); the home page summary carries only marketingName and remainLoanAmount.
const loanEntry = (fields: Readonly<Record<string, string | number>> = {}) => JSON.stringify({
  loanAcctNo: "880-012345", marketingName: "樂天信貸", remainLoanAmount: 182345, initLoanAmount: 300000,
  currentRate: 2.06, initPeriod: 84, remainPeriod: 60, monthlyPayDay: "20", nextRepaymentDate: "2026/11/05",
  nextRepaymentAmount: 4120, lastDrawdownDate: "2024/11/05", currency: "TWD", ...fields,
});

const loanPage = (entries: readonly string[], field = "loanProjects") => `{"statusCode":"0000","rsData":{"${field}":[${entries.join(",")}]}}`;
const SUMMARY = loanPage(['{"marketingName":"樂天信貸","remainLoanAmount":999}']);

type Script = Readonly<{
  signIn?: RakutenSignInOutcome;
  months?: readonly string[];
  loans?: readonly string[];
  image?: Buffer;
}>;

function fakePage(script: Script = {}) {
  const calls: string[] = [];
  let opens = 0;
  const months = script.months ?? [
    month([row(PK.a, "1234.50"), row(PK.b, '"1,000"', ',"currency":"USD"')]),
    month([row(PK.c, "200")]),
    month([], '{"dataEnd":false,"dataLimit":false,"noData":true}'),
  ];
  const page: RakutenPage = {
    async captchaImage() { calls.push("captcha"); return script.image ?? blankPng(152, 60); },
    async signIn(input) { calls.push(`signIn:${input.idNumber}:${input.captcha}`); return script.signIn ?? { kind: "signed-in" }; },
    async depositMonth(back): Promise<RakutenCapture> {
      calls.push(`month:${back}`);
      return {
        endpoint: back === 0 ? "/ixtein/adapters/ebank/txns/channel-ctw/CTWQU0001/010" : "/ixtein/adapters/ebank/txns/channel-ctw/CTWQU0001/011",
        status: 200,
        date: back === 0 ? "Thu, 15 Oct 2026 01:59:00 GMT" : null,
        text: months[back]!,
      };
    },
    async loanOverview() {
      calls.push("loans");
      return (script.loans ?? [SUMMARY, loanPage([loanEntry()])]).map((text, index) => ({
        endpoint: "/ixtein/adapters/ebank/txns/channel-cln/CLNQU0001/010",
        status: 200,
        date: index === 0 ? null : "Thu, 15 Oct 2026 01:58:00 GMT",
        text,
      }));
    },
    async signOut() { calls.push("signOut"); },
  };
  const opener: RakutenPageOpener = async (_context, _url, use) => { opens += 1; return use(page); };
  return { opener, calls, opens: () => opens };
}

const solveCaptcha = async () => "AB12";

test("Rakuten reports undecodable CAPTCHA media as a typed source failure before OCR or sign-in", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const startUrl = "https://rakuten-fixture.invalid/";
  try {
    for (const bytes of [Buffer.from("invalid-image-fixture"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])]) {
      const page = await browser.newPage();
      const requests: string[] = [];
      let solverCalled = false;
      await page.route("**/*", async (route) => {
        requests.push(route.request().url());
        if (route.request().url() !== startUrl) return route.abort();
        await route.fulfill({ status: 200, contentType: "text/html", body: `<input id="captcha">
          <div class="pic_veri"><captcha-image><img style="width:152px;height:60px" src="data:image/jpeg;base64,${bytes.toString("base64")}"></captcha-image></div>` });
      });
      try {
        const source = createRakutenSource({
          page: (context, _url, use) => playwrightRakutenPage({ ...context, browser: { withPage: (run) => run(page) } }, startUrl, use),
          solveCaptcha: async () => { solverCalled = true; return "AB12"; },
        });
        const result = await runPreviewSource(source, credentials);
        assert.ok(result.error instanceof PreviewSourceFailure);
        assert.equal(result.error.reason, "unexpected-response");
        assert.match(result.error.message, /the CAPTCHA is not a decodable image/u);
        assert.equal(result.errorCode, "source-validation-failed");
        assert.equal(solverCalled, false);
        assert.deepEqual(requests, [startUrl], "no sign-in request leaves the fixture page");
        assert.equal(result.writes.length, 0);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

async function run(script: Script = {}, products: readonly PreviewProduct[] = ["deposit"]) {
  const fake = fakePage(script);
  const result = await runPreviewSource(createRakutenSource({ page: fake.opener, solveCaptcha }), credentials, undefined, products);
  return { ...result, fake };
}

const outcomes = (output: { products: readonly { typeId: string; status: string; errorCode?: string }[] } | null) =>
  output?.products.map(({ typeId, status, errorCode }) => errorCode ? `${typeId}:${status}:${errorCode}` : `${typeId}:${status}`);

test("Rakuten loans come from the loan page's full CLNQU0001 answer, keyed by the full number and labelled with its last four", async () => {
  const { writes, observations, output, fake } = await run({}, ["deposit", "loan"]);
  assert.deepEqual(outcomes(output), ["deposit:success", "loan:success"]);
  assert.deepEqual(fake.calls, ["captcha", "signIn:A000000001:AB12", "month:0", "month:1", "month:2", "loans", "signOut"]);
  const [collection] = productCollections(writes, "loan");
  assert.deepEqual(collection, {
    collectedAt: "2026-10-15T02:00:00.000Z",
    completeness: "unproven",
    loans: [{
      sourceAccountKey: "880012345",
      displayLabel: "樂天國際銀行 樂天信貸 2345",
      currency: "TWD",
      category: null,
      outstandingBalance: { amount: "182345", observedAt: { at: "2026-10-15T01:58:00.000Z", source: "reported" } },
      originalAmount: "300000",
      interestRate: "2.06",
      paymentAmount: "4120",
      nextPaymentDate: "2026-11-05",
      installmentsPaid: 24,
      installmentsTotal: 84,
      openedOn: null,
      maturityDate: null,
    }],
  }, "the home page summary is ignored, installments paid is initPeriod minus remainPeriod, and lastDrawdownDate and monthlyPayDay are not used");
  assert.equal(observations.filter((entry) => entry.endpoint.includes("CLNQU0001")).length, 2, "both loan captures are observed");
});

test("Rakuten loan terms the source does not report stay null, and loanList is read when loanProjects is absent", async () => {
  const sparse = JSON.stringify({ loanAcctNo: "880012345", remainLoanAmount: "1,000", initPeriod: "84", remainPeriod: "", currency: "NTD" });
  const { writes } = await run({ loans: [loanPage([sparse], "loanList")] }, ["loan"]);
  const [loan] = productCollections(writes, "loan")[0]!.loans;
  assert.deepEqual(loan, {
    sourceAccountKey: "880012345", displayLabel: "樂天國際銀行 貸款 2345", currency: "TWD", category: null,
    outstandingBalance: { amount: "1000", observedAt: { at: "2026-10-15T02:00:00.000Z", source: "collection-time" } },
    originalAmount: null, interestRate: null, paymentAmount: null, nextPaymentDate: null,
    installmentsPaid: null, installmentsTotal: 84, openedOn: null, maturityDate: null,
  });
});

test("a Rakuten loan failure fails only the loan product and keeps the deposit", async () => {
  const cases: Readonly<Record<string, readonly [readonly string[], string]>> = {
    "no currency": [[loanPage([loanEntry().replace(',"currency":"TWD"', "")])], "source-validation-failed"],
    "a masked loan number": [[loanPage([loanEntry({ loanAcctNo: "880****45" })])], "source-validation-failed"],
    "no loan number": [[loanPage([loanEntry().replace('"loanAcctNo":"880-012345",', "")])], "source-validation-failed"],
    "only the home page summary": [[SUMMARY, SUMMARY], "source-collection-failed"],
    "no capture": [[], "source-validation-failed"],
    "a failed statusCode": [[loanPage([loanEntry()]).replace('"0000"', '"E001"')], "source-validation-failed"],
    "more remaining than total periods": [[loanPage([loanEntry({ remainPeriod: 90 })])], "source-validation-failed"],
  };
  for (const [name, [loans, code]] of Object.entries(cases)) {
    const result = await run({ loans }, ["deposit", "loan"]);
    assert.deepEqual(outcomes(result.output), ["deposit:success", `loan:failed:${code}`], name);
    assert.deepEqual(result.writes.map((write) => write.product), ["deposit"], `${name} writes no loan list`);
  }
});

test("a Rakuten loan page that lists nothing writes an empty unproven list", async () => {
  const { writes, output, fake } = await run({ loans: [loanPage([]), loanPage([])] }, ["loan"]);
  assert.deepEqual(outcomes(output), ["deposit:skipped", "loan:not_held"]);
  assert.deepEqual(productCollections(writes, "loan"), [{ collectedAt: "2026-10-15T02:00:00.000Z", completeness: "unproven", loans: [] }]);
  assert.ok(!fake.calls.some((call) => call.startsWith("month:")), "an unselected deposit is not read");
});

test("a Rakuten run writes the NT-dollar demand deposit with exact amounts, pk row keys, and per-row currency", async () => {
  const { receipt, writes, observations, fake } = await run();
  assert.deepEqual(receipt, { accounts: 1, balances: 1, transactions: 3, statements: 0, closedAccounts: 0 });
  const [deposit] = depositCollection(writes[0]!).accounts;
  assert.equal(deposit!.sourceAccountKey, "twd-demand:RK7788");
  assert.deepEqual(deposit!.balances, [
    { kind: "current", amount: "1234.50", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } },
  ], "the JSON number lexeme survives, TWD comes from the CTWQU0001 endpoint, and the HTTP Date is the as-of time");
  assert.deepEqual(deposit!.transactions.map(({ sourceRowKey, amount, currency, direction, postedAt, description }) =>
    ({ sourceRowKey, amount, currency, direction, postedAt, description })), [
    { sourceRowKey: PK.a, amount: "1234.50", currency: "TWD", direction: "unknown", postedAt: { precision: "minute", value: "2026-10-03T09:15" }, description: "跨行轉入 · 薪資" },
    { sourceRowKey: PK.b, amount: "1000", currency: "USD", direction: "unknown", postedAt: { precision: "minute", value: "2026-10-03T09:15" }, description: "跨行轉入 · 薪資" },
    { sourceRowKey: PK.c, amount: "200", currency: "TWD", direction: "unknown", postedAt: { precision: "minute", value: "2026-10-03T09:15" }, description: "跨行轉入 · 薪資" },
  ], "amtSign has no confirmed meaning, so the direction stays unknown");
  assert.deepEqual(fake.calls, ["captcha", "signIn:A000000001:AB12", "month:0", "month:1", "month:2", "signOut"]);
  assert.equal(observations.length, 3, "every decrypted response is observed");
  assert.ok(observations.every((entry) => entry.status === 200 && entry.endpoint.includes("CTWQU0001")));
});

test("a month that reports dataLimit or lacks dataEnd true fails instead of truncating", async () => {
  const cases = {
    dataLimit: '{"dataEnd":true,"dataLimit":true,"noData":false}',
    "dataEnd false": '{"dataEnd":false,"dataLimit":false,"noData":false}',
    "dataEnd missing": '{"dataLimit":false,"noData":false}',
  };
  for (const [name, display] of Object.entries(cases)) {
    const result = await run({ months: [month([row(PK.a, "1")]), month([row(PK.c, "1")], display), month([])] });
    assert.equal(result.errorCode, "source-collection-failed", name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.equal(result.observations.length, 3, `${name} keeps observed responses for a structure report`);
  }
});

test("a non-ISO currency and a malformed amount are refused before write", async () => {
  const currency = await run({ months: [month([row(PK.a, "1", ',"currency":""')]), month([]), month([])] });
  assert.equal(currency.errorCode, "source-validation-failed");
  assert.match(String(currency.error), /missing-currency/u);
  assert.equal(currency.writes.length, 0);
  const amount = await run({ months: [month([row(PK.a, '"1.2.3"')]), month([]), month([])] });
  assert.equal(amount.errorCode, "source-validation-failed");
  assert.match(String(amount.error), /malformed-amount/u);
  assert.equal(amount.writes.length, 0);
});

test("a pk that repeats with different content fails, and an identical repeat is kept once", async () => {
  const conflict = await run({ months: [month([row(PK.a, "1")]), month([row(PK.a, "2")]), month([])] });
  assert.equal(conflict.errorCode, "source-validation-failed");
  assert.equal(conflict.writes.length, 0);
  const repeat = await run({ months: [month([row(PK.a, "1")]), month([row(PK.a, "1")]), month([])] });
  assert.equal(depositCollection(repeat.writes[0]!).accounts[0]!.transactions.length, 1);
});

test("the default calibrated solver refuses an unsupported capture before sign-in", async () => {
  const fake = fakePage({ image: blankPng(151, 60) });
  const result = await runPreviewSource(createRakutenSource({ page: fake.opener }), credentials);
  assert.equal(result.errorCode, "verification-configuration-failed");
  assert.equal(fake.opens(), 1);
  assert.deepEqual(fake.calls, ["captcha"]);
  assert.ok(result.events.some((event) => event.code === "solver-challenge-unsupported"));
});

test("Rakuten signs in only on calibrated agreement and submits nothing on disagreement", async () => {
  for (const [other, accepted] of [["AB29", true], ["AB28", false], ["", false]] as const) {
    const fake = fakePage();
    const engine = scriptedOcrEngine([{ text: "AB29", confidence: 1 }, { text: other, confidence: 1 }]);
    const result = await runPreviewSource(createRakutenSource({ page: fake.opener,
      solveCaptcha: calibratedCaptchaSolver(RAKUTEN_CAPTCHA_FAMILY, engine) }), credentials);
    assert.equal(fake.calls.filter((c) => c.startsWith("signIn:")).length, accepted ? 1 : 0);
    if (!accepted) {
      assert.equal(result.errorCode, "verification-failed");
      assert.equal(result.writes.length, 0);
    }
  }
});

test("sign-in refusals are typed and collect nothing", async () => {
  const outcomes = {
    "身分證字號、使用者代號或密碼錯誤": "authentication-failed",
    "圖形驗證碼錯誤": "verification-failed",
    "您已在其他裝置登入": "authentication-failed",
    "請進行簡訊 OTP 驗證": "device-registration-required",
  };
  for (const [message, errorCode] of Object.entries(outcomes)) {
    const result = await run({ signIn: { kind: "refused", message } });
    assert.equal(result.errorCode, errorCode, message);
    assert.ok(!result.fake.calls.some((call) => call.startsWith("month:")), `${message} collects nothing`);
  }
  assert.equal((await run({ signIn: { kind: "no-outcome" } })).errorCode, "source-validation-failed");
});

test("a failed statusCode or a month for another account fails before write", async () => {
  const status = await run({ months: [month([]).replace('"0000"', '"E001"'), month([]), month([])] });
  assert.equal(status.errorCode, "source-validation-failed");
  assert.equal(status.writes.length, 0);
  const other = await run({ months: [month([]), month([]).replaceAll("RK-7788", "RK-9900"), month([])] });
  assert.equal(other.errorCode, "source-validation-failed");
  assert.equal(other.writes.length, 0);
  assert.ok(other.fake.calls.includes("signOut"), "the session is signed out after a failed collection");
});
