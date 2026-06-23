import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pause, workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import XLSX from "xlsx";
import { z } from "zod";

const BANK_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";

type BrowserScope = Page | Frame;

type FubonCredentials = {
  fubon_user_id?: string;
  fubon_account?: string;
  fubon_password?: string;
};

const queryItemSchema = z.enum([
  "TRANSACTION_DETAIL_QUERY",
  "PARTLY_PAID_TRANSACTION_DETAIL_QUERY",
  "DATES_DETAIL_QUERY",
  "DYNAMIC_BRANCH_DETAIL_QUERY",
]);

type QueryItem = z.infer<typeof queryItemSchema>;

const DEFAULT_QUERY_ITEMS: QueryItem[] = [
  "TRANSACTION_DETAIL_QUERY",
  "PARTLY_PAID_TRANSACTION_DETAIL_QUERY",
  "DATES_DETAIL_QUERY",
  "DYNAMIC_BRANCH_DETAIL_QUERY",
];

const quickMonthsSchema = z.enum(["1", "3", "6"]);

const inputSchema = z.object({
  loanAccountLabels: z.array(z.string()).default([]),
  queryItem: queryItemSchema.optional(),
  queryItems: z.array(queryItemSchema).optional(),
  quickMonths: quickMonthsSchema.default("6"),
  dateRange: z
    .object({
      startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
      endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
    })
    .optional(),
  downloadFormat: z.enum(["TXT", "EXCEL", "PDF"]).default("EXCEL"),
});

const outputSchema = z.object({
  queryItems: z.array(queryItemSchema),
  period: z.object({
    mode: z.enum(["quick", "custom"]),
    quickMonths: quickMonthsSchema.optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }),
  downloadFormat: z.enum(["TXT", "EXCEL", "PDF"]),
  count: z.number().int().nonnegative(),
  downloads: z.array(
    z.object({
      loanAccount: z.string(),
      queryItem: queryItemSchema,
      filename: z.string(),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      csvPath: z.string().optional(),
      csvBytes: z.number().int().nonnegative().optional(),
    }),
  ),
  skippedAccounts: z.array(
    z.object({
      loanAccount: z.string(),
      queryItem: queryItemSchema,
      reason: z.string(),
    }),
  ),
});

export {
  inputSchema as fubonLoanStatementsInputSchema,
  outputSchema as fubonLoanStatementsOutputSchema,
};

export type FubonLoanStatementsInput = z.infer<typeof inputSchema>;
export type FubonLoanStatementsOutput = z.infer<typeof outputSchema>;

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

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function csvPathFor(path: string): string {
  const csvPath = path.replace(/\.[^/.]+$/, ".csv");
  return csvPath === path ? `${path}.csv` : csvPath;
}

async function convertXlsToCsv(path: string) {
  const workbook = XLSX.readFile(path);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error(`Downloaded Excel file has no worksheets: ${path}`);
  }

  const worksheet = workbook.Sheets[sheetName];
  const csv = XLSX.utils.sheet_to_csv(worksheet);
  const csvPath = csvPathFor(path);
  await writeFile(csvPath, csv.endsWith("\n") ? csv : `${csv}\n`, "utf8");

  const csvStat = await stat(csvPath);
  return { csvPath, csvBytes: csvStat.size };
}

