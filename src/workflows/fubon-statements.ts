import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflow, pause, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import XLSX from "xlsx";
import { z } from "zod";

const BANK_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";

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

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function readFirstSheetRows(path: string): string[][] {
  const workbook = XLSX.readFile(path);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error(`Downloaded Excel file has no worksheets: ${path}`);
  }

  const worksheet = workbook.Sheets[sheetName];
  return XLSX.utils
    .sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      raw: false,
      blankrows: false,
    })
    .map((row) => row.map((cell) => cleanText(String(cell ?? ""))));
}

function metadataValue(rows: string[][], label: string): string {
  for (const row of rows) {
    for (let index = 0; index < row.length - 1; index += 1) {
      if (cleanText(row[index]) === label) return cleanText(row[index + 1]);
    }
  }

  return "";
}

function findHeaderRowIndex(rows: string[][], headers: string[]): number {
  const index = rows.findIndex((row) =>
    headers.every((header, headerIndex) => cleanText(row[headerIndex]) === header),
  );
  if (index === -1) {
    throw new Error(`Downloaded statement table is missing headers: ${headers.join(",")}`);
  }
  return index;
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

function parseDepositStatement(path: string, fallbackAccount: string): ParsedDepositStatement {
  const rows = readFirstSheetRows(path);
  const account = metadataValue(rows, "帳號") || fallbackAccount;
  const queryPeriod = metadataValue(rows, "查詢期間");
  const headerRowIndex = findHeaderRowIndex(rows, depositHeaders);
  const dataRows = rows
    .slice(headerRowIndex + 1)
    .map((row) => depositHeaders.map((_, index) => cleanText(row[index])))
    .filter((row) => /^\d{4}\/\d{2}\/\d{2}$/.test(row[0]));

  return {
    account,
    accountId: accountIdFor(account, fallbackAccount),
    queryPeriod,
    branchName: branchNameFromAccount(account),
    rows: dataRows,
  };
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
  await headerFrame.locator("#menu_CDS").click({ force: true });

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

  await headerFrame
    .locator("a")
    .filter({ hasText: "登入" })
    .first()
    .click({ force: true });

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
          await link.click({ force: true });
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
    await fastFunctionLink.click({ force: true }).catch(() => undefined);
  }

  const transactionDetails = accountRow
    .locator("a.btn_sel")
    .filter({ hasText: "交易明細查詢" });
  await transactionDetails.waitFor({ state: "attached", timeout: 30_000 });
  await transactionDetails.dispatchEvent("click");

  return maskedAccount;
}

async function queryStatements(
  page: Page,
  dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
) {
  const scope = await findScopeWithSelector(
    page,
    'a[id="form1:doValidateAndSubmit"]',
  );
  const dateRangeId = `input[id="form1:rdoDay${dateRange}"]`;
  await scope.locator(dateRangeId).check({ force: true });
  await scope.locator('a[id="form1:doValidateAndSubmit"]').click();
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // The bank keeps background frames alive; a short settle wait below is enough.
  });
  await page.waitForTimeout(1_000);
  await findScopeWithSelector(page, "#multipleDownload");
}

async function downloadStatements(
  page: Page,
  downloadFormat: "TXT" | "EXCEL" | "PDF",
  fallbackAccount: string,
): Promise<ParsedDepositStatement> {
  const scope = await findScopeWithSelector(page, "#multipleDownload");
  await scope.locator("#multipleDownload").click();
  await scope
    .locator(`input[name="download_format"][value="${downloadFormat}"]`)
    .check({ force: true });

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await scope.locator("a.confirm").click();
  const download = await downloadPromise;

  const filename = download.suggestedFilename();
  const tempPath = join(
    tmpdir(),
    `fubon-statements-${nextTimestamp()}-${safeFilename(filename)}`,
  );
  await download.saveAs(tempPath);

  try {
    return parseDepositStatement(tempPath, fallbackAccount);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
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
  await loginFrame.locator("#btnLogin2").click();

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
    throw new Error("fubon-statements normalized output requires EXCEL downloadFormat.");
  }

  const depositScope = await openMyDepositsPage(page);
  const accountCount = await countDepositRows(depositScope);
  const downloads: FubonStatementsOutput["downloads"] = [];

  for (let accountIndex = 0; accountIndex < accountCount; accountIndex += 1) {
    const accountStatements: ParsedDepositStatement[] = [];

    for (const dateRange of input.dateRanges) {
      const account = await openTransactionDetailForAccountIndex(
        page,
        accountIndex,
      );
      await queryStatements(page, dateRange);
      accountStatements.push(
        await downloadStatements(page, input.downloadFormat, account),
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
