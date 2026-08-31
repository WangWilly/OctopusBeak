import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import {
  clickAndWaitForNavigation,
  hasAttachedLocator,
} from "./browser-interaction.js";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import { canonicalSqlitePath } from "../ledger/canonical/canonical-source-store.ts";
import {
  createCanonicalLoanStore,
  type LoanCapturePage,
  type LoanSourceCompletenessEvidence,
} from "../ledger/canonical/loan-financial.ts";
import {
  persistYuantaLoanCapture,
  type YuantaLoanCaptureBuildInput,
  type YuantaLoanStatementRow,
} from "../ledger/canonical/yuanta-loan.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  authenticateYuantaBank as sharedAuthenticateYuantaBank,
  type YuantaCredentials,
} from "./yuanta-auth.ts";

const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";

type BrowserScope = Page | Frame;

type LoanAccountOption = {
  label: string;
  value: string;
};

type StatementRow = {
  accountLabel: string;
  transactionDate: string;
  postingDate: string;
  paymentItem: string;
  interestStartDate: string;
  interestEndDate: string;
  transactionAmount: string;
  balanceAfterTransaction: string;
  overpayment: string;
  sortTime: number | null;
};

const YUANTA_LOAN_MAX_PAGES = 10_000;

export type YuantaLoanPaginationSignal = {
  nextPageTarget: string | null;
  terminal: boolean;
  evidence: "next-page" | "terminal-no-next" | null;
};

type ParsedYuantaLoanPage = {
  rows: StatementRow[];
  pageOrdinal: number;
  pagination: YuantaLoanPaginationSignal;
};

const quickDateRangeSchema = z.enum(["three_months", "six_months", "one_year"]);

const customDateRangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
});

const inputSchema = z.object({
  dateRange: quickDateRangeSchema.default("one_year"),
  customDateRange: customDateRangeSchema.optional(),
  loanAccountFilters: z.array(z.string()).default([]),
  replaceActiveSession: z.boolean().default(true),
});