function matchesFilter(value: string, filters: string[]): boolean {
  if (filters.length === 0) return true;

  const normalizedValue = value.toLowerCase();
  const valueDigits = digitsOnly(value);

  return filters.some((filter) => {
    const normalizedFilter = filter.toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      normalizedValue.includes(normalizedFilter) ||
      (filterDigits.length > 0 && valueDigits.endsWith(filterDigits))
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

async function waitForNoVisibleBankMask(
  page: Page,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let hasVisibleMask = false;
    for (const scope of [page, ...page.frames()]) {
      const masks = scope.locator("div._mask, ._mask");
      const count = await masks.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        if (await masks.nth(index).isVisible().catch(() => false)) {
          hasVisibleMask = true;
          break;
        }
      }
      if (hasVisibleMask) break;
    }

    if (!hasVisibleMask) return;
    await page.waitForTimeout(250);
  }

  throw new Error("Timed out waiting for the bank loading mask to clear.");
}

async function fillLoanLoginForm(page: Page, credentials: FubonCredentials) {
  const userId = requireCredential(credentials, "fubon_user_id");
  const account = requireCredential(credentials, "fubon_account");
  const password = requireCredential(credentials, "fubon_password");

  await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });

  const headerFrame = await waitForFrame(page, "frame1");
  await headerFrame.locator("#menu_CLN").click({ force: true });

  const landingFrame = await waitForFrame(page, "txnFrame");
  let loanStatementHref = await landingFrame
    .locator("a.task_CLNQU001.menu_CLN02")
    .first()
    .getAttribute("href");
  if (!loanStatementHref) {
    loanStatementHref = await landingFrame
      .locator("a")
      .filter({ hasText: "貸款交易" })
      .first()
      .getAttribute("href");
  }
  if (!loanStatementHref) {
    throw new Error("Could not find the loan statement navigation href.");
  }

  await landingFrame.goto(new URL(loanStatementHref, BANK_ENTRY_URL).toString(), {
    waitUntil: "domcontentloaded",
  });

  let loginFrame = await waitForFrame(page, "txnFrame");
  let visiblePasswordFields = loginFrame.locator('input[type="password"]:visible');
  if ((await visiblePasswordFields.count().catch(() => 0)) === 0) {
    await headerFrame
      .locator("a")
      .filter({ hasText: "登入" })
      .first()
      .click({ force: true });
    loginFrame = await waitForFrame(page, "txnFrame");
    visiblePasswordFields = loginFrame.locator('input[type="password"]:visible');
  }

  await visiblePasswordFields.first().waitFor({ timeout: 60_000 });

  // The bank page renders these fields as password inputs even for user ID/account.
  await visiblePasswordFields.nth(0).fill(userId);
  await visiblePasswordFields.nth(1).fill(account);
  await visiblePasswordFields.nth(2).fill(password);
  await loginFrame.locator("#m1_userCaptcha").focus();
}

async function waitForSignedInState(page: Page): Promise<void> {
  const headerFrame = await waitForFrame(page, "frame1");
  await headerFrame
    .locator("#header_form\\:header_logout")
    .waitFor({ state: "visible", timeout: 120_000 });
}

function loanForm(scope: BrowserScope): Locator {
  return scope.locator("form#form1").first();
}

function loanResultTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "交易日期" })
    .filter({ hasText: "異動金額" })
    .filter({ hasText: "餘額" })
    .first();
}

function loanDownloadLink(scope: BrowserScope): Locator {
  return scope.locator('a[title="下載"], a.download').first();
}

async function readLoanFormToken(scope: BrowserScope): Promise<string | null> {
  return await scope
    .locator('input[name="uniqueToken"]')
    .first()
    .getAttribute("value")
    .catch(() => null);
}

async function waitForLoanQueryResult(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if ((await loanDownloadLink(scope).count().catch(() => 0)) > 0) {
        return scope;
      }

      if ((await loanResultTable(scope).count().catch(() => 0)) > 0) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Timed out waiting for loan query results.");
}

async function waitForLoanQueryPostback(
  page: Page,
  previousToken: string | null,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  if (!previousToken) return await waitForLoanQueryResult(page, timeoutMs);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const currentToken = await readLoanFormToken(scope);
      if (!currentToken || currentToken === previousToken) continue;

      const hasDownloadLink =
        (await loanDownloadLink(scope).count().catch(() => 0)) > 0;
      const hasResultTable =
        (await loanResultTable(scope)
          .count()
          .catch(() => 0)) > 0;
      if (hasDownloadLink || hasResultTable) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Timed out waiting for loan query postback.");
}

