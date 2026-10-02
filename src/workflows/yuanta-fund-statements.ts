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
  assignYuantaInvestmentTransactionOccurrences,
  buildYuantaInvestmentCapture,
  type YuantaCanonicalInvestmentRow,
} from "../ledger/canonical/yuanta-investment-adapters.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import type { CanonicalOccurrenceGroupCoverage } from "../ledger/canonical/occurrence-groups.ts";
import { hasAttachedLocator } from "./browser-interaction.js";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import { aggregateYuantaFundHoldingLots } from "./yuanta-fund-holdings.ts";
import { yuantaFundAdditionalEventRows } from "./yuanta-fund-events.ts";
import { resolveYuantaFundCatalogName, resolveYuantaFundIdentity, yuantaFundCatalogName, type YuantaFundCatalogEntry } from "./yuanta-fund-catalog.ts";
import { assertYuantaFundHistoryQueryRequest } from "./yuanta-fund-history-query.ts";
import { yuantaFundAccountHistoryQueries, yuantaFundAccountHistoryKey, yuantaFundAccountHistoryType, yuantaFundAccountHistoryScope, yuantaFundAccountHistoryQueryFields, yuantaFundAccountHistoryTableLabels, yuantaFundSourceAmountCurrency, yuantaFundHistoryInvestmentTypes, type YuantaFundAccountHistoryQuery } from "./yuanta-fund-account-history.ts";
import type { YuantaCredentials } from "./yuanta-auth.ts";

const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";
const YUANTA_FUND_INVESTMENT_CONTRACT_VERSION =
  "yuanta-fund/investment/canonical-v1" as const;
const FUND_TABLE_SELECTOR =
  "table.rwdTable, table.normalTable, table.formTable";

type BrowserScope = Page | Frame;

type FundPosition = {
  // Bank form parameters: route, transaction number, native fund code.
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
  cellLines?: string[][][];
  historyQuery?: YuantaFundAccountHistoryQuery;
};

type ParsedHtmlTableRows = {
  rows: string[][];
  cellColspans: number[][];
  cellLines: string[][][];
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

tableOutputConfigsByLabel["redemption-account-details"] = {
  rawColumns: ["贖回日期 分配日期", "基金名稱 交易編號", "贖回投資金額 單位數", "贖回價格 贖回匯率",
    "信託管理費 短線費用", "入帳帳號 入帳淨額", "贖回參考損益 參考贖回報酬率", "預計入帳"],
  headers: tableOutputConfigsByLabel["redemption-details"].headers,
  normalize: columns => tableOutputConfigsByLabel["redemption-details"].normalize({
    ...columns, "遞延手續費": "", "備註": columns["預計入帳"] ?? "",
  }),
};
for (const variable of [false, true]) {
  tableOutputConfigsByLabel[variable ? "variable-deduction-details" : "deduction-details"] = {
    rawColumns: variable
      ? ["基金名稱 交易編號", "扣款日期", "扣款帳號/信用卡卡號", "投資金額", "當次扣款比重", "手續費", "申購單位數", "申購匯率", "申購淨值"]
      : ["扣款日期", "基金名稱 交易編號", "扣款帳號/信用卡卡號", "投資金額", "手續費", "申購單位數", "申購匯率", "申購淨值"],
    headers: [...tableOutputConfigsByLabel["buy-details"].headers, "扣款帳號/信用卡卡號", "當次扣款比重"],
    normalize: columns => {
      const [name, transactionNo] = splitFundNameAndTransactionNo(columns["基金名稱 交易編號"] ?? "");
      return [columns["扣款日期"] ?? "", name, transactionNo, columns["投資金額"] ?? "",
        columns["申購匯率"] ?? "", columns["申購淨值"] ?? "", columns["手續費"] ?? "", "",
        columns["申購單位數"] ?? "", columns["扣款帳號/信用卡卡號"] ?? "", columns["當次扣款比重"] ?? ""];
    },
  };
}
const fundPurchaseTableLabels = ["buy-details", "deduction-details", "variable-deduction-details"];
const fundRedemptionTableLabels = ["redemption-details", "redemption-account-details"];
const fundFinancialHistoryTableLabels = [...fundPurchaseTableLabels, ...fundRedemptionTableLabels,
  "conversion-details", "cash-dividend-details", "unit-dividend-details"];

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

export function splitWhitespacePair(value: string): [string, string] {
  const lines = value.split(/\r?\n/u).map(cleanText).filter(Boolean);
  if (lines.length > 2) {
    throw new Error("YuanTa paired cell has more than two source lines.");
  }
  if (lines.length === 2) return [lines[0], lines[1]];
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
  allowEmptyHistory = false,
): Promise<FundPosition[]> {
  const scope = await waitForFundTables(
    page,
    /fundDetail|基金明細查詢|交易編號|無持有基金|未持有基金|無基金部位|查無基金/,
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
      if (allowEmptyHistory) return [];
      throw new StatementComponentAbsentError(
        "No YuanTa fund position is available for this login.",
      );
    }
  }

  return result;
}

