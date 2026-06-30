import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { pause, workflow, type LibrettoWorkflowContext } from "libretto";
import type { Download, Frame, Locator, Page } from "playwright";
import { z } from "zod";

const BANK_ENTRY_URL = "https://ebank.yuantabank.com.tw/nib/ibanc.jsp";
const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";
const big5Decoder = new TextDecoder("big5");

type BrowserScope = Page | Frame;

type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};

const dateRangeSchema = z.enum(["one_week", "one_month", "three_months"]);

const inputSchema = z.object({
  dateRange: dateRangeSchema.default("three_months"),
  accountFilters: z.array(z.string()).default([]),
  replaceActiveSession: z.boolean().default(true),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.literal("bank-transactions"),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  accounts: z.array(z.string()),
  dateRange: dateRangeSchema,
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: dateRangeSchema,
  replacedActiveSession: z.boolean(),
  count: z.number().int().nonnegative(),
  files: z.array(tableFileSchema),
});

type TableFile = z.infer<typeof tableFileSchema>;

type SourceDownloadMetadata = {
  account: string;
  filename: string;
  rowCount: number;
};

type BankTransactionRow = {
  accountLabel: string;
  values: string[];
  sortTime: number | null;
};

const dateRangeLabels: Record<z.infer<typeof dateRangeSchema>, string> = {
  one_week: "一週",
  one_month: "一個月",
  three_months: "三個月",
};

const bankTransactionHeaders = [
  "帳戶名稱",
  "帳號",
  "帳務日期",
  "交易日期",
  "交易時間",
  "交易說明",
  "支出金額",
  "存入金額",
  "帳面餘額",
  "票據號碼",
  "備註",
];

const downloadedBankHeaders = bankTransactionHeaders.slice(1);

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
  return values.length === downloadedBankHeaders.length &&
    values.every((value, index) => value === downloadedBankHeaders[index]);
}

