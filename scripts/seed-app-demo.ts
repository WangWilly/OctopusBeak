import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { applyPgliteMaicoinOperationalSchema } from "../src/ledger/pglite/maicoin-operational.ts";
import { createPgliteOperationalProvider } from "../src/ledger/pglite/operational.ts";
import { createPGliteChildRpcServer, requirePGliteChildRpcClientFromEnv } from "../electron/pglite-child-rpc.ts";
import { createPGliteFinancialLocalPort, createPGliteFinancialRegistry } from "../electron/pglite-financial-registry.ts";
import { createWorkflowFinancialCommitPort } from "../src/lib/automation/workflow-financial-commit.ts";
import { createWorkflowExecutor } from "../src/lib/automation/workflow-executor.ts";
import { createMaicoinWorkflow } from "../src/lib/automation/maicoin-workflow.ts";
import { strictSourceText } from "../src/lib/automation/source-text.ts";
import { syncExchangeRatesWithPersistence } from "../src/ledger/exchange-rates.ts";
import type { PGliteWorkflowRunItem } from "../src/ledger/pglite/workflow-run.ts";
import { createPGliteSpendingQuery } from "../src/ledger/pglite/spending-query.ts";
import { setPGliteSpendingPurchaseCategory } from "../src/ledger/pglite/purchase-category-command.ts";
import { SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR } from "../src/lib/spending/model.ts";
import { PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND } from "../src/ledger/pglite/workflow-client.ts";
import { deriveSourceConnectionIdentityKey } from "../src/ledger/canonical/source-connection-identity.ts";
import { buildYuantaInvestmentCapture, type YuantaCanonicalInvestmentRow } from "../src/ledger/canonical/yuanta-investment-adapters.ts";
import { resolveYuantaFundIdentity } from "../src/workflows/yuanta-fund-identity.ts";
import { admitCanonicalInvestmentCapture } from "../src/ledger/canonical/investment-financial-admission.ts";
import {
  deriveFubonDomesticDepositAccountNumberEvidence,
  runFubonStatements,
  type FubonParsedDepositStatement,
  type FubonStatementsRunDependencies,
} from "../src/workflows/fubon-statements.ts";
import { deriveFubonSourceConnectionKey, fubonStableLoginScope } from "../src/workflows/fubon-source-connection.ts";
import {
  FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
  FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  type FubonCurrentDepositBalanceRow,
} from "../src/workflows/fubon-current-deposit-balances.ts";
import {
  YUANTA_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
  YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD,
  type YuantaCurrentDepositBalanceRow,
} from "../src/workflows/yuanta-current-deposit-balances.ts";
import { removeSpendingDemo, seedSpendingDemo, SNAPSHOT_DATES } from "./seed-spending-demo.ts";

// Some workflow modules import a sibling as `./x.js` for the bundler; under
// strip-types the source is the `.ts` file next to it, as the checks resolve it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("./") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(specifier.replace(/\.js$/u, ".ts"), context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { runYuantaForeignCurrencyStatements } = await import("../src/workflows/yuanta-foreign-currency-statements.ts");
const { buildYuantaTradeCanonicalCaptures } = await import("../src/workflows/yuanta-trade-statements.ts");

/**
 * Disposable whole-app demo for the 總覽 → 資産 → account → transaction
 * recording. It seeds the Spending demo first, then replays the collection
 * runs a user would have made every third day since June: 台北富邦 TWD
 * deposits, a 元大銀行 USD account, 元大證券 holdings, 元大投信 funds and a
 * MaiCoin wallet. Every run goes through the production collectors, adapters
 * and the worker's canonical commit commands, so balance history, holdings
 * history and transactions look like collected data.
 *
 * Usage:
 *   node --no-warnings --experimental-strip-types scripts/seed-app-demo.ts /tmp/octopusbeak-spending-demo
 *   OCTOPUSBEAK_USER_DATA=/tmp/octopusbeak-spending-demo npm run desktop:dev -- --lang=zh-TW
 */

const TODAY = process.env.DEMO_TODAY ?? "2026-10-11";
const FIRST_DAY = "2026-06-01";

