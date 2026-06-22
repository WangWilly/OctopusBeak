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

const fileSchema = z.object({
  kind: z.enum(["csv", "manifest"]),
  filename: z.string(),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  reportType: z.string().optional(),
  category: z.string().optional(),
  rowCount: z.number().int().nonnegative().optional(),
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
  files: z.array(fileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type HoldingType = z.infer<typeof holdingTypeSchema>;
type TradeType = z.infer<typeof tradeTypeSchema>;
type FileMetadata = z.infer<typeof fileSchema>;

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
  summaryRows: string[][];
  grids: CapturedGrid[];
};

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

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
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

function recordsToCsv(rows: Record<string, unknown>[]): string {
  const headers = [
    ...new Set(rows.flatMap((row) => Object.keys(row).filter(Boolean))),
  ];
  const lines = [headers.map(csvCell).join(",")];

  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function tableRowsToCsv(rows: string[][]): string {
  const columnCount = rows.reduce(
    (largest, row) => Math.max(largest, row.length),
    0,
  );
  if (columnCount === 0) return "";

  const headers = Array.from(
    { length: columnCount },
    (_, index) => `column_${index + 1}`,
  );
  const lines = [headers.map(csvCell).join(",")];

  for (const row of rows) {
    lines.push(headers.map((_, index) => csvCell(row[index] ?? "")).join(","));
  }

  return `${lines.join("\n")}\n`;
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

function extractTableRows(html: string): string[][] {
  return [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)]
    .map((rowMatch) => {
      return [...rowMatch[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cellMatch) => stripTags(cellMatch[1]))
        .filter(Boolean);
    })
    .filter((row) => row.length > 0);
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
    summaryRows: extractTableRows(html),
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

function rowCount(pages: ReportPage[]): number {
  return pages.reduce((total, page) => {
    return (
      total +
      page.grids.reduce((gridTotal, grid) => gridTotal + grid.rows.length, 0)
    );
  }, 0);
}

function gridCount(pages: ReportPage[]): number {
  return pages.reduce((total, page) => total + page.grids.length, 0);
}

async function writeTextFile(
  outputDir: string,
  filename: string,
  content: string,
  metadata: Omit<FileMetadata, "filename" | "path" | "bytes">,
): Promise<FileMetadata> {
  const path = join(outputDir, filename);
  await writeFile(path, content, "utf8");
  const stats = await stat(path);
  return {
    ...metadata,
    filename,
    path,
    bytes: stats.size,
  };
}

async function writeResultsFiles(
  outputDir: string,
  result: {
    dateRange: { startDate: string; endDate: string };
    holdings: ReportPage[];
    trades: ReportPage[];
  },
): Promise<FileMetadata[]> {
  await mkdir(outputDir, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const files: FileMetadata[] = [];

  for (const [kind, pages] of [
    ["holdings", result.holdings],
    ["trades", result.trades],
  ] as const) {
    for (const page of pages) {
      if (page.summaryRows.length > 0) {
        files.push(
          await writeTextFile(
            outputDir,
            safeFilename(`${kind}-${page.reportType}-summary-${id}.csv`),
            tableRowsToCsv(page.summaryRows),
            {
              kind: "csv",
              reportType: page.reportType,
              category: "summary",
              rowCount: page.summaryRows.length,
            },
          ),
        );
      }

      for (const [gridIndex, grid] of page.grids.entries()) {
        if (grid.rows.length === 0) continue;

        files.push(
          await writeTextFile(
            outputDir,
            safeFilename(
              `${kind}-${page.reportType}-${grid.category}-${gridIndex + 1}-${id}.csv`,
            ),
            recordsToCsv(grid.rows),
            {
              kind: "csv",
              reportType: page.reportType,
              category: grid.category,
              rowCount: grid.rows.length,
            },
          ),
        );
      }
    }
  }

  files.push(
    await writeTextFile(
      outputDir,
      safeFilename(`yuanta-trade-statements-${id}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      {
        kind: "manifest",
      },
    ),
  );

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
        trades.push(await captureReport(page, tradeType, tradeParams(input, tradeType, dateRange)));
      }
    }

    const files = await writeResultsFiles(input.outputDir, {
      dateRange,
      holdings,
      trades,
    });

    return {
      dateRange,
      usedExistingSession: authResult.usedProfile,
      holdingPageCount: holdings.length,
      holdingGridCount: gridCount(holdings),
      holdingRowCount: rowCount(holdings),
      tradePageCount: trades.length,
      tradeGridCount: gridCount(trades),
      tradeRowCount: rowCount(trades),
      files,
    };
  },
});