export function yuantaFundHistoryResultIsUnpaged(markup: string): boolean {
  return !/(?:class|id)\s*=\s*["'][^"']*\b(?:pager|pagination)\b|\b(?:下一頁|下頁|next\s*page)\b|\b(?:currentPage|pageIndex|pageNo|pageNumber|pageSize)\b/iu.test(
    markup,
  );
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

async function queryAccountFundTransactions(
  page: Page,
  query: YuantaFundAccountHistoryQuery,
  startDate: string,
  endDate: string,
): Promise<void> {
  // Re-enter the general account query: detail-page fields can retain a lot filter.
  await clickFundMenuLink(page, "fundtransactiondetails", /基金交易明細/, "menu_fundtransactiondetails", "YuanTa account fund history query");
  const scope = await findScopeWithSelector(page, 'input[name="fundtransactiondetails_sdate"]');
  for (const name of ["isFromFundDetail", "is_fromFund"]) {
    const field = scope.locator(`input[name="${name}"]`);
    if (await field.count() && await field.first().inputValue() === "Y")
      throw new Error("YuanTa account fund history retained a position detail scope.");
  }
  const queryFields = yuantaFundAccountHistoryQueryFields(query, startDate, endDate);
  const responsePromise = page.waitForResponse(response =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/nib/tx/fundtransactiondetails", { timeout: 30_000 });
  const [, response] = await Promise.all([
    submitForm(scope, "fundtransactiondetails", queryFields), responsePromise,
  ]);
  if (!response.ok()) throw new Error("YuanTa account fund history response failed.");
  assertYuantaFundHistoryQueryRequest(new URLSearchParams(response.request().postData() ?? ""), queryFields);
  await settleAfterNavigation(page);
  const resultScope = await waitForFundTables(page,
    /查詢日期|申購匯率|贖回日期|轉出日期|入帳日期|分配日期|查無資料/,
    "YuanTa account fund history result");
  if (!yuantaFundHistoryResultIsUnpaged(await resultScope.locator("body").innerHTML()))
    throw new Error("YuanTa account fund history has untraversed pagination.");
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
    const { rows, cellColspans, cellLines } = await parseHtmlTableRows(table);
    if (rows.length === 0) continue;

    const tableLabel = classifyTable(category, rows, tableIndex);
    parsed.push({
      category,
      fund,
      period,
      tableLabel,
      rows,
      cellColspans,
      cellLines,
    });
  }

  if (parsed.length === 0) {
    throw new Error(`No YuanTa fund tables found for ${category}.`);
  }

  options.sourceText?.assertIntact(JSON.stringify(parsed));

  return parsed;
}

export async function parseHtmlTableRows(
  table: Locator,
): Promise<ParsedHtmlTableRows> {
  const rows = table.locator("tr");
  const rowCount = await rows.count();
  const parsedRows: string[][] = [];
  const parsedCellColspans: number[][] = [];
  const parsedCellLines: string[][][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("th, td");
    const cellCount = await cells.count();
    const values: string[] = [];
    const cellColspans: number[] = [];
    const cellLines: string[][] = [];

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      const cell = cells.nth(cellIndex);
      const sourceText = await cell.innerText();
      values.push(cleanText(sourceText));
      cellLines.push(sourceText.split(/\r?\n/u).map(cleanText).filter(Boolean));
      const rawColspan = await cell.getAttribute("colspan");
      const colspan = rawColspan ? Number.parseInt(rawColspan, 10) : 1;
      cellColspans.push(Number.isInteger(colspan) && colspan > 0 ? colspan : 1);
    }

    if (values.some((value) => value.length > 0)) {
      parsedRows.push(values);
      parsedCellColspans.push(cellColspans);
      parsedCellLines.push(cellLines);
    }
  }

  if (parsedRows.length === 0) {
    const text = cleanText(await table.innerText());
    if (text) {
      parsedRows.push([text]);
      parsedCellColspans.push([1]);
      parsedCellLines.push([[text]]);
    }
  }

  return { rows: parsedRows, cellColspans: parsedCellColspans, cellLines: parsedCellLines };
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
  if (/^\*?查詢日期/u.test(rows[0]?.[0] ?? "")) return "transaction-query-summary";
  if (/投資日期.*申購匯率.*申購淨值.*申購單位數/.test(text)) {
    return "buy-details";
  }
  if (/贖回日期.*入帳帳號.*入帳淨額/.test(text)) {
    return /遞延手續費/u.test(rows[findHeaderRowIndex({ rows } as ParsedTable)]?.join(" ") ?? "")
      ? "redemption-details" : "redemption-account-details";
  }
  if (/扣款日期.*申購單位數.*申購匯率.*申購淨值/u.test(text))
    return /當次扣款比重/u.test(text) ? "variable-deduction-details" : "deduction-details";
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
  return values.every((value, index) => !value || cleanText(value) === headers[index]);
}

