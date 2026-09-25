import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import {
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import {
  admitCanonicalInvestmentCapture,
  CanonicalInvestmentAdmissionError,
  type InvestmentValidatedCapture,
} from "../ledger/canonical/investment-financial-admission.ts";
import {
  buildYuantaInvestmentCapture,
  type YuantaCanonicalInvestmentRow,
} from "../ledger/canonical/yuanta-investment-adapters.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import { hasAttachedLocator } from "./browser-interaction.js";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import type { YuantaCredentials } from "./yuanta-auth.ts";

const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";
const FUND_TABLE_SELECTOR =
  "table.rwdTable, table.normalTable, table.formTable";

type BrowserScope = Page | Frame;

type FundPosition = {
  txnType: string;
  paperNo: string;
  trustNo: string;
  label: string;
};

type ParsedTable = {
  category: string;
  fund: string | null;
  period: string | null;
  tableLabel: string;
  rows: string[][];
  cellColspans?: number[][];
};

type ParsedHtmlTableRows = {
  rows: string[][];
  cellColspans: number[][];
};

type NormalizedRow = {
  category: string;
  fund: string | null;
  period: string | null;
  values: string[];
};

type TableOutputConfig = {
  rawColumns: string[];
  headers: string[];
  normalize: (columns: Record<string, string>) => string[];
};

const quickDateRangeSchema = z.enum(["three_months", "six_months", "one_year"]);

const customDateRangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
});

export const yuantaFundStatementsInputSchema = z.object({
  dateRange: quickDateRangeSchema.default("one_year"),
  customDateRange: customDateRangeSchema.optional(),
  fundFilters: z.array(z.string()).default([]),
  includePortfolioSummary: z.boolean().default(true),
  includeInvestmentDetails: z.boolean().default(false),
  includeHistoricalTransactions: z.boolean().default(true),
  includeOffHourOrders: z.boolean().default(false),
  replaceActiveSession: z.boolean().default(true),
});
const inputSchema = yuantaFundStatementsInputSchema;

type WorkflowInput = z.infer<typeof inputSchema>;

const dateRangeDays: Record<z.infer<typeof quickDateRangeSchema>, number> = {
  three_months: 92,
  six_months: 183,
  one_year: 364,
};

