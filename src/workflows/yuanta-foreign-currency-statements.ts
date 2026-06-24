import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Download, Frame, Locator, Page } from "playwright";
import { z } from "zod";

const BANK_ENTRY_URL = "https://ebank.yuantabank.com.tw/nib/ibanc.jsp";
const big5Decoder = new TextDecoder("big5");

type BrowserScope = Page | Frame;

type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};

type AccountOption = {
  label: string;
  value: string;
};

type CurrencyOption = {
  label: string;
  value: string;
};

const quickDateRangeSchema = z.enum(["one_week", "one_month", "three_months"]);

const channelTypeSchema = z.enum([
  "all",
  "online_bank",
  "voice",
  "business_bank",
  "mobile_bank",
]);

const customDateRangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
});

const inputSchema = z.object({
  dateRange: quickDateRangeSchema.default("three_months"),
  customDateRange: customDateRangeSchema.optional(),
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
  channelType: channelTypeSchema.default("all"),
  replaceActiveSession: z.boolean().default(true),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.literal("foreign-currency-transactions"),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  accounts: z.array(z.string()),
  currencies: z.array(z.string()),
  dateRange: z.string(),
  channelType: channelTypeSchema,
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: z.string(),
  channelType: channelTypeSchema,
  usedExistingSession: z.boolean(),
  replacedActiveSession: z.boolean(),
  count: z.number().int().nonnegative(),
  files: z.array(tableFileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;

type SourceDownloadMetadata = {
  account: string;
  currency: string;
  filename: string;
  rowCount: number;
};

type ForeignCurrencyTransactionRow = {
  accountLabel: string;
  queryCurrencyLabel: string;
  values: string[];
  sortTime: number | null;
};

const dateRangeLabels: Record<z.infer<typeof quickDateRangeSchema>, string> = {
  one_week: "一週",
  one_month: "一個月",
  three_months: "三個月",
};

const channelTypeValues: Record<z.infer<typeof channelTypeSchema>, string> = {
  all: "A",
  online_bank: "N",
  voice: "I",
  business_bank: "C",
  mobile_bank: "O",
};

const foreignCurrencyTransactionHeaders = [
  "帳戶名稱",
  "查詢幣別",
  "帳號",
  "帳務日期",
  "交易日期",
  "交易時間",
  "幣別",
  "交易說明",
  "支出金額",
  "存入金額",
  "帳面餘額",
  "交易資訊",
  "匯率",
];

const downloadedForeignCurrencyHeaders =
  foreignCurrencyTransactionHeaders.slice(2);

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

function digitsOnly(value: string): string {
  return toAsciiDigits(value).replace(/\D/g, "");
}

function maskAccountLabel(value: string): string {
  return cleanText(value).replace(/[0-9０-９]{4,}/g, (digits) => {
    const normalized = toAsciiDigits(digits);
    return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
  });
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

function stripSpreadsheetTextPrefix(value: string): string {
  const text = cleanText(value);
  return text.replace(/^'+/, "").replace(/'+$/, "");
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const nextChar = content[index + 1];

    if (quoted) {
      if (char === "\"" && nextChar === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function isRepeatedHeaderRow(values: string[]): boolean {
  return values.length === downloadedForeignCurrencyHeaders.length &&
    values.every(
      (value, index) => value === downloadedForeignCurrencyHeaders[index],
    );
}

function parseTransactionSortTime(values: string[]): number | null {
  const dateText = toAsciiDigits(stripSpreadsheetTextPrefix(values[2] ?? ""));
  const timeText = toAsciiDigits(stripSpreadsheetTextPrefix(values[3] ?? ""));
  const dateMatch = dateText.match(/^(\d{4})(\d{2})(\d{2})$/);
  const timeMatch = timeText.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = timeMatch ? Number(timeMatch[1]) : 0;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  const second = timeMatch ? Number(timeMatch[3] ?? "0") : 0;
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(time) ? time : null;
}

function transactionRowsFromDownloadedCsv(
  content: string,
  accountLabel: string,
  queryCurrencyLabel: string,
): ForeignCurrencyTransactionRow[] {
  const rows = parseCsvRows(content).map((row) =>
    row.map(stripSpreadsheetTextPrefix),
  );
  const headerIndex = rows.findIndex(isRepeatedHeaderRow);
  if (headerIndex < 0) {
    throw new Error(
      "Downloaded YuanTa foreign-currency CSV did not contain expected headers.",
    );
  }

  const transactions: ForeignCurrencyTransactionRow[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    if (!values.some((value) => value.length > 0)) continue;
    if (isRepeatedHeaderRow(values)) continue;
    if (values.length !== downloadedForeignCurrencyHeaders.length) {
      throw new Error(
        `Downloaded YuanTa foreign-currency CSV row had ${values.length} columns; expected ${downloadedForeignCurrencyHeaders.length}.`,
      );
    }

    transactions.push({
      accountLabel,
      queryCurrencyLabel,
      values,
      sortTime: parseTransactionSortTime(values),
    });
  }

  return transactions;
}

function sortedTransactionRows(
  rows: ForeignCurrencyTransactionRow[],
): ForeignCurrencyTransactionRow[] {
  return [...rows].sort((left, right) => {
    if (left.sortTime === null && right.sortTime === null) return 0;
    if (left.sortTime === null) return 1;
    if (right.sortTime === null) return -1;
    return right.sortTime - left.sortTime;
  });
}

function foreignCurrencyTransactionsToCsv(
  rows: ForeignCurrencyTransactionRow[],
): string {
  return rowsToCsv([
    foreignCurrencyTransactionHeaders,
    ...sortedTransactionRows(rows).map((row) => [
      row.accountLabel,
      row.queryCurrencyLabel,
      ...row.values,
    ]),
  ]);
}

async function readBig5DownloadAsUtf8(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return big5Decoder.decode(Buffer.concat(chunks));
}

async function writeForeignCurrencyTransactionsFile(
  nextTimestamp: () => string,
  dateRange: string,
  channelType: z.infer<typeof channelTypeSchema>,
  rows: ForeignCurrencyTransactionRow[],
  sourceDownloads: SourceDownloadMetadata[],
): Promise<TableFile> {
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "yuanta-foreign-currency-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `foreign-currency-transactions-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const accounts = [...new Set(rows.map((row) => row.accountLabel))];
  const currencies = [
    ...new Set(rows.map((row) => stripSpreadsheetTextPrefix(row.values[4] ?? ""))),
  ].filter((currency) => currency.length > 0);

  await writeFile(csvPath, foreignCurrencyTransactionsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt: new Date().toISOString(),
        workflow: "yuantaForeignCurrencyStatements",
        kind: "foreign-currency-transactions",
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers: foreignCurrencyTransactionHeaders,
        accounts,
        currencies,
        dateRange,
        channelType,
        sourceDownloads,
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
    kind: "foreign-currency-transactions",
    rowCount: rows.length,
    headers: foreignCurrencyTransactionHeaders,
    accounts,
    currencies,
    dateRange,
    channelType,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

function matchesFilter(
  option: { label: string; value: string },
  filters: string[],
): boolean {
  if (filters.length === 0) return true;

  const normalizedLabel = toAsciiDigits(option.label).toLowerCase();
  const normalizedValue = toAsciiDigits(option.value).toLowerCase();
  const optionDigits = digitsOnly(`${option.label} ${option.value}`);

  return filters.some((filter) => {
    const normalizedFilter = toAsciiDigits(filter).toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      normalizedLabel.includes(normalizedFilter) ||
      normalizedValue.includes(normalizedFilter) ||
      (filterDigits.length > 0 && optionDigits.endsWith(filterDigits))
    );
  });
}

function describeDateRange(input: WorkflowInput): string {
  if (input.customDateRange) {
    return `${input.customDateRange.startDate}-${input.customDateRange.endDate}`;
  }
  return dateRangeLabels[input.dateRange];
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
      const locator = scope.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0) return scope;
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
      const locator = locatorFor(scope);
      if ((await locator.count().catch(() => 0)) > 0) return scope;
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
    // YuanTa keeps timers alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
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

async function isSignedIn(page: Page): Promise<boolean> {
  const hasForeignForm = await findScopeWithSelector(page, "#acctno", 3_000)
    .then(() => true)
    .catch(() => false);
  if (hasForeignForm) return true;

  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("#submenuAreaFX")
        .or(
          candidate
            .locator('a[onclick*="fxtransactiondetails"]')
            .filter({ hasText: "外幣交易明細查詢" }),
        )
        .first(),
    "YuanTa signed-in foreign-currency navigation",
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

async function openForeignCurrencyDetailsPage(
  page: Page,
): Promise<BrowserScope> {
  const existing = await findForeignCurrencyDetailsForm(page, 5_000).catch(
    () => null,
  );
  if (existing) return existing;

  if (await clickForeignCurrencyDetailsLink(page, 5_000)) {
    return await findForeignCurrencyDetailsForm(page);
  }

  const summaryScope = await findScopeWithSelector(page, "#submenuAreaFX");
  await summaryScope.locator("#submenuAreaFX").click({ force: true });

  if (await clickForeignCurrencyDetailsLink(page, 3_000)) {
    return await findForeignCurrencyDetailsForm(page);
  }

  const demandDepositLink = await firstVisibleLocator(
    summaryScope
      .locator("#submenu_innerFX a")
      .filter({ hasText: "活期明細" }),
    "YuanTa foreign-currency demand-deposit details link",
  );
  await demandDepositLink.click({ force: true });
  await settleAfterNavigation(page);

  const formAfterOverview = await findForeignCurrencyDetailsForm(page, 3_000)
    .then((scope) => scope)
    .catch(() => null);
  if (formAfterOverview) return formAfterOverview;

  if (await clickForeignCurrencyDetailsLink(page)) {
    return await findForeignCurrencyDetailsForm(page);
  }

  throw new Error("Could not open YuanTa foreign-currency details page.");
}

async function findForeignCurrencyDetailsForm(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasAccount = (await scope.locator("#acctno").count().catch(() => 0)) > 0;
      const hasCurrency =
        (await scope.locator('select[name="currency"]').count().catch(() => 0)) >
        0;
      if (hasAccount && hasCurrency) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Could not find YuanTa foreign-currency details form.");
}

async function clickForeignCurrencyDetailsLink(
  page: Page,
  timeoutMs = 60_000,
): Promise<boolean> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate.locator('a[onclick*="fxtransactiondetails"]').filter({
        hasText: /^(外幣)?交易明細查詢$/,
      }),
    "YuanTa foreign-currency details link",
    timeoutMs,
  ).catch(() => null);
  if (!scope) return false;

  const link = await firstVisibleLocator(
    scope.locator('a[onclick*="fxtransactiondetails"]').filter({
      hasText: /^(外幣)?交易明細查詢$/,
    }),
    "YuanTa foreign-currency details link",
    timeoutMs,
  ).catch(() => null);
  if (!link) return false;

  await link.click({ force: true });
  await settleAfterNavigation(page);
  return true;
}

async function chooseDateRange(page: Page, input: WorkflowInput): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");

  if (input.customDateRange) {
    const customLink = await firstVisibleLocator(
      scope.locator("#duration a").filter({ hasText: "自選" }),
      'YuanTa date range link "自選"',
    );
    await customLink.click({ force: true });
    await scope.locator("#sdate").fill(input.customDateRange.startDate);
    await scope.locator("#edate").fill(input.customDateRange.endDate);
    return;
  }

  const label = dateRangeLabels[input.dateRange];
  const link = await firstVisibleLocator(
    scope.locator("#duration a").filter({ hasText: label }),
    `YuanTa date range link "${label}"`,
  );
  await link.click({ force: true });
}

async function waitForCurrencyOptions(
  page: Page,
  scope: BrowserScope,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await scope
      .locator('select[name="currency"] option')
      .count()
      .catch(() => 0);
    if (count > 0) return;
    await page.waitForTimeout(250);
  }
  throw new Error("Timed out waiting for YuanTa currency options.");
}

async function selectAccount(page: Page, account: AccountOption): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator("#acctno").selectOption(account.value);
  await waitForCurrencyOptions(page, scope);
}

async function readAccountOptions(
  page: Page,
  filters: string[],
): Promise<AccountOption[]> {
  const scope = await findScopeWithSelector(page, "#acctno");
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const accounts: AccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (!value || /請選擇/.test(label)) continue;

    const account = { label, value };
    if (matchesFilter(account, filters)) accounts.push(account);
  }

  if (accounts.length === 0) {
    throw new Error("No foreign-currency account options matched the input.");
  }

  return accounts;
}

async function readCurrencyOptions(
  page: Page,
  filters: string[],
): Promise<CurrencyOption[]> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await waitForCurrencyOptions(page, scope);

  const options = scope.locator('select[name="currency"] option');
  const count = await options.count();
  const currencies: CurrencyOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (!value || /請選擇/.test(label)) continue;
    currencies.push({ label, value });
  }

  if (filters.length === 0) {
    const allCurrency = currencies.find((currency) => currency.value === "ALL");
    return allCurrency ? [allCurrency] : currencies;
  }

  const filtered = currencies.filter((currency) =>
    matchesFilter(currency, filters),
  );
  if (filtered.length === 0) {
    throw new Error("No foreign-currency options matched the input.");
  }

  return filtered;
}

async function waitForCsvDownloadLink(page: Page): Promise<void> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa foreign-currency CSV download link",
  );
  await scope.locator("#resultdiv").waitFor({ state: "visible", timeout: 60_000 });
  await scope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(1_000);
}