const sourceTableSchema = z.object({
  account: z.string(),
  rowCount: z.number().int().nonnegative(),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.literal("loan-statements"),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  accounts: z.array(z.string()),
  dateRange: z.string(),
  sourceTables: z.array(sourceTableSchema),
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
  count: z.number().int().nonnegative(),
  files: z.array(tableFileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;
type SourceTable = z.infer<typeof sourceTableSchema>;
type YuantaLoanStatementsOutput = z.infer<typeof outputSchema>;

export type YuantaLoanStatementsRunDependencies = Partial<{
  canonicalLedgerDir: string;
  canonicalFinancialLedgerDir: string;
  sourceConnectionScope: string;
  observedAt: () => string;
  createLoanStore: typeof createCanonicalLoanStore;
  persistLoanCapture: (
    store: ReturnType<typeof createCanonicalLoanStore>,
    input: YuantaLoanCaptureBuildInput,
  ) => ReturnType<typeof persistYuantaLoanCapture>;
}>;

const dateRangeLabels: Record<z.infer<typeof quickDateRangeSchema>, string> = {
  three_months: "三個月",
  six_months: "六個月",
  one_year: "一年",
};

const statementHeaders = [
  "貸款帳戶",
  "交易日",
  "記帳日",
  "繳款項目",
  "提息起日",
  "提息迄日",
  "交易金額",
  "交易後餘額",
  "溢繳款",
] as const;

const sourceStatementColumnCount = 6;

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value: string): string {
  return cleanText(value.replace(/<[^>]*>/gu, " "));
}

function htmlAttribute(openingTag: string, name: string): string {
  return (
    openingTag.match(
      new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu"),
    )?.[2] ?? ""
  );
}

function htmlControlOpeningTag(controlHtml: string): string {
  return (
    controlHtml.match(/^<(?:a|button|input)\b[^>]*>/iu)?.[0] ?? controlHtml
  );
}

function htmlControlLabel(controlHtml: string): string {
  const opening = htmlControlOpeningTag(controlHtml);
  return (
    stripHtml(controlHtml) ||
    cleanText(htmlAttribute(opening, "value")) ||
    cleanText(htmlAttribute(opening, "aria-label"))
  );
}

function isDisabledHtmlControl(openingTag: string): boolean {
  return (
    /\bdisabled\b/iu.test(openingTag) ||
    /aria-disabled\s*=\s*["']?true\b/iu.test(openingTag) ||
    /\bdisabled\b/iu.test(htmlAttribute(openingTag, "class"))
  );
}

function loanPagerTarget(controlHtml: string): string | null {
  const opening = htmlControlOpeningTag(controlHtml);
  if (isDisabledHtmlControl(opening)) return null;
  const action = `${htmlAttribute(opening, "onclick")} ${htmlAttribute(opening, "href")}`;
  const pageNumber = action.match(
    /(?:goPage|setPage|currentPage|pageIndex|pageNo|pageNumber)\s*\([^)]*?(\d+)\s*\)?/iu,
  )?.[1];
  if (pageNumber) return `page:${pageNumber}`;
  const queryPage = action.match(
    /[?&#](?:page|pageNo|pageIndex)=([^&#"']+)/iu,
  )?.[1];
  if (queryPage) return `page:${queryPage}`;
  return null;
}

function isLoanNextControl(controlHtml: string): boolean {
  const opening = htmlControlOpeningTag(controlHtml);
  if (isDisabledHtmlControl(opening)) return false;
  const text = htmlControlLabel(controlHtml);
  if (!/^(?:下一頁|下頁|next(?:\s*page)?)$/iu.test(text)) return false;
  const haystack = `${opening} ${text}`;
  if (/queryMonth|menuaction/iu.test(haystack)) return false;
  return (
    loanPagerTarget(controlHtml) !== null ||
    /\b(?:pager|pagination)\b/iu.test(haystack)
  );
}

/**
 * Yuanta loan results use the same pager vocabulary as the existing
 * credit-card result adapter (`下一頁`, `goPage(...)`, and page query
 * parameters).  We retain only structural page signals: an active next
 * control requests traversal, while a pager with no active next control is a
 * provider terminal signal. A result table with no pager evidence is
 * ambiguous and cannot be admitted as a complete range.
 */
export function parseYuantaLoanPaginationSignal(
  html: string,
): YuantaLoanPaginationSignal {
  const controls = [
    ...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu),
    ...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/giu),
    ...html.matchAll(/<input\b[^>]*>/giu),
  ].map((match) => match[0]);
  const nextControl = controls.find((control) => isLoanNextControl(control));
  if (nextControl)
    return {
      nextPageTarget: loanPagerTarget(nextControl),
      terminal: false,
      evidence: loanPagerTarget(nextControl) ? "next-page" : null,
    };

  const hasDisabledNext = controls.some((control) => {
    const opening = htmlControlOpeningTag(control);
    return (
      /(?:下一頁|下頁|next(?:\s*page)?)/iu.test(htmlControlLabel(control)) &&
      isDisabledHtmlControl(opening)
    );
  });
  const hasPagerState =
    /(?:pager|pagination|goPage|setPage|currentPage|pageIndex|pageNo|下一頁|下頁)/iu.test(
      html,
    ) ||
    /<(?:input|select)\b[^>]*(?:name|id)\s*=\s*["'][^"']*(?:page|pager|current)[^"']*["']/iu.test(
      html,
    );
  if (hasPagerState && (hasDisabledNext || !controls.some((control) =>
    /(?:下一頁|下頁|next(?:\s*page)?)/iu.test(htmlControlLabel(control)),
  )))
    return {
      nextPageTarget: null,
      terminal: true,
      evidence: "terminal-no-next",
    };

  return {
    nextPageTarget: null,
    terminal: false,
    evidence: null,
  };
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

function isUnavailableAccountOption(value: string, label: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedLabel = cleanText(label).toLowerCase();
  if (
    !normalizedValue ||
    ["0", "-1", "none", "null", "undefined"].includes(normalizedValue)
  ) {
    return true;
  }
  return (
    /^(?:請|请)?選擇(?:貸款)?帳戶$/.test(normalizedLabel) ||
    /^(?:無|无)(?:可用)?(?:貸款)?帳戶$/.test(normalizedLabel)
  );
}

function describeDateRange(input: WorkflowInput): string {
  if (input.customDateRange) {
    return `${input.customDateRange.startDate}-${input.customDateRange.endDate}`;
  }
  return dateRangeLabels[input.dateRange];
}

function addMonthsClamped(date: Date, months: number): Date {
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth() + months;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(targetYear, targetMonth, Math.min(date.getDate(), lastDay));
}

function canonicalLoanDateRange(input: WorkflowInput): {
  startDate: string;
  endDate: string;
} {
  if (input.customDateRange) {
    return {
      startDate: input.customDateRange.startDate.replaceAll("/", "-"),
      endDate: input.customDateRange.endDate.replaceAll("/", "-"),
    };
  }

  const months = {
    three_months: 3,
    six_months: 6,
    one_year: 12,
  }[input.dateRange];
  const today = new Date();
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = addMonthsClamped(endDate, -months);
  const format = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { startDate: format(startDate), endDate: format(endDate) };
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

function splitDatePair(value: string): [string, string] {
  const normalized = toAsciiDigits(cleanText(value));
  const dates = normalized.match(/\d{4}\/\d{2}\/\d{2}/g) ?? [];
  return [dates[0] ?? normalized, dates[1] ?? ""];
}

function parseDateSortValue(value: string): number | null {
  const match = toAsciiDigits(cleanText(value)).match(
    /^(\d{4})\/(\d{2})\/(\d{2})$/,
  );
  if (!match) return null;

  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isFinite(time) ? time : null;
}

/** Convert the six source cells into typed workflow rows only after enforcing
 * the exact result-row shape. Empty six-cell layout rows are ignored; a
 * non-empty row with any other shape fails closed instead of disappearing. */
export function parseYuantaLoanStatementRows(
  accountLabel: string,
  sourceRows: readonly string[][],
): StatementRow[] {
  return sourceRows.flatMap((sourceRow) => {
    const values = sourceRow.map((value) => cleanText(value));
    if (values.every((value) => value.length === 0)) return [];
    if (values.length !== sourceStatementColumnCount)
      throw new Error("Unexpected Yuanta loan result row.");

    const [transactionDate, postingDate] = splitDatePair(values[0] ?? "");
    if (
      !/^\d{4}\/\d{2}\/\d{2}$/.test(transactionDate) ||
      (postingDate.length > 0 && !/^\d{4}\/\d{2}\/\d{2}$/.test(postingDate))
    )
      throw new Error("Unexpected Yuanta loan result row.");
    const [interestStartDate, interestEndDate] = splitDatePair(values[2] ?? "");

    return [
      {
        accountLabel,
        transactionDate,
        postingDate,
        paymentItem: values[1] ?? "",
        interestStartDate,
        interestEndDate,
        transactionAmount: values[3] ?? "",
        balanceAfterTransaction: values[4] ?? "",
        overpayment: values[5] ?? "",
        sortTime: parseDateSortValue(transactionDate),
      },
    ];
  });
}

function sortedStatementRows(rows: StatementRow[]): StatementRow[] {
  return [...rows].sort((left, right) => {
    if (left.sortTime === null && right.sortTime === null) return 0;
    if (left.sortTime === null) return 1;
    if (right.sortTime === null) return -1;
    return right.sortTime - left.sortTime;
  });
}

function statementRowsToCsv(rows: StatementRow[]): string {
  return rowsToCsv([
    [...statementHeaders],
    ...sortedStatementRows(rows).map((row) => [
      row.accountLabel,
      row.transactionDate,
      row.postingDate,
      row.paymentItem,
      row.interestStartDate,
      row.interestEndDate,
      row.transactionAmount,
      row.balanceAfterTransaction,
      row.overpayment,
    ]),
  ]);
}

async function writeLoanStatementsFile(
  nextTimestamp: () => string,
  dateRange: string,
  rows: StatementRow[],
  sourceTables: SourceTable[],
): Promise<TableFile> {
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "yuanta-loan-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `loan-statements-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const accounts = [...new Set(sourceTables.map((source) => source.account))];

  await writeFile(csvPath, statementRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt: new Date().toISOString(),
        workflow: "yuantaLoanStatements",
        kind: "loan-statements",
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers: statementHeaders,
        accounts,
        dateRange,
        sourceTables,
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
    kind: "loan-statements",
    rowCount: rows.length,
    headers: [...statementHeaders],
    accounts,
    dateRange,
    sourceTables,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
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
    // YuanTa keeps timers alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
}

async function findLoanStatementForm(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasAccount = await hasAttachedLocator(scope.locator("#acctno"));
      const hasLoanRange = await hasAttachedLocator(
        scope.locator("#duration a").filter({ hasText: "一年" }),
      );
      if (hasAccount && hasLoanRange) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Could not find YuanTa loan statement form.");
}

async function openLoanStatementPage(page: Page): Promise<BrowserScope> {
  const existing = await findLoanStatementForm(page, 5_000).catch(() => null);
  if (existing) return existing;

  if (await clickLoanStatementLink(page, 5_000)) {
    return await findLoanStatementForm(page);
  }

  const cid = await readCurrentCid(page);
  const fmain = await waitForFrame(page, "fmain");
  await fmain.goto(
    `${BANK_ORIGIN}/nib/tx/loantransactiondetails?type=page&cid=${encodeURIComponent(
      cid,
    )}`,
    { waitUntil: "domcontentloaded" },
  );
  await settleAfterNavigation(page);

  return await findLoanStatementForm(page);
}

async function clickLoanStatementLink(
  page: Page,
  timeoutMs = 60_000,
): Promise<boolean> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate.locator('a[onclick*="loantransactiondetails"]').filter({
        hasText: /^(貸款)?繳款明細查詢$/,
      }),
    "YuanTa loan statement link",
    timeoutMs,
  ).catch(() => null);
  if (!scope) return false;

  const link = await firstVisibleLocator(
    scope.locator('a[onclick*="loantransactiondetails"]').filter({
      hasText: /^(貸款)?繳款明細查詢$/,
    }),
    "YuanTa loan statement link",
    timeoutMs,
  ).catch(() => null);
  if (!link) return false;

  await link.click({ force: true });
  await settleAfterNavigation(page);
  return true;
}

async function readCurrentCid(page: Page): Promise<string> {
  const scope = await findScopeWithSelector(page, 'input[name="cid"]');
  const cid = await scope.locator('input[name="cid"]').first().inputValue();
  if (!cid) throw new Error("Could not read YuanTa session cid.");
  return cid;
}

async function chooseDateRange(
  page: Page,
  input: WorkflowInput,
): Promise<void> {
  const scope = await findLoanStatementForm(page);

  if (input.customDateRange) {
    const customLink = await firstVisibleLocator(
      scope.locator("#duration a").filter({ hasText: "自訂" }),
      'YuanTa loan date range link "自訂"',
    );
    await customLink.click({ force: true });
    await scope.locator("#sdate").fill(input.customDateRange.startDate);
    await scope.locator("#edate").fill(input.customDateRange.endDate);
    return;
  }

  const label = dateRangeLabels[input.dateRange];
  const link = await firstVisibleLocator(
    scope.locator("#duration a").filter({ hasText: label }),
    `YuanTa loan date range link "${label}"`,
  );
  await link.click({ force: true });
}

export async function readYuantaLoanAccountOptions(
  page: Page,
  _filters: string[] = [],
): Promise<LoanAccountOption[]> {
  const scope = await findLoanStatementForm(page);
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const availableAccounts: LoanAccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (isUnavailableAccountOption(value, label)) continue;

    const account = { label, value };
    availableAccounts.push(account);
  }

  if (availableAccounts.length === 0) {
    throw new StatementComponentAbsentError(
      "No YuanTa loan account is available for this login.",
    );
  }
  // Account filters are legacy persisted UI state. Yuanta loan capture
  // always includes every visible account; provider absence is the only skip.
  return availableAccounts;
}

async function queryLoanAccount(
  page: Page,
  input: WorkflowInput,
  account: LoanAccountOption,
): Promise<void> {
  const scope = await findLoanStatementForm(page);
  await scope.locator("#acctno").selectOption(account.value);
  await chooseDateRange(page, input);
  await clickAndWaitForNavigation(scope, "#submitbutton");
  await findScopeWithSelector(page, "#resultdiv");
}

async function parseLoanStatementRows(
  page: Page,
  accountLabel: string,
  pageOrdinal: number,
): Promise<{
  rows: StatementRow[];
  pageOrdinal: number;
  pagination: YuantaLoanPaginationSignal;
}> {
  const scope = await findScopeWithSelector(page, "#resultdiv");
  const tables = scope.locator("table.normalTable");
  const tableCount = await tables.count();
  if (tableCount === 0)
    throw new Error("Yuanta loan result is missing the source table.");

  const resultTable = tables.nth(tableCount - 1);
  await resultTable.locator("th").first().waitFor({ state: "attached" });

  const rows = resultTable.locator("tr");
  const rowCount = await rows.count();
  const sourceRows: string[][] = [];

  for (let rowIndex = 1; rowIndex < rowCount; rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("td");
    const cellCount = await cells.count();

    const values: string[] = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      values.push(cleanText(await cells.nth(cellIndex).innerText()));
    }
    sourceRows.push(values);
  }

  const parsedRows = parseYuantaLoanStatementRows(accountLabel, sourceRows);
  const renderedHtml = await scope.locator("body").innerHTML().catch(() => "");
  return {
    rows: parsedRows,
    pageOrdinal,
    pagination: parseYuantaLoanPaginationSignal(renderedHtml),
  };
}