function tableHasNoData(table: ParsedTable): boolean {
  const text = table.rows.flat().join(" ");
  return /查無資料|無資料|無交易明細/.test(text);
}

function assertYuantaFundHistoryQueryResult(
  tables: readonly ParsedTable[],
  position: FundPosition | string,
): void {
  const positionKey = typeof position === "string" ? position : fundPositionKey(position);
  const scopedTables = tables.filter(
    (table) => table.category === "historical-transactions" && table.fund === positionKey,
  );
  if (scopedTables.length === 0)
    throw new Error("Yuanta fund history result is missing for its requested scope.");

  let explicitEmpty = false;
  let capturedRows = 0;
  for (const table of scopedTables) {
    const hasExplicitEmpty = table.rows.flat().some((cell) => /查無資料/u.test(cell));
    explicitEmpty ||= hasExplicitEmpty;
    if ([...fundPurchaseTableLabels, ...fundRedemptionTableLabels].includes(table.tableLabel)) {
      const rows = normalizedColumnRecords(table);
      if (rows.length === 0 && !hasExplicitEmpty)
        throw new Error(`Yuanta fund ${table.tableLabel} table has no complete row or explicit empty result.`);
      for (const row of rows) {
        const date = canonicalSourceDate(
          row[fundPurchaseTableLabels.includes(table.tableLabel) ? "投資日期" : "贖回日期"] ?? "",
        );
        const quantity = row[fundPurchaseTableLabels.includes(table.tableLabel) ? "申購單位數" : "贖回單位數"] ?? "";
        const cash = row[fundPurchaseTableLabels.includes(table.tableLabel) ? "投資金額" : "入帳淨額"] ?? "";
        if (!quantity.trim() || !cash.trim())
          throw new Error(`Yuanta fund ${table.tableLabel} row is missing transaction amounts.`);
        capturedRows += 1;
        // Validate the source date shape here; its query-range bound is checked
        // against the coverage proof when canonical slots are assigned.
        void date;
      }
      continue;
    }

    if (["conversion-details", "cash-dividend-details", "unit-dividend-details"].includes(table.tableLabel)) {
      const rows = normalizedColumnRecords(table);
      if (rows.length > 0) {
        for (const row of rows) {
          const dateFields = table.tableLabel === "conversion-details" ? ["轉出日期", "轉入日期"]
            : [table.tableLabel === "cash-dividend-details" ? "入帳日期" : "分配日期"];
          dateFields.forEach(field => canonicalSourceDate(row[field] ?? ""));
        }
        capturedRows += rows.length;
        continue;
      }
      if (!hasExplicitEmpty)
        throw new Error(`Yuanta fund ${table.tableLabel} result is not explicitly empty.`);
      continue;
    }

    if (table.tableLabel.startsWith("historical-transactions-table-") &&
        !hasExplicitEmpty && table.rows.flat().some((cell) => cell.trim()))
      throw new Error("Yuanta fund history contains an unrecognized result table.");
  }

  if (capturedRows === 0 && !explicitEmpty)
    throw new Error("Yuanta fund history query did not report rows or an explicit empty result.");
}

