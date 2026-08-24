import { mkdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Download, Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { parseCsvMatrix } from "../lib/tabular-text.ts";
import { hasAttachedLocator } from "./browser-interaction.js";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import {
  authenticateYuantaBank as sharedAuthenticateYuantaBank,
  type YuantaCredentials,
} from "./yuanta-auth.ts";
import {
  commitForeignCurrencyDepositCaptureBatch,
  type ForeignCurrencyDepositCaptureInput,
  type ForeignCurrencyDepositCommitStore,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";

const big5Decoder = new TextDecoder("big5");

type BrowserScope = Page | Frame;

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
  accountValue: string;
  account: string;
  currency: string;
  filename: string;
  rowCount: number;
};

type ForeignCurrencyTransactionRow = {
  accountLabel: string;
  accountValue: string;
  queryCurrencyLabel: string;
  queryCurrencyValue: string;
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

function isRepeatedHeaderRow(values: string[]): boolean {
  return (
    values.length === downloadedForeignCurrencyHeaders.length &&
    values.every(
      (value, index) => value === downloadedForeignCurrencyHeaders[index],
    )
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
  accountValue: string,
  queryCurrencyLabel: string,
  queryCurrencyValue: string,
): ForeignCurrencyTransactionRow[] {
  const rows = parseCsvMatrix(content).map((row) =>
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
      accountValue,
      queryCurrencyLabel,
      queryCurrencyValue,
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
    ...new Set(
      rows.map((row) => stripSpreadsheetTextPrefix(row.values[4] ?? "")),
    ),
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

function isUnavailableOption(value: string, label: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedLabel = cleanText(label).toLowerCase();
  if (
    !normalizedValue ||
    ["0", "-1", "none", "null", "undefined"].includes(normalizedValue)
  ) {
    return true;
  }
  return (
    /^(?:請|请)?選擇(?:帳戶|账戶|幣別|币别)?$/.test(normalizedLabel) ||
    /^(?:無|无)(?:可用)?(?:帳戶|账戶|幣別|币别)$/.test(normalizedLabel)
  );
}

function describeDateRange(input: WorkflowInput): string {
  if (input.customDateRange) {
    return `${input.customDateRange.startDate}-${input.customDateRange.endDate}`;
  }
  return dateRangeLabels[input.dateRange];
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
    // YuanTa keeps timers alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
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
    summaryScope.locator("#submenu_innerFX a").filter({ hasText: "活期明細" }),
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
      const hasAccount = await hasAttachedLocator(scope.locator("#acctno"));
      const hasCurrency = await hasAttachedLocator(
        scope.locator('select[name="currency"]'),
      );
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

async function chooseDateRange(
  page: Page,
  input: WorkflowInput,
): Promise<void> {
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
    if (
      await hasAttachedLocator(scope.locator('select[name="currency"] option'))
    ) {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Timed out waiting for YuanTa currency options.");
}

async function selectAccount(
  page: Page,
  account: AccountOption,
): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator("#acctno").selectOption(account.value);
  await waitForCurrencyOptions(page, scope);
}

export async function readYuantaForeignCurrencyAccountOptions(
  page: Page,
  _filters: string[] = [],
): Promise<AccountOption[]> {
  const scope = await findScopeWithSelector(page, "#acctno");
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const availableAccounts: AccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (isUnavailableOption(value, label)) continue;

    const account = { label, value };
    availableAccounts.push(account);
  }

  if (availableAccounts.length === 0) {
    throw new StatementComponentAbsentError(
      "No YuanTa foreign-currency account is available for this login.",
    );
  }
  // Account filters are legacy persisted UI state. Yuanta foreign-currency
  // capture always includes every visible account; provider absence is the
  // only skip.
  return availableAccounts;
}

export async function readYuantaForeignCurrencyOptions(
  page: Page,
  filters: string[] = [],
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
    if (isUnavailableOption(value, label)) continue;
    currencies.push({ label, value });
  }

  if (currencies.length === 0) {
    throw new StatementComponentAbsentError(
      "No YuanTa foreign-currency position is available for this account.",
    );
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
  await scope
    .locator("#resultdiv")
    .waitFor({ state: "visible", timeout: 60_000 });
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
  await scope
    .locator("#channelType")
    .selectOption(channelTypeValues[input.channelType]);
  await scope.locator("#submitbutton").click();
  await settleAfterNavigation(page);
  await waitForCsvDownloadLink(page);
}

async function downloadTransactionRows(
  page: Page,
  accountLabel: string,
  accountValue: string,
  currencyLabel: string,
  currencyValue: string,
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
    rows: transactionRowsFromDownloadedCsv(
      content,
      accountLabel,
      accountValue,
      currencyLabel,
      currencyValue,
    ),
  };
}

function sourceDateRange(input: WorkflowInput): {
  startDate: string;
  endDate: string;
} {
  if (input.customDateRange)
    return {
      startDate: input.customDateRange.startDate.replaceAll("/", "-"),
      endDate: input.customDateRange.endDate.replaceAll("/", "-"),
    };
  const end = new Date();
  const days = input.dateRange === "one_week" ? 7 : input.dateRange === "one_month" ? 31 : 93;
  const start = new Date(end.getTime() - days * 86_400_000);
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

function exactCell(value: string, label: string): string {
  const normalized = stripSpreadsheetTextPrefix(value).replace(/[ ,]/g, "");
  if (!normalized || normalized === "-")
    throw new Error(`Yuanta foreign row is missing ${label}.`);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized))
    throw new Error(`Yuanta foreign ${label} is not an exact decimal.`);
  return normalized;
}

function currencyCode(label: string, value: string): string {
  const rowCandidate = label.toUpperCase().match(/\b[A-Z]{3}\b/)?.[0];
  if (rowCandidate && rowCandidate !== "ALL") return rowCandidate;
  const typedCandidate = value.toUpperCase().match(/\b[A-Z]{3}\b/)?.[0];
  if (typedCandidate && typedCandidate !== "ALL") return typedCandidate;
  throw new Error("Yuanta foreign row lacks a source currency.");
}

/** Public workflow-to-canonical seam used by browser runs and deterministic checks. */
export function buildYuantaForeignCurrencyCaptureInput(
  rows: readonly ForeignCurrencyTransactionRow[],
  input: WorkflowInput,
  accountNo: string,
  observedAt = new Date().toISOString(),
  captureOccurrenceId = "",
  zeroResultAuthority?: "provider-explicit-no-data",
): ForeignCurrencyDepositCaptureInput {
  if (
    rows.length === 0 &&
    zeroResultAuthority !== "provider-explicit-no-data"
  )
    throw new Error(
      "Yuanta foreign empty capture requires provider-explicit-no-data terminal evidence.",
    );
  const range = sourceDateRange(input);
  return {
    source: "yuanta",
    accountNo,
    sourceConnectionKey: "yuanta-foreign-current-login",
    identityEpochKey: "yuanta-foreign-current-identity",
    accountType: "depository",
    captureCurrencyScope: { kind: "multi-currency" },
    captureOccurrenceId,
    zeroResultAuthority,
    observedAt,
    ...range,
    completeness: "complete-range",
    records: rows.map((row) => {
      const values = row.values;
      const debit = stripSpreadsheetTextPrefix(values[6] ?? "");
      const credit = stripSpreadsheetTextPrefix(values[7] ?? "");
      if ((debit.length > 0) === (credit.length > 0))
        throw new Error("Yuanta foreign row must prove exactly one amount direction.");
      const localDate = toAsciiDigits(values[2] ?? "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      const localTime = toAsciiDigits(values[3] ?? "");
      const rowCurrency = currencyCode(values[4] ?? "", row.queryCurrencyValue);
      const providerSequence = stripSpreadsheetTextPrefix(values[0] ?? "").trim();
      if (!providerSequence)
        throw new Error("Yuanta foreign row lacks provider sequence identity.");
      const reportedRateText = stripSpreadsheetTextPrefix(values[10] ?? "");
      return {
        sourceKey: `${accountNo}:${rowCurrency}:sequence:${providerSequence}`,
        sequence: providerSequence,
        amount: exactCell(debit || credit, "amount"),
        direction: debit.length > 0 ? "outflow" : "inflow",
        currencyEvidence: {
          kind: "row" as const,
          currency: rowCurrency,
        },
        balanceAfter: exactCell(values[8] ?? "", "balance"),
        sourceTime: {
          localDate,
          localTime: localTime || undefined,
          precision: localTime ? undefined : ("date" as const),
        },
        // Yuanta's foreign statement amount is already denominated in the
        // source row currency; preserving it as original evidence avoids
        // inventing a TWD conversion or fee from an unlabeled rate column.
        originalAmount: {
          amount: exactCell(debit || credit, "original amount"),
          currency: rowCurrency,
        },
        sourceReportedRate: reportedRateText
          ? {
              rate: exactCell(reportedRateText, "reported rate"),
              baseCurrency: rowCurrency,
              quoteCurrency: "TWD",
              observedOn: localDate,
            }
          : null,
        description: values[5] || null,
        sourcePayload: {
          providerSequence,
          transactionInfo: values[9] ?? "",
          reportedRate: reportedRateText,
        },
      };
    }),
  };
}

export async function commitYuantaForeignCurrencyCapture(
  store: ForeignCurrencyDepositCommitStore,
  input: ForeignCurrencyDepositCaptureInput,
) {
  return commitForeignCurrencyDepositCaptureBatch(store, [input]);
}

export default workflow("yuantaForeignCurrencyStatements", {
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page } = ctx;
    const credentials = (
      input as typeof input & { credentials: YuantaCredentials }
    ).credentials;
    const authResult = await sharedAuthenticateYuantaBank(
      ctx,
      credentials,
      input.replaceActiveSession,
    );
    const replacedActiveSession = authResult.replacedActiveSession;

    await openForeignCurrencyDetailsPage(page);

    const accounts = await readYuantaForeignCurrencyAccountOptions(
      page,
      input.accountFilters,
    );
    const rows: ForeignCurrencyTransactionRow[] = [];
    const sourceDownloads: SourceDownloadMetadata[] = [];
    const nextTimestamp = createTimestampGenerator();

    for (const account of accounts) {
      await selectAccount(page, account);
      const currencies = await readYuantaForeignCurrencyOptions(
        page,
        input.currencyFilters,
      );

      for (const currency of currencies) {
        const maskedAccount = maskAccountLabel(account.label);
        await queryAccountCurrency(page, input, account, currency);
        const download = await downloadTransactionRows(
          page,
          maskedAccount,
          account.value,
          currency.label,
          currency.value,
        );
        rows.push(...download.rows);
        sourceDownloads.push({
          accountValue: account.value,
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

    const financialLedgerDir =
      process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR;
    if (financialLedgerDir) {
      const captureOccurrenceId = randomUUID();
      const financialStore = createCanonicalSourceStore(
        canonicalSqlitePath(financialLedgerDir),
      );
      try {
        const grouped = new Map<string, ForeignCurrencyTransactionRow[]>();
        for (const row of rows) {
          const accountRows = grouped.get(row.accountValue) ?? [];
          accountRows.push(row);
          grouped.set(row.accountValue, accountRows);
        }
        const captures = accounts.map((account) => {
          const accountRows = grouped.get(account.value) ?? [];
          const accountDownloads = sourceDownloads.filter(
            (download) => download.accountValue === account.value,
          );
          const zeroResultAuthority =
            accountRows.length === 0 &&
            accountDownloads.length > 0 &&
            accountDownloads.every((download) => download.rowCount === 0)
              ? ("provider-explicit-no-data" as const)
              : undefined;
          return buildYuantaForeignCurrencyCaptureInput(
            accountRows,
            input,
            account.value,
            new Date().toISOString(),
            captureOccurrenceId,
            zeroResultAuthority,
          );
        });
        await commitForeignCurrencyDepositCaptureBatch(financialStore, captures);
      } finally {
        financialStore.close();
      }
    }

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