async function queryAccountCurrency(
  page: Page,
  input: WorkflowInput,
  account: AccountOption,
  currency: CurrencyOption,
): Promise<void> {
  await selectAccount(page, account);

  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator('select[name="currency"]').selectOption(currency.value);
  await chooseDateRange(page, input);
  await scope.locator("#channelType").selectOption(channelTypeValues[input.channelType]);
  await scope.locator("#submitbutton").click();
  await settleAfterNavigation(page);
  await waitForCsvDownloadLink(page);
}

async function downloadTransactionRows(
  page: Page,
  accountLabel: string,
  currencyLabel: string,
): Promise<{ filename: string; rows: ForeignCurrencyTransactionRow[] }> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa foreign-currency CSV download link",
  );

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  const link = scope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first();
  await link.waitFor({ state: "visible", timeout: 60_000 });
  await link.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await link.click();
  const download = await downloadPromise;

  const filename = download.suggestedFilename();
  const content = await readBig5DownloadAsUtf8(download);
  return {
    filename,
    rows: transactionRowsFromDownloadedCsv(content, accountLabel, currencyLabel),
  };
}

export default workflow("yuantaForeignCurrencyStatements", {
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
        if (!(await isSignedIn(authPage))) {
          const loginFrame = authPage.frame({ name: "main" });
          const stillOnLogin =
            loginFrame &&
            (await loginFrame
              .locator("#custidMask, #custnoInput, #custcode, #gcode")
              .first()
              .isVisible()
              .catch(() => false));
          if (stillOnLogin) {
            await submitLogin(authPage, signInCredentials as YuantaCredentials);
          }
        }
        replacedActiveSession = await waitForSignedInState(
          authPage,
          () => lastBankDialogMessage,
          input.replaceActiveSession,
        );
      },
    });

    await openForeignCurrencyDetailsPage(page);

    const accounts = await readAccountOptions(page, input.accountFilters);
    const rows: ForeignCurrencyTransactionRow[] = [];
    const sourceDownloads: SourceDownloadMetadata[] = [];
    const nextTimestamp = createTimestampGenerator();

    for (const account of accounts) {
      await selectAccount(page, account);
      const currencies = await readCurrencyOptions(page, input.currencyFilters);

      for (const currency of currencies) {
        const maskedAccount = maskAccountLabel(account.label);
        await queryAccountCurrency(page, input, account, currency);
        const download = await downloadTransactionRows(
          page,
          maskedAccount,
          currency.label,
        );
        rows.push(...download.rows);
        sourceDownloads.push({
          account: maskedAccount,
          currency: currency.label,
          filename: download.filename,
          rowCount: download.rows.length,
        });
      }
    }

    const dateRange = describeDateRange(input);
    const file = await writeForeignCurrencyTransactionsFile(
      nextTimestamp,
      dateRange,
      input.channelType,
      rows,
      sourceDownloads,
    );

    return {
      dateRange,
      channelType: input.channelType,
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession,
      count: 1,
      files: [file],
    };
  },
});