export function normalizedRowsForTable(table: ParsedTable): NormalizedRow[] {
  const config = tableOutputConfigsByLabel[table.tableLabel];
  if (!config) return [];
  if (tableHasNoData(table)) {
    if (fundFinancialHistoryTableLabels.includes(table.tableLabel) &&
      table.rows.some(row => row.some(value => /^\d{4}[/-]\d{2}[/-]\d{2}/u.test(cleanText(value)))))
      throw new Error("YuanTa history table contradicts its explicit empty result.");
    return [];
  }

  const headerRowIndex = findMatchingHeaderRowIndex(table, config.rawColumns);
  if (headerRowIndex < 0) return [];

  const sourceHeaders = (table.rows[headerRowIndex] ?? []).map(value => cleanText(value).replace(/\s*\?/gu, ""));
  const scalarOrderRequired = [...fundPurchaseTableLabels, "unit-dividend-details"].includes(table.tableLabel);
  const sourceColumnOrder = scalarOrderRequired
    ? config.rawColumns.map(header => sourceHeaders.indexOf(cleanText(header))) : null;
  const exactSourceColumnOrder = sourceColumnOrder && sourceHeaders.length === config.rawColumns.length &&
    sourceColumnOrder.every(index => index >= 0) && new Set(sourceColumnOrder).size === sourceColumnOrder.length
    ? sourceColumnOrder : null;
  if (scalarOrderRequired && !exactSourceColumnOrder)
    throw new Error("YuanTa scalar history table requires complete unique source headers.");
  const rows: NormalizedRow[] = [];

  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < table.rows.length;
    rowIndex += 1
  ) {
    if (table.tableLabel === "redemption-account-details" && cleanText(table.rows[rowIndex]?.[0]) === "合計") {
      // The observed account report has an eight-cell aggregate footer without
      // merged cells. Require its full label layout before excluding it.
      const footer = table.rows[rowIndex]!;
      const spans = table.cellColspans?.[rowIndex];
      if (spans?.length !== 8 || spans.some(span => span !== 1) || footer.length !== 8 || cleanText(footer[1]) !== "贖回投資金額" ||
        cleanText(footer[3]) !== "贖回參考損益" || cleanText(footer[5]) !== "贖回參考報酬率" ||
        cleanText(footer[7]) !== "")
        throw new Error("YuanTa redemption aggregate footer has an unsupported source shape.");
      continue;
    }
    const sourceValues = normalizedRawRowValues(table, rowIndex, config.rawColumns);
    if (fundFinancialHistoryTableLabels.includes(table.tableLabel) &&
      sourceValues.some(value => value.length > 0) && sourceValues.length !== config.rawColumns.length)
      throw new Error("YuanTa history row has an unsupported source column count.");
    const values = exactSourceColumnOrder ? exactSourceColumnOrder.map(index => sourceValues[index] ?? "") : sourceValues;
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

  if (fundRedemptionTableLabels.includes(table.tableLabel) && table.cellLines?.[rowIndex]) {
    const sourceLines = table.cellLines[rowIndex];
    if (rawValues.length !== columns.length || sourceLines.length !== columns.length)
      throw new Error("YuanTa redemption row has an unsupported source shape.");
    return rawValues.map((value, index) => {
      if (!["贖回日期 分配日期", "基金名稱 交易編號", "贖回投資金額 單位數", "贖回價格 贖回匯率",
        "信託管理費 短線費用", "入帳帳號 入帳淨額", "贖回參考損益 參考贖回報酬率"].includes(columns[index])) return value;
      const logicalLines: string[] = [];
      for (let line = 0; line < sourceLines[index].length; line += 1) {
        const current = sourceLines[index][line];
        if (/^(?:台幣|新臺幣|新台幣|美元|美金|日圓|歐元|港幣|澳幣|人民幣|南非幣|紐幣|英鎊|TWD|USD|JPY|EUR)$/u.test(current) &&
          /^[\d,]+(?:\.\d+)?$/u.test(sourceLines[index][line + 1] ?? "")) {
          logicalLines.push(`${current} ${sourceLines[index][++line]}`);
        } else logicalLines.push(current);
      }
      if (columns[index] === "入帳帳號 入帳淨額" && logicalLines.length === 3) {
        if (!logicalLines[0] || !/^\d+$/u.test(logicalLines[1]!))
          throw new Error("YuanTa redemption account description has an unsupported source shape.");
        yuantaFundSourceAmountCurrency(logicalLines[2]!);
        return `${logicalLines[0]} ${logicalLines[1]}\n${logicalLines[2]}`;
      }
      return logicalLines.join("\n");
    });
  }

  if (table.tableLabel === "conversion-details" && table.cellLines?.[rowIndex]) {
    const lines = table.cellLines[rowIndex];
    if (rawValues.length !== columns.length || lines.length !== columns.length) {
      throw new Error("YuanTa conversion row has an unsupported source shape.");
    }
    return rawValues.map((value, index) =>
      [0, 2, 4, 5, 6, 7].includes(index) ? lines[index].join("\n") : value,
    );
  }

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

const fundOccurrenceScopeKey = (position: FundPosition): string =>
  deriveSourceConnectionIdentityKey(
    "yuanta-fund-occurrence-scope",
    [position.txnType, position.paperNo, position.trustNo],
  );

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
    美金: "USD",
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
  sourceTransactionNo: string,
): FundPosition | undefined {
  const normalized = cleanText(sourceTransactionNo);
  const matches = positions.filter((position) =>
    normalized.length > 0 && normalized === cleanText(position.paperNo),
  );
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

// Causes stay in memory and are excluded from source/admission JSON.
const fundAdmissionCauses = new WeakMap<object, unknown>();
function failedFundAdmission<T extends YuantaFundCanonicalAdmission>(admission: T, cause: unknown): T {
  fundAdmissionCauses.set(admission, cause);
  return admission;
}
function fundAdmissionError(admission: YuantaFundCanonicalAdmission, message: string): CanonicalInvestmentAdmissionError {
  const error = new CanonicalInvestmentAdmissionError(message);
  if (fundAdmissionCauses.has(admission))
    Object.defineProperty(error, "cause", { value: fundAdmissionCauses.get(admission), configurable: true });
  return error;
}

function fundCurrencyByPositionKey(
  holdingRows: readonly Record<string, string>[],
  positions: readonly FundPosition[],
): Map<string, string> {
  const currencies = new Map<string, string>();
  for (const row of holdingRows) {
    const position = positionForTransactionNumber(
      positions,
      row["交易編號"] ?? "",
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

function sourceFundCatalog(tables: readonly ParsedTable[]): YuantaFundCatalogEntry[] {
  const catalog = tables.filter(table => table.tableLabel === "fund-security-catalog").flatMap(table =>
    table.rows.slice(1).map(row => {
      if (row.length !== 3 || !/^[A-Za-z0-9]{4}$/u.test(row[0] ?? "") ||
        !row[1]?.trim() || !/^[A-Z]{3}$/u.test(row[2] ?? ""))
        throw new Error("YuanTa fund source catalog has an invalid identity record.");
      return { fundCode: row[0]!, name: row[1]!, pricingCurrency: row[2]! };
    }));
  if (new Set(catalog.map(entry => entry.fundCode)).size !== catalog.length)
    throw new Error("YuanTa fund source catalog has repeated native codes.");
  return catalog;
}

function yuantaFundTransactionRows(
  tables: readonly ParsedTable[],
  positions: readonly FundPosition[],
  currencyByPosition: ReadonlyMap<string, string>,
): YuantaCanonicalInvestmentRow[] {
  const transactions: YuantaCanonicalInvestmentRow[] = [];
  const catalog = sourceFundCatalog(tables);
  // A current holding's statement display name is grounded by its exact
  // transaction-number join to the native code from fundDetail. Retain that
  // source spelling as an additional exact name, never as a fuzzy alias.
  for (const table of tables.filter(table => table.category === "investment-overview" && table.tableLabel === "investment-detail")) {
    for (const row of normalizedColumnRecords(table)) {
      const position = positionForTransactionNumber(positions, row["交易編號"] ?? "");
      const entry = catalog.find(entry => entry.fundCode === position?.trustNo);
      const name = row["基金名稱"] ?? "";
      if (entry && name.trim() && !catalog.some(candidate => candidate.fundCode === entry.fundCode &&
        yuantaFundCatalogName(candidate.name) === yuantaFundCatalogName(name)))
        catalog.push({ ...entry, name });
    }
  }
  for (const table of tables) {
    if (
      !table.fund ||
      !fundFinancialHistoryTableLabels.includes(table.tableLabel)
    ) {
      continue;
    }
    const accountHistoryType = yuantaFundAccountHistoryType(table.fund);
    const position = accountHistoryType ? undefined : parseFundPositionKey(table.fund);
    if (
      position &&
      !positions.some(
        (candidate) => fundPositionKey(candidate) === fundPositionKey(position),
      )
    ) {
      throw new Error("fund transaction has no selected provider position");
    }
    const occurrenceScope = accountHistoryType ? yuantaFundAccountHistoryScope(accountHistoryType) : fundOccurrenceScopeKey(position!);
    if (![...fundPurchaseTableLabels, ...fundRedemptionTableLabels].includes(table.tableLabel)) {
      for (const row of normalizedColumnRecords(table)) {
        transactions.push(...yuantaFundAdditionalEventRows(table.tableLabel, row, catalog,
          occurrenceScope, { amount: canonicalExactAmount, date: canonicalSourceDate, currency: canonicalCurrency,
            ...(accountHistoryType ? { cashCurrency: yuantaFundSourceAmountCurrency, allowNameIdentity: true as const } : {}),
          }));
      }
      continue;
    }
    const action = fundPurchaseTableLabels.includes(table.tableLabel) ? "buy" : "sell";
    const positionCurrency = position ? currencyByPosition.get(fundPositionKey(position)) : undefined;
    if (!accountHistoryType && !positionCurrency) {
      throw new Error("fund transaction has no source security currency");
    }
    for (const row of normalizedColumnRecords(table)) {
      const effectiveOn = canonicalSourceDate(
        row[action === "buy" ? "投資日期" : "贖回日期"] ?? "",
      );
      const quantityValue =
        row[action === "buy" ? "申購單位數" : "贖回單位數"] ?? "";
      const cashValue = row[action === "buy" ? "投資金額" : "入帳淨額"] ?? "";
      const currency = accountHistoryType ? yuantaFundSourceAmountCurrency(cashValue) : positionCurrency!;
      const security = accountHistoryType ? resolveYuantaFundIdentity(row["基金名稱"] ?? "") :
        catalog.length ? { ...resolveYuantaFundCatalogName(catalog, row["基金名稱"] ?? ""), identityKind: "producer-security-id" as const } : undefined;
      transactions.push({
        sourceRecordKey: deriveSourceConnectionIdentityKey(
          "yuanta-fund-transaction-record",
          [
            occurrenceScope,
            row["交易編號"] ?? "",
            action,
            effectiveOn,
            quantityValue,
            cashValue,
          ],
        ),
        occurrenceScopeKey: occurrenceScope,
        occurrenceFingerprintFields: action === "buy"
          ? [
              row["交易編號"] ?? "",
              security?.name ?? row["基金名稱"] ?? "",
              row["投資金額"] ?? "",
              row["申購匯率"] ?? "",
              row["申購淨值"] ?? "",
              row["申購手續費"] ?? "",
              row["點數折抵"] ?? "",
              row["申購單位數"] ?? "",
              ...(table.tableLabel === "buy-details" ? [] : [row["扣款帳號/信用卡卡號"] ?? "", row["當次扣款比重"] ?? ""]),
            ]
          : [
              row["交易編號"] ?? "",
              security?.name ?? row["基金名稱"] ?? "",
              row["分配日期"] ?? "",
              row["贖回投資金額"] ?? "",
              row["贖回單位數"] ?? "",
              row["贖回價格"] ?? "",
              row["贖回匯率"] ?? "",
              row["信託管理費"] ?? "",
              row["短線費用"] ?? "",
              row["遞延手續費"] ?? "",
              row["入帳淨額"] ?? "",
              row["備註"] ?? "",
            ],
        producerSecurityId: security?.fundCode ?? position!.trustNo,
        securityName: (security?.name ?? row["基金名稱"]?.trim()) || undefined,
        securityCurrency: security ? security.pricingCurrency : currency,
        ...(security?.identityKind === "source-fund-name" ? { securityIdentityKind: "source-fund-name" as const } : {}),
        currency,
        effectiveOn,
        action,
        quantity: canonicalExactAmount(quantityValue),
        cashEffect: { ...canonicalExactAmount(cashValue), currency },
      });
    }
  }
  // Equal history rows from distinct position queries do not prove whether
  // they are one shared event or separate economic occurrences. Reject the
  // capture; only repeated rows within one proven query bucket get slots.
  const observedScopes = new Map<string, string>();
  for (const transaction of transactions) {
    const fingerprint = JSON.stringify([transaction.producerSecurityId, transaction.action,
      transaction.effectiveOn, transaction.occurrenceFingerprintFields]);
    const scope = transaction.occurrenceScopeKey!;
    const prior = observedScopes.get(fingerprint);
    if (prior && prior !== scope)
      throw new Error("YuanTa history has overlapping position queries without cross-query occurrence evidence.");
    observedScopes.set(fingerprint, scope);
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
  } catch (cause) {
    return failedFundAdmission({
      status: "not-admitted",
      reason: "transaction-source-evidence-incomplete",
    }, cause);
  }
  const transactionCount = transactionRows.length;
  if (holdingRows.length === 0) {
    const explicitEmptyHoldings = tables.some(table => table.tableLabel === "current-position-absence" &&
      table.category === "investment-source-evidence" && table.rows.length === 1 &&
      table.rows[0]?.length === 1 && table.rows[0][0] === "無基金部位");
    if (explicitEmptyHoldings && transactionCount > 0) return {
      status: "admitted", contractVersion: YUANTA_FUND_INVESTMENT_CONTRACT_VERSION,
      holdingCount: 0, transactionCount,
    };
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
        row["交易編號"] ?? "",
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
  } catch (cause) {
    return failedFundAdmission(transactionCount > 0
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
        }, cause);
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
    throw fundAdmissionError(admission,
      `Yuanta fund canonical admission partial: ${admission.reason}. ` +
        `${admission.transactionCount} dated transaction row(s) were rejected; ` +
        `the complete source was not admitted because ${holdingEvidenceMessage}.`,
    );
  }
  throw fundAdmissionError(admission,
    `Yuanta fund canonical admission failed: ${admission.reason}. ` +
      "Canonical Financial Commit was not opened.",
  );
}

function collectYuantaFundCanonicalItems(
  credentials: YuantaCredentials,
  positions: readonly FundPosition[],
  tables: readonly ParsedTable[],
  historyProof: YuantaFundHistoryProof | undefined,
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
  const holdingLots: YuantaCanonicalInvestmentRow[] = overviewRows.map((row) => {
    const position = positionForTransactionNumber(
      positions,
      row["交易編號"] ?? "",
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
      producerSecurityId: resolveYuantaFundIdentity(row["基金名稱"] ?? "").fundCode,
      securityIdentityKind: "source-fund-name" as const,
      securityCurrency: null,
      securityName: resolveYuantaFundIdentity(row["基金名稱"] ?? "").name,
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
  const holdings = aggregateYuantaFundHoldingLots(holdingLots);
  const transactionRows = yuantaFundTransactionRows(
    tables,
    positions,
    currencyByPosition,
  );
  if (!historyProof && transactionRows.length > 0)
    throw new Error("Yuanta fund transaction rows cannot be admitted without complete history coverage.");
  const transactions = historyProof
    ? assignYuantaInvestmentTransactionOccurrences({
        contractVersion: YUANTA_FUND_INVESTMENT_CONTRACT_VERSION,
        transactions: transactionRows,
        transactionHistory: historyProof.transactionHistory,
        occurrenceGroupCoverage: historyProof.occurrenceGroupCoverage,
      })
    : transactionRows;

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
  } else if (transactions.length > 0) {
    // A whole account history proof belongs to one complete transaction set.
    // Splitting by economic date would strip coverage from later captures.
    const effectiveOn = transactions.map(transaction => transaction.effectiveOn).sort().at(-1)!;
    captureGroups.set(effectiveOn, { holdings: [], transactions });
  }

  const captures: InvestmentValidatedCapture[] = [];
  const historyCaptureDate = historyProof
    ? captureGroups.keys().next().value as string | undefined
    : undefined;
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
      ...(historyProof && sourceEffectiveOn === historyCaptureDate
        ? {
            transactionHistory: historyProof.transactionHistory,
            occurrenceGroupCoverage: historyProof.occurrenceGroupCoverage,
          }
        : {}),
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
  transactionHistory?: Readonly<{
    startDate: string;
    endDate: string;
    complete: true;
  }>;
  occurrenceGroupCoverage?: readonly CanonicalOccurrenceGroupCoverage[];
  historyPositionInventory?: Readonly<{
    sourceContract: "yuanta-fund/all-position-history-v1";
    complete: true;
    positionKeys: readonly string[];
  }>;
  accountHistoryQueryCoverage?: readonly YuantaFundAccountHistoryQuery[];
}>;

type YuantaFundHistoryProof = Readonly<{
  transactionHistory: Readonly<{
    startDate: string;
    endDate: string;
    complete: true;
  }>;
  occurrenceGroupCoverage: readonly CanonicalOccurrenceGroupCoverage[];
}>;

function validateYuantaFundHistoryProof(
  source: YuantaFundSourceTables,
  input: WorkflowInput,
): YuantaFundHistoryProof | undefined {
  const historicalTables = source.tables.filter(
    (table) => table.category === "historical-transactions",
  );
  if (!input.includeHistoricalTransactions) {
    if (source.transactionHistory || source.occurrenceGroupCoverage || source.historyPositionInventory || source.accountHistoryQueryCoverage || historicalTables.length > 0)
      throw new Error("Yuanta fund transaction rows require a complete history query.");
    return undefined;
  }

  const history = source.transactionHistory;
  const coverage = source.occurrenceGroupCoverage;
  const inventory = source.historyPositionInventory;
  // Current holdings alone do not enumerate closed positions (ADR 0034).
  // Only a source contract covering that universe can authorize full history.
  const positionKeys = source.positions.map(fundPositionKey);
  if (!source.accountHistoryQueryCoverage && (inventory?.sourceContract !== "yuanta-fund/all-position-history-v1" ||
    !inventory.complete || inventory.positionKeys.length !== positionKeys.length ||
    new Set(inventory.positionKeys).size !== inventory.positionKeys.length ||
    positionKeys.some(key => !inventory.positionKeys.includes(key))))
    throw new Error("Yuanta fund history does not prove the complete position universe including closed positions.");
  const requestedRange = resolveDateRange(input);
  const startDate = canonicalSourceDate(requestedRange.startDate);
  const endDate = canonicalSourceDate(requestedRange.endDate);
  if (!history?.complete || history.startDate !== startDate || history.endDate !== endDate ||
      startDate > endDate || !coverage || (!source.accountHistoryQueryCoverage && source.positions.length === 0))
    throw new Error("Yuanta fund transaction history does not prove the requested full date range.");

  if (source.accountHistoryQueryCoverage) {
    const queryKey = (query: YuantaFundAccountHistoryQuery) => `${query.investmentType}:${query.detail}`;
    const expected = new Set(yuantaFundAccountHistoryQueries.map(queryKey));
    const actual = source.accountHistoryQueryCoverage.map(queryKey);
    if (actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some(key => !expected.has(key)))
      throw new Error("Yuanta fund account history is missing or repeating a required investment-type report.");
    const scopes = new Set(yuantaFundHistoryInvestmentTypes.map(yuantaFundAccountHistoryScope));
    if (coverage.length !== scopes.size || new Set(coverage.map(entry => entry.scopeKey)).size !== scopes.size ||
      coverage.some(entry => !scopes.has(entry.scopeKey) || entry.startDate !== startDate || entry.endDate !== endDate ||
        entry.contractVersion !== YUANTA_FUND_INVESTMENT_CONTRACT_VERSION))
      throw new Error("Yuanta fund account history coverage does not match its complete report inventory.");
    for (const query of yuantaFundAccountHistoryQueries) {
      const queryTables = historicalTables.filter(table => table.historyQuery && queryKey(table.historyQuery) === queryKey(query));
      const labels: readonly string[] = query.detail === "sell" ? fundRedemptionTableLabels
        : query.detail === "deduct" ? [query.investmentType === "type3" ? "variable-deduction-details" : "deduction-details"]
        : [yuantaFundAccountHistoryTableLabels[query.detail]];
      if (queryTables.filter(table => labels.includes(table.tableLabel)).length !== 1 ||
        queryTables.some(table => table.fund !== yuantaFundAccountHistoryKey(query.investmentType) ||
          (fundFinancialHistoryTableLabels.includes(table.tableLabel) && !labels.includes(table.tableLabel))))
        throw new Error("Yuanta fund account history has no unique result for its requested report.");
      assertYuantaFundHistoryQueryResult(queryTables, yuantaFundAccountHistoryKey(query.investmentType));
    }
    if (historicalTables.some(table => !table.historyQuery || !expected.has(queryKey(table.historyQuery)) ||
      !yuantaFundAccountHistoryType(table.fund ?? "")))
      throw new Error("Yuanta fund account history has unqueried evidence.");
    return { transactionHistory: history, occurrenceGroupCoverage: coverage };
  }

  const expectedScopes = new Map(
    source.positions.map((position) => [fundOccurrenceScopeKey(position), position]),
  );
  const expectedPositionKeys = new Set(source.positions.map(fundPositionKey));
  if (expectedScopes.size !== source.positions.length || coverage.length !== expectedScopes.size)
    throw new Error("Yuanta fund history coverage does not inventory each queried position exactly once.");
  const seenScopes = new Set<string>();
  for (const entry of coverage) {
    if (!expectedScopes.has(entry.scopeKey) || seenScopes.has(entry.scopeKey) ||
        entry.startDate !== startDate || entry.endDate !== endDate ||
        entry.contractVersion !== YUANTA_FUND_INVESTMENT_CONTRACT_VERSION)
      throw new Error("Yuanta fund history coverage is outside the queried position and range.");
    seenScopes.add(entry.scopeKey);
    const position = expectedScopes.get(entry.scopeKey)!;
    assertYuantaFundHistoryQueryResult(historicalTables, position);
  }
  if (historicalTables.some((table) => !expectedPositionKeys.has(table.fund ?? "")))
    throw new Error("Yuanta fund history includes an unqueried position scope.");
  return { transactionHistory: history, occurrenceGroupCoverage: coverage };
}

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
  const historyStartDate = canonicalSourceDate(dateRange.startDate);
  const historyEndDate = canonicalSourceDate(dateRange.endDate);
  const tables: ParsedTable[] = [];
  const occurrenceGroupCoverage: CanonicalOccurrenceGroupCoverage[] = [];
  let positions: FundPosition[] = [];
  const checkCancelled = () => context.signal.throwIfAborted();


  if (input.includePortfolioSummary) {
    checkCancelled();
    await openPortfolioSummary(page);
    await captureTables(page, tables, "portfolio-summary", null, null, context);
  }

  if (input.includeInvestmentDetails || input.includeHistoricalTransactions) {
    checkCancelled();
    const overviewScope = await openInvestmentOverview(page);
    positions = await extractFundPositions(page, input.includeHistoricalTransactions);
    if (positions.length === 0 && input.includeHistoricalTransactions) {
      if (!isYuantaFundPositionAbsentText(await overviewScope.locator("body").innerText()))
        throw new Error("YuanTa empty position inventory has no explicit source absence evidence.");
      tables.push({ category: "investment-source-evidence", fund: null, period: null,
        tableLabel: "current-position-absence", rows: [["無基金部位"]] });
    }
    await captureTables(
      page,
      tables,
      "investment-overview",
      null,
      null,
      context,
    );
    if (positions.length === 0 && !input.includeHistoricalTransactions)
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

    }
  }

  if (input.includeHistoricalTransactions) {
    if (input.fundFilters.length)
      throw new Error("YuanTa complete account history cannot use a fund subset filter.");
    for (const query of yuantaFundAccountHistoryQueries) {
      checkCancelled();
      await queryAccountFundTransactions(page, query, dateRange.startDate, dateRange.endDate);
      const firstTable = tables.length;
      const key = yuantaFundAccountHistoryKey(query.investmentType);
      await captureTables(page, tables, "historical-transactions", key, dateRange.label, context);
      for (const table of tables.slice(firstTable)) table.historyQuery = query;
      assertYuantaFundHistoryQueryResult(tables.slice(firstTable), key);
    }
    for (const type of yuantaFundHistoryInvestmentTypes) occurrenceGroupCoverage.push({
      scopeKey: yuantaFundAccountHistoryScope(type), startDate: historyStartDate, endDate: historyEndDate,
      contractVersion: YUANTA_FUND_INVESTMENT_CONTRACT_VERSION,
    });
    // Closed products may no longer appear in the subscription catalog. Only an
    // exact, independently sourced public association can supplement that catalog.

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
  if (input.includeHistoricalTransactions && occurrenceGroupCoverage.length === 0)
    throw new Error("Yuanta fund history has no queried position buckets to prove complete.");
  return {
    positions,
    tables,
    ...(input.includeHistoricalTransactions
      ? {
          transactionHistory: {
            startDate: historyStartDate,
            endDate: historyEndDate,
            complete: true as const,
          },
          occurrenceGroupCoverage,
          accountHistoryQueryCoverage: yuantaFundAccountHistoryQueries,
        }
      : {}),
  };
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
    validateYuantaFundHistoryProof(sourceCollection, input),
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
