import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, pause, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { activateControlWithoutPointer } from "./browser-interaction.js";
import {
  fetchFormPostbackHtml,
  replaceDocumentHtml,
} from "./form-postback.js";

const BANK_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";
const depositAccountSelectSelector = 'select[id="form1:comboAccount"]';

type BrowserScope = Page | Frame;

export const fubonStatementDateRangeSchema = z.enum([
  "1",
  "3",
  "7",
  "14",
  "21",
  "30",
  "60",
  "90",
  "180",
  "180_365",
]);

export const fubonStatementsInputSchema = z.object({
  dateRanges: z
    .array(fubonStatementDateRangeSchema)
    .min(1)
    .default(["180", "180_365"]),
  downloadFormat: z.enum(["TXT", "EXCEL", "PDF"]).default("EXCEL"),
});

export const fubonStatementsOutputSchema = z.object({
  dateRanges: z.array(fubonStatementDateRangeSchema),
  downloadFormat: z.enum(["TXT", "EXCEL", "PDF"]),
  count: z.number().int().nonnegative(),
  downloads: z.array(
    z.object({
      accountId: z.string(),
      account: z.string(),
      queryPeriods: z.array(z.string()),
      branchName: z.string(),
      baseName: z.string(),
      csvFilename: z.string(),
      csvPath: z.string(),
      csvBytes: z.number().int().nonnegative(),
      jsonFilename: z.string(),
      jsonPath: z.string(),
      jsonBytes: z.number().int().nonnegative(),
      rowCount: z.number().int().nonnegative(),
    }),
  ),
});

export type FubonCredentials = {
  fubon_user_id?: string;
  fubon_account?: string;
  fubon_password?: string;
};

export type FubonStatementsInput = z.infer<typeof fubonStatementsInputSchema>;
export type FubonStatementsOutput = z.infer<typeof fubonStatementsOutputSchema>;

type Input = FubonStatementsInput & {
  credentials: FubonCredentials;
};

type ParsedDepositStatement = {
  account: string;
  accountId: string;
  queryPeriod: string;
  branchName: string;
  rows: string[][];
};

type ParsedDepositStatementPage = {
  account: string;
  accountId: string;
  branchName: string;
  queryPeriod: string;
  rows: string[][];
  nextPage: string | null;
  pageFieldName: string | null;
};

type DepositAccountOption = {
  label: string;
  value: string;
};

let lastTimestamp = 0;

const depositHeaders = [
  "帳務日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
];