async function findYuantaLoanNextPageControl(
  scope: BrowserScope,
): Promise<Locator | null> {
  const result = scope.locator("#resultdiv").first();
  if ((await result.count().catch(() => 0)) === 0) return null;
  const controls = result.locator("a,button,input");
  const count = await controls.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const markup = await control
      .evaluate((element) => element.outerHTML)
      .catch(() => "");
    if (markup && isLoanNextControl(markup)) return control;
  }
  return null;
}

export function assembleYuantaLoanStatement(
  pages: readonly ParsedYuantaLoanPage[],
): {
  rows: StatementRow[];
  completeness: LoanSourceCompletenessEvidence | null;
  pages: readonly LoanCapturePage[];
} {
  const terminalPage = pages.at(-1);
  const complete =
    terminalPage?.pagination.terminal === true &&
    terminalPage.pagination.evidence === "terminal-no-next" &&
    pages.every((page, index) =>
      index === pages.length - 1
        ? page.pagination.terminal
        : page.pagination.evidence === "next-page" && !page.pagination.terminal,
    );
  return {
    rows: pages.flatMap((page) => page.rows),
    completeness: complete
      ? {
          pageCount: pages.length,
          terminal: true,
          proofKind: "source-declared-terminal-range",
        }
      : null,
    pages: pages.map((page) => ({
      pageOrdinal: page.pageOrdinal,
      responseCode: "200",
      terminal: page.pagination.terminal,
      rowCount: page.rows.length,
      proofKind: "source-declared-terminal-range",
    })),
  };
}

