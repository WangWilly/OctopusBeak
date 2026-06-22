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
const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";

type BrowserScope = Page | Frame;

type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};

type LoanAccountOption = {
  label: string;
  value: string;
};

type StatementRow = {
  transactionAndPostingDate: string;
  paymentItem: string;
  interestPeriod: string;
  transactionAmount: string;
  balanceAfterTransaction: string;
  overpayment: string;
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

const statementFileSchema = z.object({
  account: z.string(),
  rowCount: z.number().int().nonnegative(),
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
  statements: z.array(statementFileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type StatementFile = z.infer<typeof statementFileSchema>;

const dateRangeLabels: Record<z.infer<typeof quickDateRangeSchema>, string> = {
  three_months: "三個月",
  six_months: "六個月",
  one_year: "一年",
};

const statementHeaders = [
  "交易日/記帳日",
  "繳款項目",
  "提息起日/提息迄日",
  "交易金額",
  "交易後餘額",
  "溢繳款",
] as const;

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

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
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

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: StatementRow[]): string {
  const lines = [
    statementHeaders.map(csvCell).join(","),
    ...rows.map((row) =>
      [
        row.transactionAndPostingDate,
        row.paymentItem,
        row.interestPeriod,
        row.transactionAmount,
        row.balanceAfterTransaction,
        row.overpayment,
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
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
  await loginFrame.locator("#custidMask").fill(userId);
  await fillReadonlyLoginInput(loginFrame.locator("#custnoInput"), account);
  await fillReadonlyLoginInput(loginFrame.locator("#custcode"), password);
  await loginFrame.locator("#gcode").focus();
}

async function fillReadonlyLoginInput(
  field: Locator,
  value: string,
): Promise<void> {
  await field.click({ force: true });
  await field.evaluate((element) => element.removeAttribute("readonly"));
  await field.fill(value);
}

async function submitLogin(page: Page): Promise<void> {
  const loginFrame = await waitForFrame(page, "main");
  await loginFrame.locator('a[href="javascript:doPreLogin();"]').click();
}

async function isSignedIn(page: Page): Promise<boolean> {
  const hasLoanForm = await findLoanStatementForm(page, 3_000)
    .then(() => true)
    .catch(() => false);
  if (hasLoanForm) return true;

  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("#menu_loansummary")
        .or(candidate.locator("#menu_loantransactiondetails"))
        .or(candidate.locator('a[onclick*="loantransactiondetails"]'))
        .first(),
    "YuanTa signed-in loan navigation",
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

async function findLoanStatementForm(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasAccount = (await scope.locator("#acctno").count().catch(() => 0)) > 0;
      const hasLoanRange =
        (await scope
          .locator("#duration a")
          .filter({ hasText: "一年" })
          .count()
          .catch(() => 0)) > 0;
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

async function chooseDateRange(page: Page, input: WorkflowInput): Promise<void> {
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

async function readLoanAccountOptions(
  page: Page,
  filters: string[],
): Promise<LoanAccountOption[]> {
  const scope = await findLoanStatementForm(page);
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const accounts: LoanAccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (!value || value === "0" || /請選擇/.test(label)) continue;

    const account = { label, value };
    if (matchesFilter(account, filters)) accounts.push(account);
  }

  if (accounts.length === 0) {
    throw new Error("No loan account options matched the input.");
  }

  return accounts;
}

async function queryLoanAccount(
  page: Page,
  input: WorkflowInput,
  account: LoanAccountOption,
): Promise<void> {
  const scope = await findLoanStatementForm(page);
  await scope.locator("#acctno").selectOption(account.value);
  await chooseDateRange(page, input);
  await scope.locator("#submitbutton").click();
  await settleAfterNavigation(page);
  await findScopeWithSelector(page, "#resultdiv");
}

async function parseLoanStatementRows(page: Page): Promise<StatementRow[]> {
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
    if (cellCount !== statementHeaders.length) continue;

    const values: string[] = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      values.push(cleanText(await cells.nth(cellIndex).innerText()));
    }
    if (values.every((value) => value.length === 0)) continue;

    statements.push({
      transactionAndPostingDate: values[0],
      paymentItem: values[1],
      interestPeriod: values[2],
      transactionAmount: values[3],
      balanceAfterTransaction: values[4],
      overpayment: values[5],
    });
  }

  return statements;
}

async function writeStatementFiles(
  accountLabel: string,
  rows: StatementRow[],
): Promise<Omit<StatementFile, "account" | "rowCount">> {
  const downloadsDir = join(process.cwd(), "downloads", "yuanta-loan-statements");
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${Date.now()}-${safeFilename(accountLabel)}`;
  const csvPath = join(downloadsDir, `${baseName}.csv`);
  const jsonPath = join(downloadsDir, `${baseName}.json`);

  await writeFile(csvPath, rowsToCsv(rows), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

export default workflow("yuantaLoanStatements", {
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
          if (stillOnLogin) await submitLogin(authPage);
        }
        replacedActiveSession = await waitForSignedInState(
          authPage,
          () => lastBankDialogMessage,
          input.replaceActiveSession,
        );
      },
    });

    await openLoanStatementPage(page);
    const accounts = await readLoanAccountOptions(page, input.loanAccountFilters);
    const statements: StatementFile[] = [];

    for (const account of accounts) {
      const maskedAccount = maskAccountLabel(account.label);
      await queryLoanAccount(page, input, account);
      const rows = await parseLoanStatementRows(page);
      const files = await writeStatementFiles(maskedAccount, rows);
      statements.push({
        account: maskedAccount,
        rowCount: rows.length,
        ...files,
      });
    }

    return {
      dateRange: describeDateRange(input),
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession,
      count: statements.length,
      statements,
    };
  },
});