function requireCredential(
  credentials: FubonCredentials,
  name: keyof FubonCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function maskAccount(account: string): string {
  const digits = digitsOnly(account);
  if (digits.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nextTimestamp(): string {
  const timestamp = Date.now();
  lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
  return String(lastTimestamp);
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function addMonthsClamped(date: Date, months: number): Date {
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth() + months;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(
    targetYear,
    targetMonth,
    Math.min(date.getDate(), lastDay),
  );
}

function depositDateRangeFields(
  dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
): Record<string, string> {
  const today = new Date();
  const endDate = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const dayOffsets: Partial<
    Record<z.infer<typeof fubonStatementDateRangeSchema>, number>
  > = {
    "1": 0,
    "3": 2,
    "7": 6,
    "14": 13,
    "21": 20,
  };
  const monthOffsets: Partial<
    Record<z.infer<typeof fubonStatementDateRangeSchema>, number>
  > = {
    "30": 1,
    "60": 2,
    "90": 3,
    "180": 6,
  };

  if (dateRange === "180_365") {
    return {
      "form1:rdoGroup3": dateRange,
      "form1:startDate": formatDate(addMonthsClamped(endDate, -12)),
      "form1:endDate": formatDate(addMonthsClamped(endDate, -6)),
      "resultGrid:dataGridCurrentPage": "1",
    };
  }

  const dayOffset = dayOffsets[dateRange];
  const monthOffset = monthOffsets[dateRange];
  const startDate =
    dayOffset !== undefined
      ? addDays(endDate, -dayOffset)
      : addMonthsClamped(endDate, -(monthOffset ?? 0));

  return {
    "form1:rdoGroup3": dateRange,
    "form1:startDate": formatDate(startDate),
    "form1:endDate": formatDate(endDate),
    "resultGrid:dataGridCurrentPage": "1",
  };
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function branchNameFromAccount(account: string): string {
  return cleanText(account.match(/\(([^()]+)\)\s*$/)?.[1]);
}

function accountIdFor(account: string, fallback: string): string {
  const accountPrefix = account.split(/[（(]/)[0] ?? account;
  const fallbackPrefix = fallback.split(/[（(]/)[0] ?? fallback;
  return (
    digitsOnly(accountPrefix) ||
    digitsOnly(fallbackPrefix) ||
    safeFilename(fallback)
  );
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function depositRowSortKey(row: string[]): string {
  return cleanText(row[1]) || cleanText(row[0]);
}

function compareDepositRowsByTransactionTimeDesc(
  left: string[],
  right: string[],
): number {
  return depositRowSortKey(right).localeCompare(depositRowSortKey(left));
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

async function fillLoginForm(page: Page, credentials: FubonCredentials) {
  const userId = requireCredential(credentials, "fubon_user_id");
  const account = requireCredential(credentials, "fubon_account");
  const password = requireCredential(credentials, "fubon_password");

  await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });

  const headerFrame = await waitForFrame(page, "frame1");
  await activateControlWithoutPointer(headerFrame.locator("#menu_CDS"));

  const landingFrame = await waitForFrame(page, "txnFrame");
  const myDepositsHref = await landingFrame
    .locator("a.task_CBOQU003.menu_CDS0102")
    .first()
    .getAttribute("href");
  if (!myDepositsHref) {
    throw new Error("Could not find the My Deposits navigation href.");
  }
  await landingFrame.goto(new URL(myDepositsHref, BANK_ENTRY_URL).toString(), {
    waitUntil: "domcontentloaded",
  });

  await activateControlWithoutPointer(
    headerFrame
      .locator("a")
      .filter({ hasText: "登入" })
      .first(),
  );

  const loginFrame = await waitForFrame(page, "txnFrame");
  const visiblePasswordFields = loginFrame.locator(
    'input[type="password"]:visible',
  );
  await visiblePasswordFields.first().waitFor({ timeout: 60_000 });

  // The bank page renders these fields as password inputs even for user ID/account.
  await visiblePasswordFields.nth(0).fill(userId);
  await visiblePasswordFields.nth(1).fill(account);
  await visiblePasswordFields.nth(2).fill(password);
  await loginFrame.locator("#m1_userCaptcha").focus();
}

async function waitForSignedInState(page: Page) {
  const headerFrame = await waitForFrame(page, "frame1");
  await headerFrame.locator("#header_form\\:header_logout").waitFor({
    state: "visible",
    timeout: 120_000,
  });
}

function depositRows(scope: BrowserScope): Locator {
  return scope
    .locator("tr")
    .filter({ has: scope.locator("a.btn_sel").filter({ hasText: "交易明細查詢" }) });
}

async function countDepositRows(scope: BrowserScope): Promise<number> {
  await scope
    .locator("a.btn_sel")
    .filter({ hasText: "交易明細查詢" })
    .first()
    .waitFor({
      state: "attached",
      timeout: 60_000,
    });
  return await depositRows(scope).count();
}

async function readMaskedAccountLabel(row: Locator): Promise<string> {
  const raw = await row
    .locator("td")
    .first()
    .innerText()
    .catch(async () => await row.innerText());
  return maskAccount(raw);
}

async function readDepositAccountOptions(
  page: Page,
): Promise<DepositAccountOption[]> {
  const scope = await findScopeWithSelector(page, depositAccountSelectSelector);
  const options = scope.locator(`${depositAccountSelectSelector} option`);
  const count = await options.count();
  const accounts: DepositAccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = cleanText(await option.getAttribute("value"));
    const label = cleanText(await option.textContent());
    if (value && label) accounts.push({ label, value });
  }

  if (accounts.length === 0) {
    throw new Error("No Fubon deposit account options matched the page.");
  }

  return accounts;
}

async function selectDepositAccount(
  page: Page,
  account: DepositAccountOption,
): Promise<void> {
  const scope = await findScopeWithSelector(page, depositAccountSelectSelector);
  await scope.locator(depositAccountSelectSelector).selectOption(account.value);
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await page.locator(selector).count().catch(() => 0)) > 0) {
      return page;
    }

    for (const frame of page.frames()) {
      if ((await frame.locator(selector).count().catch(() => 0)) > 0) {
        return frame;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for selector ${selector}.`);
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
      if ((await locatorFor(scope).count().catch(() => 0)) > 0) {
        return scope;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find ${description} in any frame.`);
}

function depositResultTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "帳務日期" })
    .filter({ hasText: "交易時間" })
    .filter({ hasText: "即時餘額" })
    .first();
}

async function clickFirstLinkByText(
  page: Page,
  text: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const link = scope.locator("a").filter({ hasText: text }).first();
      if ((await link.count().catch(() => 0)) > 0) {
        const href = await link.getAttribute("href");
        if (href && href !== "#" && !href.startsWith("javascript:")) {
          await scope.goto(new URL(href, BANK_ENTRY_URL).toString(), {
            waitUntil: "domcontentloaded",
          });
        } else {
          await activateControlWithoutPointer(link);
        }
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find link with text "${text}".`);
}

async function openMyDepositsPage(page: Page): Promise<BrowserScope> {
  const existing = await findScopeWithSelector(
    page,
    "a.input_sel.fastFunctionLinks",
    15_000,
  ).catch(() => null);
  if (existing) return existing;

  await clickFirstLinkByText(page, "我的存款");
  return await findScopeWithSelector(page, "a.input_sel.fastFunctionLinks");
}

async function openTransactionDetailForAccountIndex(
  page: Page,
  accountIndex: number,
): Promise<string> {
  const scope = await openMyDepositsPage(page);

  const rowCount = await countDepositRows(scope);
  if (accountIndex >= rowCount) {
    throw new Error(
      `Deposit account index ${accountIndex} is out of range; only ${rowCount} account rows are visible.`,
    );
  }

  const accountRow = depositRows(scope).nth(accountIndex);
  const maskedAccount = await readMaskedAccountLabel(accountRow);
  const fastFunctionLink = accountRow.locator("a.input_sel.fastFunctionLinks");
  if ((await fastFunctionLink.count()) > 0) {
    await activateControlWithoutPointer(fastFunctionLink).catch(() => undefined);
  }

  const transactionDetails = accountRow
    .locator("a.btn_sel")
    .filter({ hasText: "交易明細查詢" });
  await transactionDetails.waitFor({ state: "attached", timeout: 30_000 });
  await activateControlWithoutPointer(transactionDetails);

  return maskedAccount;
}

async function parseDepositStatementHtml(
  page: Page,
  html: string,
): Promise<ParsedDepositStatementPage> {
  const parsed = (await page.evaluate(
    ({ html: sourceHtml, headers }) => {
      const clean = (value: string | null | undefined) =>
        (value ?? "")
          .replace(/[\u00a0\u3000]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const cellsFor = (row: Element) =>
        Array.from(row.querySelectorAll("th,td")).map((cell) =>
          clean(cell.textContent),
        );
      const doc = new DOMParser().parseFromString(sourceHtml, "text/html");
      const tables = Array.from(doc.querySelectorAll("table"));
      const tableRows = tables
        .map((table) =>
          Array.from(table.querySelectorAll("tr")).map((row) => cellsFor(row)),
        )
        .find((rows) =>
          rows.some((row) =>
            headers.every((header, index) => clean(row[index]).includes(header)),
          ),
        );
      if (!tableRows) {
        throw new Error("Deposit query response is missing the result table.");
      }

      const headerRowIndex = tableRows.findIndex((row) =>
        headers.every((header, index) => clean(row[index]).includes(header)),
      );
      const rows = tableRows
        .slice(headerRowIndex + 1)
        .map((row) => headers.map((_, index) => clean(row[index])))
        .filter((row) => /^\d{4}\/\d{2}\/\d{2}$/.test(row[0]));
      const startDate = clean(
        (doc.getElementById("form1:startDate") as HTMLInputElement | null)
          ?.value,
      );
      const endDate = clean(
        (doc.getElementById("form1:endDate") as HTMLInputElement | null)?.value,
      );
      const nextLink = Array.from(doc.querySelectorAll("a")).find(
        (link) =>
          clean(link.textContent) === "下一頁" &&
          /setDataGridCurrentPage/.test(link.getAttribute("onclick") ?? ""),
      );
      const nextMatch = (nextLink?.getAttribute("onclick") ?? "").match(
        /setDataGridCurrentPage\([^,]+,\s*(\d+),\s*['"]([^'"]+)['"]/,
      );
      const selectedAccountValue =
        Array.from(
          sourceHtml.matchAll(
            /setupComboBox\("form1:comboAccount",\s*"[^"]*",\s*"([^"]+)"/g,
          ),
        )
          .map((match) => clean(match[1]))
          .filter(Boolean)
          .at(-1) ?? "";
      const accountItems = Array.from(
        sourceHtml.matchAll(
          /comboAccountItems\[\d+\]\s*=\s*new Array\("([^"]*)",\s*"([^"]*)"/g,
        ),
      ).map((match) => ({
        label: clean(match[1]),
        value: clean(match[2]),
      }));
      const selectedAccount = accountItems.find(
        (item) => item.value === selectedAccountValue,
      );
      const account = selectedAccount?.label ?? "";
      const accountId = clean(account.split(/[（(]/)[0]);
      const branchName = clean(account.match(/[（(]([^()（）]+)[）)]/)?.[1]);

      return {
        account,
        accountId,
        branchName,
        nextPage: nextMatch?.[1] ?? null,
        pageFieldName: nextMatch?.[2] ?? null,
        queryPeriod: startDate && endDate ? `${startDate}~${endDate}` : "",
        rows,
      };
    },
    { html, headers: depositHeaders },
  )) as ParsedDepositStatementPage;

  return parsed;
}

async function fetchDepositStatement(
  page: Page,
  dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
  fallbackAccount: string,
): Promise<ParsedDepositStatement> {
  const scope = await findScopeWithSelector(
    page,
    'a[id="form1:doValidateAndSubmit"]',
  );
  const dateRangeId = `input[id="form1:rdoDay${dateRange}"]`;
  await activateControlWithoutPointer(scope.locator(dateRangeId));
  await page.waitForTimeout(500);

  const html = await fetchFormPostbackHtml(
    scope.locator("form").first(),
    "form1:doValidateAndSubmit",
    depositDateRangeFields(dateRange),
  );
  const pages = [await parseDepositStatementHtml(page, html)];
  await replaceDocumentHtml(scope, html);

  let nextPage = pages[0].nextPage;
  let pageFieldName = pages[0].pageFieldName;
  while (nextPage && pageFieldName) {
    const nextHtml = await fetchFormPostbackHtml(
      scope.locator("form").first(),
      undefined,
      { [pageFieldName]: nextPage },
    );
    const nextParsed = await parseDepositStatementHtml(page, nextHtml);
    pages.push(nextParsed);
    await replaceDocumentHtml(scope, nextHtml);
    nextPage = nextParsed.nextPage;
    pageFieldName = nextParsed.pageFieldName;
  }

  await findScopeWithLocator(
    page,
    depositResultTable,
    "deposit statement result table",
  );

  const firstPage = pages[0];
  return {
    account: firstPage.account || fallbackAccount,
    accountId:
      firstPage.accountId ||
      accountIdFor(firstPage.account || fallbackAccount, fallbackAccount),
    queryPeriod: firstPage.queryPeriod,
    branchName:
      firstPage.branchName || branchNameFromAccount(firstPage.account || fallbackAccount),
    rows: pages.flatMap((page) => page.rows),
  };
}

async function writeDepositStatementFiles(
  statements: ParsedDepositStatement[],
): Promise<FubonStatementsOutput["downloads"][number]> {
  const first = statements[0];
  if (!first) throw new Error("Cannot write an empty deposit statement file.");

  const downloadsDir = join(process.cwd(), "downloads", "fubon-statements");
  await mkdir(downloadsDir, { recursive: true });

  const account = first.account;
  const accountId = first.accountId;
  const queryPeriods = uniqueValues(
    statements.map((statement) => statement.queryPeriod),
  );
  const branchName = first.branchName;
  const rows = statements
    .flatMap((statement) => statement.rows)
    .sort(compareDepositRowsByTransactionTimeDesc);
  const baseName = `${safeFilename(accountId)}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);

  await writeFile(csvPath, rowsToCsv([depositHeaders, ...rows]), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: account,
        查詢期間: queryPeriods,
        分行名稱: branchName,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);

  return {
    accountId,
    account,
    queryPeriods,
    branchName,
    baseName,
    csvFilename,
    csvPath,
    csvBytes: csvStat.size,
    jsonFilename,
    jsonPath,
    jsonBytes: jsonStat.size,
    rowCount: rows.length,
  };
}

export async function signInFubon(
  page: Page,
  session: string,
  credentials: FubonCredentials,
): Promise<void> {
  await fillLoginForm(page, credentials);

  console.log(
    "manual-auth-required: enter the CAPTCHA in the browser, then run `npx libretto resume --session " +
      session +
      "`.",
  );
  await pause(session);

  const loginFrame = await waitForFrame(page, "txnFrame");
  await activateControlWithoutPointer(loginFrame.locator("#btnLogin2"));

  if (
    await loginFrame
      .locator("#m1_inputOTP")
      .isVisible()
      .catch(() => false)
  ) {
    console.log(
      "manual-otp-required: complete OTP in the browser, then run `npx libretto resume --session " +
        session +
        "`.",
    );
    await pause(session);
  }

  await waitForSignedInState(page);
}

export async function runFubonStatements(
  page: Page,
  input: FubonStatementsInput,
): Promise<FubonStatementsOutput> {
  if (input.downloadFormat !== "EXCEL") {
    throw new Error(
      'fubon-statements normalized output currently supports downloadFormat="EXCEL" only.',
    );
  }

  await openTransactionDetailForAccountIndex(page, 0);
  const accounts = await readDepositAccountOptions(page);
  const downloads: FubonStatementsOutput["downloads"] = [];

  for (const account of accounts) {
    await selectDepositAccount(page, account);
    const accountStatements: ParsedDepositStatement[] = [];

    for (const dateRange of input.dateRanges) {
      accountStatements.push(
        await fetchDepositStatement(page, dateRange, account.label),
      );
    }

    downloads.push(await writeDepositStatementFiles(accountStatements));
  }

  return {
    dateRanges: input.dateRanges,
    downloadFormat: input.downloadFormat,
    count: downloads.length,
    downloads,
  };
}

export default workflow("fubonStatements", {
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: fubonStatementsInputSchema,
  output: fubonStatementsOutputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const { page, session } = ctx;

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await signInFubon(page, session, input.credentials);
    return await runFubonStatements(page, input);
  },
});
