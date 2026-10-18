import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewDepositCollection } from "../../ledger/pglite/preview-financial-data.ts";
import {
  collectEsunDeposits,
  ESUN_DEPOSIT_INIT_PATH,
  ESUN_DEPOSIT_MAX_PAGES,
  ESUN_DEPOSIT_PREQUERY_PATHS,
  ESUN_DEPOSIT_SEARCH_PATHS,
} from "./esun-deposit.ts";
import type { EsunPortalReply, EsunPortalTransport } from "./esun-portal.ts";
import { PreviewSourceFailure } from "./source-kit.ts";

const NOW = "2026-10-15T02:00:00.000Z";
const DATE = "Thu, 15 Oct 2026 01:59:00 GMT";
const TW_ACCOUNT = "SYN-TW-0001";
const TW_SECOND = "SYN-TW-0002";
const FR_ACCOUNT = "SYN-FR-0003";

type Body = Record<string, unknown>;
type Call = Readonly<{ path: string; requestBody: Body; resetFlow: boolean }>;

const ok = (resultBody: Body, date: string | null = DATE): EsunPortalReply =>
  ({ kind: "json", httpStatus: 200, text: JSON.stringify({ resultCode: "0000", resultBody }), date });
const raw = (text: string): EsunPortalReply => ({ kind: "json", httpStatus: 200, text, date: DATE });
const notHeld = (description: string): EsunPortalReply =>
  ({ kind: "json", httpStatus: 200, text: JSON.stringify({ resultCode: "S001", resultDescription: description }), date: DATE });

const twRow = (overrides: Body = {}): Body => ({
  detailTitle: "Synthetic transfer",
  txDate: "2026/10/03",
  txTime: "09:15:30",
  amount: "1,200.00",
  debitCredit: "CR",
  passbookRemark: "Synthetic memo",
  balance: "51,200.00",
  ...overrides,
});
const group = (rows: readonly Body[]) => ({ queryDeptTxDtlResult: { detailListData: [{ detailInfo: rows }] } });

const twPrequery = (account: string, overrides: Body = {}): Body => ({
  demandDeptAcc: account,
  accountAlias: account === TW_ACCOUNT ? "Salary" : null,
  twAccountList: [{ accountNo: TW_ACCOUNT }, { accountNo: TW_SECOND }],
  twCurrInfo: { realBalance: account === TW_ACCOUNT ? "50,000.00" : "12.50" },
  ...group([]),
  ...overrides,
});
const frPrequery = (overrides: Body = {}): Body => ({
  demandDeptAcc: FR_ACCOUNT,
  frAccountList: [{ accountNo: FR_ACCOUNT }],
  totalTWBalance: "99999",
  currInfoList: [{ currency: "USD", totalAmount: "1,000.25" }, { currency: "JPY", totalAmount: "30000" }],
  ...group([]),
  ...overrides,
});

type Routes = Readonly<{
  twPrequery?: (account: string | null) => EsunPortalReply;
  frPrequery?: (account: string | null) => EsunPortalReply;
  twSearch?: (account: string, startIndex: number) => EsunPortalReply;
  frSearch?: (account: string, startIndex: number) => EsunPortalReply;
}>;

const defaults: Required<Routes> = {
  twPrequery: (account) => ok(twPrequery(account ?? TW_ACCOUNT)),
  frPrequery: () => ok(frPrequery()),
  twSearch: (account) => ok(group(account === TW_ACCOUNT ? [twRow(), twRow({ debitCredit: "DR", amount: "200", balance: "51,000.00", txTime: "" })] : [])),
  frSearch: () => ok(group([
    { detailTitle: "Synthetic FX", txDate: "2026-10-02", currency: "USD", amount: "10.5", debitCredit: "DR" },
    { detailTitle: "Synthetic FX", txDate: "2026-10-02", currency: "JPY", amount: "500", debitCredit: "CR" },
  ])),
};