const tableOutputConfigsByLabel: Record<string, TableOutputConfig> = {
  "portfolio-summary": simpleTableConfig([
    "基金名稱",
    "基金類型",
    "投資幣別",
    "投資金額",
    "不含息參考市值",
    "不含息參考損益",
    "不含息參考報酬率",
    "含息參考損益",
    "含息參考報酬率",
    "狀態",
  ]),
  "currency-total": simpleTableConfig([
    "幣別總計",
    "投資金額",
    "不含息參考市值",
    "不含息參考損益",
    "不含息參考報酬率",
    "含息參考損益",
    "含息參考報酬率",
  ]),
  "investment-detail": {
    rawColumns: [
      "投資日期",
      "幣別",
      "基金名稱 交易編號",
      "效率投資",
      "投資金額 不含息參考市值",
      "投資淨值 參考淨值",
      "單位數 參考匯率",
      "(不含息) 參考損益 參考報酬率",
      "(含息) 參考損益 參考報酬率",
      "累積配息 在途交易",
      "操作",
    ],
    headers: [
      "投資日期",
      "投資幣別",
      "基金名稱",
      "交易編號",
      "效率投資",
      "投資金額",
      "不含息參考市值",
      "投資淨值",
      "參考淨值",
      "單位數",
      "參考匯率",
      "不含息參考損益",
      "不含息參考報酬率",
      "含息參考損益",
      "含息參考報酬率",
      "累積配息",
      "在途交易",
    ],
    normalize: (columns) => {
      const [fundName, transactionNo] = splitFundNameAndTransactionNo(
        columns["基金名稱 交易編號"] ?? "",
      );
      const [investedAmount, marketValueExDividend] = splitWhitespacePair(
        columns["投資金額 不含息參考市值"] ?? "",
      );
      const [purchaseNav, referenceNav] = splitWhitespacePair(
        columns["投資淨值 參考淨值"] ?? "",
      );
      const [units, referenceExchangeRate] = splitWhitespacePair(
        columns["單位數 參考匯率"] ?? "",
      );
      const [gainLossExDividend, returnRateExDividend] = splitWhitespacePair(
        columns["(不含息) 參考損益 參考報酬率"] ?? "",
      );
      const [gainLossWithDividend, returnRateWithDividend] =
        splitWhitespacePair(columns["(含息) 參考損益 參考報酬率"] ?? "");
      const [accumulatedDividend, pendingTransaction] = splitWhitespacePair(
        columns["累積配息 在途交易"] ?? "",
      );

      return [
        columns["投資日期"] ?? "",
        columns["幣別"] ?? "",
        fundName,
        transactionNo,
        columns["效率投資"] ?? "",
        investedAmount,
        marketValueExDividend,
        purchaseNav,
        referenceNav,
        units,
        referenceExchangeRate,
        gainLossExDividend,
        returnRateExDividend,
        gainLossWithDividend,
        returnRateWithDividend,
        accumulatedDividend,
        pendingTransaction,
      ];
    },
  },
  "reference-nav": simpleTableConfig([
    "參考項目",
    "參考基準日",
    "參考淨值",
    "最新淨值查詢",
  ]),
  "buy-details": simpleTableConfig([
    "投資日期",
    "基金名稱",
    "交易編號",
    "投資金額",
    "申購匯率",
    "申購淨值",
    "申購手續費",
    "點數折抵",
    "申購單位數",
  ]),
  "redemption-details": {
    rawColumns: [
      "贖回日期 分配日期",
      "基金名稱 交易編號",
      "贖回投資金額 單位數",
      "贖回價格 贖回匯率",
      "信託管理費 短線費用",
      "遞延手續費",
      "入帳帳號 入帳淨額",
      "贖回參考損益 參考贖回報酬率",
      "備註",
    ],
    headers: [
      "贖回日期",
      "分配日期",
      "基金名稱",
      "交易編號",
      "贖回投資金額",
      "贖回單位數",
      "贖回價格",
      "贖回匯率",
      "信託管理費",
      "短線費用",
      "遞延手續費",
      "入帳帳號",
      "入帳淨額",
      "贖回參考損益",
      "參考贖回報酬率",
      "備註",
    ],
    normalize: (columns) => {
      const [redemptionDate, allocationDate] = splitWhitespacePair(
        columns["贖回日期 分配日期"] ?? "",
      );
      const [fundName, transactionNo] = splitFundNameAndTransactionNo(
        columns["基金名稱 交易編號"] ?? "",
      );
      const [redemptionAmount, units] = splitWhitespacePair(
        columns["贖回投資金額 單位數"] ?? "",
      );
      const [redemptionPrice, redemptionRate] = splitWhitespacePair(
        columns["贖回價格 贖回匯率"] ?? "",
      );
      const [trustFee, shortTermFee] = splitWhitespacePair(
        columns["信託管理費 短線費用"] ?? "",
      );
      const [depositAccount, netDepositAmount] = splitWhitespacePair(
        columns["入帳帳號 入帳淨額"] ?? "",
      );
      const [referenceGainLoss, referenceReturnRate] = splitWhitespacePair(
        columns["贖回參考損益 參考贖回報酬率"] ?? "",
      );

      return [
        redemptionDate,
        allocationDate,
        fundName,
        transactionNo,
        redemptionAmount,
        units,
        redemptionPrice,
        redemptionRate,
        trustFee,
        shortTermFee,
        columns["遞延手續費"] ?? "",
        depositAccount,
        netDepositAmount,
        referenceGainLoss,
        referenceReturnRate,
        columns["備註"] ?? "",
      ];
    },
  },
  "conversion-details": {
    rawColumns: [
      "轉出日期 轉入日期",
      "交易編號",
      "轉出基金 轉入基金",
      "轉換投資金額",
      "轉出單位數 轉入單位數",
      "轉出基金淨值 轉入基金淨值",
      "轉換匯率 短線費用",
      "銀行轉換手續費 基金公司轉換手續費",
    ],
    headers: [
      "轉出日期",
      "轉入日期",
      "交易編號",
      "轉出基金",
      "轉入基金",
      "轉換投資金額",
      "轉出單位數",
      "轉入單位數",
      "轉出基金淨值",
      "轉入基金淨值",
      "轉換匯率",
      "短線費用",
      "銀行轉換手續費",
      "基金公司轉換手續費",
    ],
    normalize: (columns) => {
      const [transferOutDate, transferInDate] = splitWhitespacePair(
        columns["轉出日期 轉入日期"] ?? "",
      );
      const [transferOutFund, transferInFund] = splitWhitespacePair(
        columns["轉出基金 轉入基金"] ?? "",
      );
      const [transferOutUnits, transferInUnits] = splitWhitespacePair(
        columns["轉出單位數 轉入單位數"] ?? "",
      );
      const [transferOutNav, transferInNav] = splitWhitespacePair(
        columns["轉出基金淨值 轉入基金淨值"] ?? "",
      );
      const [conversionRate, shortTermFee] = splitWhitespacePair(
        columns["轉換匯率 短線費用"] ?? "",
      );
      const [bankFee, fundCompanyFee] = splitWhitespacePair(
        columns["銀行轉換手續費 基金公司轉換手續費"] ?? "",
      );

      return [
        transferOutDate,
        transferInDate,
        columns["交易編號"] ?? "",
        transferOutFund,
        transferInFund,
        columns["轉換投資金額"] ?? "",
        transferOutUnits,
        transferInUnits,
        transferOutNav,
        transferInNav,
        conversionRate,
        shortTermFee,
        bankFee,
        fundCompanyFee,
      ];
    },
  },
  "cash-dividend-details": {
    rawColumns: [
      "入帳日期",
      "基金名稱 交易編號",
      "基準日期 計價幣別",
      "基準單位數 分配金額",
      "匯率 分配率",
      "入帳帳號",
    ],
    headers: [
      "入帳日期",
      "基金名稱",
      "交易編號",
      "基準日期",
      "計價幣別",
      "基準單位數",
      "分配金額",
      "匯率",
      "分配率",
      "入帳帳號",
    ],
    normalize: (columns) => {
      const [fundName, transactionNo] = splitFundNameAndTransactionNo(
        columns["基金名稱 交易編號"] ?? "",
      );
      const [recordDate, currency] = splitWhitespacePair(
        columns["基準日期 計價幣別"] ?? "",
      );
      const [baseUnits, dividendAmount] = splitWhitespacePair(
        columns["基準單位數 分配金額"] ?? "",
      );
      const [exchangeRate, dividendRate] = splitWhitespacePair(
        columns["匯率 分配率"] ?? "",
      );

      return [
        columns["入帳日期"] ?? "",
        fundName,
        transactionNo,
        recordDate,
        currency,
        baseUnits,
        dividendAmount,
        exchangeRate,
        dividendRate,
        columns["入帳帳號"] ?? "",
      ];
    },
  },
  "unit-dividend-details": simpleTableConfig([
    "分配日期",
    "基金名稱",
    "交易編號",
    "基準日期",
    "基準單位數",
    "分配率",
    "分配單位數",
  ]),
  "offhour-buy-orders": simpleTableConfig([
    "申購基金",
    "投資類型",
    "申購日期",
    "投資生效日期",
    "投資幣別",
    "客戶風險等級",
    "扣款帳號/信用卡卡號",
    "申購手續費",
    "每月扣款日期",
    "每次投資金額",
    "扣款起始日",
    "扣款到期日",
    "精選組合",
    "介紹人編號",
    "公開說明書交付方式",
  ]),
  "offhour-conversion-orders": simpleTableConfig([
    "轉出基金",
    "轉換方式",
    "轉換幣別",
    "申請日期",
    "轉換生效日期",
    "轉入基金",
    "轉換金額",
    "轉換單位數",
    "風險等級",
    "扣繳手續費帳號",
    "轉換手續費",
    "客戶風險等級",
    "介紹人編號",
    "公開說明書交付方式",
  ]),
  "offhour-redemption-orders": simpleTableConfig([
    "贖回基金",
    "贖回方式",
    "申請日期",
    "贖回生效日期",
    "贖回轉入帳號",
    "贖回投資金額",
    "贖回單位數",
  ]),
  "offhour-redemption-rebuy-orders": simpleTableConfig([
    "贖回基金",
    "贖回方式",
    "申請日期",
    "贖回生效日期",
    "贖回投資金額",
    "贖回單位數",
    "贖回轉入帳號",
    "再申購基金",
    "預估再申購手續費率",
    "保留金額",
  ]),
  "offhour-change-orders": simpleTableConfig([
    "異動基金",
    "申請日期",
    "生效日期",
    "異動種類",
    "變更後設定值",
  ]),
};

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function simpleTableConfig(headers: string[]): TableOutputConfig {
  return {
    rawColumns: headers,
    headers,
    normalize: (columns) => headers.map((header) => columns[header] ?? ""),
  };
}

function splitWhitespacePair(value: string): [string, string] {
  const text = cleanText(value);
  const parts = text.split(" ").filter(Boolean);
  if (parts.length <= 1) return [text, ""];
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

function splitFundNameAndTransactionNo(value: string): [string, string] {
  const text = cleanText(value);
  const match = text.match(/^(.+?)\s+([A-Z]{1,8}\d[\w-]*)$/);
  if (!match) return [text, ""];
  return [match[1] ?? "", match[2] ?? ""];
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function resolveDateRange(input: WorkflowInput): {
  startDate: string;
  endDate: string;
  label: string;
} {
  if (input.customDateRange) {
    return {
      startDate: input.customDateRange.startDate,
      endDate: input.customDateRange.endDate,
      label: `${input.customDateRange.startDate}-${input.customDateRange.endDate}`,
    };
  }

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - dateRangeDays[input.dateRange]);
  const startDate = formatDate(start);
  const endDate = formatDate(end);

  return { startDate, endDate, label: `${startDate}-${endDate}` };
}

async function waitForFrame(
  page: Page,
  name: string,
  timeoutMs = 60_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frame({ name });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for frame "${name}".`);
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(scope.locator(selector))) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find selector "${selector}" in any frame.`);
}

