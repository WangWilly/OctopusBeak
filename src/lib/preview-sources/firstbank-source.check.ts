import assert from "node:assert/strict";
import test from "node:test";
import {
  createFirstbankSource,
  FIRSTBANK_PREVIEW_SOURCE,
  type FirstbankCapture,
  type FirstbankPage,
  type FirstbankPageOpener,
  type FirstbankQueryAccount,
  type FirstbankSignInOutcome,
} from "./firstbank-source.ts";
import { depositCollection, runPreviewSource } from "./preview-source-harness.ts";

const credentials = {
  PREVIEW_FIRSTBANK_DEPOSIT_ID_NUMBER: "A000000001",
  PREVIEW_FIRSTBANK_DEPOSIT_USER_CODE: "user01",
  PREVIEW_FIRSTBANK_DEPOSIT_PASSWORD: "secret-pass",
};

const row = (...cells: readonly string[]) => `<tr class="ResultContent">${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;

const overviewRows = {
  salary: row("活期儲蓄存款", "123-45-678901（薪轉）", "新臺幣", "12,345.50", "12,000.00"),
  dollar: row("外匯活期存款", "123-45-999999", "USD", "812.34", "-"),
  term: row("定期存款", "123-45-555555", "新臺幣", "100,000", "&nbsp;"),
  card: row("VISA金融卡", "123-45-678901", "-", "-", "-"),
};

const overview = (rows: readonly string[] = Object.values(overviewRows), extra = "") =>
  `<html><body>${extra}<table><tr class="ResultHeader"><th>帳戶類別</th><th>帳號(暱稱)</th><th>幣別</th><th>帳面餘額</th><th>可用餘額</th></tr>${rows.join("")}</table></body></html>`;

const historyHeader = "<tr class=\"ResultHeader\"><th>交易日期</th><th>支出金額</th><th>存入金額</th><th>幣別</th><th>餘額</th><th>摘要</th><th>備註</th></tr>";

const history = (account: string, rows: readonly string[], extra = "") =>
  `<html><body><div>帳號：${account}</div>${extra}<table>${historyHeader}${rows.join("")}</table></body></html>`;

const histories = {
  A1: history("123-45-678901", [
    row("115/10/03 09:15:00", "-", "1,000.00", "", "12,345.50", "跨行轉入", "薪資"),
    row("2026/09/20", "250.5", "0", "", "11,345.50", "提款", "&nbsp;"),
  ]),
  A2: history("123-45-999999", [row("2026/10/05", "", "12.30", "美金", "812.34", "外幣轉入", "")]),
} as Record<string, string>;

const QUERY: readonly FirstbankQueryAccount[] = [
  { value: "A1", label: "123-45-678901 薪轉" },
  { value: "A2", label: "123-45-999999" },
];

type Script = Readonly<{
  signIn?: FirstbankSignInOutcome;
  overview?: string;
  query?: readonly FirstbankQueryAccount[];
  histories?: Readonly<Record<string, string>>;
  signOutFails?: boolean;
}>;

function fakePage(script: Script = {}) {
  const calls: string[] = [];
  let opens = 0;
  const capture = (endpoint: string, text: string, date: string | null = null): FirstbankCapture => ({ endpoint, status: 200, date, text });
  const page: FirstbankPage = {
    async captchaImage() { calls.push("captcha"); return Buffer.from("png"); },
    async signIn(input) { calls.push(`signIn:${input.idNumber}:${input.userCode}:${input.captcha}`); return script.signIn ?? { kind: "signed-in" }; },
    async depositOverview() {
      calls.push("overview");
      return capture("/NetBank/ajax/acntReview1.html", script.overview ?? overview(), "Thu, 15 Oct 2026 01:59:00 GMT");
    },
    async queryAccounts() { calls.push("queryAccounts"); return script.query ?? QUERY; },
    async transactions(account, range) {
      calls.push(`transactions:${account.value}:${range.start}-${range.end}`);
      return capture("/NetBank/2/010103.html", (script.histories ?? histories)[account.value]!);
    },
    async signOut() {
      calls.push("signOut");
      if (script.signOutFails) throw new Error("logout failed");
    },
  };
  const opener: FirstbankPageOpener = async (_context, _url, use) => { opens += 1; return use(page); };
  return { opener, calls, opens: () => opens };
}

const solveCaptcha = async () => "1234";

async function run(script: Script = {}) {
  const fake = fakePage(script);
  const result = await runPreviewSource(createFirstbankSource({ page: fake.opener, solveCaptcha }), credentials);
  return { ...result, fake };
}

test("a First Bank run writes each deposit account with exact balances and three months of column-directed transactions", async () => {
  const { receipt, writes, observations, fake } = await run();
  assert.deepEqual(receipt, { accounts: 3, balances: 4, transactions: 3, statements: 0, closedAccounts: 0 });
  const asOf = { at: "2026-10-15T01:59:00.000Z", source: "reported" };
  const [salary, dollar, term] = depositCollection(writes[0]!).accounts;
  assert.deepEqual(
    [salary, dollar, term].map((account) => ({ key: account!.sourceAccountKey, label: account!.displayLabel, currency: account!.currency, balances: account!.balances })),
    [
      {
        key: "demand:12345678901:TWD",
        label: "第一銀行 薪轉 8901",
        currency: "TWD",
        balances: [
          { kind: "current", amount: "12345.50", currency: "TWD", observedAt: asOf },
          { kind: "available", amount: "12000.00", currency: "TWD", observedAt: asOf },
        ],
      },
      { key: "demand:12345999999:USD", label: "第一銀行 存款 9999 USD", currency: "USD", balances: [{ kind: "current", amount: "812.34", currency: "USD", observedAt: asOf }] },
      { key: "term:12345555555:TWD", label: "第一銀行 定存 5555", currency: "TWD", balances: [{ kind: "current", amount: "100000", currency: "TWD", observedAt: asOf }] },
    ],
    "the card row is skipped, the 幣別 cell names the currency, and the HTTP Date is the as-of time",
  );
  assert.deepEqual(salary!.transactions.map(({ amount, currency, direction, postedAt, description }) => ({ amount, currency, direction, postedAt, description })), [
    { amount: "1000.00", currency: "TWD", direction: "inflow", postedAt: { precision: "second", value: "2026-10-03T09:15:00" }, description: "跨行轉入 · 薪資" },
    { amount: "250.5", currency: "TWD", direction: "outflow", postedAt: { precision: "day", value: "2026-09-20" }, description: "提款" },
  ], "the ROC year is converted, and the direction comes from the debit and credit columns");
  assert.match(salary!.transactions[0]!.sourceRowKey, /^2026-10-03:[0-9a-f]{16}:1$/u);
  assert.deepEqual(dollar!.transactions.map(({ amount, currency, direction }) => ({ amount, currency, direction })), [{ amount: "12.30", currency: "USD", direction: "inflow" }]);
  assert.deepEqual(term!.transactions, [], "a time deposit is balance-only");
  assert.deepEqual(fake.calls, [
    "captcha", "signIn:A000000001:user01:1234", "overview", "queryAccounts",
    "transactions:A1:2026/08/01-2026/10/15", "transactions:A2:2026/08/01-2026/10/15", "signOut",
  ]);
  assert.deepEqual(observations.map((entry) => [entry.endpoint, entry.status]), [
    ["/NetBank/ajax/acntReview1.html", 200], ["/NetBank/2/010103.html", 200], ["/NetBank/2/010103.html", 200],
  ], "every captured response is observed");
});

test("a deposit row without a currency is refused before write", async () => {
  const result = await run({ overview: overview([overviewRows.salary, row("活期存款", "123-45-999999", "", "812.34", "-")]) });
  assert.equal(result.errorCode, "source-validation-failed");
  assert.match(String(result.error), /missing-currency/u);
  assert.equal(result.writes.length, 0);
  assert.equal(result.observations.length, 1, "the overview stays observed for a structure report");
});

test("a malformed amount is refused before write", async () => {
  const result = await run({ histories: { ...histories, A2: history("123-45-999999", [row("2026/10/05", "", "1.2.3", "USD", "1", "x", "")]) } });
  assert.equal(result.errorCode, "source-validation-failed");
  assert.match(String(result.error), /malformed-amount/u);
  assert.equal(result.writes.length, 0);
});

test("an incomplete page or account list fails as incomplete-data before write", async () => {
  const cases: Record<string, Script> = {
    "a next-page link": { histories: { ...histories, A1: history("123-45-678901", [], "<a href=\"#\">下一頁</a>") } },
    "a row-limit notice": { overview: overview(undefined, "<p>僅顯示 50 筆資料</p>") },
    "more than ten query accounts": {
      overview: overview(Array.from({ length: 11 }, (_, index) => row("活期存款", `123-45-${String(100000 + index)}`, "TWD", "1", "1"))),
      query: Array.from({ length: 11 }, (_, index) => ({ value: `Q${index}`, label: `123-45-${String(100000 + index)}` })),
    },
    "a demand account missing from the query list": { query: [QUERY[0]!] },
  };
  for (const [name, script] of Object.entries(cases)) {
    const result = await run(script);
    assert.equal(result.errorCode, "source-collection-failed", name);
    assert.match(String(result.error), /incomplete-data/u, name);
    assert.equal(result.writes.length, 0, `${name} writes nothing`);
    assert.ok(result.fake.calls.includes("signOut"), `${name} still signs out`);
  }
});

test("a row that sets both or neither column, or a page for another account, fails before write", async () => {
  const both = await run({ histories: { ...histories, A1: history("123-45-678901", [row("2026/10/03", "1", "2", "", "1", "x", "")]) } });
  assert.equal(both.errorCode, "source-validation-failed");
  const neither = await run({ histories: { ...histories, A1: history("123-45-678901", [row("2026/10/03", "-", "0.00", "", "1", "x", "")]) } });
  assert.equal(neither.errorCode, "source-validation-failed");
  const other = await run({ histories: { ...histories, A1: history("123-45-000000", []) } });
  assert.equal(other.errorCode, "source-validation-failed");
  assert.equal(both.writes.length + neither.writes.length + other.writes.length, 0);
});

test("production refuses the image CAPTCHA before opening any page", async () => {
  const result = await runPreviewSource(FIRSTBANK_PREVIEW_SOURCE, credentials);
  assert.equal(result.errorCode, "verification-configuration-failed", "the harness page throws if the source opens one");
  assert.match(String(result.error), /firstbank-image-captcha/u);
  assert.ok(result.events.some((event) => event.code === "solver-challenge-unsupported"));
  const fake = fakePage();
  const injected = await runPreviewSource(createFirstbankSource({ page: fake.opener }), credentials);
  assert.equal(injected.errorCode, "verification-configuration-failed");
  assert.equal(fake.opens(), 0);
  assert.deepEqual(fake.calls, []);
});

test("sign-in refusals are typed, collect nothing, and still attempt the logout", async () => {
  const outcomes = {
    MULTI_SESSION_LOGIN: /session-conflict/u,
    "您的帳號已在其他地方登入，請勿重複登入": /session-conflict/u,
    "圖形驗證碼錯誤！": /verification-rejected/u,
    "使用者代號或密碼錯誤": /sign-in-rejected/u,
  };
  for (const [message, reason] of Object.entries(outcomes)) {
    const result = await run({ signIn: { kind: "refused", message } });
    assert.match(String(result.error), reason, message);
    assert.ok(!result.fake.calls.includes("overview"), `${message} collects nothing`);
    assert.equal(result.fake.calls.at(-1), "signOut", `${message} still signs out`);
  }
  assert.equal((await run({ signIn: { kind: "no-outcome" } })).errorCode, "source-validation-failed");
});

test("a failed logout does not override the result", async () => {
  const result = await run({ signOutFails: true });
  assert.equal(result.errorCode, null);
  assert.equal(result.writes.length, 1);
});