function fakePortal(routes: Routes = {}) {
  const calls: Call[] = [];
  const route = { ...defaults, ...routes };
  const transport: EsunPortalTransport = async (path, requestBody, resetFlow) => {
    calls.push({ path, requestBody: { ...requestBody }, resetFlow });
    const account = (requestBody.account ?? null) as string | null;
    const startIndex = requestBody.startIndex as number;
    switch (path) {
      case ESUN_DEPOSIT_INIT_PATH: return ok({});
      case ESUN_DEPOSIT_PREQUERY_PATHS.tw: return route.twPrequery(account);
      case ESUN_DEPOSIT_PREQUERY_PATHS.fr: return route.frPrequery(account);
      case ESUN_DEPOSIT_SEARCH_PATHS.tw: return route.twSearch(account!, startIndex);
      case ESUN_DEPOSIT_SEARCH_PATHS.fr: return route.frSearch(account!, startIndex);
      default: throw new Error(`unexpected path ${path}`);
    }
  };
  return { transport, calls };
}

async function collection(routes: Routes = {}) {
  const portal = fakePortal(routes);
  const result = await collectEsunDeposits(portal.transport, NOW);
  assert.ok(!("absent" in result), "expected a collection");
  return { collection: result as PreviewDepositCollection, calls: portal.calls };
}

async function failure(routes: Routes): Promise<PreviewSourceFailure> {
  const portal = fakePortal(routes);
  const error = await collectEsunDeposits(portal.transport, NOW).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof PreviewSourceFailure, `expected a typed failure, got ${String(error)}`);
  return error;
}