function parseBankSortTime(values: string[]): number | null {
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

function statementRowsFromDownloadedCsv(
  content: string,
  accountLabel: string,
): BankTransactionRow[] {
  const rows = parseCsvRows(content).map((row) =>
    row.map(stripSpreadsheetTextPrefix),
  );
  const headerIndex = rows.findIndex(isRepeatedHeaderRow);
  if (headerIndex < 0) {
    throw new Error("Downloaded YuanTa statement CSV did not contain expected headers.");
  }

  const statements: BankTransactionRow[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    if (!values.some((value) => value.length > 0)) continue;
    if (isRepeatedHeaderRow(values)) continue;
    if (values.length !== downloadedBankHeaders.length) {
      throw new Error(
        `Downloaded YuanTa statement CSV row had ${values.length} columns; expected ${downloadedBankHeaders.length}.`,
      );
    }

    statements.push({
      accountLabel,
      values,
      sortTime: parseBankSortTime(values),
    });
  }

  return statements;
}

function sortedStatementRows(rows: BankTransactionRow[]): BankTransactionRow[] {
  return [...rows].sort((left, right) => {
    if (left.sortTime === null && right.sortTime === null) return 0;
    if (left.sortTime === null) return 1;
    if (right.sortTime === null) return -1;
    return right.sortTime - left.sortTime;
  });
}

function bankTransactionsToCsv(rows: BankTransactionRow[]): string {
  return rowsToCsv([
    bankTransactionHeaders,
    ...sortedStatementRows(rows).map((row) => [row.accountLabel, ...row.values]),
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

async function writeBankTransactionsFile(
  nextTimestamp: () => string,
  dateRange: z.infer<typeof dateRangeSchema>,
  rows: BankTransactionRow[],
  sourceDownloads: SourceDownloadMetadata[],
): Promise<TableFile> {
  const downloadsDir = join(process.cwd(), "downloads", "yuanta-statements");
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `bank-transactions-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const accounts = [...new Set(rows.map((row) => row.accountLabel))];

  await writeFile(csvPath, bankTransactionsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt: new Date().toISOString(),
        workflow: "yuantaStatements",
        kind: "bank-transactions",
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers: bankTransactionHeaders,
        accounts,
        dateRange,
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
    kind: "bank-transactions",
    rowCount: rows.length,
    headers: bankTransactionHeaders,
    accounts,
    dateRange,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

function matchesAccountFilter(
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

function cidFromUrl(url: string): string | null {
  const match = url.match(/[?&]cid=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function currentCidFromFrameUrls(page: Page): string | null {
  for (const frame of page.frames()) {
    const cid = cidFromUrl(frame.url());
    if (cid) return cid;
  }
  return cidFromUrl(page.url());
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
    // YuanTa keeps frames and timers alive; selector waits below confirm readiness.
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

async function waitForSignedInState(
  page: Page,
  getLastDialogMessage: () => string,
  replaceActiveSession: boolean,
): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  let replacedActiveSession = false;
  while (Date.now() < deadline) {
    const fmain = page.frame({ name: "fmain" });
    if (
      page.frame({ name: "fmenu" }) &&
      fmain &&
      currentCidFromFrameUrls(page)
    ) {
      return replacedActiveSession;
    }

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

async function openTransactionDetailsPage(page: Page): Promise<BrowserScope> {
  const existing = await findScopeWithSelector(page, "#acctno", 5_000).catch(
    () => null,
  );
  if (existing) return existing;

  const fmain = page.frame({ name: "fmain" });
  const cid = currentCidFromFrameUrls(page);
  if (fmain && cid) {
    await fmain.goto(
      `${BANK_ORIGIN}/nib/tx/transactiondetails?type=page&cid=${encodeURIComponent(
        cid,
      )}`,
      { waitUntil: "domcontentloaded" },
    );
    await settleAfterNavigation(page);

    const direct = await findScopeWithSelector(page, "#acctno", 15_000).catch(
      () => null,
    );
    if (direct) return direct;
  }

  const menuScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("#menu_transactiondetails")
        .or(candidate.locator("a").filter({ hasText: "臺幣交易明細查詢" }))
        .first(),
    "YuanTa transaction-details menu link",
  );
  const links = menuScope
    .locator("#menu_transactiondetails")
    .or(menuScope.locator("a").filter({ hasText: "臺幣交易明細查詢" }));
  const link = await firstVisibleLocator(
    links,
    "YuanTa transaction-details menu link",
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);

  return await findScopeWithSelector(page, "#acctno");
}

async function chooseDateRange(
  page: Page,
  dateRange: z.infer<typeof dateRangeSchema>,
): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");
  const label = dateRangeLabels[dateRange];
  const link = await firstVisibleLocator(
    scope.locator("#duration a").filter({ hasText: label }),
    `YuanTa date range link "${label}"`,
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  await findScopeWithSelector(page, "#acctno");
}

async function readAccountOptions(page: Page, filters: string[]) {
  const scope = await findScopeWithSelector(page, "#acctno");
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const accounts: Array<{ label: string; value: string }> = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (!value || /請選擇/.test(label)) continue;

    const account = { label, value };
    if (matchesAccountFilter(account, filters)) accounts.push(account);
  }

  if (accounts.length === 0) {
    throw new Error("No domestic-currency account options matched the input.");
  }

  return accounts;
}

async function queryAccount(
  page: Page,
  account: { label: string; value: string },
): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator("#acctno").selectOption(account.value);
  await scope.locator("#submitbutton").click();
  await settleAfterNavigation(page);

  const resultScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa CSV download link",
  );
  await resultScope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first()
    .waitFor({ state: "attached", timeout: 60_000 });
}

async function downloadStatementRows(
  page: Page,
  accountLabel: string,
): Promise<{ filename: string; rows: BankTransactionRow[] }> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa CSV download link",
  );

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await scope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first()
    .click();
  const download = await downloadPromise;

  const filename = download.suggestedFilename();
  const content = await readBig5DownloadAsUtf8(download);
  return {
    filename,
    rows: statementRowsFromDownloadedCsv(content, accountLabel),
  };
}

export default workflow("yuantaStatements", {
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page, session } = ctx;
    const credentials = (input as typeof input & { credentials: YuantaCredentials })
      .credentials;
    let lastBankDialogMessage = "";

    page.on("dialog", async (dialog) => {
      lastBankDialogMessage = dialog.message();
      console.warn("bank-dialog", {
        type: dialog.type(),
        message: lastBankDialogMessage,
      });
      await dialog.accept();
    });

    await fillLoginForm(page, credentials);

    console.log(
      "manual-auth-required: enter the CAPTCHA in the browser, then run `npx libretto resume --session " +
        session +
        "`.",
    );
    await pause(session);

    await submitLogin(page, credentials);
    const replacedActiveSession = await waitForSignedInState(
      page,
      () => lastBankDialogMessage,
      input.replaceActiveSession,
    );

    await openTransactionDetailsPage(page);
    await chooseDateRange(page, input.dateRange);

    const accounts = await readAccountOptions(page, input.accountFilters);
    const rows: BankTransactionRow[] = [];
    const sourceDownloads: SourceDownloadMetadata[] = [];
    const nextTimestamp = createTimestampGenerator();

    for (const account of accounts) {
      const maskedAccount = maskAccountLabel(account.label);
      await queryAccount(page, account);
      const download = await downloadStatementRows(page, maskedAccount);
      rows.push(...download.rows);
      sourceDownloads.push({
        account: maskedAccount,
        filename: download.filename,
        rowCount: download.rows.length,
      });
    }

    const file = await writeBankTransactionsFile(
      nextTimestamp,
      input.dateRange,
      rows,
      sourceDownloads,
    );

    return {
      dateRange: input.dateRange,
      replacedActiveSession,
      count: 1,
      files: [file],
    };
  },
});
