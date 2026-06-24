import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Page } from "playwright";
import { z } from "zod";

const TRADE_LOGIN_URL =
  "https://global.yuanta.com.tw/NexusWebTrade/Login/OTPLogin?urlid=6020";

type YuantaTradeCredentials = {
  yuanta_trade_user_id?: string;
  yuanta_trade_password?: string;
  yuanta_trade_ca_path?: string;
  yuanta_trade_ca_password?: string;
};

const dateSchema = z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/);

const holdingTypeSchema = z.enum([
  "Stock",
  "SecuritiesLending",
  "UnlimitedUseLending",
  "Ledger",
  "Futures",
  "Oversea",
  "Wealth",
  "Bond",
  "Derivative",
  "InternationalSecurities",
]);

const tradeTypeSchema = z.enum([
  "StockTrade",
  "SecuritiesLendingTrade",
  "UnlimitedUseLendingTrade",
  "LedgerTrade",
  "FuturesTrade",
  "OverseaTrade",
  "WealthTrade",
  "BondTrade",
  "DerivativeTrade",
  "InternationalSecuritiesTrade",
]);

const inputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountIndex: z.number().int().default(-1),
  includeHoldings: z.boolean().default(true),
  includeTrades: z.boolean().default(true),
  holdingTypes: z.array(holdingTypeSchema).default(holdingTypeSchema.options),
  tradeTypes: z.array(tradeTypeSchema).default(tradeTypeSchema.options),
  outputDir: z.string().default("downloads/yuanta-trade-statements"),
});

const generatedTableFileSchema = z.object({
  tableName: z.enum(["trade-transactions", "holdings", "asset-summaries"]),
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
  accounts: z.array(z.string()),
  periods: z.array(z.string()),
  assetTypes: z.array(z.string()),
  tradeTypes: z.array(z.string()),
  subCategories: z.array(z.string()),
  generatedAt: z.string(),
  workflow: z.literal("yuantaTradeStatements"),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
});