test("NT-dollar and foreign-currency accounts are written with exact balances, directions, and three months of history", async () => {
  const { collection: written, calls } = await collection();
  assert.equal(written.collectedAt, NOW);
  assert.deepEqual(written.accounts.map((account) => [account.sourceAccountKey, account.currency, account.displayLabel, account.balances]), [
    [`${TW_ACCOUNT}:TWD`, "TWD", "玉山銀行 Salary 0001", [{ kind: "current", amount: "50000.00", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } }]],
    [`${TW_SECOND}:TWD`, "TWD", "玉山銀行 存款帳戶 0002", [{ kind: "current", amount: "12.50", currency: "TWD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } }]],
    [`${FR_ACCOUNT}:USD`, "USD", "玉山銀行 存款帳戶 0003 (USD)", [{ kind: "current", amount: "1000.25", currency: "USD", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } }]],
    [`${FR_ACCOUNT}:JPY`, "JPY", "玉山銀行 存款帳戶 0003 (JPY)", [{ kind: "current", amount: "30000", currency: "JPY", observedAt: { at: "2026-10-15T01:59:00.000Z", source: "reported" } }]],
  ]);
  const [tw, second, usd, jpy] = written.accounts;
  assert.deepEqual(tw!.transactions.map(({ amount, currency, direction, postedAt, description }) => ({ amount, currency, direction, postedAt, description })), [
    { amount: "1200.00", currency: "TWD", direction: "inflow", postedAt: { precision: "second", value: "2026-10-03T09:15:30" }, description: "Synthetic transfer · Synthetic memo" },
    { amount: "200", currency: "TWD", direction: "outflow", postedAt: { precision: "day", value: "2026-10-03" }, description: "Synthetic transfer · Synthetic memo" },
  ]);
  assert.equal(second!.transactions.length, 0);
  assert.deepEqual(usd!.transactions.map(({ amount, direction }) => [amount, direction]), [["10.5", "outflow"]]);
  assert.deepEqual(jpy!.transactions.map(({ amount, direction }) => [amount, direction]), [["500", "inflow"]]);

  assert.deepEqual(calls.map(({ path, requestBody, resetFlow }) => [path.split("/").pop(), requestBody.account ?? null, resetFlow]), [
    ["init", null, true],
    ["preQueryTWTransactionDetail", null, false],
    ["queryTWTransactionDetail", TW_ACCOUNT, false],
    ["init", null, true],
    ["preQueryTWTransactionDetail", TW_SECOND, false],
    ["queryTWTransactionDetail", TW_SECOND, false],
    ["init", null, true],
    ["preQueryFRTransactionDetail", null, false],
    ["queryFRTransactionDetail", FR_ACCOUNT, false],
  ], "home/init starts every deposit flow, and each response is requested once");
  const search = calls.find((call) => call.path === ESUN_DEPOSIT_SEARCH_PATHS.tw)!.requestBody;
  assert.deepEqual(search, {
    account: TW_ACCOUNT, startDate: "2026/08/01", endDate: "2026/10/15", startIndex: 1, count: 100, customerInputHashtag: [],
  });
});

test("row keys stay stable across collections and count identical rows", async () => {
  const twin = () => ok(group([twRow(), twRow()]));
  const first = await collection({ twSearch: (account) => account === TW_ACCOUNT ? twin() : ok(group([])) });
  const second = await collection({ twSearch: (account) => account === TW_ACCOUNT ? twin() : ok(group([])) });
  const keys = first.collection.accounts[0]!.transactions.map((row) => row.sourceRowKey);
  assert.equal(new Set(keys).size, 2);
  assert.match(keys[0]!, /^2026-10-03:[0-9a-f]{16}:1$/u);
  assert.match(keys[1]!, /:2$/u);
  assert.deepEqual(second.collection.accounts[0]!.transactions.map((row) => row.sourceRowKey), keys);
});

test("a row without a debit or credit code keeps its lexeme with an unknown direction", async () => {
  const { collection: written } = await collection({
    twSearch: (account) => ok(group(account === TW_ACCOUNT ? [twRow({ debitCredit: undefined, amount: "-35" })] : [])),
  });
  assert.deepEqual(written.accounts[0]!.transactions.map(({ amount, direction }) => [amount, direction]), [["-35", "unknown"]]);
});

test("a JSON number keeps its source lexeme", async () => {
  const body = JSON.stringify(twPrequery(TW_ACCOUNT, { twAccountList: [{ accountNo: TW_ACCOUNT }] }))
    .replace('"realBalance":"50,000.00"', '"realBalance":50000.10');
  const { collection: written } = await collection({ twPrequery: () => raw(`{"resultCode":"0000","resultBody":${body}}`) });
  assert.equal(written.accounts[0]!.balances[0]!.amount, "50000.10");
});

test("the balance falls back to the collection time without a Date header", async () => {
  const { collection: written } = await collection({ twPrequery: (account) => ok(twPrequery(account ?? TW_ACCOUNT), null) });
  assert.deepEqual(written.accounts[0]!.balances[0]!.observedAt, { at: NOW, source: "collection-time" });
});

test("paging follows full pages and stops at the first short page", async () => {
  const fullPage = (offset: number) => Array.from({ length: 100 }, (_, index) => twRow({ amount: String(offset + index + 1) }));
  const { collection: written, calls } = await collection({
    twSearch: (account, startIndex) => account !== TW_ACCOUNT ? ok(group([]))
      : startIndex === 1 ? ok(group(fullPage(0))) : startIndex === 101 ? ok(group(fullPage(100))) : ok(group([twRow({ amount: "999" })])),
  });
  assert.equal(written.accounts[0]!.transactions.length, 201);
  assert.deepEqual(calls.filter((call) => call.path === ESUN_DEPOSIT_SEARCH_PATHS.tw && call.requestBody.account === TW_ACCOUNT)
    .map((call) => call.requestBody.startIndex), [1, 101, 201]);
});

test("both no-account notices are the only not_held", async () => {
  const portal = fakePortal({
    twPrequery: () => notHeld("查無臺幣帳號，或您尚未開立臺幣帳戶"),
    frPrequery: () => notHeld("查無外幣帳號，或您尚未開立外幣帳戶"),
  });
  assert.deepEqual(await collectEsunDeposits(portal.transport, NOW), { absent: "not_held" });
  assert.equal(portal.calls.some((call) => call.path.includes("/search/")), false);

  const twOnly = await collection({ frPrequery: () => notHeld("查無外幣帳號，或您尚未開立外幣帳戶") });
  assert.deepEqual(twOnly.collection.accounts.map((account) => account.currency), ["TWD", "TWD"]);
});

test("unclear or incomplete answers fail the product before any write", async () => {
  const cases: ReadonlyArray<readonly [string, Routes, PreviewSourceFailure["reason"]]> = [
    ["S001 naming another kind", { twPrequery: () => notHeld("查無外幣帳號") }, "unexpected-response"],
    ["S001 with another notice", { frPrequery: () => notHeld("系統維護中") }, "unexpected-response"],
    ["a result code other than 0000", { twSearch: () => ({ kind: "json", httpStatus: 200, text: JSON.stringify({ resultCode: "E999" }), date: DATE }) }, "unexpected-response"],
    ["an HTTP error", { twPrequery: () => ({ kind: "json", httpStatus: 500, text: "{}", date: DATE }) }, "unexpected-response"],
    ["a non-JSON answer", { twPrequery: () => ({ kind: "non-json", httpStatus: 502 }) }, "unexpected-response"],
    ["a missing portal session", { frPrequery: () => ({ kind: "portal-session-missing" }) }, "unexpected-response"],
    ["a missing account list", { twPrequery: (account) => ok(twPrequery(account ?? TW_ACCOUNT, { twAccountList: undefined })) }, "unexpected-response"],
    ["an answer for another account", { twPrequery: () => ok(twPrequery(TW_ACCOUNT)) }, "unexpected-response"],
    ["a foreign balance without a currency", { frPrequery: () => ok(frPrequery({ currInfoList: [{ totalAmount: "1" }] })) }, "missing-currency"],
    ["a foreign account without balances", { frPrequery: () => ok(frPrequery({ currInfoList: [] })) }, "unexpected-response"],
    ["a missing NT-dollar balance", { twPrequery: (account) => ok(twPrequery(account ?? TW_ACCOUNT, { twCurrInfo: {} })) }, "malformed-amount"],
    ["a malformed balance", { twPrequery: (account) => ok(twPrequery(account ?? TW_ACCOUNT, { twCurrInfo: { realBalance: "1.2.3" } })) }, "malformed-amount"],
    ["a malformed amount", { twSearch: () => ok(group([twRow({ amount: "NT$12" })])) }, "malformed-amount"],
    ["a signed amount beside a debit code", { twSearch: () => ok(group([twRow({ debitCredit: "DR", amount: "-12" })])) }, "malformed-amount"],
    ["an unknown debit or credit code", { twSearch: () => ok(group([twRow({ debitCredit: "XX" })])) }, "unexpected-response"],
    ["a foreign row without a currency", { frSearch: () => ok(group([{ txDate: "2026/10/01", amount: "1", debitCredit: "CR" }])) }, "missing-currency"],
    ["a foreign row in another currency", { frSearch: () => ok(group([{ txDate: "2026/10/01", currency: "EUR", amount: "1", debitCredit: "CR" }])) }, "unexpected-response"],
    ["a row without a date", { twSearch: () => ok(group([twRow({ txDate: "" })])) }, "unexpected-response"],
    ["a page that repeats", { twSearch: () => ok(group(Array.from({ length: 100 }, () => twRow()))) }, "incomplete-data"],
    ["more pages than the limit", { twSearch: (_account, startIndex) => ok(group(Array.from({ length: 100 }, (_, index) => twRow({ amount: String(startIndex + index) })))) }, "incomplete-data"],
    ["a page longer than requested", { twSearch: () => ok(group(Array.from({ length: 101 }, (_, index) => twRow({ amount: String(index + 1) })))) }, "incomplete-data"],
    ["an empty search beside pre-query rows", { twPrequery: (account) => ok(twPrequery(account ?? TW_ACCOUNT, group([twRow()]))), twSearch: () => ok(group([])) }, "incomplete-data"],
  ];
  for (const [name, routes, reason] of cases) {
    assert.equal((await failure(routes)).reason, reason, name);
  }
  assert.equal(ESUN_DEPOSIT_MAX_PAGES, 20);
});
