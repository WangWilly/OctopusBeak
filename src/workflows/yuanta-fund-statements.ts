import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { hasAttachedLocator } from "./browser-interaction.js";

const BANK_ENTRY_URL = "https://ebank.yuantabank.com.tw/nib/ibanc.jsp";
const BANK_LOGOUT_URL = "https://ebank.yuantabank.com.tw/nib/tx/logout";
const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";
const FUND_TABLE_SELECTOR = "table.rwdTable, table.normalTable, table.formTable";

type BrowserScope = Page | Frame;

type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};

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
};

type NormalizedRow = {
  category: string;
  fund: string | null;
  period: string | null;
  values: string[];
};

type TableOutputConfig = {
  kind: string;
  rawColumns: string[];
  headers: string[];
  normalize: (columns: Record<string, string>) => string[];
};

type OutputTableGroup = {
  kind: string;
  headers: string[];
  categories: Set<string>;
  funds: Set<string>;
  periods: Set<string>;
  sourceTableLabels: Set<string>;
  sourceTableCount: number;
  noDataSourceTableCount: number;
  rows: NormalizedRow[];
};

const quickDateRangeSchema = z.enum(["three_months", "six_months", "one_year"]);

const customDateRangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
});

const inputSchema = z.object({
  dateRange: quickDateRangeSchema.default("one_year"),
  customDateRange: customDateRangeSchema.optional(),
  fundFilters: z.array(z.string()).default([]),
  includePortfolioSummary: z.boolean().default(true),
  includeInvestmentDetails: z.boolean().default(false),
  includeHistoricalTransactions: z.boolean().default(true),
  includeOffHourOrders: z.boolean().default(false),
  replaceActiveSession: z.boolean().default(true),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.string(),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  categories: z.array(z.string()),
  funds: z.array(z.string()),
  periods: z.array(z.string()),
  sourceTableLabels: z.array(z.string()),
  sourceTableCount: z.number().int().nonnegative(),
  noDataSourceTableCount: z.number().int().nonnegative(),
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: z.string(),
  usedExistingSession: z.boolean(),
  replacedActiveSession: z.boolean(),
  fundCount: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  files: z.array(tableFileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;

const dateRangeDays: Record<z.infer<typeof quickDateRangeSchema>, number> = {
  three_months: 92,
  six_months: 183,
  one_year: 364,
};

const rowMetadataHeaders = ["資料類別", "基金識別", "查詢期間"];

const tableOutputConfigsByLabel: Record<string, TableOutputConfig> = {
  "portfolio-summary": simpleTableConfig(
    "fund-holdings",
    [
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
    ],
  ),
  "currency-total": simpleTableConfig(
    "fund-currency-totals",
    [
      "幣別總計",
      "投資金額",
      "不含息參考市值",
      "不含息參考損益",
      "不含息參考報酬率",
      "含息參考損益",
      "含息參考報酬率",
    ],
  ),
  "investment-detail": {
    kind: "fund-position-lots",
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
  "buy-details": simpleTableConfig(
    "fund-buy-transactions",
    [
      "投資日期",
      "基金名稱",
      "交易編號",
      "投資金額",
      "申購匯率",
      "申購淨值",
      "申購手續費",
      "點數折抵",
      "申購單位數",
    ],
  ),
  "redemption-details": {
    kind: "fund-redemption-transactions",
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
    kind: "fund-conversion-transactions",
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
    kind: "fund-cash-dividends",
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
  "unit-dividend-details": simpleTableConfig(
    "fund-unit-dividends",
    [
      "分配日期",
      "基金名稱",
      "交易編號",
      "基準日期",
      "基準單位數",
      "分配率",
      "分配單位數",
    ],
  ),
  "offhour-buy-orders": simpleTableConfig(
    "fund-offhour-buy-orders",
    [
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
    ],
  ),
  "offhour-conversion-orders": simpleTableConfig(
    "fund-offhour-conversion-orders",
    [
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
    ],
  ),
  "offhour-redemption-orders": simpleTableConfig(
    "fund-offhour-redemption-orders",
    [
      "贖回基金",
      "贖回方式",
      "申請日期",
      "贖回生效日期",
      "贖回轉入帳號",
      "贖回投資金額",
      "贖回單位數",
    ],
  ),
  "offhour-redemption-rebuy-orders": simpleTableConfig(
    "fund-offhour-redemption-rebuy-orders",
    [
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
    ],
  ),
  "offhour-change-orders": simpleTableConfig(
    "fund-offhour-change-orders",
    [
      "異動基金",
      "申請日期",
      "生效日期",
      "異動種類",
      "變更後設定值",
    ],
  ),
};

const bookingOutputKinds = new Set([
  "fund-holdings",
  "fund-buy-transactions",
  "fund-redemption-transactions",
  "fund-cash-dividends",
  "fund-conversion-transactions",
]);

const sortDateHeaderByKind: Record<string, string> = {
  "fund-buy-transactions": "投資日期",
  "fund-redemption-transactions": "贖回日期",
  "fund-cash-dividends": "入帳日期",
  "fund-conversion-transactions": "轉出日期",
};

function requireCredential(
  credentials: YuantaCredentials,
  name: keyof YuantaCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

function simpleTableConfig(kind: string, headers: string[]): TableOutputConfig {
  return {
    kind,
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

function categoryDisplayLabel(category: string): string {
  const labels: Record<string, string> = {
    "portfolio-summary": "投資總覽",
    "investment-overview": "投資明細",
    "historical-transactions": "歷史交易",
    "offhour-orders": "預約交易",
  };

  return labels[category] ?? category;
}

function parseDateSortValue(value: string): number | null {
  const text = toAsciiDigits(cleanText(value));
  const match = text.match(/(\d{2,4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  if (!match) return null;

  const rawYear = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(rawYear) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const year = rawYear < 1911 ? rawYear + 1911 : rawYear;
  const time = Date.UTC(year, month - 1, day);
  return Number.isFinite(time) ? time : null;
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

function matchesFundFilter(position: FundPosition, filters: string[]): boolean {
  if (filters.length === 0) return true;

  const haystack = toAsciiDigits(
    `${position.txnType} ${position.paperNo} ${position.trustNo} ${position.label}`,
  ).toLowerCase();

  return filters.some((filter) =>
    haystack.includes(toAsciiDigits(filter).toLowerCase().trim()),
  );
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

async function fillLoginForm(
  page: Page,
  credentials: YuantaCredentials,
): Promise<void> {
  const userId = requireCredential(credentials, "yuanta_user_id");
  const account = requireCredential(credentials, "yuanta_account");
  const password = requireCredential(credentials, "yuanta_password");

  await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });

  const loginFrame = await waitForFrame(page, "main");
  const userIdField = loginFrame.locator("#custidMask");
  await userIdField.fill(userId);
  await maskUserId(loginFrame);
  await fillReadonlyLoginInput(loginFrame.locator("#custnoInput"), account);
  await fillReadonlyLoginInput(loginFrame.locator("#custcode"), password);
  await loginFrame.locator("#gcode").focus();
}

async function maskUserId(loginFrame: Frame): Promise<void> {
  await loginFrame.evaluate(() => {
    const yuanTaWindow = window as typeof window & { maskID?: () => void };
    if (typeof yuanTaWindow.maskID !== "function") {
      throw new Error("YuanTa login page did not expose maskID().");
    }
    yuanTaWindow.maskID();
  });

  const hiddenUserId = await loginFrame.locator("#custid").inputValue();
  if (!hiddenUserId.trim()) {
    throw new Error("YuanTa login page did not populate hidden custid.");
  }
}

async function restoreUserIdForSubmit(
  loginFrame: Frame,
  userId: string,
): Promise<void> {
  const normalizedUserId = userId.trim();
  await loginFrame.locator("#custid").evaluate((element, value) => {
    (element as HTMLInputElement).value = value;
  }, normalizedUserId);

  const hiddenUserId = await loginFrame.locator("#custid").inputValue();
  if (hiddenUserId !== normalizedUserId) {
    throw new Error("YuanTa login page did not restore hidden custid.");
  }
}

async function fillReadonlyLoginInput(
  field: Locator,
  value: string,
): Promise<void> {
  await field.click({ force: true });
  await field.evaluate((element) => element.removeAttribute("readonly"));
  await field.fill(value);
}

async function submitLogin(
  page: Page,
  credentials: YuantaCredentials,
): Promise<void> {
  const loginFrame = await waitForFrame(page, "main");
  await restoreUserIdForSubmit(
    loginFrame,
    requireCredential(credentials, "yuanta_user_id"),
  );
  await loginFrame.locator('a[href="javascript:doPreLogin();"]').click();
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

async function isSignedIn(page: Page): Promise<boolean> {
  if (await isFundArea(page)) return true;

  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator('a[onclick*="doAction"][onclick*="FUND"]')
        .or(candidate.locator('a[onclick*="menu_fund"]'))
        .or(candidate.locator('a[onclick*="creditcardsummary"]'))
        .first(),
    "YuanTa signed-in navigation",
    3_000,
  )
    .then(() => true)
    .catch(() => false);
}

async function waitForSignedInState(
  page: Page,
  getLastDialogMessage: () => string,
  replaceActiveSession: boolean,
): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  let replacedActiveSession = false;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) return replacedActiveSession;

    const loginFrame = page.frame({ name: "main" });
    const activeSessionPrompt =
      loginFrame &&
      (await loginFrame
        .locator("#reloginBT")
        .or(loginFrame.locator("a").filter({ hasText: "立即登入" }))
        .first()
        .isVisible()
        .catch(() => false));
    if (loginFrame && activeSessionPrompt) {
      if (!replaceActiveSession) {
        throw new Error(
          "YuanTa reports another active session. Re-run with replaceActiveSession=true to continue.",
        );
      }

      await loginFrame
        .locator("#reloginBT")
        .or(loginFrame.locator("a").filter({ hasText: "立即登入" }))
        .first()
        .click({ force: true });
      replacedActiveSession = true;
      await settleAfterNavigation(page);
      continue;
    }

    const stillOnLogin =
      loginFrame &&
      (await loginFrame
        .locator("#custidMask, #custnoInput, #custcode, #gcode")
        .first()
        .isVisible()
        .catch(() => false));
    const dialogMessage = getLastDialogMessage();
    if (stillOnLogin && dialogMessage) {
      throw new Error(`YuanTa login failed: ${dialogMessage}`);
    }

    await page.waitForTimeout(500);
  }

  const dialogMessage = getLastDialogMessage();
  throw new Error(
    dialogMessage
      ? `Timed out waiting for YuanTa signed-in state after dialog: ${dialogMessage}`
      : "Timed out waiting for YuanTa signed-in state.",
  );
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
      scope.locator(`a[onclick*="${actionFragment}"]`).filter({ hasText: label }),
      description,
      5_000,
    ).catch(() => null));
  if (link) {
    await link.click({ force: true });
    await settleAfterNavigation(page);
    return;
  }

  const menuActionScope = await findMenuActionScope(page, 10_000).catch(
    () => null,
  );
  if (menuActionScope) {
    await menuActionScope.evaluate(
      ({ action, id }) => {
        const yuanTaWindow = window as typeof window & {
          menuaction?: (menuAction: string, menuId: string, flag?: string) => void;
        };
        if (typeof yuanTaWindow.menuaction !== "function") {
          throw new Error("YuanTa page did not expose menuaction().");
        }
        yuanTaWindow.menuaction(action, id, "N");
      },
      { action: actionFragment, id: menuId },
    );
    await settleAfterNavigation(page);
    return;
  }

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
        await scope.locator("body").innerText().catch(() => ""),
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
    /投資日期|交易編號|基金明細查詢/,
    "YuanTa fund investment detail tables",
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

async function extractFundPositions(page: Page): Promise<FundPosition[]> {
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
      await link.locator("xpath=ancestor::tr[1]").innerText().catch(() => ""),
    );
    const label = cleanText(await link.textContent()) || rowText || paperNo;
    const key = `${txnType}:${paperNo}:${trustNo}`;
    if (!positions.has(key)) {
      positions.set(key, { txnType, paperNo, trustNo, label });
    }
  }

  return [...positions.values()];
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
  await scope.locator("form#mform, form[name='mform']").first().evaluate(
    (formElement, { action: formAction, values: formValues }) => {
      const form = formElement as HTMLFormElement;
      for (const [name, value] of Object.entries(formValues)) {
        const byName = form.elements.namedItem(name);
        const element =
          byName instanceof RadioNodeList ? byName[0] : byName;
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

async function logoutFromYuanTa(page: Page): Promise<void> {
  await page.goto(BANK_LOGOUT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await settleAfterNavigation(page);
}

async function parseFundTables(
  page: Page,
  category: string,
  fund: string | null,
  period: string | null,
): Promise<ParsedTable[]> {
  const scope = await findScopeWithSelector(page, FUND_TABLE_SELECTOR);
  const tables = scope.locator(FUND_TABLE_SELECTOR);
  const count = await tables.count();
  const parsed: ParsedTable[] = [];

  for (let tableIndex = 0; tableIndex < count; tableIndex += 1) {
    const table = tables.nth(tableIndex);
    const rows = await parseHtmlTableRows(table);
    if (rows.length === 0) continue;

    const tableLabel = classifyTable(category, rows, tableIndex);
    parsed.push({ category, fund, period, tableLabel, rows });
  }

  if (parsed.length === 0) {
    throw new Error(`No YuanTa fund tables found for ${category}.`);
  }

  return parsed;
}

async function parseHtmlTableRows(table: Locator): Promise<string[][]> {
  const rows = table.locator("tr");
  const rowCount = await rows.count();
  const parsedRows: string[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("th, td");
    const cellCount = await cells.count();
    const values: string[] = [];

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      values.push(cleanText(await cells.nth(cellIndex).innerText()));
    }

    if (values.some((value) => value.length > 0)) parsedRows.push(values);
  }

  if (parsedRows.length === 0) {
    const text = cleanText(await table.innerText());
    if (text) parsedRows.push([text]);
  }

  return parsedRows;
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

function fundDownloadsDir(): string {
  return join(process.cwd(), "downloads", "yuanta-fund-statements");
}

function headerScore(row: string[]): number {
  return row.filter((value) =>
    /日期|基金|交易|投資|金額|幣別|單位|淨值|帳號|類型|損益|報酬率/.test(
      value,
    ),
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
    const values = alignValuesToHeaders(table.rows[rowIndex], config.rawColumns);
    if (!values.some((value) => value.length > 0)) continue;
    if (values.length !== config.rawColumns.length) continue;
    if (isRepeatedHeaderRow(values, config.rawColumns)) continue;

    const rowColumns: Record<string, string> = {};
    for (let columnIndex = 0; columnIndex < values.length; columnIndex += 1) {
      const header = config.rawColumns[columnIndex] ?? `column_${columnIndex + 1}`;
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

function groupedOutputTables(
  tables: ParsedTable[],
): OutputTableGroup[] {
  const groups = new Map<string, OutputTableGroup>();

  for (const table of tables) {
    const config = tableOutputConfigsByLabel[table.tableLabel];
    if (!config) continue;
    if (!bookingOutputKinds.has(config.kind)) continue;

    const group = groups.get(config.kind) ?? {
      kind: config.kind,
      headers: config.headers,
      categories: new Set<string>(),
      funds: new Set<string>(),
      periods: new Set<string>(),
      sourceTableLabels: new Set<string>(),
      sourceTableCount: 0,
      noDataSourceTableCount: 0,
      rows: [],
    };

    group.sourceTableCount += 1;
    group.sourceTableLabels.add(table.tableLabel);
    group.categories.add(table.category);
    addIfPresent(group.funds, table.fund);
    addIfPresent(group.periods, table.period);
    if (tableHasNoData(table)) group.noDataSourceTableCount += 1;
    group.rows.push(...normalizedRowsForTable(table));
    groups.set(config.kind, group);
  }

  return [...groups.values()];
}

function sortedOutputRows(group: OutputTableGroup): NormalizedRow[] {
  const sortHeader = sortDateHeaderByKind[group.kind];
  if (!sortHeader) return group.rows;

  const sortIndex = group.headers.indexOf(sortHeader);
  if (sortIndex < 0) return group.rows;

  return [...group.rows].sort((left, right) => {
    const leftTime = parseDateSortValue(left.values[sortIndex] ?? "");
    const rightTime = parseDateSortValue(right.values[sortIndex] ?? "");

    if (leftTime === null && rightTime === null) return 0;
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return rightTime - leftTime;
  });
}

function outputTableRowsToCsv(group: OutputTableGroup): string {
  const csvRows = [
    [...rowMetadataHeaders, ...group.headers],
    ...sortedOutputRows(group).map((row) => [
      categoryDisplayLabel(row.category),
      row.fund ?? "",
      row.period ?? "",
      ...row.values,
    ]),
  ];

  return rowsToCsv(csvRows);
}

async function writeOutputTableFile(
  nextTimestamp: () => string,
  group: OutputTableGroup,
): Promise<TableFile> {
  const downloadsDir = fundDownloadsDir();
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${group.kind}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const headers = [...rowMetadataHeaders, ...group.headers];
  const categories = [...group.categories];
  const funds = [...group.funds];
  const periods = [...group.periods];
  const sourceTableLabels = [...group.sourceTableLabels];

  await writeFile(csvPath, outputTableRowsToCsv(group), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt: new Date().toISOString(),
        workflow: "yuantaFundStatements",
        kind: group.kind,
        csvFilename,
        jsonFilename,
        rowCount: group.rows.length,
        headers,
        categories,
        funds,
        periods,
        sourceTableLabels,
        sourceTableCount: group.sourceTableCount,
        noDataSourceTableCount: group.noDataSourceTableCount,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    baseName,
    kind: group.kind,
    rowCount: group.rows.length,
    headers,
    categories,
    funds,
    periods,
    sourceTableLabels,
    sourceTableCount: group.sourceTableCount,
    noDataSourceTableCount: group.noDataSourceTableCount,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

async function writeOutputTableFiles(
  nextTimestamp: () => string,
  tables: ParsedTable[],
): Promise<TableFile[]> {
  const files: TableFile[] = [];

  for (const group of groupedOutputTables(tables)) {
    files.push(await writeOutputTableFile(nextTimestamp, group));
  }

  return files;
}

async function captureTables(
  page: Page,
  parsedTables: ParsedTable[],
  category: string,
  fund: string | null,
  period: string | null,
): Promise<void> {
  const tables = await parseFundTables(page, category, fund, period);
  for (const table of tables) {
    parsedTables.push(table);
  }
}

export default workflow("yuantaFundStatements", {
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page, session } = ctx;
    const credentials = (input as typeof input & { credentials: YuantaCredentials })
      .credentials;
    let lastBankDialogMessage = "";
    let replacedActiveSession = false;

    page.on("dialog", async (dialog) => {
      lastBankDialogMessage = dialog.message();
      console.warn("bank-dialog", {
        type: dialog.type(),
        message: lastBankDialogMessage,
      });
      await dialog.accept();
    });

    const authResult = await librettoAuthenticate(ctx, {
      credentials,
      isSignedIn: async ({ page: authPage }) => await isSignedIn(authPage),
      signIn: async ({ page: authPage, session: authSession }, signInCredentials) => {
        await fillLoginForm(authPage, signInCredentials as YuantaCredentials);
        console.log(
          "manual-auth-required: enter the CAPTCHA in the browser, then run `npx libretto resume --session " +
            authSession +
            "`.",
        );
        await pause(authSession);
        const loginFrame = authPage.frame({ name: "main" });
        const loginButtonVisible =
          loginFrame &&
          (await loginFrame
            .locator('a[href="javascript:doPreLogin();"]')
            .isVisible()
            .catch(() => false));
        if (loginButtonVisible) {
          await submitLogin(authPage, signInCredentials as YuantaCredentials);
        }
        replacedActiveSession = await waitForSignedInState(
          authPage,
          () => lastBankDialogMessage,
          input.replaceActiveSession,
        );
      },
    });

    try {
      const dateRange = resolveDateRange(input);
      const parsedTables: ParsedTable[] = [];
      const nextTimestamp = createTimestampGenerator();
      let selectedFunds: FundPosition[] = [];
      let completedFundSteps = 0;
      let fundStepCount = 0;
      const fundProgress = () => {
        if (fundStepCount === 0) return;
        console.log(
          `automation-progress: ${
            75 +
            Math.min(
              24,
              Math.round((completedFundSteps / fundStepCount) * 24),
            )
          }`,
        );
      };

      if (input.includePortfolioSummary) {
        await openPortfolioSummary(page);
        await captureTables(
          page,
          parsedTables,
          "portfolio-summary",
          null,
          null,
        );
      }

      if (
        input.includeInvestmentDetails ||
        input.includeHistoricalTransactions
      ) {
        const overviewStartedAt = Date.now();
        await openInvestmentOverview(page);
        const fundPositions = await extractFundPositions(page);
        selectedFunds = fundPositions.filter((position) =>
          matchesFundFilter(position, input.fundFilters),
        );
        console.log("yuanta-fund-positions-found", {
          available: fundPositions.length,
          selected: selectedFunds.length,
          durationMs: Date.now() - overviewStartedAt,
        });

        if (input.includeInvestmentDetails) {
          await captureTables(
            page,
            parsedTables,
            "investment-overview",
            null,
            null,
          );
        }

        if (input.includeHistoricalTransactions) {
          if (selectedFunds.length === 0) {
            throw new Error("Could not find matching YuanTa fund positions.");
          }

          fundStepCount = selectedFunds.length;
          for (
            let fundIndex = 0;
            fundIndex < selectedFunds.length;
            fundIndex += 1
          ) {
            const position = selectedFunds[fundIndex];
            const tableCountBefore = parsedTables.length;
            const historyStartedAt = Date.now();
            console.log("yuanta-fund-history-start", {
              index: fundIndex + 1,
              total: selectedFunds.length,
              startedAt: new Date(historyStartedAt).toISOString(),
            });
            await openInvestmentOverview(page);
            await openFundDetail(page, position);
            await queryFundTransactions(
              page,
              dateRange.startDate,
              dateRange.endDate,
            );
            await captureTables(
              page,
              parsedTables,
              "historical-transactions",
              `${position.paperNo}-${position.trustNo}`,
              dateRange.label,
            );
            completedFundSteps += 1;
            console.log("yuanta-fund-history-complete", {
              index: fundIndex + 1,
              total: selectedFunds.length,
              tableCount: parsedTables.length - tableCountBefore,
              durationMs: Date.now() - historyStartedAt,
            });
            fundProgress();
          }
        }
      }

      if (input.includeOffHourOrders) {
        await openOffHourOrders(page);
        await queryOffHourOrders(page, dateRange.startDate, dateRange.endDate);
        await captureTables(
          page,
          parsedTables,
          "offhour-orders",
          null,
          dateRange.label,
        );
      }

      const files = await writeOutputTableFiles(nextTimestamp, parsedTables);

      return {
        dateRange: dateRange.label,
        usedExistingSession: authResult.usedProfile,
        replacedActiveSession,
        fundCount: selectedFunds.length,
        count: files.length,
        files,
      };
    } finally {
      await logoutFromYuanTa(page).catch((error: unknown) => {
        console.warn("yuanta-logout-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  },
});