async function traverseYuantaLoanStatementPages(
  page: Page,
  accountLabel: string,
): Promise<ReturnType<typeof assembleYuantaLoanStatement>> {
  const pages: ParsedYuantaLoanPage[] = [];
  const fingerprints = new Set<string>();

  while (true) {
    if (pages.length >= YUANTA_LOAN_MAX_PAGES)
      throw new Error("Yuanta loan pagination exceeded the safe page limit.");
    const parsed = await parseLoanStatementRows(
      page,
      accountLabel,
      pages.length,
    );
    const fingerprint = JSON.stringify({
      rows: parsed.rows.map((row) => [
        row.transactionDate,
        row.postingDate,
        row.paymentItem,
        row.transactionAmount,
        row.balanceAfterTransaction,
      ]),
      nextPageTarget: parsed.pagination.nextPageTarget,
    });
    if (fingerprints.has(fingerprint))
      throw new Error("Yuanta loan pagination repeated a page.");
    fingerprints.add(fingerprint);
    pages.push(parsed);
    if (!parsed.pagination.nextPageTarget) break;

    const scope = await findScopeWithSelector(page, "#resultdiv");
    const nextControl = await findYuantaLoanNextPageControl(scope);
    if (!nextControl)
      throw new Error(
        "Yuanta loan pagination control disappeared before traversal.",
      );
    await nextControl.click({ force: true });
    await settleAfterNavigation(page);
    await findScopeWithSelector(page, "#resultdiv");
  }

  return assembleYuantaLoanStatement(pages);
}