async function findScopeWithLocator(
  page: Page,
  locatorFor: (scope: BrowserScope) => Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(locatorFor(scope))) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find ${description} in any frame.`);
}

async function firstVisibleLocator(
  locator: Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await locator.page().waitForTimeout(500);
  }

  throw new Error(`Could not find a visible ${description}.`);
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // YuanTa keeps frames and timers alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
}

async function readCurrentCid(page: Page): Promise<string | null> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) => candidate.locator('input[name="cid"]').first(),
    "YuanTa cid field",
    3_000,
  ).catch(() => null);
  if (scope) {
    const cid = await scope
      .locator('input[name="cid"]')
      .first()
      .inputValue()
      .catch(() => "");
    if (cid) return cid;
  }

  for (const frame of page.frames()) {
    const match = frame.url().match(/[?&]cid=([^&]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }

  const pageMatch = page.url().match(/[?&]cid=([^&]+)/);
  return pageMatch?.[1] ? decodeURIComponent(pageMatch[1]) : null;
}

async function gotoFundTransactionPage(
  page: Page,
  actionFragment: string,
): Promise<boolean> {
  const cid = await readCurrentCid(page);
  const fmain = page.frame({ name: "fmain" });
  if (!cid || !fmain) return false;

  const separator = actionFragment.includes("?") ? "&" : "?";
  await fmain.goto(
    `${BANK_ORIGIN}/nib/tx/${actionFragment}${separator}type=page&cid=${encodeURIComponent(
      cid,
    )}`,
    { waitUntil: "domcontentloaded" },
  );
  await settleAfterNavigation(page);
  return true;
}

async function isFundArea(page: Page, timeoutMs = 3_000): Promise<boolean> {
  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator('a[onclick*="fundsummary"]')
        .or(candidate.locator('a[onclick*="fundtransactiondetails"]'))
        .or(candidate.locator('a[onclick*="f_offhourqueryandcancel"]'))
        .or(candidate.locator('input[name="menutype"][value*="fund"]'))
        .first(),
    "YuanTa fund navigation",
    timeoutMs,
  )
    .then(() => true)
    .catch(() => false);
}

async function clickFundMenuLink(
  page: Page,
  actionFragment: string,
  label: RegExp,
  menuId: string,
  description: string,
): Promise<void> {
  if (await gotoFundTransactionPage(page, actionFragment).catch(() => false)) {
    return;
  }

  const initialScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator(`a[onclick*="${actionFragment}"]`)
        .filter({ hasText: label }),
    description,
    10_000,
  ).catch(() => null);

  const initialLink =
    initialScope &&
    (await firstVisibleLocator(
      initialScope
        .locator(`a[onclick*="${actionFragment}"]`)
        .filter({ hasText: label }),
      description,
      5_000,
    ).catch(() => null));
  if (initialLink) {
    await initialLink.click({ force: true });
    await settleAfterNavigation(page);
    return;
  }

  // The authenticated shell can retain fmenu/fmain while hiding the visual
  // fund menu after another product navigation. Use Yuanta's own menuaction
  // hook before waiting for a visible menu or re-authenticating.
  if (await runFundMenuAction(page, actionFragment, menuId, 2_000)) return;

  await revealFundMenu(page);
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator(`a[onclick*="${actionFragment}"]`)
        .filter({ hasText: label }),
    description,
    10_000,
  ).catch(() => null);

  const link =
    scope &&
    (await firstVisibleLocator(
      scope
        .locator(`a[onclick*="${actionFragment}"]`)
        .filter({ hasText: label }),
      description,
      5_000,
    ).catch(() => null));
  if (link) {
    await link.click({ force: true });
    await settleAfterNavigation(page);
    return;
  }

  if (await runFundMenuAction(page, actionFragment, menuId, 10_000)) return;

  throw new Error(`Could not click ${description}.`);
}

async function findMenuActionScope(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasMenuAction = await scope
        .evaluate(() => {
          const yuanTaWindow = window as typeof window & {
            menuaction?: unknown;
          };
          return typeof yuanTaWindow.menuaction === "function";
        })
        .catch(() => false);
      if (hasMenuAction) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Could not find YuanTa menuaction() in any frame.");
}

async function runFundMenuAction(
  page: Page,
  actionFragment: string,
  menuId: string,
  timeoutMs: number,
): Promise<boolean> {
  const menuActionScope = await findMenuActionScope(page, timeoutMs).catch(
    () => null,
  );
  if (!menuActionScope) return false;

  await menuActionScope.evaluate(
    ({ action, id }) => {
      const yuanTaWindow = window as typeof window & {
        menuaction?: (
          menuAction: string,
          menuId: string,
          flag?: string,
        ) => void;
      };
      if (typeof yuanTaWindow.menuaction !== "function") {
        throw new Error("YuanTa page did not expose menuaction().");
      }
      yuanTaWindow.menuaction(action, id, "N");
    },
    { action: actionFragment, id: menuId },
  );
  await settleAfterNavigation(page);
  return true;
}

async function revealFundMenu(page: Page): Promise<void> {
  const fundMenuScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate.locator('a[onclick*="doAction"][onclick*="FUND"]').first(),
    "YuanTa fund top-level menu",
    5_000,
  ).catch(() => null);
  if (!fundMenuScope) return;

  const fundMenu = await firstVisibleLocator(
    fundMenuScope.locator('a[onclick*="doAction"][onclick*="FUND"]'),
    "YuanTa fund top-level menu",
    5_000,
  ).catch(() => null);
  if (!fundMenu) return;

  await fundMenu.click({ force: true });
  await page.waitForTimeout(500);
}

async function waitForFundTables(
  page: Page,
  bodyPattern: RegExp,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasTable = await hasAttachedLocator(
        scope.locator(FUND_TABLE_SELECTOR),
      );
      if (!hasTable) continue;

      const bodyText = cleanText(
        await scope
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
      if (bodyPattern.test(bodyText)) return scope;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function openPortfolioSummary(page: Page): Promise<BrowserScope> {
  await clickFundMenuLink(
    page,
    "fundsummary?TxnType=FundSummary",
    /基金歸戶總覽/,
    "menu_fundSummary",
    "YuanTa fund portfolio summary link",
  );
  return await waitForFundTables(
    page,
    /基金名稱|幣別總計|投資金額/,
    "YuanTa fund portfolio summary tables",
  );
}

async function openInvestmentOverview(page: Page): Promise<BrowserScope> {
  await clickFundMenuLink(
    page,
    "fundsummary?TxnType=unknow",
    /基金投資明細總覽/,
    "menu_fundUknow",
    "YuanTa fund investment detail link",
  );
  return await waitForFundTables(
    page,
    /投資日期|交易編號|基金明細查詢|無持有基金|未持有基金|無基金部位/,
    "YuanTa fund investment detail tables",
  );
}

export function isYuantaFundPositionAbsentText(
  value: string | null | undefined,
): boolean {
  return /無持有基金|未持有基金|無基金部位|沒有基金部位|查無基金/.test(
    cleanText(value),
  );
}

async function openOffHourOrders(page: Page): Promise<BrowserScope> {
  await openInvestmentOverview(page);
  const scope = await waitForFundTables(
    page,
    /doOffhourQuery|營業時間外交易查詢/,
    "YuanTa fund investment overview off-hour link",
  );
  const link = await firstVisibleLocator(
    scope.locator('a[onclick*="doOffhourQuery"]'),
    "YuanTa regular fund off-hour orders link",
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  return await waitForFundTables(
    page,
    /申購基金|轉出基金|查詢起迄日/,
    "YuanTa off-hour fund orders tables",
  );
}

async function queryOffHourOrders(
  page: Page,
  startDate: string,
  endDate: string,
): Promise<BrowserScope> {
  const scope = await findScopeWithSelector(page, "#sdate, #edate");
  await scope.locator("#sdate").fill(startDate);
  await scope.locator("#edate").fill(endDate);

  const responsePromise = page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/nib/tx/offhourqueryandcancel"),
      { timeout: 30_000 },
    )
    .catch(() => null);
  await submitForm(scope, "offhourqueryandcancel?method=query", {});
  await responsePromise;
  await settleAfterNavigation(page);
  return await waitForFundTables(
    page,
    /申購基金|轉出基金|查詢起迄日/,
    "queried YuanTa off-hour fund orders tables",
  );
}

export async function extractFundPositions(
  page: Page,
): Promise<FundPosition[]> {
  const scope = await waitForFundTables(
    page,
    /fundDetail|基金明細查詢|交易編號/,
    "YuanTa fund positions",
  );
  const links = scope.locator('a[onclick*="fundDetail("]');
  const count = await links.count();
  const positions = new Map<string, FundPosition>();

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const onclick = (await link.getAttribute("onclick")) ?? "";
    const match = onclick.match(
      /fundDetail\(['"]([^'"]+)['"],['"]([^'"]+)['"],['"]([^'"]+)['"]\)/,
    );
    if (!match) continue;

    const [, txnType, paperNo, trustNo] = match;
    const rowText = cleanText(
      await link
        .locator("xpath=ancestor::tr[1]")
        .innerText()
        .catch(() => ""),
    );
    const label = cleanText(await link.textContent()) || rowText || paperNo;
    const key = `${txnType}:${paperNo}:${trustNo}`;
    if (!positions.has(key)) {
      positions.set(key, { txnType, paperNo, trustNo, label });
    }
  }

  const result = [...positions.values()];
  if (result.length === 0) {
    const bodyText = await scope
      .locator("body")
      .innerText()
      .catch(() => "");
    if (isYuantaFundPositionAbsentText(bodyText)) {
      throw new StatementComponentAbsentError(
        "No YuanTa fund position is available for this login.",
      );
    }
  }

  return result;
}

async function openFundDetail(
  page: Page,
  position: FundPosition,
): Promise<BrowserScope> {
  const scope = await waitForFundTables(
    page,
    /fundDetail|基金明細查詢|交易編號/,
    "YuanTa fund investment detail tables",
  );

  const responsePromise = page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/nib/tx/fundsummary"),
      { timeout: 30_000 },
    )
    .catch(() => null);
  await submitForm(scope, "fundsummary", {
    TxnType: position.txnType,
    PapernNo: position.paperNo,
    TrustNo: position.trustNo,
  });
  await responsePromise;
  await settleAfterNavigation(page);
  return await waitForFundTables(
    page,
    /交易明細查詢|參考淨值|投資日期/,
    `YuanTa fund detail page for ${position.paperNo}`,
  );
}

async function queryFundTransactions(
  page: Page,
  startDate: string,
  endDate: string,
): Promise<BrowserScope> {
  const scope = await findScopeWithSelector(
    page,
    'input[name="qry_option"], input[name="fundtransactiondetails_sdate"]',
  );

  const responsePromise = page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/nib/tx/fundtransactiondetails"),
      { timeout: 30_000 },
    )
    .catch(() => null);
  await submitForm(scope, "fundtransactiondetails", {
    qry_option: "all_single",
    fundtransactiondetails_sdate: startDate,
    fundtransactiondetails_edate: endDate,
    TxnType: "FundSingleDetail",
  });

  await responsePromise;
  await settleAfterNavigation(page);
  return await waitForFundTables(
    page,
    /查詢日期|申購匯率|贖回日期|轉出日期|入帳日期|分配日期|查無資料/,
    "YuanTa fund transaction history tables",
  );
}

async function submitForm(
  scope: BrowserScope,
  action: string,
  values: Record<string, string>,
): Promise<void> {
  await scope
    .locator("form#mform, form[name='mform']")
    .first()
    .evaluate(
      (formElement, { action: formAction, values: formValues }) => {
        const form = formElement as HTMLFormElement;
        for (const [name, value] of Object.entries(formValues)) {
          const byName = form.elements.namedItem(name);
          const element = byName instanceof RadioNodeList ? byName[0] : byName;
          if (element && "value" in element) {
            (element as HTMLInputElement).value = value;
            continue;
          }

          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          form.appendChild(input);
        }

        form.action = formAction;
        form.submit();
      },
      { action, values },
    );
}

async function parseFundTables(
  page: Page,
  category: string,
  fund: string | null,
  period: string | null,
  options: Readonly<{ sourceText?: SourceTextPort; signal?: AbortSignal }> = {},
): Promise<ParsedTable[]> {
  options.signal?.throwIfAborted();
  const scope = await findScopeWithSelector(page, FUND_TABLE_SELECTOR);
  options.sourceText?.assertIntact(await scope.locator("body").innerHTML());
  const tables = scope.locator(FUND_TABLE_SELECTOR);
  const count = await tables.count();
  const parsed: ParsedTable[] = [];

  for (let tableIndex = 0; tableIndex < count; tableIndex += 1) {
    const table = tables.nth(tableIndex);
    const { rows, cellColspans } = await parseHtmlTableRows(table);
    if (rows.length === 0) continue;

    const tableLabel = classifyTable(category, rows, tableIndex);
    parsed.push({
      category,
      fund,
      period,
      tableLabel,
      rows,
      cellColspans,
    });
  }

  if (parsed.length === 0) {
    throw new Error(`No YuanTa fund tables found for ${category}.`);
  }

  options.sourceText?.assertIntact(JSON.stringify(parsed));

  return parsed;
}

async function parseHtmlTableRows(
  table: Locator,
): Promise<ParsedHtmlTableRows> {
  const rows = table.locator("tr");
  const rowCount = await rows.count();
  const parsedRows: string[][] = [];
  const parsedCellColspans: number[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("th, td");
    const cellCount = await cells.count();
    const values: string[] = [];
    const cellColspans: number[] = [];

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      const cell = cells.nth(cellIndex);
      values.push(cleanText(await cell.innerText()));
      const rawColspan = await cell.getAttribute("colspan");
      const colspan = rawColspan ? Number.parseInt(rawColspan, 10) : 1;
      cellColspans.push(Number.isInteger(colspan) && colspan > 0 ? colspan : 1);
    }

    if (values.some((value) => value.length > 0)) {
      parsedRows.push(values);
      parsedCellColspans.push(cellColspans);
    }
  }

  if (parsedRows.length === 0) {
    const text = cleanText(await table.innerText());
    if (text) {
      parsedRows.push([text]);
      parsedCellColspans.push([1]);
    }
  }

  return { rows: parsedRows, cellColspans: parsedCellColspans };
}

function classifyTable(
  category: string,
  rows: string[][],
  tableIndex: number,
): string {
  const text = rows.flat().join(" ");

  if (/基金名稱.*基金類型.*投資幣別/.test(text)) return "portfolio-summary";
  if (/投資日期.*基金名稱.*交易編號.*累積配息/.test(text)) {
    return "investment-detail";
  }
  if (/幣別總計.*投資金額/.test(text)) return "currency-total";
  if (/參考項目.*參考基準日.*參考淨值/.test(text)) {
    return "reference-nav";
  }
  if (/交易功能項目.*確認送出/.test(text)) {
    return "transaction-query-form";
  }
  if (/查詢日期.*查詢基金/.test(text)) return "transaction-query-summary";
  if (/投資日期.*申購匯率.*申購淨值.*申購單位數/.test(text)) {
    return "buy-details";
  }
  if (/贖回日期.*入帳帳號.*入帳淨額/.test(text)) {
    return "redemption-details";
  }
  if (/轉出日期.*轉入日期.*轉出基金.*轉入基金/.test(text)) {
    return "conversion-details";
  }
  if (/入帳日期.*分配金額.*入帳帳號/.test(text)) {
    return "cash-dividend-details";
  }
  if (/分配日期.*分配單位數/.test(text)) {
    return "unit-dividend-details";
  }
  if (/申購基金.*投資類型.*申購日期/.test(text)) {
    return "offhour-buy-orders";
  }
  if (/轉出基金.*轉換方式.*轉入基金/.test(text)) {
    return "offhour-conversion-orders";
  }
  if (/再申購基金.*預估再申購手續費率/.test(text)) {
    return "offhour-redemption-rebuy-orders";
  }
  if (/贖回基金.*贖回方式.*贖回轉入帳號/.test(text)) {
    return "offhour-redemption-orders";
  }
  if (/異動基金.*異動種類.*變更後設定值/.test(text)) {
    return "offhour-change-orders";
  }
  if (/查詢起迄日/.test(text)) return "offhour-query-form";

  return `${category}-table-${tableIndex + 1}`;
}

function headerScore(row: string[]): number {
  return row.filter((value) =>
    /日期|基金|交易|投資|金額|幣別|單位|淨值|帳號|類型|損益|報酬率/.test(value),
  ).length;
}

function findHeaderRowIndex(table: ParsedTable): number {
  let bestIndex = -1;
  let bestScore = 0;

  for (let index = 0; index < table.rows.length; index += 1) {
    const score = headerScore(table.rows[index]);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestScore > 0) return bestIndex;
  return table.rows[0].some((header) => header.length > 0) ? 0 : -1;
}

function alignValuesToHeaders(values: string[], headers: string[]): string[] {
  const aligned = [...values];
  while (aligned.length > headers.length && !aligned[0]) {
    aligned.shift();
  }
  return aligned;
}

function isRepeatedHeaderRow(values: string[], headers: string[]): boolean {
  if (values.length !== headers.length) return false;
  return values.every((value, index) => !value || value === headers[index]);
}

function tableHasNoData(table: ParsedTable): boolean {
  const text = table.rows.flat().join(" ");
  return /查無資料|無資料|無交易明細/.test(text);
}

function normalizedRowsForTable(table: ParsedTable): NormalizedRow[] {
  const config = tableOutputConfigsByLabel[table.tableLabel];
  if (!config) return [];
  if (tableHasNoData(table)) return [];

  const headerRowIndex = findMatchingHeaderRowIndex(table, config.rawColumns);
  if (headerRowIndex < 0) return [];

  const rows: NormalizedRow[] = [];

  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < table.rows.length;
    rowIndex += 1
  ) {
    const values = normalizedRawRowValues(table, rowIndex, config.rawColumns);
    if (!values.some((value) => value.length > 0)) continue;
    if (values.length !== config.rawColumns.length) continue;
    if (isRepeatedHeaderRow(values, config.rawColumns)) continue;

    const rowColumns: Record<string, string> = {};
    for (let columnIndex = 0; columnIndex < values.length; columnIndex += 1) {
      const header =
        config.rawColumns[columnIndex] ?? `column_${columnIndex + 1}`;
      rowColumns[header] = values[columnIndex] ?? "";
    }

    const normalizedValues = config.normalize(rowColumns);
    if (normalizedValues.length !== config.headers.length) {
      throw new Error(
        `Normalized YuanTa fund table ${table.tableLabel} produced ${normalizedValues.length} values for ${config.headers.length} headers.`,
      );
    }
    if (!normalizedValues.some((value) => value.length > 0)) continue;

    rows.push({
      category: table.category,
      fund: table.fund,
      period: table.period,
      values: normalizedValues,
    });
  }

  return rows;
}

function normalizedRawRowValues(
  table: ParsedTable,
  rowIndex: number,
  columns: string[],
): string[] {
  const rawValues = table.rows[rowIndex] ?? [];
  const rawColspans = table.cellColspans?.[rowIndex];

  // YuanTa's reference-NAV table has four logical columns, but the last
  // value cell spans the value and empty lookup columns. Preserve the source
  // value in its original column and add only the represented empty column.
  if (
    table.tableLabel === "reference-nav" &&
    rawValues.length === 3 &&
    rawColspans?.length === 3 &&
    rawColspans[0] === 1 &&
    rawColspans[1] === 1 &&
    rawColspans[2] === 2
  ) {
    return [...rawValues, ""];
  }

  if (table.tableLabel === "reference-nav") {
    const aligned = alignValuesToHeaders(rawValues, columns);
    const hasOnlyUnitColspans =
      !rawColspans || rawColspans.every((colspan) => colspan === 1);
    if (aligned.length === columns.length && hasOnlyUnitColspans) {
      return aligned;
    }
    throw new Error(
      `YuanTa reference-NAV row ${rowIndex} has an unsupported source shape.`,
    );
  }

  return alignValuesToHeaders(rawValues, columns);
}

function findMatchingHeaderRowIndex(
  table: ParsedTable,
  columns: string[],
): number {
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = alignValuesToHeaders(table.rows[index], columns);
    if (row.length !== columns.length) continue;

    const sameCellCount = row.filter(
      (value, cellIndex) => value === columns[cellIndex],
    ).length;
    if (sameCellCount >= Math.max(2, Math.floor(columns.length * 0.6))) {
      return index;
    }
  }

  return findHeaderRowIndex(table);
}

function addIfPresent(values: Set<string>, value: string | null): void {
  if (value) values.add(value);
}

async function captureTables(
  page: Page,
  parsedTables: ParsedTable[],
  category: string,
  fund: string | null,
  period: string | null,
  options: Readonly<{ sourceText?: SourceTextPort; signal?: AbortSignal }> = {},
): Promise<void> {
  const tables = await parseFundTables(page, category, fund, period, options);
  for (const table of tables) {
    parsedTables.push(table);
  }
}

type YuantaFundValuationBasis = {
  fundKey: string;
  navEffectiveOn: string;
  fxEffectiveOn: string;
};

const fundPositionKey = (position: FundPosition): string =>
  [position.txnType, position.paperNo, position.trustNo]
    .map(encodeURIComponent)
    .join(":");

function parseFundPositionKey(value: string): FundPosition {
  const parts = value.split(":").map(decodeURIComponent);
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("YuanTa fund source evidence has no stable position key.");
  }
  return {
    txnType: parts[0]!,
    paperNo: parts[1]!,
    trustNo: parts[2]!,
    label: parts[1]!,
  };
}

function canonicalSourceDate(value: string): string {
  const normalized = value.trim().replaceAll("/", "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error("YuanTa fund source basis date is missing.");
  }
  return normalized;
}

function canonicalCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  const aliases: Record<string, string> = {
    台幣: "TWD",
    新臺幣: "TWD",
    新台幣: "TWD",
    美元: "USD",
    日圓: "JPY",
    歐元: "EUR",
    人民幣: "CNY",
  };
  return aliases[normalized] ?? normalized;
}

export function canonicalYuantaFundCurrency(value: string): string {
  return canonicalCurrency(value);
}

function canonicalExactAmount(value: string): {
  coefficient: string;
  scale: number;
} {
  if (value.includes("-")) {
    throw new Error("YuanTa fund amount must be non-negative.");
  }
  const normalized = value.replaceAll(",", "").replace(/[^0-9.]/g, "");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error("YuanTa fund amount is not an exact decimal.");
  return {
    coefficient: `${match[1]}${match[2] ?? ""}`.replace(/^0+(?=\d)/, ""),
    scale: match[2]?.length ?? 0,
  };
}

function normalizedColumnRecords(
  table: ParsedTable,
): Array<Record<string, string>> {
  const config = tableOutputConfigsByLabel[table.tableLabel];
  if (!config) return [];
  return normalizedRowsForTable(table).map((row) =>
    Object.fromEntries(
      config.headers.map((header, index) => [header, row.values[index] ?? ""]),
    ),
  );
}

export function parseYuantaFundValuationBasis(
  table: ParsedTable,
): YuantaFundValuationBasis {
  if (table.tableLabel !== "reference-nav" || !table.fund) {
    throw new Error(
      "YuanTa fund valuation basis table is not position-scoped.",
    );
  }
  const rows = normalizedColumnRecords(table);
  const nav = rows.find((row) => row["參考項目"]?.trim() === "贖回");
  const fx = rows.find((row) => row["參考項目"]?.trim() === "匯率");
  if (!nav?.["參考基準日"] || !fx?.["參考基準日"]) {
    throw new Error(
      "YuanTa fund valuation requires source-reported NAV and FX basis dates.",
    );
  }
  return {
    fundKey: table.fund,
    navEffectiveOn: canonicalSourceDate(nav["參考基準日"]),
    fxEffectiveOn: canonicalSourceDate(fx["參考基準日"]),
  };
}

function positionForTransactionNumber(
  positions: readonly FundPosition[],
  sourceIdentityText: string,
): FundPosition | undefined {
  const normalized = sourceIdentityText.replace(/\s+/g, "");
  const matches = positions.filter((position) => {
    const trustNo = position.trustNo.replace(/\s+/g, "");
    const label = position.label.replace(/\s+/g, "");
    return (
      normalized === trustNo ||
      normalized.includes(trustNo) ||
      (label.length > 0 && normalized.includes(label))
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

type YuantaFundCanonicalAdmission =
  | {
      status: "admitted";
      contractVersion: "yuanta-fund/investment/canonical-v1";
      holdingCount: number;
      transactionCount: number;
    }
  | {
      status: "partial";
      contractVersion: "yuanta-fund/investment/canonical-v1";
      holdingCount: number;
      transactionCount: number;
      reason:
        | "no-investment-holding-evidence"
        | "source-effective-time-evidence-incomplete";
    }
  | {
      status: "not-admitted";
      reason:
        | "no-investment-holding-evidence"
        | "source-effective-time-evidence-incomplete"
        | "transaction-source-evidence-incomplete";
    };

function fundCurrencyByPositionKey(
  holdingRows: readonly Record<string, string>[],
  positions: readonly FundPosition[],
): Map<string, string> {
  const currencies = new Map<string, string>();
  for (const row of holdingRows) {
    const position = positionForTransactionNumber(
      positions,
      `${row["交易編號"] ?? ""} ${row["基金名稱"] ?? ""}`,
    );
    if (!position) {
      throw new Error("fund holding has no stable provider position");
    }
    const currency = canonicalCurrency(row["投資幣別"] ?? "");
    if (!currency) throw new Error("fund holding has no source currency");
    const key = fundPositionKey(position);
    const previous = currencies.get(key);
    if (previous && previous !== currency) {
      throw new Error("fund holding currency changed within one position");
    }
    currencies.set(key, currency);
  }
  return currencies;
}

function yuantaFundTransactionRows(
  tables: readonly ParsedTable[],
  positions: readonly FundPosition[],
  currencyByPosition: ReadonlyMap<string, string>,
): YuantaCanonicalInvestmentRow[] {
  const transactions: YuantaCanonicalInvestmentRow[] = [];
  for (const table of tables) {
    if (
      !table.fund ||
      !["buy-details", "redemption-details"].includes(table.tableLabel)
    ) {
      continue;
    }
    const position = parseFundPositionKey(table.fund);
    if (
      !positions.some(
        (candidate) => fundPositionKey(candidate) === fundPositionKey(position),
      )
    ) {
      throw new Error("fund transaction has no selected provider position");
    }
    const action = table.tableLabel === "buy-details" ? "buy" : "sell";
    const currency = currencyByPosition.get(fundPositionKey(position));
    if (!currency) {
      throw new Error("fund transaction has no source security currency");
    }
    for (const row of normalizedColumnRecords(table)) {
      const effectiveOn = canonicalSourceDate(
        row[action === "buy" ? "投資日期" : "贖回日期"] ?? "",
      );
      const quantityValue =
        row[action === "buy" ? "申購單位數" : "贖回單位數"] ?? "";
      const cashValue = row[action === "buy" ? "投資金額" : "入帳淨額"] ?? "";
      transactions.push({
        sourceRecordKey: deriveSourceConnectionIdentityKey(
          "yuanta-fund-transaction-record",
          [
            position.paperNo,
            position.trustNo,
            row["交易編號"] ?? "",
            action,
            effectiveOn,
            quantityValue,
            cashValue,
          ],
        ),
        producerSecurityId: position.paperNo,
        securityName: row["基金名稱"]?.trim() || undefined,
        currency,
        effectiveOn,
        action,
        quantity: canonicalExactAmount(quantityValue),
        cashEffect: { ...canonicalExactAmount(cashValue), currency },
      });
    }
  }
  return transactions;
}

/** A canonical holding is admissible only when every overview lot can be
 * joined to position-scoped source evidence for its financial effective date.
 * If the provider's historical buy/redemption table exposes an economic date,
 * those transactions may still be admitted when the current holding snapshot
 * has no source-reported as-of date. */
export function evaluateYuantaFundCanonicalAdmission(
  tables: readonly ParsedTable[],
  positions: readonly FundPosition[] = [],
): YuantaFundCanonicalAdmission {
  const holdingRows = tables
    .filter(
      (table) =>
        table.tableLabel === "investment-detail" &&
        table.category === "investment-overview",
    )
    .flatMap(normalizedColumnRecords);
  let transactionRows: YuantaCanonicalInvestmentRow[];
  try {
    transactionRows = yuantaFundTransactionRows(
      tables,
      positions,
      fundCurrencyByPositionKey(holdingRows, positions),
    );
  } catch {
    return {
      status: "not-admitted",
      reason: "transaction-source-evidence-incomplete",
    };
  }
  const transactionCount = transactionRows.length;
  if (holdingRows.length === 0) {
    return transactionCount > 0
      ? {
          status: "partial",
          contractVersion: "yuanta-fund/investment/canonical-v1",
          holdingCount: 0,
          transactionCount,
          reason: "no-investment-holding-evidence",
        }
      : {
          status: "not-admitted",
          reason: "no-investment-holding-evidence",
        };
  }
  try {
    const currencyByPosition = fundCurrencyByPositionKey(
      holdingRows,
      positions,
    );
    const basisByFund = new Map(
      tables
        .filter((table) => table.tableLabel === "reference-nav")
        .map(parseYuantaFundValuationBasis)
        .map((basis) => [basis.fundKey, basis]),
    );
    for (const row of holdingRows) {
      const position = positionForTransactionNumber(
        positions,
        `${row["交易編號"] ?? ""} ${row["基金名稱"] ?? ""}`,
      );
      if (
        !position ||
        !basisByFund.has(fundPositionKey(position)) ||
        !currencyByPosition.has(fundPositionKey(position))
      ) {
        throw new Error("holding lot has no position-scoped valuation basis");
      }
    }
    return {
      status: "admitted",
      contractVersion: "yuanta-fund/investment/canonical-v1",
      holdingCount: holdingRows.length,
      transactionCount,
    };
  } catch {
    return transactionCount > 0
      ? {
          status: "partial",
          contractVersion: "yuanta-fund/investment/canonical-v1",
          holdingCount: holdingRows.length,
          transactionCount,
          reason: "source-effective-time-evidence-incomplete",
        }
      : {
          status: "not-admitted",
          reason: "source-effective-time-evidence-incomplete",
        };
  }
}

export function assertYuantaFundCanonicalAdmission(
  admission: YuantaFundCanonicalAdmission,
): asserts admission is Extract<
  YuantaFundCanonicalAdmission,
  { status: "admitted" }
> {
  if (admission.status === "admitted") return;
  if (admission.status === "partial") {
    const holdingEvidenceMessage =
      admission.reason === "no-investment-holding-evidence"
        ? "no current holding observation was captured"
        : "the source did not report a holding effective date";
    throw new CanonicalInvestmentAdmissionError(
      `Yuanta fund canonical admission partial: ${admission.reason}. ` +
        `${admission.transactionCount} dated transaction row(s) were rejected; ` +
        `the complete source was not admitted because ${holdingEvidenceMessage}.`,
    );
  }
  throw new CanonicalInvestmentAdmissionError(
    `Yuanta fund canonical admission failed: ${admission.reason}. ` +
      "Canonical Financial Commit was not opened.",
  );
}

function collectYuantaFundCanonicalItems(
  credentials: YuantaCredentials,
  positions: readonly FundPosition[],
  tables: readonly ParsedTable[],
  options: Readonly<{
    deferredCommitItems: PGliteWorkflowRunItem[];
    sourceText: SourceTextPort;
    signal: AbortSignal;
    now(): string;
  }>,
): number {
  const admission = evaluateYuantaFundCanonicalAdmission(tables, positions);
  assertYuantaFundCanonicalAdmission(admission);

  const overviewRows = tables
    .filter(
      (table) =>
        table.tableLabel === "investment-detail" &&
        table.category === "investment-overview",
    )
    .flatMap(normalizedColumnRecords);
  const currencyByPosition = fundCurrencyByPositionKey(overviewRows, positions);
  const basisByFund = new Map(
    tables
      .filter((table) => table.tableLabel === "reference-nav")
      .map(parseYuantaFundValuationBasis)
      .map((basis) => [basis.fundKey, basis]),
  );
  const holdings: YuantaCanonicalInvestmentRow[] = overviewRows.map((row) => {
    const position = positionForTransactionNumber(
      positions,
      `${row["交易編號"] ?? ""} ${row["基金名稱"] ?? ""}`,
    );
    if (!position) {
      throw new Error("YuanTa fund holding has no stable producer position.");
    }
    const basis = basisByFund.get(fundPositionKey(position));
    if (!basis) {
      throw new Error("YuanTa fund holding has no valuation basis evidence.");
    }
    const currency = currencyByPosition.get(fundPositionKey(position));
    if (!currency) {
      throw new Error("YuanTa fund holding has no source currency.");
    }
    const usesReferenceFx = currency === "TWD";
    const effectiveOn = usesReferenceFx
      ? [basis.navEffectiveOn, basis.fxEffectiveOn].sort().at(-1)!
      : basis.navEffectiveOn;
    const sourceRecordKey = deriveSourceConnectionIdentityKey(
      "yuanta-fund-holding-record",
      [
        position.paperNo,
        position.trustNo,
        effectiveOn,
        row["單位數"] ?? "",
        row["不含息參考市值"] ?? "",
      ],
    );
    return {
      sourceRecordKey,
      producerSecurityId: position.paperNo,
      securityName: row["基金名稱"]?.trim() || undefined,
      currency,
      effectiveOn,
      quantity: canonicalExactAmount(row["單位數"] ?? ""),
      valuation: {
        ...canonicalExactAmount(row["不含息參考市值"] ?? ""),
        currency,
      },
      effectiveTimeEvidence: {
        sourceField: usesReferenceFx
          ? "reference-nav-and-fx-basis-date"
          : "reference-nav-basis-date",
        components: [
          {
            role: "reference-nav" as const,
            sourceField: "贖回/參考基準日",
            value: basis.navEffectiveOn,
          },
          ...(usesReferenceFx
            ? [
                {
                  role: "reference-fx" as const,
                  sourceField: "匯率/參考基準日",
                  value: basis.fxEffectiveOn,
                },
              ]
            : []),
        ],
      },
    };
  });
  const transactions = yuantaFundTransactionRows(
    tables,
    positions,
    currencyByPosition,
  );

  const sourceConnectionKey = deriveSourceConnectionIdentityKey("yuanta-fund", [
    credentials.yuanta_user_id ?? "",
    credentials.yuanta_account ?? "",
  ]);
  const accountKey = deriveSourceConnectionIdentityKey("yuanta-fund-account", [
    sourceConnectionKey,
    credentials.yuanta_account ?? "",
  ]);
  const observedAt = options.now();
  const captureGroups = new Map<
    string,
    {
      holdings: YuantaCanonicalInvestmentRow[];
      transactions: YuantaCanonicalInvestmentRow[];
    }
  >();
  for (const holding of holdings) {
    const group = captureGroups.get(holding.effectiveOn) ?? {
      holdings: [],
      transactions: [],
    };
    group.holdings.push(holding);
    captureGroups.set(holding.effectiveOn, group);
  }
  if (holdings.length > 0) {
    const firstGroup = captureGroups.values().next().value as
      | {
          holdings: YuantaCanonicalInvestmentRow[];
          transactions: YuantaCanonicalInvestmentRow[];
        }
      | undefined;
    if (firstGroup) firstGroup.transactions = transactions;
  } else {
    for (const transaction of transactions) {
      const group = captureGroups.get(transaction.effectiveOn) ?? {
        holdings: [],
        transactions: [],
      };
      group.transactions.push(transaction);
      captureGroups.set(transaction.effectiveOn, group);
    }
  }
  const captures: InvestmentValidatedCapture[] = [];
  for (const [sourceEffectiveOn, group] of captureGroups) {
    const capture = buildYuantaInvestmentCapture({
      sourceId: "yuanta-fund",
      captureId: `yuanta-fund-investment:${deriveSourceConnectionIdentityKey("yuanta-fund-capture", [sourceConnectionKey, accountKey, sourceEffectiveOn, observedAt])}`,
      sourceConnectionKey,
      identityEpochKey: deriveSourceConnectionIdentityKey("yuanta-fund-epoch", [
        sourceConnectionKey,
        credentials.yuanta_account ?? "",
      ]),
      accountKey,
      reportingCurrency: "TWD",
      observedAt,
      sourceEffectiveOn,
      holdings: group.holdings,
      transactions: group.transactions,
    });
    captures.push(admitCanonicalInvestmentCapture(capture));
  }
  if (captures.length === 0)
    throw new Error("Yuanta fund admission produced no canonical captures.");
  const items: PGliteWorkflowRunItem[] = captures.map((capture) => ({
    provider: "yuanta-fund",
    product: "investment",
    itemKey: capture.captureId,
    command: {
      kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
      request: { capture },
    },
    relationCommands: () => [
      {
        kind: PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
        request: {
          sourceConnectionKey: capture.identity.sourceConnectionKey,
          observedAt: capture.observedAt,
        },
      },
    ],
  }));
  options.signal.throwIfAborted();
  for (const item of items)
    options.sourceText.assertIntact(JSON.stringify(item.command));
  options.signal.throwIfAborted();
  options.deferredCommitItems.push(...items);
  return items.length;
}

export type YuantaFundWorkflowCollection = Readonly<{
  sourceCount: number;
  rowCount: number;
  itemCount: number;
}>;

type YuantaFundSourceTables = Readonly<{
  positions: readonly FundPosition[];
  tables: readonly ParsedTable[];
}>;

type YuantaFundSourceCollector = (
  page: Page,
  input: WorkflowInput,
  context: Readonly<{ sourceText: SourceTextPort; signal: AbortSignal }>,
) => Promise<YuantaFundSourceTables>;

export type YuantaFundWorkflowDependencies = Readonly<{
  collectOnly: true;
  deferredCommitItems: PGliteWorkflowRunItem[];
  sourceText: SourceTextPort;
  signal: AbortSignal;
  now(): string;
  collectSourceTables?: YuantaFundSourceCollector;
}>;

async function collectYuantaFundSourceTables(
  page: Page,
  input: WorkflowInput,
  context: Readonly<{ sourceText: SourceTextPort; signal: AbortSignal }>,
): Promise<YuantaFundSourceTables> {
  const dateRange = resolveDateRange(input);
  const tables: ParsedTable[] = [];
  let positions: FundPosition[] = [];
  const checkCancelled = () => context.signal.throwIfAborted();

  if (input.includePortfolioSummary) {
    checkCancelled();
    await openPortfolioSummary(page);
    await captureTables(page, tables, "portfolio-summary", null, null, context);
  }

  if (input.includeInvestmentDetails || input.includeHistoricalTransactions) {
    checkCancelled();
    await openInvestmentOverview(page);
    positions = await extractFundPositions(page);
    await captureTables(
      page,
      tables,
      "investment-overview",
      null,
      null,
      context,
    );
    if (positions.length === 0)
      throw new Error("Could not find matching YuanTa fund positions.");

    for (const position of positions) {
      checkCancelled();
      await openInvestmentOverview(page);
      await openFundDetail(page, position);
      await captureTables(
        page,
        tables,
        "investment-source-evidence",
        fundPositionKey(position),
        null,
        context,
      );
      if (input.includeHistoricalTransactions) {
        await queryFundTransactions(
          page,
          dateRange.startDate,
          dateRange.endDate,
        );
        await captureTables(
          page,
          tables,
          "historical-transactions",
          fundPositionKey(position),
          dateRange.label,
          context,
        );
      }
    }
  }

  if (input.includeOffHourOrders) {
    checkCancelled();
    await openOffHourOrders(page);
    await queryOffHourOrders(page, dateRange.startDate, dateRange.endDate);
    await captureTables(
      page,
      tables,
      "offhour-orders",
      null,
      dateRange.label,
      context,
    );
  }

  checkCancelled();
  return { positions, tables };
}

export async function runYuantaFundStatements(
  page: Page,
  input: WorkflowInput,
  credentials: YuantaCredentials,
  dependencies: YuantaFundWorkflowDependencies,
): Promise<YuantaFundWorkflowCollection> {
  dependencies.signal.throwIfAborted();
  const sourceCollection = await (
    dependencies.collectSourceTables ?? collectYuantaFundSourceTables
  )(page, input, {
    sourceText: dependencies.sourceText,
    signal: dependencies.signal,
  });
  dependencies.signal.throwIfAborted();
  dependencies.sourceText.assertIntact(JSON.stringify(sourceCollection.tables));

  const itemCount = collectYuantaFundCanonicalItems(
    credentials,
    sourceCollection.positions,
    sourceCollection.tables,
    dependencies,
  );
  return {
    sourceCount: sourceCollection.tables.length,
    rowCount: sourceCollection.tables.reduce(
      (count, table) => count + table.rows.length,
      0,
    ),
    itemCount,
  };
}
