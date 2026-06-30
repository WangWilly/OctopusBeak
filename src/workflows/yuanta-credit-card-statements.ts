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

type StatementKind = "unbilled" | "billed";

type StatementRow = {
  creditCardNo: string;
  creditCardName: string;
  consumeDate: string;
  postedDate: string;
  description: string;
  countryCurrency: string;
  foreignExchangeDate: string;
  foreignAmount: string;
  twdAmount: string;
  paymentStatus: string;
  period: string | null;
};

const inputSchema = z.object({
  monthIndexes: z.array(z.number().int().min(0).max(24)).optional(),
  includeUnbilled: z.boolean().default(true),
  includePaymentDetails: z.boolean().default(true),
  includeSummary: z.boolean().default(true),
  replaceActiveSession: z.boolean().default(true),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.enum(["unbilled", "billed"]),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  periods: z.array(z.string()),
  csvFilename: z.string(),
  jsonFilename: z.string(),
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
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;

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

function consumeDateSortKey(row: StatementRow): string {
  const date = toAsciiDigits(cleanText(row.consumeDate));
  const match = date.match(/^(\d{3,4})\/(\d{2})\/(\d{2})$/);
  if (!match) return "";

  const year = match[1].length === 3 ? Number(match[1]) + 1911 : Number(match[1]);
  return `${String(year).padStart(4, "0")}${match[2]}${match[3]}`;
}

function compareRowsByConsumeDateDesc(
  left: StatementRow,
  right: StatementRow,
): number {
  return consumeDateSortKey(right).localeCompare(consumeDateSortKey(left));
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
  await field.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    input.removeAttribute("readonly");
    input.readOnly = false;
    input.value = nextValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
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
      const hasMonthLink = await hasAttachedLocator(
        scope.locator('a[onclick*="queryMonth("]'),
      );
      const hasTable = await hasAttachedLocator(scope.locator("table.rwdTable"));
      const hasPeriod =
        !period ||
        (await scope
          .locator("body")
          .filter({ hasText: period })
          .count()
          .catch(() => 0)) > 0;

      if (hasMonthLink && hasTable && hasPeriod) return scope;
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

const baseStatementHeaders = [
  "信用卡號",
  "信用卡名稱",
  "消費日期",
  "入帳日期",
  "消費明細",
  "國家/幣別",
  "外幣折算日",
  "外幣金額",
  "新臺幣金額",
];

const billedStatementHeaders = [...baseStatementHeaders, "繳費狀態"];

async function parseHtmlTableRows(table: Locator): Promise<string[][]> {
  const rows = await table.locator("tr").all();
  const parsedRows: string[][] = [];

  for (const row of rows) {
    const values = (
      await row
        .locator("th, td:not(.cardDetailList):not(.billcontrol_Btn)")
        .allTextContents()
    ).map(cleanText);
    if (values.some((value) => value.length > 0)) parsedRows.push(values);
  }

  if (parsedRows.length === 0) {
    const text = cleanText(await table.innerText());
    if (text) parsedRows.push([text]);
  }

  return parsedRows;
}

function normalizeTableRows(tableLabel: string, rows: string[][]): string[][] {
  if (tableLabel !== "transactions" || rows.length < 2) return rows;

  const [headers, ...bodyRows] = rows;
  const trailingHeaderIndex = headers.length - 1;
  const hasBlankTrailingHeader =
    trailingHeaderIndex >= 0 && !headers[trailingHeaderIndex];
  const hasTwdAmountHeader = headers.includes("新臺幣金額");
  if (!hasBlankTrailingHeader || !hasTwdAmountHeader) return rows;

  const normalizedHeaders = headers.slice(0, trailingHeaderIndex);
  const normalizedBodyRows = bodyRows.map((row) => {
    if (
      row.length === headers.length &&
      !row[0] &&
      row[trailingHeaderIndex]
    ) {
      return row.slice(1);
    }

    return row.slice(0, normalizedHeaders.length);
  });

  return [normalizedHeaders, ...normalizedBodyRows];
}

function creditCardDownloadsDir(): string {
  return join(process.cwd(), "downloads", "yuanta-credit-card-statements");
}

function headerScore(row: string[]): number {
  return row.filter((value) =>
    /日期|明細|幣別|金額|繳款|入帳|消費/.test(value),
  ).length;
}

function findHeaderRowIndex(rows: string[][]): number {
  let bestIndex = -1;
  let bestScore = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const score = headerScore(rows[index]);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestIndex >= 0) return bestIndex;
  return rows[0]?.some((header) => header.length > 0) ? 0 : -1;
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

function hasTransactionHeaders(headers: string[]): boolean {
  return ["消費日期", "入帳日期", "消費明細", "新臺幣金額"].every((header) =>
    headers.includes(header),
  );
}

function columnsFromValues(
  headers: string[],
  values: string[],
): Record<string, string> {
  const columns: Record<string, string> = {};
  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    columns[headers[columnIndex]] = values[columnIndex] ?? "";
  }
  return columns;
}

function shouldLeaveCardInfoBlank(description: string): boolean {
  return description.includes("鑽金紅利回饋");
}

function statementRowsFromTableRows(
  rows: string[][],
  context: {
    creditCardNo: string;
    creditCardName: string;
    period: string | null;
    paymentStatus: string;
  },
): StatementRow[] {
  const normalizedRows = normalizeTableRows("transactions", rows);
  const headerRowIndex = findHeaderRowIndex(normalizedRows);
  if (headerRowIndex < 0) return [];

  const headers = uniqueHeaders(normalizedRows[headerRowIndex]);
  if (!hasTransactionHeaders(headers)) return [];

  const statementRows: StatementRow[] = [];
  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < normalizedRows.length;
    rowIndex += 1
  ) {
    const values = alignValuesToHeaders(
      normalizedRows[rowIndex],
      headers,
    ).slice(0, headers.length);
    if (!values.some((value) => value.length > 0)) continue;
    if (isRepeatedHeaderRow(values, headers)) continue;

    const columns = columnsFromValues(headers, values);
    const description = columns["消費明細"] ?? "";
    const blankCardInfo = shouldLeaveCardInfoBlank(description);
    statementRows.push({
      creditCardNo: blankCardInfo ? "" : context.creditCardNo,
      creditCardName: blankCardInfo ? "" : context.creditCardName,
      consumeDate: columns["消費日期"] ?? "",
      postedDate: columns["入帳日期"] ?? "",
      description,
      countryCurrency: columns["國家/幣別"] ?? "",
      foreignExchangeDate: columns["外幣折算日"] ?? "",
      foreignAmount: columns["外幣金額"] ?? "",
      twdAmount: columns["新臺幣金額"] ?? "",
      paymentStatus: context.paymentStatus,
      period: context.period,
    });
  }

  return statementRows;
}

async function findStatementScope(page: Page): Promise<BrowserScope | null> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(scope.locator(".cardBx"))) {
        return scope;
      }
      const noRecordText = await scope
        .locator("#creditNoRecordMsg, .errorArea")
        .first()
        .textContent({ timeout: 1_000 })
        .catch(() => "");
      if (/查無資料|無資料|無消費/.test(noRecordText ?? "")) return null;
    }
    await page.waitForTimeout(250);
  }

  return null;
}

