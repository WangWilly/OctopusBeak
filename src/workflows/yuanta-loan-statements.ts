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
): Promise<StatementRow[]> {
  const scope = await findScopeWithSelector(page, "#resultdiv");
  const tables = scope.locator("table.normalTable");
  const tableCount = await tables.count();
  if (tableCount === 0) return [];

  const resultTable = tables.nth(tableCount - 1);
  await resultTable.locator("th").first().waitFor({ state: "attached" });

  const rows = resultTable.locator("tr");
  const rowCount = await rows.count();
  const statements: StatementRow[] = [];

  for (let rowIndex = 1; rowIndex < rowCount; rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("td");
    const cellCount = await cells.count();
    if (cellCount !== sourceStatementColumnCount) continue;

    const values: string[] = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      values.push(cleanText(await cells.nth(cellIndex).innerText()));
    }
    if (values.every((value) => value.length === 0)) continue;

    const [transactionDate, postingDate] = splitDatePair(values[0]);
    const [interestStartDate, interestEndDate] = splitDatePair(values[2]);

    statements.push({
      accountLabel,
      transactionDate,
      postingDate,
      paymentItem: values[1],
      interestStartDate,
      interestEndDate,
      transactionAmount: values[3],
      balanceAfterTransaction: values[4],
      overpayment: values[5],
      sortTime: parseDateSortValue(transactionDate),
    });
  }

  return statements;
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
    const replacedActiveSession = authResult.replacedActiveSession;

    await openLoanStatementPage(page);
    const accounts = await readYuantaLoanAccountOptions(
      page,
      input.loanAccountFilters,
    );
    const rows: StatementRow[] = [];
    const sourceTables: SourceTable[] = [];
    const nextTimestamp = createTimestampGenerator();

    for (const account of accounts) {
      const maskedAccount = maskAccountLabel(account.label);
      await queryLoanAccount(page, input, account);
      const accountRows = await parseLoanStatementRows(page, maskedAccount);
      rows.push(...accountRows);
      sourceTables.push({
        account: maskedAccount,
        rowCount: accountRows.length,
      });
    }

    const dateRange = describeDateRange(input);
    const file = await writeLoanStatementsFile(
      nextTimestamp,
      dateRange,
      rows,
      sourceTables,
    );

    return {
      dateRange,
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession,
      count: 1,
      files: [file],
    };
  },
});