async function navigateToLoanStatementsPage(page: Page): Promise<BrowserScope> {
  try {
    return await findScopeWithSelector(page, "#form1\\:loanAccountCombo", 5_000);
  } catch {
    // Continue with explicit navigation below.
  }

  const headerFrame = await waitForFrame(page, "frame1");
  await headerFrame.locator("#menu_CLN").click({ force: true });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const taskLink = scope.locator("a.task_CLNQU001.menu_CLN02").first();
      const textLink = scope
        .locator("a")
        .filter({ hasText: "貸款交易明細查詢" })
        .first();

      for (const link of [taskLink, textLink]) {
        if ((await link.count().catch(() => 0)) === 0) continue;

        const href = await link.getAttribute("href");
        if (href && href !== "#" && !href.startsWith("javascript:")) {
          await scope.goto(new URL(href, BANK_ENTRY_URL).toString(), {
            waitUntil: "domcontentloaded",
          });
        } else {
          await link.click({ force: true });
        }

        return await findScopeWithSelector(
          page,
          "#form1\\:loanAccountCombo",
          60_000,
        );
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error("Could not navigate to the loan statement page.");
}

async function openLoanStatementsPage(page: Page): Promise<BrowserScope> {
  const scope = await navigateToLoanStatementsPage(page);
  await loanForm(scope).waitFor({ state: "attached", timeout: 60_000 });
  return scope;
}

type LoanAccountOption = {
  label: string;
  value: string;
};

function requestedQueryItems(input: FubonLoanStatementsInput): QueryItem[] {
  if (input.queryItems && input.queryItems.length > 0) return input.queryItems;
  if (input.queryItem) return [input.queryItem];
  return DEFAULT_QUERY_ITEMS;
}

function hasExplicitQueryItems(input: FubonLoanStatementsInput): boolean {
  return Boolean(input.queryItem || (input.queryItems && input.queryItems.length > 0));
}

async function readLoanAccountOptions(
  scope: BrowserScope,
  filters: string[],
): Promise<LoanAccountOption[]> {
  const combo = scope.locator("#form1\\:loanAccountCombo");
  await combo.locator("option").first().waitFor({
    state: "attached",
    timeout: 60_000,
  });

  const options = combo.locator("option");
  const count = await options.count();
  const result: LoanAccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = cleanText(await option.getAttribute("value"));
    const label = cleanText(await option.textContent());
    if (!value || value === "none" || !label) continue;
    if (!matchesFilter(label, filters)) continue;
    result.push({ label, value });
  }

  if (result.length === 0) {
    throw new Error("No matching loan accounts were found.");
  }

  return result;
}

async function selectLoanAccount(
  page: Page,
  account: LoanAccountOption,
): Promise<BrowserScope> {
  let scope = await findScopeWithSelector(page, "#form1\\:loanAccountCombo");
  await waitForNoVisibleBankMask(page);

  await scope
    .locator("#form1\\:loanAccountCombo")
    .selectOption(account.value, { force: true });
  await waitForNoVisibleBankMask(page);

  return await findScopeWithSelector(page, "#form1\\:queryItemCombo");
}

async function readAvailableLoanQueryItems(
  scope: BrowserScope,
): Promise<QueryItem[]> {
  const combo = scope.locator("#form1\\:queryItemCombo");
  await combo.locator("option").first().waitFor({
    state: "attached",
    timeout: 60_000,
  });

  const options = combo.locator("option");
  const count = await options.count();
  const result: QueryItem[] = [];

  for (let index = 0; index < count; index += 1) {
    const value = cleanText(await options.nth(index).getAttribute("value"));
    const parsed = queryItemSchema.safeParse(value);
    if (parsed.success && !result.includes(parsed.data)) {
      result.push(parsed.data);
    }
  }

  return result;
}

async function configureLoanQuery(
  page: Page,
  input: FubonLoanStatementsInput,
  queryItem: QueryItem,
): Promise<BrowserScope> {
  const scope = await findScopeWithSelector(page, "#form1\\:queryItemCombo");
  const availableQueryItems = await readAvailableLoanQueryItems(scope);
  if (!availableQueryItems.includes(queryItem)) {
    throw new Error(`Loan query item is not available for this account: ${queryItem}`);
  }

  await scope
    .locator("#form1\\:queryItemCombo")
    .selectOption(queryItem, { force: true });
  await waitForNoVisibleBankMask(page);

  if (input.dateRange) {
    await scope
      .locator('input.queryPeriod[value="custom"]')
      .check({ force: true });
    await scope.locator("#form1\\:startDate").fill(input.dateRange.startDate);
    await scope.locator("#form1\\:endDate").fill(input.dateRange.endDate);
  } else {
    await scope.locator('input.queryPeriod[value="quick"]').check({
      force: true,
    });
    await scope
      .locator(`input.quickKind[value="${input.quickMonths}"]`)
      .check({ force: true });
  }

  return scope;
}

async function runLoanQuery(page: Page): Promise<BrowserScope> {
  const scope = await findScopeWithSelector(page, "#form1\\:doValidate");
  const previousToken = await readLoanFormToken(scope);
  await scope.locator("#form1\\:doValidate").click({ force: true });

  return await waitForLoanQueryPostback(page, previousToken);
}