async function parseStatementRows(
  page: Page,
  period: string | null,
  paymentStatus: string,
): Promise<StatementRow[]> {
  const scope = await findStatementScope(page);
  if (!scope) return [];

  const cardTables = await scope
    .locator(".cardBx")
    .evaluateAll((cardBoxes) =>
      cardBoxes
        .filter(
          (cardBox) =>
            cardBox.querySelector(".cardInfoD") &&
            cardBox.querySelector("table.rwdTable"),
        )
        .map((cardBox) => {
        const textOf = (element: Element | null): string =>
          (element?.textContent ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
        const creditCardName = textOf(
          cardBox.querySelector(".cardInfoD h4.web") ??
            cardBox.querySelector(".cardHead h4"),
        ).replace(/主卡/g, "").trim();
        let creditCardNo = "";
        for (const item of Array.from(
          cardBox.querySelectorAll(".cardInfod_Con li"),
        )) {
          if (textOf(item.querySelector("h5")).includes("卡號")) {
            creditCardNo = textOf(item.querySelector("p"));
            break;
          }
        }
        const tables = Array.from(cardBox.querySelectorAll("table.rwdTable")).map(
          (table) =>
            Array.from(table.querySelectorAll("tr"))
              .map((row) =>
                Array.from(
                  row.querySelectorAll(
                    "th, td:not(.cardDetailList):not(.billcontrol_Btn)",
                  ),
                ).map(textOf),
              )
              .filter((row) => row.some((value) => value.length > 0)),
        );
        return { creditCardNo, creditCardName, tables };
      }),
    );

  return cardTables.flatMap(({ creditCardNo, creditCardName, tables }) =>
    tables.flatMap((rows) =>
      statementRowsFromTableRows(rows, {
        creditCardNo,
        creditCardName,
        period,
        paymentStatus,
      }),
    ),
  );
}

function parseAmount(value: string | undefined): number | null {
  const normalized = (value ?? "").replace(/[, $NT]/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferPaymentStatus(columns: Record<string, string>): string {
  const due = parseAmount(columns["本期應繳金額"]);
  const paid = parseAmount(columns["已繳款金額"]);
  if (due === null || paid === null) return "";
  if (due <= 0) return "無應繳";
  if (paid <= 0) return "未繳";
  if (paid >= due) return "已繳";
  return "部分繳款";
}

async function readBillingPaymentStatus(page: Page): Promise<string> {
  const scope = await findScopeWithSelector(page, "table.rwdTable");
  const tables = scope.locator("table.rwdTable");
  const count = await tables.count();

  for (let tableIndex = 0; tableIndex < count; tableIndex += 1) {
    const rows = await parseHtmlTableRows(tables.nth(tableIndex));
    const headerRowIndex = rows.findIndex(
      (row) => row.includes("帳單月份") && row.includes("已繳款金額"),
    );
    if (headerRowIndex < 0 || headerRowIndex + 1 >= rows.length) continue;

    const headers = uniqueHeaders(rows[headerRowIndex]);
    const values = alignValuesToHeaders(rows[headerRowIndex + 1], headers).slice(
      0,
      headers.length,
    );
    return inferPaymentStatus(columnsFromValues(headers, values));
  }

  return "";
}

function statementHeaders(kind: StatementKind): string[] {
  return kind === "billed" ? billedStatementHeaders : baseStatementHeaders;
}

function statementRowsToCsv(kind: StatementKind, rows: StatementRow[]): string {
  const csvRows = [
    statementHeaders(kind),
    ...[...rows].sort(compareRowsByConsumeDateDesc).map((row) => {
      const values = [
        row.creditCardNo,
        row.creditCardName,
        row.consumeDate,
        row.postedDate,
        row.description,
        row.countryCurrency,
        row.foreignExchangeDate,
        row.foreignAmount,
        row.twdAmount,
      ];
      if (kind === "billed") values.push(row.paymentStatus);
      return values;
    }),
  ];

  return rowsToCsv(csvRows);
}

async function writeStatementFile(
  nextTimestamp: () => string,
  kind: StatementKind,
  rows: StatementRow[],
): Promise<TableFile> {
  const downloadsDir = creditCardDownloadsDir();
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${kind}-statements-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const generatedAt = new Date().toISOString();
  const headers = statementHeaders(kind);
  const periods = [
    ...new Set(rows.map((row) => row.period).filter((period) => period !== null)),
  ];

  await writeFile(csvPath, statementRowsToCsv(kind, rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt,
        workflow: "yuantaCreditCardStatements",
        kind,
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers,
        periods,
        paymentStatuses:
          kind === "billed"
            ? [...new Set(rows.map((row) => row.paymentStatus).filter(Boolean))]
            : [],
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
    kind,
    rowCount: rows.length,
    headers,
    periods,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
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
    const nextTimestamp = createTimestampGenerator();
    const billedRows: StatementRow[] = [];

    for (const month of monthOptions) {
      if (month.index !== 0) await clickMonth(page, month);
      const paymentStatus = await readBillingPaymentStatus(page);
      billedRows.push(
        ...(await parseStatementRows(page, month.label, paymentStatus)),
      );
    }

    const files: TableFile[] = [];
    let unbilledFile: TableFile | null = null;
    if (input.includeUnbilled) {
      await clickCreditCardFunction(page, 1, "YuanTa unbilled credit card link");
      const unbilledRows = await parseStatementRows(page, null, "");
      unbilledFile = await writeStatementFile(
        nextTimestamp,
        "unbilled",
        unbilledRows,
      );
    }

    if (unbilledFile) files.push(unbilledFile);
    files.push(await writeStatementFile(nextTimestamp, "billed", billedRows));

    return {
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession,
      count: files.length,
      files,
    };
  },
});