export async function runYuantaLoanStatements(
  page: Page,
  input: WorkflowInput,
  overrides: YuantaLoanStatementsRunDependencies = {},
): Promise<Omit<YuantaLoanStatementsOutput, "usedExistingSession" | "replacedActiveSession">> {
  const ledgerDir =
    overrides.canonicalFinancialLedgerDir ??
    overrides.canonicalLedgerDir ??
    DEFAULT_LEDGER_DIR;
  const store = (overrides.createLoanStore ?? createCanonicalLoanStore)(
    canonicalSqlitePath(ledgerDir),
  );
  const persist = overrides.persistLoanCapture ?? persistYuantaLoanCapture;
  const sourceConnectionScope =
    overrides.sourceConnectionScope ?? "yuanta-loan-workflow";
  const observedAt = overrides.observedAt ?? (() => new Date().toISOString());

  try {
    await openLoanStatementPage(page);
    const accounts = await readYuantaLoanAccountOptions(
      page,
      input.loanAccountFilters,
    );
    const rows: StatementRow[] = [];
    const sourceTables: SourceTable[] = [];
    const nextTimestamp = createTimestampGenerator();
    const dateRange = describeDateRange(input);
    const canonicalRange = canonicalLoanDateRange(input);

    for (const account of accounts) {
      const maskedAccount = maskAccountLabel(account.label);
      await queryLoanAccount(page, input, account);
      const parsed = await traverseYuantaLoanStatementPages(page, maskedAccount);
      if (
        !parsed.completeness ||
        parsed.pages.length !== parsed.completeness.pageCount
      ) {
        throw new Error(
          "Yuanta loan result lacks explicit complete terminal page evidence.",
        );
      }
      const accountRows = parsed.rows;
      rows.push(...accountRows);
      sourceTables.push({
        account: maskedAccount,
        rowCount: accountRows.length,
      });
      await persist(store, {
        accountValue: account.value,
        sourceConnectionScope,
        observedAt: observedAt(),
        startDate: canonicalRange.startDate,
        endDate: canonicalRange.endDate,
        scope: {
          startDate: canonicalRange.startDate,
          endDate: canonicalRange.endDate,
          completeness: "complete-range",
          completenessBasis: "source-declared-terminal-range",
          completenessRuleVersion: "loan/canonical/v1.yuanta",
          pageCount: parsed.completeness.pageCount,
          terminal: parsed.completeness.terminal,
        },
        pages: parsed.pages,
        // The loan result has no source-linked deposit-side transaction.
        // Empty linkage arrays are therefore explicitly not asserted as
        // complete relation coverage.
        relationCoverage: "not-asserted",
        counterpartTransactions: [],
        relations: [],
        rows: accountRows.map<YuantaLoanStatementRow>((row) => ({
          transactionDate: row.transactionDate,
          postingDate: row.postingDate,
          paymentItem: row.paymentItem,
          transactionAmount: row.transactionAmount,
          balanceAfterTransaction: row.balanceAfterTransaction,
        })),
      });
    }

    const file = await writeLoanStatementsFile(
      nextTimestamp,
      dateRange,
      rows,
      sourceTables,
    );

    return {
      dateRange,
      count: 1,
      files: [file],
    };
  } finally {
    store.close();
  }
}

export default workflow("yuantaLoanStatements", {
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
    const output = await runYuantaLoanStatements(page, input, {
      canonicalLedgerDir:
        process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
        process.env.LEDGER_DIR ??
        DEFAULT_LEDGER_DIR,
      canonicalFinancialLedgerDir:
        process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR ??
        process.env.OCTOPUSBEAK_CANONICAL_LEDGER_DIR ??
        process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
        process.env.LEDGER_DIR ??
        DEFAULT_LEDGER_DIR,
      sourceConnectionScope: `${credentials.yuanta_user_id ?? ""}\u0000${credentials.yuanta_account ?? ""}`,
    });
    return {
      ...output,
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession: authResult.replacedActiveSession,
    };
  },
});