async function downloadLoanStatement(
  page: Page,
  loanAccount: string,
  queryItem: z.infer<typeof queryItemSchema>,
  downloadFormat: "TXT" | "EXCEL" | "PDF",
) {
  const scope = await findScopeWithSelector(page, 'a[title="下載"], a.download');
  await loanDownloadLink(scope).click({ force: true });

  const formatOption = scope.locator(
    `input[name="download_format"][value="${downloadFormat}"]`,
  );
  await formatOption.waitFor({ state: "attached", timeout: 30_000 });
  await formatOption.check({ force: true });

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await scope.locator("a.confirm").first().click({ force: true });
  const download = await downloadPromise;

  const downloadsDir = join(process.cwd(), "downloads", "fubon-loan-statements");
  await mkdir(downloadsDir, { recursive: true });

  const filename = download.suggestedFilename();
  const path = join(
    downloadsDir,
    `${Date.now()}-${safeFilename(loanAccount)}-${safeFilename(queryItem)}-${safeFilename(filename)}`,
  );
  await download.saveAs(path);

  const fileStat = await stat(path);
  const converted =
    downloadFormat === "EXCEL" ? await convertXlsToCsv(path) : undefined;
  return { filename, path, bytes: fileStat.size, ...converted };
}

export async function runFubonLoanStatements(
  page: Page,
  input: FubonLoanStatementsInput,
): Promise<FubonLoanStatementsOutput> {
  let scope = await openLoanStatementsPage(page);
  const loanAccounts = await readLoanAccountOptions(
    scope,
    input.loanAccountLabels,
  );
  const queryItems = requestedQueryItems(input);
  const explicitQueryItems = hasExplicitQueryItems(input);

  const downloads: FubonLoanStatementsOutput["downloads"] = [];
  const skippedAccounts: FubonLoanStatementsOutput["skippedAccounts"] = [];

  for (const account of loanAccounts) {
    scope = await selectLoanAccount(page, account);
    const availableQueryItems = await readAvailableLoanQueryItems(scope);
    const accountQueryItems = queryItems.filter((queryItem) =>
      availableQueryItems.includes(queryItem),
    );
    const unavailableQueryItems = queryItems.filter(
      (queryItem) => !availableQueryItems.includes(queryItem),
    );

    if (explicitQueryItems) {
      for (const queryItem of unavailableQueryItems) {
        const reason = `Loan query item is not available for this account: ${queryItem}`;
        console.warn("loan-query-skipped", {
          loanAccount: account.label,
          queryItem,
          reason,
        });
        skippedAccounts.push({
          loanAccount: account.label,
          queryItem,
          reason,
        });
      }
    }

    if (accountQueryItems.length === 0) {
      const queryItem = queryItems[0];
      const reason = "No requested loan query items are available for this account.";
      console.warn("loan-query-skipped", {
        loanAccount: account.label,
        queryItem,
        reason,
      });
      skippedAccounts.push({
        loanAccount: account.label,
        queryItem,
        reason,
      });
      continue;
    }

    for (const queryItem of accountQueryItems) {
      try {
        scope = await configureLoanQuery(page, input, queryItem);
        scope = await runLoanQuery(page);
        await loanDownloadLink(scope).waitFor({
          state: "attached",
          timeout: 60_000,
        });
        const download = await downloadLoanStatement(
          page,
          account.label,
          queryItem,
          input.downloadFormat,
        );
        downloads.push({
          loanAccount: account.label,
          queryItem,
          ...download,
        });
      } catch (error) {
        console.warn("loan-query-skipped", {
          loanAccount: account.label,
          queryItem,
          reason: error instanceof Error ? error.message : String(error),
        });
        skippedAccounts.push({
          loanAccount: account.label,
          queryItem,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (downloads.length === 0 && skippedAccounts.length > 0) {
    throw new Error(
      `No loan statements were downloaded. First skipped account reason: ${skippedAccounts[0].reason}`,
    );
  }

  return {
    queryItems,
    period: input.dateRange
      ? {
          mode: "custom" as const,
          startDate: input.dateRange.startDate,
          endDate: input.dateRange.endDate,
        }
      : {
          mode: "quick" as const,
          quickMonths: input.quickMonths,
        },
    downloadFormat: input.downloadFormat,
    count: downloads.length,
    downloads,
    skippedAccounts,
  };
}

export default workflow("fubonLoanStatements", {
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page, session } = ctx;
    const credentials = (input as typeof input & { credentials: FubonCredentials })
      .credentials;

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await fillLoanLoginForm(page, credentials);

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
    return await runFubonLoanStatements(page, input);
  },
});