const money = (value: number) => value.toLocaleString("en-US");
const slash = (date: string) => date.replaceAll("-", "/");
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dayIndex = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${FIRST_DAY}T00:00:00Z`)) / 86_400_000);

/** A deterministic price path: steady drift plus two slow waves. */
function pricePath(start: number, end: number, phase: number, decimals: number) {
  const span = dayIndex(TODAY);
  return (date: string) => {
    const t = dayIndex(date) / span;
    const wave = 0.022 * Math.sin(t * 9 + phase) + 0.011 * Math.sin(t * 23 + phase * 2);
    const value = (start + (end - start) * t) * (1 + wave);
    return Number(value.toFixed(decimals));
  };
}

// ── 台北富邦 TWD deposit ────────────────────────────────────────────────────

type DepositRow = readonly [date: string, time: string, summary: string, out: number, inn: number, note: string];

const FUBON_ACCOUNT = { value: "82110000367028", label: "82110000367028 (松江分行)", branchName: "松江分行" };
const FUBON_LOGIN = { fubon_user_id: "DEMO-FUBON-USER", fubon_account: "DEMO-FUBON-LOGIN" };
const FUBON_OPENING_BALANCE = 528_640;

/** The video's hero row: an everyday debit-card purchase. */
export const HERO_TRANSACTION = { date: "2026-10-06", time: "18:42:13", summary: "金融卡消費", note: "全聯福利中心松江店", amount: 1_286 } as const;

function fubonRows(cardBills: readonly { dueDate: string; amount: number }[]): DepositRow[] {
  const rows: DepositRow[] = [];
  const electricity: Record<string, number> = { "2026-06": 1_486, "2026-07": 2_315, "2026-08": 2_642, "2026-09": 1_968 };
  const groceries: Record<string, readonly [string, number][]> = {
    "2026-06": [["08", 1_126], ["21", 864]],
    "2026-07": [["06", 1_342], ["19", 918]],
    "2026-08": [["09", 1_075], ["23", 1_231]],
    "2026-09": [["07", 986], ["20", 1_412]],
  };
  for (const month of ["2026-06", "2026-07", "2026-08", "2026-09"]) {
    const d = (day: string) => `${month}-${day}`;
    rows.push([d("05"), "08:12:41", "薪資轉入", 0, 86_500, "台灣雲端科技股份有限公司"]);
    rows.push([d("05"), "10:03:17", "網銀轉帳", 22_000, 0, "房租"]);
    rows.push([d("08"), "06:30:02", "代繳電費", electricity[month]!, 0, "台灣電力公司"]);
    rows.push([d("12"), "19:44:58", "ATM提款", 5_000, 0, "富邦松江ATM"]);
    rows.push([d("18"), "09:00:00", "基金申購", 5_000, 0, "元大投信 定期定額"]);
    for (const [day, amount] of groceries[month]!) rows.push([d(day), "18:36:20", "金融卡消費", amount, 0, "全聯福利中心松江店"]);
    rows.push([d("26"), "12:15:33", "ATM提款", 3_000, 0, "7-ELEVEN 松江門市ATM"]);
    rows.push([d("28"), "14:22:09", "跨行轉帳", 15_000, 0, "元大證券交割"]);
  }
  for (const bill of cardBills)
    if (bill.dueDate <= TODAY) rows.push([bill.dueDate, "07:10:25", "網路繳費", bill.amount, 0, "玉山銀行信用卡款"]);
  rows.push(["2026-10-01", "12:08:44", "金融卡消費", 159, 0, "7-ELEVEN 松江門市"]);
  rows.push(["2026-10-02", "06:30:05", "代繳水費", 386, 0, "臺北自來水事業處"]);
  rows.push(["2026-10-05", "08:12:39", "薪資轉入", 0, 86_500, "台灣雲端科技股份有限公司"]);
  rows.push(["2026-10-05", "10:05:51", "網銀轉帳", 22_000, 0, "房租"]);
  rows.push([HERO_TRANSACTION.date, HERO_TRANSACTION.time, HERO_TRANSACTION.summary, HERO_TRANSACTION.amount, 0, HERO_TRANSACTION.note]);
  rows.push(["2026-10-07", "20:11:36", "ATM提款", 5_000, 0, "富邦松江ATM"]);
  rows.push(["2026-10-08", "06:30:03", "代繳電費", 1_568, 0, "台灣電力公司"]);
  rows.push(["2026-10-09", "14:20:47", "跨行轉帳", 30_000, 0, "元大證券交割"]);
  rows.push(["2026-10-10", "11:48:02", "利息存入", 0, 412, "活期存款息"]);
  return rows.sort((left, right) => `${left[0]}${left[1]}`.localeCompare(`${right[0]}${right[1]}`));
}

function fubonStatementThrough(rows: readonly DepositRow[], through: string) {
  const accountNumber = deriveFubonDomesticDepositAccountNumberEvidence(FUBON_ACCOUNT);
  if (!accountNumber) throw new Error("Demo Fubon account option has no account-number evidence.");
  const accountOption = { ...FUBON_ACCOUNT, accountNumber };
  let balance = FUBON_OPENING_BALANCE;
  // The 180-day range always reaches back past the first demo row.
  const queryRange = { startDate: slash(addDays(through, -179)), endDate: slash(through) };
  const statementRows = rows.filter(([date]) => date <= through).map(([date, time, summary, out, inn, note], rowOrdinal) => {
    balance += inn - out;
    const cells = [slash(date), time, summary, out ? money(out) : "", inn ? money(inn) : "", money(balance), note] as const;
    return { rowOrdinal, cells };
  });
  const statement: FubonParsedDepositStatement = {
    account: FUBON_ACCOUNT.label,
    accountId: FUBON_ACCOUNT.value,
    queryPeriod: "180",
    branchName: FUBON_ACCOUNT.branchName,
    rows: statementRows.map((row) => [...row.cells]),
    pages: [{
      pageOrdinal: 0,
      responseSequence: 1,
      terminal: true,
      nextPage: null,
      pageFieldName: null,
      paginationEvidence: "terminal-no-next",
      queryRange,
      selectedAccount: accountOption,
      providerPageSize: 200,
      providerTotalCount: statementRows.length,
      rows: statementRows,
      zeroObservation: statementRows.length > 0 ? "non-empty-page" : "empty-page",
    }],
    accountOption,
  };
  return { statement, balance, rowCount: statementRows.length };
}

async function collectFubon(
  rows: readonly DepositRow[],
  date: string,
  accountIdentityContinuity: FubonStatementsRunDependencies["accountIdentityContinuity"],
): Promise<PGliteWorkflowRunItem[]> {
  const { statement, balance, rowCount } = fubonStatementThrough(rows, date);
  if (rowCount === 0) return [];
  const at = `${date}T01:20:00.000Z`;
  const currentRow: FubonCurrentDepositBalanceRow = {
    source: "fubon",
    accountNumber: FUBON_ACCOUNT.value,
    accountNickname: "薪轉戶",
    depositType: "活期儲蓄存款",
    branchName: FUBON_ACCOUNT.branchName,
    currency: "TWD",
    currencySourceLexeme: "台幣",
    instantBalance: { coefficient: String(balance * 100), scale: 2, sourceLexeme: `${money(balance)}.00` },
    availableBalance: { coefficient: String(balance * 100), scale: 2, sourceLexeme: `${money(balance)}.00` },
    effectiveAt: at,
    providerHttpDate: new Date(at).toUTCString(),
    observedAt: at,
    sourceEvidence: {
      endpoint: FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
      status: 200,
      cacheControl: "no-store, no-cache",
      contractVersion: FUBON_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    },
  };
  const items: PGliteWorkflowRunItem[] = [];
  await runFubonStatements({} as never, { dateRanges: ["180"], downloadFormat: "EXCEL" }, {
    sourceConnectionScope: fubonStableLoginScope(FUBON_LOGIN)!,
    sourceConnectionKey: deriveFubonSourceConnectionKey(FUBON_LOGIN)!,
    deferredCommitItems: items,
    sourceText: strictSourceText,
    signal: new AbortController().signal,
    accountIdentityContinuity,
    openTransactionDetailForAccountIndex: async () => "****7028",
    readDepositAccountOptions: async () => [FUBON_ACCOUNT],
    selectDepositAccount: async () => undefined,
    fetchDepositStatement: async () => statement,
    readCurrentDepositBalances: async () => [currentRow],
  });
  return items;
}

// ── 元大銀行 USD deposit ────────────────────────────────────────────────────

const YUANTA_FX_ACCOUNT = { value: "20660000418235", label: "20660000418235 外幣綜合存款" };
const USD_OPENING = 3_120;
/** [date, time, summary, out, in, info, reported rate] in USD. */
const USD_ROWS: readonly (readonly [string, string, string, number, number, string, string])[] = [
  ["2026-06-02", "00:05:00", "利息存入", 0, 4.62, "外幣活存息", ""],
  ["2026-06-20", "10:15:02", "結購外匯", 0, 500, "網銀結購", "32.18"],
  ["2026-06-21", "00:05:00", "利息存入", 0, 4.86, "外幣活存息", ""],
  ["2026-07-20", "10:12:44", "結購外匯", 0, 500, "網銀結購", "32.46"],
  ["2026-07-21", "00:05:00", "利息存入", 0, 5.21, "外幣活存息", ""],
  ["2026-08-11", "15:40:19", "匯出匯款", 650, 0, "海外學費", ""],
  ["2026-08-20", "10:09:31", "結購外匯", 0, 500, "網銀結購", "32.71"],
  ["2026-08-21", "00:05:00", "利息存入", 0, 4.95, "外幣活存息", ""],
  ["2026-09-21", "10:18:05", "結購外匯", 0, 500, "網銀結購", "32.05"],
  ["2026-09-21", "00:05:00", "利息存入", 0, 5.34, "外幣活存息", ""],
];

async function collectYuantaFx(date: string): Promise<PGliteWorkflowRunItem[]> {
  let balance = USD_OPENING;
  const rows = [...USD_ROWS]
    .sort((left, right) => `${left[0]}${left[1]}`.localeCompare(`${right[0]}${right[1]}`))
    .filter(([day]) => day <= date)
    .map(([day, time, summary, out, inn, info, rate]) => {
      balance = Math.round((balance + inn - out) * 100) / 100;
      const compact = day.replaceAll("-", "");
      return {
        accountLabel: YUANTA_FX_ACCOUNT.label,
        accountValue: YUANTA_FX_ACCOUNT.value,
        queryCurrencyLabel: "美元",
        queryCurrencyValue: "USD",
        values: [YUANTA_FX_ACCOUNT.value, compact, compact, time, "USD", summary, out ? out.toFixed(2) : "", inn ? inn.toFixed(2) : "", balance.toFixed(2), info, rate],
        sortTime: Date.parse(`${day}T${time}Z`),
      };
    });
  if (rows.length === 0) return [];
  const at = `${date}T01:25:00.000Z`;
  const amount = { coefficient: String(Math.round(balance * 100)), scale: 2, sourceLexeme: balance.toFixed(2) };
  const current: YuantaCurrentDepositBalanceRow = {
    source: "yuanta",
    kind: "foreign",
    stream: "foreign-currency-deposit",
    accountNumber: YUANTA_FX_ACCOUNT.value,
    sourceAccountKey: YUANTA_FX_ACCOUNT.value,
    currency: "USD",
    available: amount,
    ledger: amount,
    effectiveAt: at,
    providerHttpDate: new Date(at).toUTCString(),
    observedAt: at,
    sourceEvidence: {
      endpoint: YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
      method: YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD,
      status: 200,
      cacheControl: "no-store",
      contractVersion: YUANTA_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    },
  };
  const items: PGliteWorkflowRunItem[] = [];
  await runYuantaForeignCurrencyStatements({} as never, {
    dateRange: "three_months",
    customDateRange: { startDate: slash(addDays(date, -179)), endDate: slash(date) },
    accountFilters: [],
    currencyFilters: [],
    channelType: "all",
  }, { yuanta_user_id: "DEMO-YUANTA-USER" } as never, {
    collectOnly: true,
    deferredCommitItems: items,
    openPage: async () => undefined,
    readAccounts: async () => [YUANTA_FX_ACCOUNT],
    selectAccount: async () => undefined,
    readCurrencies: async () => [{ label: "美元", value: "USD" }],
    queryAccountCurrency: async () => undefined,
    downloadRows: async () => ({ rows }),
    readCurrentBalances: async () => [current],
    now: () => at,
  } as never);
  return items;
}

// ── 元大證券 holdings ───────────────────────────────────────────────────────

const BROKERAGE_ACCOUNT = "984C-0352871";
/** Each 交割 transfer from 台北富邦 settles a buy made two days earlier. */
const STOCKS = [
  { code: "2330", name: "台積電", quantity: () => 300, price: pricePath(1_315, 1_480, 0.4, 0) },
  { code: "0050", name: "元大台灣50", quantity: (date: string) => 4_200 + 270 * ["2026-06-26", "2026-07-26", "2026-08-26", "2026-09-26"].filter((day) => day <= date).length, price: pricePath(51.6, 58.35, 1.7, 2) },
  { code: "2881", name: "富邦金", quantity: (date: string) => (date >= "2026-10-07" ? 2_300 : 2_000), price: pricePath(87.2, 95.4, 2.9, 1) },
  { code: "2454", name: "聯發科", quantity: () => 100, price: pricePath(1_265, 1_395, 4.1, 0) },
] as const;

function collectYuantaTrade(date: string): PGliteWorkflowRunItem[] {
  const holdings = STOCKS.map((stock) => ({
    account_number: BROKERAGE_ACCOUNT,
    product_code: stock.code,
    product_name: stock.name,
    as_of_date: slash(date),
    quantity: String(stock.quantity(date)),
    market_value_twd: String(Math.round(stock.quantity(date) * stock.price(date))),
    currency: "TWD",
  }));
  return buildYuantaTradeCanonicalCaptures(
    { yuanta_trade_user_id: "DEMO-YUANTA-TRADE-USER" },
    holdings,
    [],
    { dateRange: { startDate: slash(addDays(date, -89)), endDate: slash(date) }, requestedTradeTypes: ["普通買賣"] },
  ).map((capture) => ({
    provider: "yuanta-trade",
    product: "investment",
    itemKey: capture.captureId,
    command: { kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND, request: { capture } },
  }));
}

// ── 元大投信 funds ──────────────────────────────────────────────────────────

const FUND_LOGIN = { yuanta_user_id: "DEMO-YUANTA-USER", yuanta_account: "DEMO-FUND-ACCOUNT" };
const FUNDS = [
  { name: "元大台灣高股息優質龍頭基金", units: 12_180, monthly: 5_000, nav: pricePath(15.82, 17.24, 0.9, 2) },
  { name: "元大全球人工智慧ETF連結基金", units: 4_060, monthly: 0, nav: pricePath(19.36, 22.08, 3.3, 2) },
] as const;

function fundUnits(fund: typeof FUNDS[number], navDate: string): number {
  let units = fund.units;
  for (const month of ["2026-06", "2026-07", "2026-08", "2026-09"]) {
    const buy = `${month}-18`;
    if (fund.monthly && buy <= navDate) units += Math.round((fund.monthly / fund.nav(buy)) * 100) / 100;
  }
  return Math.round(units * 100) / 100;
}

function collectYuantaFund(date: string): PGliteWorkflowRunItem[] {
  const navDate = date;
  const sourceConnectionKey = deriveSourceConnectionIdentityKey("yuanta-fund", [FUND_LOGIN.yuanta_user_id, FUND_LOGIN.yuanta_account]);
  const accountKey = deriveSourceConnectionIdentityKey("yuanta-fund-account", [sourceConnectionKey, FUND_LOGIN.yuanta_account]);
  const observedAt = `${date}T01:30:00.000Z`;
  const holdings: YuantaCanonicalInvestmentRow[] = FUNDS.map((fund) => {
    const units = fundUnits(fund, navDate);
    const nav = fund.nav(navDate);
    const unitsLexeme = units.toFixed(2);
    const value = Math.round(units * nav);
    return {
      sourceRecordKey: `sha256:${createHash("sha256").update(JSON.stringify(["yuanta-fund-holding", accountKey, fund.name, navDate, unitsLexeme])).digest("base64url")}`,
      producerSecurityId: resolveYuantaFundIdentity(fund.name).producerSecurityId,
      securityName: resolveYuantaFundIdentity(fund.name).name,
      securityIdentityKind: "source-fund-name",
      securityCurrency: null,
      currency: "TWD",
      effectiveOn: navDate,
      quantity: { coefficient: unitsLexeme.replace(".", ""), scale: 2 },
      valuation: { coefficient: String(value), scale: 0, currency: "TWD" },
      effectiveTimeEvidence: {
        sourceField: "reference-nav-basis-date",
        components: [{ role: "reference-nav", sourceField: "贖回/參考基準日", value: navDate }],
      },
    };
  });
  const capture = admitCanonicalInvestmentCapture(buildYuantaInvestmentCapture({
    sourceId: "yuanta-fund",
    captureId: `yuanta-fund-investment:${deriveSourceConnectionIdentityKey("yuanta-fund-capture", [sourceConnectionKey, accountKey, navDate, observedAt])}`,
    sourceConnectionKey,
    identityEpochKey: deriveSourceConnectionIdentityKey("yuanta-fund-epoch", [sourceConnectionKey, FUND_LOGIN.yuanta_account]),
    accountKey,
    reportingCurrency: "TWD",
    observedAt,
    sourceEffectiveOn: navDate,
    holdingSnapshot: { sourceField: "reference-nav-basis-date" },
    holdings,
    transactions: [],
  }));
  return [{
    provider: "yuanta-fund",
    product: "investment",
    itemKey: capture.captureId,
    command: { kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND, request: { capture } },
  }];
}

// ── MaiCoin ─────────────────────────────────────────────────────────────────

const CRYPTO = [
  { currency: "btc", balance: "0.0352", price: pricePath(3_365_000, 3_512_000, 0.2, 0) },
  { currency: "eth", balance: "0.6180", price: pricePath(118_400, 131_900, 2.2, 0) },
  { currency: "usdt", balance: "1250.00", price: pricePath(32.21, 31.94, 1.1, 2) },
] as const;

/** Answer the MAX endpoints the production collector calls, as of one run date. */
function maicoinFetch(date: () => string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = { Date: new Date(`${date()}T01:35:00Z`).toUTCString() };
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers });
    if (url.pathname === "/api/v3/info") return json({ email: "demo@octopusbeak.test", m_wallet_enabled: false });
    if (url.pathname === "/api/v3/wallet/spot/accounts")
      return json(CRYPTO.map((coin) => ({ currency: coin.currency, balance: coin.balance, locked: "0" })));
    if (url.pathname === "/api/v3/wallet/m/accounts") return json([]);
    if (url.pathname === "/api/v3/markets")
      return json(CRYPTO.filter((coin) => coin.currency !== "twd").map((coin) => ({
        id: `${coin.currency}twd`, base_unit: coin.currency, quote_unit: "twd", status: "active",
      })));
    if (url.pathname === "/api/v3/tickers")
      return json(CRYPTO.map((coin) => ({
        market: `${coin.currency}twd`,
        at: Math.floor(Date.parse(`${date()}T01:35:00Z`) / 1000),
        last: String(coin.price(date())),
      })));
    if (url.pathname.endsWith("/trades") || url.pathname.startsWith("/api/v3/fund_transactions/")
      || url.pathname === "/api/v3/rewards" || url.pathname === "/api/v3/converts") return json([]);
    throw new Error(`Unexpected MAX endpoint in the demo: ${url.pathname}`);
  }) as typeof fetch;
}

// ── Seed ────────────────────────────────────────────────────────────────────

export async function seedAppDemo(userData: string) {
  const spending = await seedSpendingDemo(userData);
  const database = await PGlite.create({ dataDir: spending.dataDir });
  const store = new PGliteStore(database);
  await applyPgliteMaicoinOperationalSchema(store);
  const operational = createPgliteOperationalProvider(store);
  const server = createPGliteChildRpcServer({
    provider: { operational, financial: createPGliteFinancialLocalPort(createPGliteFinancialRegistry(store, operational.exchangeRates)) },
  });
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  let child: ReturnType<typeof requirePGliteChildRpcClientFromEnv> | undefined;
  try {
    await server.ready;
    Object.assign(process.env, server.env);
    child = requirePGliteChildRpcClientFromEnv();
    await child.ready;
    const financialCommit = createWorkflowFinancialCommitPort(child.workflow);
    const committed: Record<string, number> = {};
    const run = async (provider: string, items: PGliteWorkflowRunItem[]) => {
      if (items.length === 0) return;
      const result = await financialCommit.execute(items, { provider });
      if (result.status !== "completed")
        throw new Error(`${provider} demo commit ${result.status}: ${JSON.stringify(result.diagnostics)}`);
      committed[provider] = (committed[provider] ?? 0) + result.committedCount;
    };

    let runDate = TODAY;
    globalThis.fetch = maicoinFetch(() => runDate);
    const maicoin = createWorkflowExecutor([createMaicoinWorkflow()], {
      browser: { withPage: async () => { throw new Error("MaiCoin does not use a browser."); } },
      text: strictSourceText,
      humanAssistance: { request: async () => { throw new Error("MaiCoin does not request assistance."); } },
      financialCommit,
      commitAttempts: { record: async () => undefined },
      maicoinPersistence: child.operationalProvider.maicoin,
      events: { append: async () => undefined },
      now: () => `${runDate}T01:35:00.000Z`,
    } as never);

    const deposits = fubonRows(spending.cardBills);
    for (const date of SNAPSHOT_DATES) {
      runDate = date;
      await run("fubon", await collectFubon(deposits, date, (request) => child!.financial.request("financial.accountIdentity.continuity", [request])));
      await run("yuanta", await collectYuantaFx(date));
      await run("yuanta-trade", collectYuantaTrade(date));
      await run("yuanta-fund", collectYuantaFund(date));
      await maicoin.run("sync-maicoin", `maicoin-demo-${date}`, {
        credentials: { accessKey: "demo-access", secretKey: "demo-secret", subAccount: "main" },
      }, new AbortController().signal);
      committed.maicoin = (committed.maicoin ?? 0) + 1;
    }

    // USD rates through the exchange-rate workflow's own persistence path.
    const rateRows = [];
    for (let date = FIRST_DAY; date <= TODAY; date = addDays(date, 1)) {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const twdPerUsd = pricePath(32.24, 32.02, 1.3, 3)(date);
      rateRows.push({ date, base: "TWD", quote: "USD", rate: Number((1 / twdPerUsd).toFixed(6)) });
    }
    const rates = await syncExchangeRatesWithPersistence(operational.exchangeRates, {
      currencies: ["USD"],
      requiredFrom: FIRST_DAY,
    }, {
      now: () => new Date(`${TODAY}T06:00:00Z`),
      fetchImpl: (async () => new Response(JSON.stringify(rateRows), { status: 200 })) as typeof fetch,
    });

    // Bank debits the Spending page counts as purchases get a category the
    // way a user sets one there, so the Spending demo has no unclassified slice.
    const categoryOf = (description: string) =>
      /房租|電費|水費/u.test(description) ? "housing_and_utilities"
        : /全聯|7-ELEVEN/u.test(description) ? "food_and_groceries" : null;
    const latestKnowledge = async () => Number((await store.query<{ value: number | string }>(
      "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits")).rows[0]?.value ?? 0);
    const spendingQuery = createPGliteSpendingQuery(store);
    let categorized = 0;
    for (const month of ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]) {
      const page = await spendingQuery.recordPage({ knowledgeAt: await latestKnowledge(), month, limit: 200, categoryCodes: [SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR] });
      for (const record of page.records) {
        const category = record.transaction?.integrationNamespace === "fubon" ? categoryOf(record.description ?? "") : null;
        if (!category) throw new Error(`Unclassified demo purchase: ${record.description}`);
        await setPGliteSpendingPurchaseCategory(store, { purchaseId: record.purchaseId, knowledgeAt: await latestKnowledge(), categoryCode: category });
        categorized += 1;
      }
    }
    committed.categorizedBankPurchases = categorized;
    const pending = await spendingQuery.pendingOverview({ knowledgeAt: await latestKnowledge() });
    if (pending.pendingCount !== 3) throw new Error(`The bank data changed the pending merge pairs: ${pending.pendingCount}`);

    const fubonFinal = fubonStatementThrough(deposits, TODAY).balance;
    return {
      ...spending,
      committed,
      runDates: SNAPSHOT_DATES.length,
      exchangeRatesWritten: rates.written,
      fubonClosingBalance: fubonFinal,
      hero: HERO_TRANSACTION,
    };
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(server.env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    child?.close();
    await server.close();
    await store.close();
  }
}

async function main() {
  const userData = process.argv[2];
  if (!userData) throw new Error("Usage: seed-app-demo <user-data-root under /tmp>");
  removeSpendingDemo(userData);
  const started = Date.now();
  const result = await seedAppDemo(userData);
  console.log(JSON.stringify({ ...result, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
}

const isCliEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) await main();
