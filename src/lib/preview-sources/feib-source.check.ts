import assert from "node:assert/strict";
import test from "node:test";
import {
  createFeibSource,
  feibQueryRanges,
  type FeibCapture,
  type FeibPage,
  type FeibPageOpener,
  type FeibQueryRange,
  type FeibSignInOutcome,
} from "./feib-source.ts";
import { depositCollection, runPreviewSource } from "./preview-source-harness.ts";

// Synthetic pages shaped like FEIB's JSP documents; no live sample exists.
const credentials = {
  PREVIEW_FEIB_DEPOSIT_ID_NUMBER: "a000000001",
  PREVIEW_FEIB_DEPOSIT_USER_CODE: "user01",
  PREVIEW_FEIB_DEPOSIT_PASSWORD: "secret-pass",
};

const SALARY_NO = "09990000001111";
const SPARE_NO = "09990000002222";
const SIGNED_IN = '<a href="/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Logout&state=logout">登 出</a>';
const td = (...cells: readonly string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
const select = (account: string) =>
  `<select name="selFun1" onchange="selFun1(this.value, '${account}','00','004','0');"><option value="">---請選擇---</option><option value="detail">交易明細</option></select>`;

const overviewRows = {
  salary: td("合成分行", "活期儲蓄存款", "09990000001111", "新臺幣", "NTD$12,345.67元", select("09990000001111")),
  spare: td("範例分行", "活期存款", "0999-0000-002222", "新臺幣", "NTD$100.00元", select("09990000002222")),
  dollar: td("合成分行", "外匯活期存款", "09990000003333", "美金", "USD$812.34", select("09990000003333")),
};

const overview = (rows: readonly string[] = Object.values(overviewRows), signedIn = SIGNED_IN) => `<html><body>${signedIn}
<!-- <h2>活期性存款</h2> -->
<div class="page"><h2>活期性存款</h2><table><thead><tr><th>所屬分行</th><th>帳戶類別</th><th>帳號</th><th>幣別</th><th>帳戶餘額</th><th>我要查詢/申請</th></tr></thead>
<tbody>${rows.join("")}</tbody></table>
<h2>定期性存款</h2><table><tr><th>往來單位</th><th>帳戶類別</th><th>帳號</th><th>幣別</th><th>帳戶餘額</th></tr>
${td("合成分行", "定期存款", "09990000009999", "新臺幣", "NTD$500,000.00元")}</table></div></body></html>`;

type HistoryRow = Readonly<{ date: string; booked?: string; summary: string; debit?: string; credit?: string; balance: string; memo?: string }>;

const historyRow = (row: HistoryRow) =>
  td(row.date, row.booked ?? row.date, row.summary, row.debit ?? "", row.credit ?? "", row.balance, row.memo ?? "",
    '<select onchange="setUsing(0,this.value)"><option value="">--請選擇--</option><option value="01">薪資/獎金</option></select>');

function history(account: string, range: FeibQueryRange, rows: readonly HistoryRow[] | null, extra = "") {
  const options = [SALARY_NO, SPARE_NO]
    .map((value) => `<option value="${value}" ${value === account ? "selected" : ""}>合成分行/活期儲蓄存款/${value}</option>`).join("");
  const result = rows === null ? "" : `<div class="table-caption"><ul><li>活存帳號：${account}</li><li>查詢期間：${range.start}~${range.end}</li></ul></div>
<table><thead><tr><th>交易日期</th><th>帳務日期</th><th>摘要</th><th>支出金額</th><th>存入金額</th><th>帳戶餘額</th><th>備註</th><th>用途</th></tr></thead>
<tbody>${rows.map(historyRow).join("")}</tbody></table>`;
  return `<html><body>${SIGNED_IN}<div class="page"><form name="inqForm" id="inqForm" method="post" action="/netbank/servlet/TrxDispatcher">
<input type="hidden" name="trx" value="com.lb.wibc.trx.SavAcctTxDtlInq"><input type="hidden" name="check" value="false">
<select name="acct" id="acct">${options}</select>
<input type="text" name="sdate" id="sdate" value="${range.start}" /><input type="text" name="edate" id="edate" value="${range.end}" /></form>
${extra}${result}</div></body></html>`;
}

const SALARY_ROWS: readonly HistoryRow[] = [
  { date: "2026/09/05", summary: "跨行轉", credit: "5,000.00", balance: "12,445.67", memo: "薪資" },
  { date: "2026/09/30", booked: "2026/10/01", summary: "ＡＴＭ提款", debit: "100.00", balance: "12,345.67" },
  { date: "2026/09/30", booked: "2026/10/01", summary: "ＡＴＭ提款", debit: "100.00", balance: "12,345.67" },
];

type Script = Readonly<{
  signIn?: FeibSignInOutcome;
  postpone?: boolean;
  overview?: string;
  history?: (account: string, range: FeibQueryRange) => string;
}>;

function fakePage(script: Script = {}) {
  const calls: string[] = [];
  let opens = 0;
  const capture = (text: string, date: string | null = null): FeibCapture => ({ status: 200, date, text });
  const page: FeibPage = {
    async captchaImage() { calls.push("captcha"); return Buffer.from("png"); },
    async signIn(input) { calls.push(`signIn:${input.idNumber}:${input.userCode}:${input.captcha}`); return script.signIn ?? { kind: "signed-in" }; },
    async postponePasswordChange() { calls.push("postpone"); return script.postpone ?? true; },
    async depositOverview() { calls.push("overview"); return capture(script.overview ?? overview(), "Thu, 15 Oct 2026 01:59:00 GMT"); },
    async transactions(account, range) {
      calls.push(`transactions:${account}:${range.start}-${range.end}`);
      return capture((script.history ?? ((queried, queriedRange) =>
        history(queried, queriedRange, queried === SALARY_NO && queriedRange.end === "2026/10/15" ? SALARY_ROWS : null)))(account, range));
    },
    async signOut() { calls.push("signOut"); },
  };
  const opener: FeibPageOpener = async (_context, _url, use) => { opens += 1; return use(page); };
  return { opener, calls, opens: () => opens };
}

const solveCaptcha = async () => "123456";

async function run(script: Script = {}) {
  const fake = fakePage(script);
  const result = await runPreviewSource(createFeibSource({ page: fake.opener, solveCaptcha }), credentials);
  return { ...result, calls: fake.calls, opens: fake.opens };
}

test("FEIB ranges keep within two months and move a missing day to the next month's first", () => {
  assert.deepEqual(feibQueryRanges({ start: "2026-08-01", end: "2026-10-15" }), [
    { start: "2026/08/15", end: "2026/10/15" },
    { start: "2026/08/01", end: "2026/08/14" },
  ]);
  assert.deepEqual(feibQueryRanges({ start: "2026-02-01", end: "2026-04-30" }), [
    { start: "2026/03/01", end: "2026/04/30" },
    { start: "2026/02/01", end: "2026/02/28" },
  ], "2/30 does not exist, so 4/30 reaches back to 3/1");
  assert.deepEqual(feibQueryRanges({ start: "2025-11-01", end: "2026-01-31" }), [
    { start: "2025/12/01", end: "2026/01/31" },
    { start: "2025/11/01", end: "2025/11/30" },
  ], "11/31 does not exist across the year boundary");
});

test("FEIB collects each NT-dollar demand account with its split-range transactions and signs out", async () => {
  const result = await run();
  assert.equal(result.errorCode, null, String(result.error));
  assert.deepEqual(result.calls, [
    "captcha",
    "signIn:A000000001:user01:123456",
    "overview",
    "transactions:09990000001111:2026/08/15-2026/10/15",
    "transactions:09990000001111:2026/08/01-2026/08/14",
    "transactions:09990000002222:2026/08/15-2026/10/15",
    "transactions:09990000002222:2026/08/01-2026/08/14",
    "signOut",
  ], "the foreign-currency and time deposit rows are never queried");
  const collection = depositCollection(result.writes[0]!);
  const asOf = { at: "2026-10-15T01:59:00.000Z", source: "reported" };
  assert.deepEqual(collection.accounts.map((account) => [account.sourceAccountKey, account.displayLabel, account.balances]), [
    ["09990000001111:TWD", "遠東商銀 活期儲蓄存款 1111", [{ kind: "current", amount: "12345.67", currency: "TWD", observedAt: asOf }]],
    ["09990000002222:TWD", "遠東商銀 活期存款 2222", [{ kind: "current", amount: "100.00", currency: "TWD", observedAt: asOf }]],
  ]);
  const rows = collection.accounts[0]!.transactions;
  assert.deepEqual(rows.map(({ amount, direction, postedAt, description }) => ({ amount, direction, postedAt, description })), [
    { amount: "5000.00", direction: "inflow", postedAt: { precision: "day", value: "2026-09-05" }, description: "跨行轉 · 薪資" },
    { amount: "100.00", direction: "outflow", postedAt: { precision: "day", value: "2026-10-01" }, description: "ＡＴＭ提款" },
    { amount: "100.00", direction: "outflow", postedAt: { precision: "day", value: "2026-10-01" }, description: "ＡＴＭ提款" },
  ], "存入 is an inflow, 支出 an outflow, and the booking date is the posting date");
  assert.match(rows[1]!.sourceRowKey, /^2026-09-30:[0-9a-f]{16}:1$/u);
  assert.equal(rows[2]!.sourceRowKey, rows[1]!.sourceRowKey.replace(/:1$/u, ":2"), "identical rows on one day keep their order");
  assert.equal(result.observations.length, 5, "the overview and every history page are observed");
  assert.ok(result.observations.every((observation) => !JSON.stringify(observation.body).includes("薪資/獎金")), "the 用途 select is not content");
});

test("FEIB follows 下次登入再變更 on the password-change reminder, and stops when it cannot", async () => {
  const postponed = await run({ signIn: { kind: "password-change-prompt" } });
  assert.equal(postponed.errorCode, null);
  assert.deepEqual(postponed.calls.slice(1, 4), ["signIn:A000000001:user01:123456", "postpone", "overview"]);

  const required = await run({ signIn: { kind: "password-change-prompt" }, postpone: false });
  assert.equal(required.errorCode, "authentication-failed");
  assert.ok(!required.calls.includes("overview"));
  assert.equal(required.calls.at(-1), "signOut");
});

test("FEIB sign-in outcomes map to typed failures without a second submission", async () => {
  const cases: readonly (readonly [FeibSignInOutcome, string])[] = [
    [{ kind: "refused", message: "您的使用者代號或密碼錯誤，連續錯誤三次將暫停使用" }, "authentication-failed"],
    [{ kind: "refused", message: "使用者 代號 錯誤" }, "authentication-failed"],
    [{ kind: "refused", message: "您已在其他裝置登入中" }, "authentication-failed"],
    [{ kind: "refused", message: "圖形驗證碼錯誤" }, "verification-failed"],
    [{ kind: "captcha-rejected" }, "verification-failed"],
    [{ kind: "fields-rejected" }, "authentication-failed"],
    [{ kind: "refused", message: "系統維護中，請稍後再試" }, "source-unavailable"],
    [{ kind: "refused", message: "歡迎光臨" }, "source-validation-failed"],
    [{ kind: "no-outcome" }, "source-validation-failed"],
  ];
  for (const [signIn, code] of cases) {
    const result = await run({ signIn });
    assert.equal(result.errorCode, code, JSON.stringify(signIn));
    assert.equal(result.calls.filter((call) => call.startsWith("signIn")).length, 1);
    assert.equal(result.writes.length, 0);
    assert.equal(result.calls.at(-1), "signOut");
  }
});

test("FEIB fails closed on an echo mismatch, a both-sided row, a truncation notice, or a lost session", async () => {
  const salary = (rows: readonly HistoryRow[], extra = "") => (account: string, range: FeibQueryRange) =>
    history(account, range, account === SALARY_NO ? rows : null, extra);
  const failures: readonly (readonly [Script, string])[] = [
    [{ history: (account, range) => history(account === SALARY_NO ? SPARE_NO : account, range, []) }, "source-validation-failed"],
    [{ history: (account, range) => history(account, { ...range, start: "2026/07/01" }, []) }, "source-validation-failed"],
    [{ history: salary([{ date: "2026/09/05", summary: "x", debit: "1.00", credit: "1.00", balance: "1" }]) }, "source-validation-failed"],
    [{ history: salary([{ date: "2026/09/05", summary: "x", balance: "1" }]) }, "source-validation-failed"],
    [{ history: salary([{ date: "2026/09/05", summary: "x", credit: "1.0.0", balance: "1" }]) }, "source-validation-failed"],
    [{ history: salary(SALARY_ROWS, "<p>僅顯示 100 筆，請縮小查詢區間</p>") }, "source-collection-failed"],
    [{ overview: overview([td("合成分行", "活期儲蓄存款", "09990000001111", "", "NTD$1.00元")]) }, "source-validation-failed"],
    [{ overview: overview(Object.values(overviewRows), "") }, "authentication-failed"],
  ];
  for (const [script, code] of failures) {
    const result = await run(script);
    assert.equal(result.errorCode, code, JSON.stringify(script.overview ?? script.history?.(SALARY_NO, { start: "2026/08/15", end: "2026/10/15" }).slice(-400)));
    assert.equal(result.writes.length, 0, "nothing is written before the product validates");
    assert.equal(result.calls.at(-1), "signOut");
  }
});

test("an FEIB overview with an empty demand table is not held", async () => {
  const result = await run({ overview: overview([]) });
  assert.equal(result.errorCode, null);
  assert.equal(result.output?.products[0]?.status, "not_held");
});

test("production FEIB solves with its calibrated family and refuses a capture outside it", async () => {
  const fake = fakePage();
  const result = await runPreviewSource(createFeibSource({ page: fake.opener }), credentials);
  assert.equal(result.errorCode, "verification-configuration-failed", "the fake page's image is not 100x30");
  assert.deepEqual(fake.calls, ["captcha"], "nothing is submitted for an unsupported capture");
});
