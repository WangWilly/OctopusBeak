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

const BANK_ENTRY_URL = "https://ebank.yuantabank.com.tw/nib/ibanc.jsp";

type BrowserScope = Page | Frame;

type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};

type MonthOption = {
  index: number;
  label: string;
};

type ParsedTable = {
  category: string;
  period: string | null;
  tableLabel: string;
  rows: string[][];
};

type AggregateRow = {
  category: string;
  period: string | null;
  tableLabel: string;
  sourceTableIndex: number;
  sourceRowIndex: number;
  columns: Record<string, string>;
  values: string[];
};

const inputSchema = z.object({
  monthIndexes: z.array(z.number().int().min(0).max(24)).optional(),
  includeUnbilled: z.boolean().default(true),
  includePaymentDetails: z.boolean().default(true),
  includeSummary: z.boolean().default(true),
  replaceActiveSession: z.boolean().default(true),
});

const tableFileSchema = z.object({
  category: z.string(),
  period: z.string().nullable(),
  tableLabel: z.string(),
  rowCount: z.number().int().nonnegative(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const aggregateFileSchema = z.object({
  aggregateLabel: z.string(),
  sourceTableCount: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  usedExistingSession: z.boolean(),
  replacedActiveSession: z.boolean(),
  count: z.number().int().nonnegative(),
  files: z.array(tableFileSchema),
  aggregateCount: z.number().int().nonnegative(),
  aggregateFiles: z.array(aggregateFileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;
type AggregateFile = z.infer<typeof aggregateFileSchema>;

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

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
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

async function isCreditCardBillsPage(
  page: Page,
  timeoutMs = 3_000,
): Promise<boolean> {
  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator('input[name="menutype"][value="creditcardbillsquery"]')
        .or(candidate.locator('a[onclick*="queryMonth("]'))
        .first(),
    "YuanTa credit card bills page",
    timeoutMs,
  )
    .then(() => true)
    .catch(() => false);
}

async function isSignedIn(page: Page): Promise<boolean> {
  if (await isCreditCardBillsPage(page)) return true;

  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("#submenuAreaCD")
        .or(candidate.locator('a[onclick*="creditcardbillsquery"]'))
        .or(candidate.locator('a[onclick*="creditcardsummary"]'))
        .first(),
    "YuanTa signed-in credit card navigation",
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

async function openCreditCardBillsPage(page: Page): Promise<BrowserScope> {
  const existing = await findCreditCardBillsScope(page, 5_000).catch(() => null);
  if (existing) return await waitForCreditCardBillsReady(page);

  if (await clickCreditCardBillsLink(page, 5_000)) {
    return await waitForCreditCardBillsReady(page);
  }

  const menuScope = await findScopeWithSelector(page, "#submenuAreaCD", 5_000)
    .then((scope) => scope)
    .catch(() => null);
  if (menuScope) {
    await firstVisibleLocator(
      menuScope.locator("#submenuAreaCD"),
      "YuanTa credit card menu",
      5_000,
    )
      .then((link) => link.click({ force: true }))
      .catch(() => undefined);
    await page.waitForTimeout(500);
  }

  if (await clickCreditCardBillsLink(page)) {
    return await waitForCreditCardBillsReady(page);
  }

  throw new Error("Could not open YuanTa credit card bills page.");
}

async function findCreditCardBillsScope(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator('input[name="menutype"][value="creditcardbillsquery"]')
        .or(candidate.locator('a[onclick*="queryMonth("]'))
        .first(),
    "YuanTa credit card bills page",
    timeoutMs,
  );
}

async function waitForCreditCardBillsReady(
  page: Page,
  period?: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scope = await findCreditCardBillsScope(page, 3_000).catch(() => null);
    if (scope) {
      const monthCount = await scope
        .locator('a[onclick*="queryMonth("]')
        .count()
        .catch(() => 0);
      const tableCount = await scope.locator("table.rwdTable").count().catch(() => 0);
      const hasPeriod =
        !period ||
        (await scope
          .locator("body")
          .filter({ hasText: period })
          .count()
          .catch(() => 0)) > 0;

      if (monthCount > 0 && tableCount > 0 && hasPeriod) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Timed out waiting for YuanTa credit card bills page tables.");
}

async function clickCreditCardBillsLink(
  page: Page,
  timeoutMs = 60_000,
): Promise<boolean> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator('a[onclick*="creditcardbillsquery"]')
        .filter({ hasText: /歷史帳單明細/ }),
    "YuanTa credit card bills link",
    timeoutMs,
  ).catch(() => null);
  if (!scope) return false;

  const link = await firstVisibleLocator(
    scope
      .locator('a[onclick*="creditcardbillsquery"]')
      .filter({ hasText: /歷史帳單明細/ }),
    "YuanTa credit card bills link",
    timeoutMs,
  ).catch(() => null);
  if (!link) return false;

  await link.click({ force: true });
  await settleAfterNavigation(page);
  return true;
}

async function readMonthOptions(page: Page): Promise<MonthOption[]> {
  const scope = await waitForCreditCardBillsReady(page);
  const links = scope.locator('a[onclick*="queryMonth("]');
  const count = await links.count();
  const options = new Map<number, MonthOption>();

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const onclick = (await link.getAttribute("onclick")) ?? "";
    const match = onclick.match(/queryMonth\(['"]?(\d+)['"]?\)/);
    if (!match) continue;

    const label = cleanText(await link.textContent());
    if (!label) continue;

    const monthIndex = Number(match[1]);
    options.set(monthIndex, { index: monthIndex, label });
  }

  if (options.size === 0) {
    throw new Error("Could not find YuanTa credit card statement month links.");
  }

  return [...options.values()].sort((left, right) => left.index - right.index);
}

function selectMonthOptions(
  options: MonthOption[],
  input: WorkflowInput,
): MonthOption[] {
  if (!input.monthIndexes) return options;

  const selected = options.filter((option) =>
    input.monthIndexes?.includes(option.index),
  );
  const missing = input.monthIndexes.filter(
    (index) => !options.some((option) => option.index === index),
  );
  if (missing.length > 0) {
    throw new Error(
      `YuanTa did not expose credit card statement month indexes: ${missing.join(
        ", ",
      )}.`,
    );
  }
  return selected;
}

async function clickMonth(page: Page, month: MonthOption): Promise<void> {
  const scope = await waitForCreditCardBillsReady(page);
  const link = await firstVisibleLocator(
    scope.locator('a[onclick*="queryMonth("]').filter({ hasText: month.label }),
    `YuanTa credit card month "${month.label}"`,
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  await waitForCreditCardBillsReady(page, month.label);
}

async function clickCreditCardFunction(
  page: Page,
  functionIndex: number,
  description: string,
): Promise<BrowserScope> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) => candidate.locator(`a[onclick*="turnCDFunc(${functionIndex})"]`),
    description,
  );
  const link = await firstVisibleLocator(
    scope.locator(`a[onclick*="turnCDFunc(${functionIndex})"]`),
    description,
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  return await findScopeWithSelector(page, "table.rwdTable");
}

async function clickCreditCardSummary(page: Page): Promise<BrowserScope> {
  const summaryScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator('a[onclick*="turnCDSummary"]')
        .or(
          candidate
            .locator('a[onclick*="creditcardsummary"]')
            .filter({ hasText: "信用卡總覽" }),
        ),
    "YuanTa credit card summary link",
  );
  const link = await firstVisibleLocator(
    summaryScope
      .locator('a[onclick*="turnCDSummary"]')
      .or(
        summaryScope
          .locator('a[onclick*="creditcardsummary"]')
          .filter({ hasText: "信用卡總覽" }),
      ),
    "YuanTa credit card summary link",
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  return await findScopeWithSelector(page, "table.rwdTable");
}

async function parseCreditCardTables(
  page: Page,
  category: string,
  period: string | null,
): Promise<ParsedTable[]> {
  const scope = await findScopeWithSelector(page, "table.rwdTable");
  const tables = scope.locator("table.rwdTable");
  const count = await tables.count();
  const parsed: ParsedTable[] = [];

  for (let tableIndex = 0; tableIndex < count; tableIndex += 1) {
    const table = tables.nth(tableIndex);
    const rows = await parseHtmlTableRows(table);
    if (rows.length === 0) continue;

    const tableLabel = classifyTable(category, rows, tableIndex);
    parsed.push({ category, period, tableLabel, rows });
  }

  if (parsed.length === 0) {
    throw new Error(`No YuanTa credit card tables found for ${category}.`);
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
  if (/帳單月份/.test(text)) return "bill-summary";
  if (/消費日期/.test(text)) return "transactions";
  if (/本期無消費明細/.test(text)) return "no-transactions";
  if (/繳款日/.test(text)) return "payment-details";
  if (/信用額度/.test(text)) return "credit-limit-summary";
  if (/帳單結帳日/.test(text)) return "payment-summary";
  if (/自動扣款/.test(text)) return "auto-payment-summary";
  return `${category}-table-${tableIndex + 1}`;
}

function creditCardDownloadsDir(): string {
  return join(process.cwd(), "downloads", "yuanta-credit-card-statements");
}

const nonAggregateTableLabels = new Set([
  "bill-summary",
  "no-transactions",
  "credit-limit-summary",
  "payment-summary",
  "auto-payment-summary",
]);

function isAggregateTable(table: ParsedTable): boolean {
  if (nonAggregateTableLabels.has(table.tableLabel)) return false;
  if (table.rows.length < 2) return false;

  const text = table.rows.flat().join(" ");
  if (/本期無消費明細|查無資料|無資料/.test(text)) return false;

  return findHeaderRowIndex(table) >= 0;
}

function headerScore(row: string[]): number {
  return row.filter((value) =>
    /日期|明細|幣別|金額|繳款|入帳|消費/.test(value),
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

  if (bestIndex >= 0) return bestIndex;
  return table.rows[0].some((header) => header.length > 0) ? 0 : -1;
}

function uniqueHeaders(row: string[]): string[] {
  const seen = new Map<string, number>();

  return row.map((value, index) => {
    const baseName = cleanText(value) || `column_${index + 1}`;
    const count = seen.get(baseName) ?? 0;
    seen.set(baseName, count + 1);
    return count === 0 ? baseName : `${baseName}_${count + 1}`;
  });
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

function aggregateRowsForTable(
  table: ParsedTable,
  sourceTableIndex: number,
): AggregateRow[] {
  const headerRowIndex = findHeaderRowIndex(table);
  if (headerRowIndex < 0) return [];

  const headers = uniqueHeaders(table.rows[headerRowIndex]);
  const rows: AggregateRow[] = [];

  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < table.rows.length;
    rowIndex += 1
  ) {
    const values = alignValuesToHeaders(table.rows[rowIndex], headers);
    if (!values.some((value) => value.length > 0)) continue;
    if (isRepeatedHeaderRow(values, headers)) continue;

    const columns: Record<string, string> = {};
    for (let columnIndex = 0; columnIndex < values.length; columnIndex += 1) {
      const header = headers[columnIndex] ?? `column_${columnIndex + 1}`;
      columns[header] = values[columnIndex] ?? "";
    }

    rows.push({
      category: table.category,
      period: table.period,
      tableLabel: table.tableLabel,
      sourceTableIndex,
      sourceRowIndex: rowIndex + 1,
      columns,
      values,
    });
  }

  return rows;
}

function groupedAggregateRows(
  tables: ParsedTable[],
): Map<string, { sourceTableCount: number; rows: AggregateRow[] }> {
  const groups = new Map<
    string,
    { sourceTableCount: number; rows: AggregateRow[] }
  >();

  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    const table = tables[tableIndex];
    if (!isAggregateTable(table)) continue;

    const rows = aggregateRowsForTable(table, tableIndex + 1);
    if (rows.length === 0) continue;

    const group = groups.get(table.tableLabel) ?? {
      sourceTableCount: 0,
      rows: [],
    };
    group.sourceTableCount += 1;
    group.rows.push(...rows);
    groups.set(table.tableLabel, group);
  }

  return groups;
}

function aggregateRowsToCsv(rows: AggregateRow[]): string {
  const dataColumns = [
    ...new Set(rows.flatMap((row) => Object.keys(row.columns))),
  ];
  const metadataColumns = [
    "source_category",
    "source_period",
    "source_table_label",
    "source_table_index",
    "source_row_index",
  ];

  const csvRows = [
    [...metadataColumns, ...dataColumns],
    ...rows.map((row) => [
      row.category,
      row.period ?? "",
      row.tableLabel,
      String(row.sourceTableIndex),
      String(row.sourceRowIndex),
      ...dataColumns.map((column) => row.columns[column] ?? ""),
    ]),
  ];

  return rowsToCsv(csvRows);
}

async function writeAggregateFile(
  runId: string,
  aggregateLabel: string,
  sourceTableCount: number,
  rows: AggregateRow[],
): Promise<AggregateFile> {
  const downloadsDir = creditCardDownloadsDir();
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${runId}-aggregate-${safeFilename(aggregateLabel)}`;
  const csvPath = join(downloadsDir, `${baseName}.csv`);
  const jsonPath = join(downloadsDir, `${baseName}.json`);

  await writeFile(csvPath, aggregateRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        aggregateLabel,
        sourceTableCount,
        rowCount: rows.length,
        rows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    aggregateLabel,
    sourceTableCount,
    rowCount: rows.length,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

async function writeAggregateFiles(
  runId: string,
  tables: ParsedTable[],
): Promise<AggregateFile[]> {
  const aggregateFiles: AggregateFile[] = [];
  const groups = groupedAggregateRows(tables);

  for (const [aggregateLabel, group] of groups.entries()) {
    aggregateFiles.push(
      await writeAggregateFile(
        runId,
        aggregateLabel,
        group.sourceTableCount,
        group.rows,
      ),
    );
  }

  return aggregateFiles;
}

async function writeTableFiles(
  runId: string,
  sequence: number,
  table: ParsedTable,
): Promise<TableFile> {
  const downloadsDir = creditCardDownloadsDir();
  await mkdir(downloadsDir, { recursive: true });

  const period = table.period ? safeFilename(table.period) : "all";
  const baseName = `${runId}-${String(sequence).padStart(2, "0")}-${safeFilename(
    table.category,
  )}-${period}-${safeFilename(table.tableLabel)}`;
  const csvPath = join(downloadsDir, `${baseName}.csv`);
  const jsonPath = join(downloadsDir, `${baseName}.json`);

  await writeFile(csvPath, rowsToCsv(table.rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        category: table.category,
        period: table.period,
        tableLabel: table.tableLabel,
        rows: table.rows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    category: table.category,
    period: table.period,
    tableLabel: table.tableLabel,
    rowCount: table.rows.length,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

async function captureTables(
  page: Page,
  runId: string,
  files: TableFile[],
  parsedTables: ParsedTable[],
  category: string,
  period: string | null,
): Promise<void> {
  const tables = await parseCreditCardTables(page, category, period);
  for (const table of tables) {
    parsedTables.push(table);
    files.push(await writeTableFiles(runId, files.length + 1, table));
  }
}

function runId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export default workflow("yuantaCreditCardStatements", {
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

    await openCreditCardBillsPage(page);

    const allMonthOptions = await readMonthOptions(page);
    const monthOptions = selectMonthOptions(allMonthOptions, input);
    const files: TableFile[] = [];
    const parsedTables: ParsedTable[] = [];
    const id = runId();

    for (const month of monthOptions) {
      if (month.index !== 0) await clickMonth(page, month);
      await captureTables(
        page,
        id,
        files,
        parsedTables,
        "monthly-bill",
        month.label,
      );
    }

    if (input.includeUnbilled) {
      await clickCreditCardFunction(page, 1, "YuanTa unbilled credit card link");
      await captureTables(page, id, files, parsedTables, "unbilled", null);
    }

    if (input.includePaymentDetails) {
      await clickCreditCardFunction(
        page,
        3,
        "YuanTa recent credit card payment details link",
      );
      await captureTables(
        page,
        id,
        files,
        parsedTables,
        "payment-details",
        null,
      );
    }

    if (input.includeSummary) {
      await clickCreditCardSummary(page);
      await captureTables(page, id, files, parsedTables, "summary", null);
    }

    const aggregateFiles = await writeAggregateFiles(id, parsedTables);

    return {
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession,
      count: files.length,
      files,
      aggregateCount: aggregateFiles.reduce(
        (total, file) => total + file.rowCount,
        0,
      ),
      aggregateFiles,
    };
  },
});