const outputSchema = z.object({
  dateRange: z.object({
    startDate: dateSchema,
    endDate: dateSchema,
  }),
  usedExistingSession: z.boolean(),
  holdingPageCount: z.number().int().nonnegative(),
  holdingGridCount: z.number().int().nonnegative(),
  holdingRowCount: z.number().int().nonnegative(),
  tradePageCount: z.number().int().nonnegative(),
  tradeGridCount: z.number().int().nonnegative(),
  tradeRowCount: z.number().int().nonnegative(),
  files: z.array(generatedTableFileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type HoldingType = z.infer<typeof holdingTypeSchema>;
type TradeType = z.infer<typeof tradeTypeSchema>;
type FileMetadata = z.infer<typeof generatedTableFileSchema>;
type CsvRow = Record<string, string>;

type GridColumn = {
  field: string;
  title: string;
};

type CapturedGrid = {
  gridId: string;
  category: string;
  columns: GridColumn[];
  rows: Record<string, unknown>[];
};

type AssetSummaryRow = {
  assetType: string;
  assetName: string;
  assetValueTwd: string;
  unrealizedPnlTwd: string;
};

type ReportPage = {
  reportType: string;
  url: string;
  title: string;
  currentAssetType: string | null;
  currentTradeType: string | null;
  currentFinanceType: string | null;
  queryDateType: string | null;
  startDate: string | null;
  endDate: string | null;
  subCategory: string | null;
  accountOptions: unknown[];
  summaryRows: AssetSummaryRow[];
  grids: CapturedGrid[];
};

const tradeTransactionHeaders = [
  "trade_date",
  "account_number",
  "asset_type",
  "trade_type",
  "sub_category",
  "product_code",
  "product_name",
  "currency",
  "action",
  "quantity",
  "price",
  "gross_amount",
  "fee",
  "tax",
  "settlement_amount",
  "settlement_currency",
  "realized_pnl",
  "cost_amount",
] as const;

const holdingHeaders = [
  "as_of_date",
  "account_number",
  "asset_type",
  "sub_category",
  "product_code",
  "product_name",
  "currency",
  "quantity",
  "market_date",
  "market_price",
  "market_value_original",
  "market_value_twd",
  "cost_price",
  "cost_amount",
  "unrealized_pnl_original",
  "unrealized_pnl_twd",
  "return_rate",
  "fx_rate",
] as const;

const assetSummaryHeaders = [
  "as_of_date",
  "asset_type",
  "asset_name",
  "asset_value_twd",
  "unrealized_pnl_twd",
] as const;

const DEFAULT_TRADE_SUBCATEGORIES: Partial<Record<TradeType, string>> = {
  SecuritiesLendingTrade: "Lend",
  UnlimitedUseLendingTrade: "Collateral",
  FuturesTrade: "DomesticFutures",
  OverseaTrade: "Stock",
  WealthTrade: "Cash",
  DerivativeTrade: "ASO",
  InternationalSecuritiesTrade: "Stock",
};

function requireCredential(
  credentials: YuantaTradeCredentials,
  name: keyof YuantaTradeCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(
    date.getDate(),
  )}`;
}

function defaultStartDate(endDate: Date): Date {
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 90);
  return startDate;
}

function resolveDateRange(input: WorkflowInput): {
  startDate: string;
  endDate: string;
} {
  const today = new Date();
  const endDate = input.endDate ?? formatDate(today);
  const startDate = input.startDate ?? formatDate(defaultStartDate(today));
  return { startDate, endDate };
}

function cleanText(value: string | null | undefined): string {
  return decodeHtml(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 10)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return cleanText(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

const nextTimestamp = createTimestampGenerator();

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function rowValue(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && String(value).length > 0) {
      return cleanText(String(value));
    }
  }
  return "";
}

function cleanOptionalAmount(value: string): string {
  const text = cleanText(value);
  return text === "--" ? "" : text;
}

function rowsToCsv(rows: CsvRow[], headers: readonly string[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function periodLabel(dateRange: { startDate: string; endDate: string }): string {
  return `${dateRange.startDate}~${dateRange.endDate}`;
}

function reportPeriod(page: ReportPage): string {
  if (page.startDate && page.endDate) return `${page.startDate}~${page.endDate}`;
  return page.startDate || page.endDate || "";
}

function dateSortKey(value: string): string {
  const match = cleanText(value).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) return "";
  return `${match[1]}${match[2]}${match[3]}`;
}

function compareTradeRowsByDateDesc(left: CsvRow, right: CsvRow): number {
  return dateSortKey(right.trade_date).localeCompare(dateSortKey(left.trade_date));
}

function getStringVar(html: string, name: string): string | null {
  const match = html.match(new RegExp(`var\\s+${name}\\s*=\\s*'([^']*)'`));
  return match?.[1] ?? null;
}

function findMatchingDelimiter(
  source: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function parseJsonArrayAt(source: string, openIndex: number): unknown[] {
  const closeIndex = findMatchingDelimiter(source, openIndex, "[", "]");
  if (closeIndex < 0) return [];
  const raw = source.slice(openIndex, closeIndex + 1);
  return JSON.parse(raw) as unknown[];
}

function extractJsonArrayVar(html: string, name: string): unknown[] {
  const match = new RegExp(`var\\s+${name}\\s*=\\s*\\[`).exec(html);
  if (!match) return [];
  const openIndex = match.index + match[0].lastIndexOf("[");
  return parseJsonArrayAt(html, openIndex);
}

function extractDataArray(gridChunk: string): unknown[] {
  const dataMatch = /data\s*:\s*\[/.exec(gridChunk);
  if (!dataMatch) return [];
  const openIndex = dataMatch.index + dataMatch[0].lastIndexOf("[");
  return parseJsonArrayAt(gridChunk, openIndex);
}

function extractColumns(gridChunk: string): GridColumn[] {
  const columns: GridColumn[] = [];
  for (const match of gridChunk.matchAll(
    /field:\s*'([^']+)'\s*,\s*title:\s*'([^']*)'/g,
  )) {
    columns.push({
      field: match[1],
      title: stripTags(match[2]) || match[1],
    });
  }
  return columns;
}

function uniqueKey(
  baseKey: string,
  record: Record<string, unknown>,
  suffix: string,
): string {
  if (!(baseKey in record)) return baseKey;
  const withSuffix = `${baseKey} (${suffix})`;
  if (!(withSuffix in record)) return withSuffix;
  let index = 2;
  while (`${withSuffix} ${index}` in record) index += 1;
  return `${withSuffix} ${index}`;
}

function normalizeRows(
  rawRows: unknown[],
  columns: GridColumn[],
): Record<string, unknown>[] {
  return rawRows
    .filter((row): row is Record<string, unknown> => {
      return typeof row === "object" && row !== null && !Array.isArray(row);
    })
    .map((row) => {
      if (columns.length === 0) return row;

      const normalized: Record<string, unknown> = {};
      for (const column of columns) {
        if (!(column.field in row)) continue;
        const key = uniqueKey(column.title || column.field, normalized, column.field);
        normalized[key] = row[column.field];
      }
      return normalized;
    });
}

function gridCategory(gridId: string): string {
  return gridId.replace(/^grid/, "") || gridId;
}

function extractGrids(html: string): CapturedGrid[] {
  const grids: CapturedGrid[] = [];
  const gridRegex = /\$\(['"]#(grid[^'"]+)['"]\)\.kendoGrid\(/g;
  let match: RegExpExecArray | null;

  while ((match = gridRegex.exec(html))) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingDelimiter(html, openIndex, "(", ")");
    if (closeIndex < 0) continue;

    const gridChunk = html.slice(openIndex + 1, closeIndex);
    const columns = extractColumns(gridChunk);
    const rawRows = extractDataArray(gridChunk);

    grids.push({
      gridId: match[1],
      category: gridCategory(match[1]),
      columns,
      rows: normalizeRows(rawRows, columns),
    });
  }

  return grids;
}

function extractAssetSummaryRows(html: string): AssetSummaryRow[] {
  const tableMatch = html.match(
    /<table\b[^>]*class=["'][^"']*\btable-asset\b[^"']*["'][^>]*>[\s\S]*?<\/table>/i,
  );
  if (!tableMatch) return [];

  const rows: AssetSummaryRow[] = [];
  for (const rowMatch of tableMatch[0].matchAll(
    /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi,
  )) {
    const assetType = rowMatch[1].match(
      /data-asset-type=["']([^"']+)["']/i,
    )?.[1];
    if (!assetType) continue;

    const cells = [...rowMatch[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (cellMatch) => stripTags(cellMatch[1]),
    );
    if (cells.length < 3) continue;

    rows.push({
      assetType,
      assetName: cleanText(cells[0]),
      assetValueTwd: cleanOptionalAmount(cells[1]),
      unrealizedPnlTwd: cleanOptionalAmount(cells[2]),
    });
  }

  return rows;
}

function parseReportPage(html: string, url: string, reportType: string): ReportPage {
  return {
    reportType,
    url,
    title: stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    currentAssetType: getStringVar(html, "currAssetType"),
    currentTradeType: getStringVar(html, "currTradeType"),
    currentFinanceType: getStringVar(html, "currFinanceType"),
    queryDateType: getStringVar(html, "queryDateType"),
    startDate: getStringVar(html, "startDate"),
    endDate: getStringVar(html, "endDate"),
    subCategory: getStringVar(html, "subCategory"),
    accountOptions: extractJsonArrayVar(html, "accountData"),
    summaryRows: extractAssetSummaryRows(html),
    grids: extractGrids(html),
  };
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // YuanTa pages keep analytics and local signing requests alive.
  });
  await page.waitForTimeout(750);
}

async function grantYuantaBrowserPermissions(page: Page): Promise<void> {
  await page.context().grantPermissions(["local-network-access"], {
    origin: "https://global.yuanta.com.tw",
  });
}

async function isSignedIn(page: Page): Promise<boolean> {
  if (!page.url().includes("/NexusWebTrade/AssetReport/")) return false;
  return await page
    .locator("#btnLogout")
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
}

async function acceptDisclaimerIfPresent(page: Page): Promise<void> {
  const checkbox = page.locator("#checkDisclaimer");
  if (!(await checkbox.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return;
  }

  await checkbox.check({ force: true });
  await page.locator("#btnConfirm").click();
  await settleAfterNavigation(page);
}

async function completeCertificateIfPresent(
  page: Page,
  certificatePath: string,
  certificatePassword: string,
  session: string,
): Promise<void> {
  const selectFileButton = page.locator("#btnPfxFile");
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (await page.locator("#btnLogout, #checkDisclaimer").first().isVisible().catch(() => false)) {
      return;
    }

    if (await selectFileButton.isVisible().catch(() => false)) {
      break;
    }

    await page.waitForTimeout(500);
  }

  if (!(await selectFileButton.isVisible().catch(() => false))) {
    throw new Error("Timed out waiting for the YuanTa certificate form.");
  }

  await page.locator("#jpki_PfxFile").fill(certificatePath);
  const passwordField = page.locator("#jpki_PfxFilePwd");
  const passwordVisible = await passwordField
    .isVisible({ timeout: 5_000 })
    .catch(() => false);

  if (!passwordVisible) {
    console.log(
      "manual-auth-required: choose the YuanTa certificate file if direct path entry is unavailable, then run `npx libretto resume --session " +
        session +
        "`.",
    );
    await pause(session);
  }

  await passwordField.fill(certificatePassword);
  await page.locator("#btnGo").click();
  await settleAfterNavigation(page);
}

async function fillTradeLoginForm(
  page: Page,
  credentials: YuantaTradeCredentials,
): Promise<void> {
  const userId = requireCredential(credentials, "yuanta_trade_user_id");
  const password = requireCredential(credentials, "yuanta_trade_password");

  await page.goto(TRADE_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#loginid").fill(userId);
  await page.locator("#loginPWD").fill(password);
}

async function checkYuantaCustomerBox(page: Page): Promise<void> {
  const checkbox = page.locator("#chbYCaptchaV2");
  if (!(await checkbox.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return;
  }

  if (!(await checkbox.isChecked().catch(() => false))) {
    await checkbox.check({ force: true });
  }
}

async function submitLoginIfReady(page: Page): Promise<void> {
  const loginButton = page.locator("#loginBtn");
  if (!(await loginButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return;
  }

  await checkYuantaCustomerBox(page);
  await loginButton.click();
  await settleAfterNavigation(page);
}

async function postAssetReport(
  page: Page,
  reportType: string,
  params: Record<string, string | number>,
): Promise<void> {
  await page.evaluate(
    ({ reportType, params }) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = reportType;

      for (const [key, value] of Object.entries(params)) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = String(value);
        form.appendChild(input);
      }

      document.body.appendChild(form);
      window.setTimeout(() => form.submit(), 0);
    },
    { reportType, params },
  );

  await settleAfterNavigation(page);
  await acceptDisclaimerIfPresent(page);
  await page.locator("#btnLogout").waitFor({ timeout: 60_000 });
}

async function captureReport(
  page: Page,
  reportType: string,
  params: Record<string, string | number>,
): Promise<ReportPage> {
  await postAssetReport(page, reportType, params);
  return parseReportPage(await page.content(), page.url(), reportType);
}

function tradeParams(
  input: WorkflowInput,
  tradeType: TradeType,
  dateRange: { startDate: string; endDate: string },
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    index: input.accountIndex,
    queryDateType: "6",
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  };

  const subCategory = DEFAULT_TRADE_SUBCATEGORIES[tradeType];
  if (subCategory) params.subCategory = subCategory;

  return params;
}

function gridCount(pages: ReportPage[]): number {
  return pages.reduce((total, page) => total + page.grids.length, 0);
}

function normalizeTradeRows(
  pages: ReportPage[],
  dateRange: { startDate: string; endDate: string },
): CsvRow[] {
  const period = periodLabel(dateRange);
  const rows: CsvRow[] = [];

  for (const page of pages) {
    for (const grid of page.grids) {
      for (const row of grid.rows) {
        const tradeDate = rowValue(row, ["交易日期"]);
        if (!tradeDate) continue;

        rows.push({
          trade_date: tradeDate,
          account_number: rowValue(row, ["交易帳號"]),
          asset_type: page.currentAssetType ?? "",
          trade_type: page.reportType,
          sub_category: page.subCategory || grid.category,
          product_code: rowValue(row, [
            "商品代號",
            "證券代號",
            "股票代號",
            "標的代號",
            "債券代號",
          ]),
          product_name: rowValue(row, [
            "商品名稱",
            "證券名稱",
            "投資標的",
            "標的名稱",
            "擔保品名稱",
          ]),
          currency: rowValue(row, [
            "商品幣別",
            "交易幣別",
            "幣別",
            "計價幣別",
            "投資幣別",
          ]),
          action: rowValue(row, ["交易類別"]),
          quantity: rowValue(row, [
            "面額/股數",
            "股數",
            "數量",
            "成交口數",
            "沖銷單位",
            "原始單位",
            "單位數",
            "交易單位數",
            "交易面額",
            "名目本金",
            "契約名目本金",
          ]),
          price: rowValue(row, [
            "價格",
            "成交價",
            "成交價格",
            "淨值",
            "約定利率 (年化)",
          ]),
          gross_amount: rowValue(row, [
            "交易價金",
            "成交金額",
            "價金",
            "交易金額",
            "交割金額",
            "現金收入(元)",
          ]),
          fee: rowValue(row, [
            "手續費",
            "手續/處理費",
            "手續處理費",
            "借券費",
            "入券費",
            "設質費",
          ]),
          tax: rowValue(row, ["稅/費", "交易稅", "代扣稅", "分離課稅"]),
          settlement_amount: rowValue(row, [
            "交割金額(原幣)",
            "應收付",
            "淨收付",
            "給付淨額",
            "應收付金額",
            "交割金額",
            "現金收入(元)",
            "現金支出(元)",
            "收入",
            "支出",
          ]),
          settlement_currency: rowValue(row, ["交割幣別"]),
          realized_pnl: rowValue(row, [
            "已實現損益",
            "含息投資損益",
            "客戶損益(稅前)",
          ]),
          cost_amount: rowValue(row, [
            "成本金額(原幣)",
            "投資成本",
            "累計投資成本",
          ]),
          __period: period,
        });
      }
    }
  }

  return rows.sort(compareTradeRowsByDateDesc);
}

function normalizeHoldingRows(
  pages: ReportPage[],
  fallbackDateRange: { startDate: string; endDate: string },
): CsvRow[] {
  const rows: CsvRow[] = [];

  for (const page of pages) {
    const asOfDate = page.endDate || page.startDate || fallbackDateRange.endDate;
    const period = reportPeriod(page) || asOfDate;

    for (const grid of page.grids) {
      for (const row of grid.rows) {
        const productCode = rowValue(row, [
          "商品代號",
          "證券代號",
          "股票代號",
          "標的代號",
        ]);
        const productName = rowValue(row, [
          "商品名稱",
          "證券名稱",
          "股票名稱",
          "基金名稱",
          "商品",
          "標的",
        ]);

        if (!productCode && !productName) continue;

        rows.push({
          as_of_date: asOfDate,
          account_number: rowValue(row, ["交易帳號"]),
          asset_type: page.currentAssetType ?? page.reportType,
          sub_category: page.subCategory || grid.category,
          product_code: productCode,
          product_name: productName,
          currency: rowValue(row, ["交易幣別", "商品幣別", "計價幣別", "幣別"]),
          quantity: rowValue(row, [
            "面額/股數",
            "股數",
            "數量",
            "餘額單位",
            "單位數",
            "未平倉口數",
            "票面餘額",
            "名目本金",
          ]),
          market_date: rowValue(row, ["市價日期", "淨值日", "價格參考日", "交易日"]),
          market_price: rowValue(row, ["參考市價", "參考價格", "參考淨值"]),
          market_value_original: rowValue(row, [
            "原幣現值",
            "參考現值 (原幣)",
            "資產淨值",
          ]),
          market_value_twd: rowValue(row, [
            "台幣現值",
            "市值",
            "參考現值 (約當台幣)",
            "擔保品市值",
            "約當台幣",
          ]),
          cost_price: rowValue(row, ["成本價格"]),
          cost_amount: rowValue(row, ["買入成本", "投資成本", "期初投入 (約當台幣)"]),
          unrealized_pnl_original: rowValue(row, [
            "未實現損益 (原幣)",
            "未實現損益",
          ]),
          unrealized_pnl_twd: rowValue(row, [
            "未實現損益 (約當台幣)",
            "未實現損益 (台幣)",
            "損益",
          ]),
          return_rate: rowValue(row, ["參考報酬率", "含息報酬率", "不含息報酬率"]),
          fx_rate: rowValue(row, ["參考匯率 (原幣)", "參考匯率"]),
          __period: period,
          __trade_type: page.currentTradeType ?? "",
        });
      }
    }
  }

  return rows;
}

function normalizeSummaryRows(
  pages: ReportPage[],
  fallbackDateRange: { startDate: string; endDate: string },
): CsvRow[] {
  const rows: CsvRow[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    const asOfDate = page.endDate || page.startDate || fallbackDateRange.endDate;
    const period = reportPeriod(page) || asOfDate;

    for (const summaryRow of page.summaryRows) {
      const key = `${asOfDate}|${summaryRow.assetType}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        as_of_date: asOfDate,
        asset_type: summaryRow.assetType,
        asset_name: summaryRow.assetName,
        asset_value_twd: summaryRow.assetValueTwd,
        unrealized_pnl_twd: summaryRow.unrealizedPnlTwd,
        __period: period,
      });
    }
  }

  return rows;
}

function metadataForRows(
  tableName: FileMetadata["tableName"],
  rows: CsvRow[],
  headers: readonly string[],
  generatedAt: string,
  csvFilename: string,
  jsonFilename: string,
): Omit<FileMetadata, "csvPath" | "jsonPath" | "csvBytes" | "jsonBytes"> {
  return {
    tableName,
    csvFilename,
    jsonFilename,
    accounts: unique(rows.map((row) => row.account_number ?? "")),
    periods: unique(rows.map((row) => row.__period ?? "")),
    assetTypes: unique(rows.map((row) => row.asset_type ?? "")),
    tradeTypes: unique(rows.map((row) => row.trade_type ?? row.__trade_type ?? "")),
    subCategories: unique(rows.map((row) => row.sub_category ?? "")),
    generatedAt,
    workflow: "yuantaTradeStatements",
    rowCount: rows.length,
    headers: [...headers],
  };
}

async function writeTableWithMetadata(
  outputDir: string,
  tableName: FileMetadata["tableName"],
  rows: CsvRow[],
  headers: readonly string[],
): Promise<FileMetadata> {
  await mkdir(outputDir, { recursive: true });

  const csvFilename = `${tableName}-${nextTimestamp()}.csv`;
  const jsonFilename = csvFilename.replace(/\.csv$/, ".json");
  const csvPath = join(outputDir, csvFilename);
  const jsonPath = join(outputDir, jsonFilename);
  const generatedAt = new Date().toISOString();
  const metadata = metadataForRows(
    tableName,
    rows,
    headers,
    generatedAt,
    csvFilename,
    jsonFilename,
  );
  const csvContent = rowsToCsv(rows, headers);
  const jsonContent = `${JSON.stringify(metadata, null, 2)}\n`;

  await writeFile(csvPath, csvContent, "utf8");
  await writeFile(jsonPath, jsonContent, "utf8");

  const csvStats = await stat(csvPath);
  const jsonStats = await stat(jsonPath);

  return {
    ...metadata,
    csvPath,
    jsonPath,
    csvBytes: csvStats.size,
    jsonBytes: jsonStats.size,
  };
}

async function writeResultsFiles(
  outputDir: string,
  result: {
    holdings: CsvRow[];
    trades: CsvRow[];
    summaries: CsvRow[];
  },
): Promise<FileMetadata[]> {
  const files: FileMetadata[] = [];

  if (result.trades.length > 0) {
    files.push(
      await writeTableWithMetadata(
        outputDir,
        "trade-transactions",
        result.trades,
        tradeTransactionHeaders,
      ),
    );
  }

  if (result.holdings.length > 0) {
    files.push(
      await writeTableWithMetadata(
        outputDir,
        "holdings",
        result.holdings,
        holdingHeaders,
      ),
    );
  }

  if (result.summaries.length > 0) {
    files.push(
      await writeTableWithMetadata(
        outputDir,
        "asset-summaries",
        result.summaries,
        assetSummaryHeaders,
      ),
    );
  }

  return files;
}

export default workflow("yuantaTradeStatements", {
  credentials: [
    "yuanta_trade_user_id",
    "yuanta_trade_password",
    "yuanta_trade_ca_path",
    "yuanta_trade_ca_password",
  ],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page, session } = ctx;
    const credentials = (input as typeof input & {
      credentials: YuantaTradeCredentials;
    }).credentials;
    let lastBankDialogMessage = "";

    await grantYuantaBrowserPermissions(page);

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
        await fillTradeLoginForm(authPage, signInCredentials as YuantaTradeCredentials);
        console.log(
          "manual-auth-required: solve YuanTa CAPTCHA/challenge in the browser, then run `npx libretto resume --session " +
            authSession +
            "`.",
        );
        await pause(authSession);

        await submitLoginIfReady(authPage);
        if (lastBankDialogMessage.includes("請勾選")) {
          throw new Error(
            `YuanTa login rejected the customer confirmation checkbox: ${lastBankDialogMessage}`,
          );
        }
        await completeCertificateIfPresent(
          authPage,
          requireCredential(
            signInCredentials as YuantaTradeCredentials,
            "yuanta_trade_ca_path",
          ),
          requireCredential(
            signInCredentials as YuantaTradeCredentials,
            "yuanta_trade_ca_password",
          ),
          authSession,
        );
        await acceptDisclaimerIfPresent(authPage);
        await authPage.locator("#btnLogout").waitFor({ timeout: 120_000 });
      },
    });

    if (!(await isSignedIn(page))) {
      await page.goto(
        "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/Stock",
        { waitUntil: "domcontentloaded" },
      );
      await settleAfterNavigation(page);
      await acceptDisclaimerIfPresent(page);
    }

    const dateRange = resolveDateRange(input);
    const holdings: ReportPage[] = [];
    const trades: ReportPage[] = [];

    if (input.includeHoldings) {
      for (const holdingType of input.holdingTypes as HoldingType[]) {
        holdings.push(
          await captureReport(page, holdingType, {
            index: input.accountIndex,
          }),
        );
      }
    }

    if (input.includeTrades) {
      for (const tradeType of input.tradeTypes as TradeType[]) {
        trades.push(
          await captureReport(
            page,
            tradeType,
            tradeParams(input, tradeType, dateRange),
          ),
        );
      }
    }

    const tradeRows = normalizeTradeRows(trades, dateRange);
    const holdingRows = normalizeHoldingRows(holdings, dateRange);
    const summaryRows = normalizeSummaryRows([...holdings, ...trades], dateRange);
    const files = await writeResultsFiles(input.outputDir, {
      holdings: holdingRows,
      trades: tradeRows,
      summaries: summaryRows,
    });

    return {
      dateRange,
      usedExistingSession: authResult.usedProfile,
      holdingPageCount: holdings.length,
      holdingGridCount: gridCount(holdings),
      holdingRowCount: holdingRows.length,
      tradePageCount: trades.length,
      tradeGridCount: gridCount(trades),
      tradeRowCount: tradeRows.length,
      files,
    };
  },
});
