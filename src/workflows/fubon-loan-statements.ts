import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import {
  activateControlWithoutPointer,
  fillInputWithoutPointer,
  selectOptionWithoutPointer,
} from "./browser-interaction.ts";
import { completeFubonHumanLogin, openFubonLoginForm } from "./fubon-auth.ts";
// completeFubonHumanLogin owns emitHumanAssistanceStage with initialZoom: 1.15.
import { fetchFormPostbackHtml, replaceDocumentHtml } from "./form-postback.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";

const BANK_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";

type BrowserScope = Page | Frame;

const LOAN_ACCOUNT_SELECTOR = "#form1\\:loanAccountCombo";
const LOAN_FORM_SELECTOR = "form#form1";
const LOAN_NAVIGATION_ERROR = "Could not navigate to the loan statement page.";

export type LoanNavigationOptions = Readonly<{
  existingScopeTimeoutMs?: number;
  formReadyTimeoutMs?: number;
  retryFormReadyTimeoutMs?: number;
  navigationControlTimeoutMs?: number;
  navigationLinkTimeoutMs?: number;
}>;

const DEFAULT_LOAN_NAVIGATION_OPTIONS: Required<LoanNavigationOptions> = {
  existingScopeTimeoutMs: 5_000,
  formReadyTimeoutMs: 30_000,
  retryFormReadyTimeoutMs: 5_000,
  navigationControlTimeoutMs: 5_000,
  navigationLinkTimeoutMs: 30_000,
};

type LoanNavigationStage =
  | "loan-existing-form-probe"
  | "loan-link-resolve"
  | "loan-menu-trigger"
  | "loan-form-ready";

type LoanNavigationStageStatus = "start" | "success" | "timeout" | "failure";

function logLoanNavigationStage(
  stage: LoanNavigationStage,
  status: LoanNavigationStageStatus,
): void {
  console.log(stage, { status });
}

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

const DEFAULT_QUERY_ITEMS: QueryItem[] = ["TRANSACTION_DETAIL_QUERY"];
const SUPPORTED_NORMALIZED_QUERY_ITEM: QueryItem = "TRANSACTION_DETAIL_QUERY";

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
      loanAccountId: z.string(),
      loanAccount: z.string(),
      queryItem: queryItemSchema,
      queryPeriod: z.string(),
      branchName: z.string(),
      accountType: z.string(),
      currency: z.string(),
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

type LoanPeriod = FubonLoanStatementsOutput["period"];

let lastTimestamp = 0;

type ParsedLoanStatement = {
  loanAccount: string;
  loanAccountId: string;
  queryPeriod: string;
  branchName: string;
  accountType: string;
  currency: string;
  rows: string[][];
};

const loanHeaders = [
  "交易日期",
  "交易內容",
  "異動金額",
  "利率",
  "計息起日",
  "計息止日",
  "餘額",
  "備註",
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

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
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

function loanAccountIdFor(loanAccount: string, fallback: string): string {
  const loanAccountPrefix = loanAccount.split(/[（(]/)[0] ?? loanAccount;
  const fallbackPrefix = fallback.split(/[（(]/)[0] ?? fallback;
  return (
    digitsOnly(loanAccountPrefix) ||
    digitsOnly(fallbackPrefix) ||
    safeFilename(fallback)
  );
}

function loanRowSortTime(row: string[]): number | null {
  const match = cleanText(row[0]).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) return null;

  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isFinite(time) ? time : null;
}

function compareLoanRowsByTransactionDateDesc(
  left: string[],
  right: string[],
): number {
  const leftTime = loanRowSortTime(left);
  const rightTime = loanRowSortTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return rightTime - leftTime;
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
      if (await waitForLoanAttached(locator, deadline)) return scope;
      if (Date.now() >= deadline) break;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find selector "${selector}" in any frame.`);
}

function scopesForLoanNavigation(page: Page): BrowserScope[] {
  const scopes: BrowserScope[] = [page];
  const currentTransactionFrame = page.frame({ name: "txnFrame" });
  if (currentTransactionFrame) scopes.push(currentTransactionFrame);

  for (const frame of page.frames()) {
    if (frame !== currentTransactionFrame) scopes.push(frame);
  }

  return scopes;
}

async function waitForLoanAttached(
  locator: Locator,
  deadline: number,
  probeSliceMs = 250,
): Promise<boolean> {
  const remainingMs = deadline - Date.now();
  const timeoutMs = Math.min(probeSliceMs, remainingMs);
  if (timeoutMs <= 0) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await locator.first().waitFor({
      state: "attached",
      timeout: timeoutMs,
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function hasLoanForm(
  scope: BrowserScope,
  deadline: number,
): Promise<boolean> {
  const combo = scope.locator(LOAN_ACCOUNT_SELECTOR).first();
  if (!(await waitForLoanAttached(combo, deadline))) return false;

  const form = scope.locator(LOAN_FORM_SELECTOR).first();
  return await waitForLoanAttached(form, deadline);
}

async function findLoanFormScope(
  page: Page,
  timeoutMs: number,
  stage: Exclude<
    LoanNavigationStage,
    "loan-link-resolve" | "loan-menu-trigger"
  >,
): Promise<BrowserScope> {
  logLoanNavigationStage(stage, "start");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    for (const scope of scopesForLoanNavigation(page)) {
      if (await hasLoanForm(scope, deadline)) {
        logLoanNavigationStage(stage, "success");
        return scope;
      }
      if (Date.now() >= deadline) break;
    }

    if (Date.now() >= deadline) break;
    await page.waitForTimeout(
      Math.min(250, Math.max(1, deadline - Date.now())),
    );
  }

  logLoanNavigationStage(stage, "timeout");
  throw new Error(
    `Could not find selector "${LOAN_ACCOUNT_SELECTOR}" in any frame.`,
  );
}

async function findLoanNavigationLink(
  page: Page,
  timeoutMs: number,
): Promise<Locator> {
  logLoanNavigationStage("loan-link-resolve", "start");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    for (const scope of scopesForLoanNavigation(page)) {
      const taskLink = scope.locator("a.task_CLNQU001.menu_CLN02").first();
      if (await waitForLoanAttached(taskLink, deadline)) {
        logLoanNavigationStage("loan-link-resolve", "success");
        return taskLink;
      }
      if (Date.now() >= deadline) break;

      const textLink = scope
        .locator("a")
        .filter({ hasText: "貸款交易明細查詢" })
        .first();
      if (await waitForLoanAttached(textLink, deadline)) {
        logLoanNavigationStage("loan-link-resolve", "success");
        return textLink;
      }
      if (Date.now() >= deadline) break;
    }

    if (Date.now() >= deadline) break;
    await page.waitForTimeout(
      Math.min(250, Math.max(1, deadline - Date.now())),
    );
  }

  logLoanNavigationStage("loan-link-resolve", "timeout");
  throw new Error("Could not find the loan statement navigation control.");
}

async function activateLoanControlWithTimeout(
  locator: Locator,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const action = activateControlWithoutPointer(locator, {
    signal: controller.signal,
    timeout: 0,
  });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(0, timeoutMs),
  );

  try {
    await action;
    if (timedOut) {
      throw new Error("Loan navigation control timed out.");
    }
  } catch (error) {
    if (timedOut) {
      throw new Error("Loan navigation control timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
      if (await waitForLoanAttached(locator, deadline)) return scope;
      if (Date.now() >= deadline) break;
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
        if (
          await masks
            .nth(index)
            .isVisible()
            .catch(() => false)
        ) {
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

async function openLoanLoginForm(page: Page) {
  await openFubonLoginForm(page);
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

export async function navigateToLoanStatementsPage(
  page: Page,
  options: LoanNavigationOptions = {},
): Promise<BrowserScope> {
  const timings = {
    ...DEFAULT_LOAN_NAVIGATION_OPTIONS,
    ...options,
  };

  // A previous statement component may already have left the loan form in a
  // live frame. Reuse that DOM before triggering another bank redirect.
  try {
    return await findLoanFormScope(
      page,
      timings.existingScopeTimeoutMs,
      "loan-existing-form-probe",
    );
  } catch {
    // Continue with the bounded navigation trigger below.
  }

  logLoanNavigationStage("loan-menu-trigger", "start");
  try {
    const headerFrame = await waitForFrame(
      page,
      "frame1",
      timings.navigationLinkTimeoutMs,
    );
    await activateLoanControlWithTimeout(
      headerFrame.locator("#menu_CLN"),
      timings.navigationControlTimeoutMs,
    );
    logLoanNavigationStage("loan-menu-trigger", "success");
  } catch {
    logLoanNavigationStage("loan-menu-trigger", "failure");
    // The transaction frame can already be on the target page. In that case
    // the link trigger is unnecessary, and the readiness probe below is the
    // source of truth.
  }

  let navigationLink: Locator | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!navigationLink) {
      navigationLink = await findLoanNavigationLink(
        page,
        timings.navigationLinkTimeoutMs,
      ).catch(() => undefined);
    }

    if (navigationLink) {
      try {
        // Trigger the bank-owned redirect through the current DOM. Directly
        // navigating the frame loses the 302 hand-off and can wait forever for
        // a destination document that the bank never exposes.
        await activateLoanControlWithTimeout(
          navigationLink,
          timings.navigationControlTimeoutMs,
        );
      } catch {
        // A timed-out trigger is not proof that the redirect failed. Probe the
        // current DOM before the single controlled retry.
      }
    }

    try {
      return await findLoanFormScope(
        page,
        attempt === 0
          ? timings.formReadyTimeoutMs
          : timings.retryFormReadyTimeoutMs,
        "loan-form-ready",
      );
    } catch {
      if (attempt === 0) {
        // Re-resolve the link once in case the first trigger replaced the
        // transaction frame. The loop allows exactly one retry/fallback.
        navigationLink = undefined;
      }
    }
  }

  throw new Error(LOAN_NAVIGATION_ERROR);
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
  const requested =
    input.queryItems && input.queryItems.length > 0
      ? input.queryItems
      : input.queryItem
        ? [input.queryItem]
        : DEFAULT_QUERY_ITEMS;
  const unsupported = requested.filter(
    (queryItem) => queryItem !== SUPPORTED_NORMALIZED_QUERY_ITEM,
  );
  if (unsupported.length > 0) {
    throw new Error(
      `fubon-loan-statements normalized output only supports ${SUPPORTED_NORMALIZED_QUERY_ITEM}; unsupported query items: ${unsupported.join(
        ", ",
      )}`,
    );
  }

  return requested;
}

function hasExplicitQueryItems(input: FubonLoanStatementsInput): boolean {
  return Boolean(
    input.queryItem || (input.queryItems && input.queryItems.length > 0),
  );
}

function describeLoanPeriod(input: FubonLoanStatementsInput): LoanPeriod {
  return input.dateRange
    ? {
        mode: "custom" as const,
        startDate: input.dateRange.startDate,
        endDate: input.dateRange.endDate,
      }
    : {
        mode: "quick" as const,
        quickMonths: input.quickMonths,
      };
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function addMonthsClamped(date: Date, months: number): Date {
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth() + months;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(targetYear, targetMonth, Math.min(date.getDate(), lastDay));
}

function loanQueryPeriod(input: FubonLoanStatementsInput): string {
  if (input.dateRange) {
    return `${input.dateRange.startDate}~${input.dateRange.endDate}`;
  }

  const today = new Date();
  const endDate = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const startDate = addMonthsClamped(endDate, -Number(input.quickMonths));
  return `${formatDate(startDate)}~${formatDate(endDate)}`;
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
    throw new StatementComponentAbsentError(
      "No Fubon loan account is available for this login.",
    );
  }

  return result;
}

async function selectLoanAccount(
  page: Page,
  account: LoanAccountOption,
): Promise<BrowserScope> {
  let scope = await findScopeWithSelector(page, "#form1\\:loanAccountCombo");
  await waitForNoVisibleBankMask(page);

  await selectOptionWithoutPointer(
    scope.locator("#form1\\:loanAccountCombo"),
    account.value,
  );
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
    throw new Error(
      `Loan query item is not available for this account: ${queryItem}`,
    );
  }

  await selectOptionWithoutPointer(
    scope.locator("#form1\\:queryItemCombo"),
    queryItem,
  );
  await waitForNoVisibleBankMask(page);

  if (input.dateRange) {
    await activateControlWithoutPointer(
      scope.locator('input.queryPeriod[value="custom"]'),
    );
    await fillInputWithoutPointer(
      scope.locator("#form1\\:startDate"),
      input.dateRange.startDate,
    );
    await fillInputWithoutPointer(
      scope.locator("#form1\\:endDate"),
      input.dateRange.endDate,
    );
  } else {
    await activateControlWithoutPointer(
      scope.locator('input.queryPeriod[value="quick"]'),
    );
    await activateControlWithoutPointer(
      scope.locator(`input.quickKind[value="${input.quickMonths}"]`),
    );
  }

  return scope;
}

async function parseLoanStatementHtml(
  page: Page,
  html: string,
  fallbackLoanAccount: string,
  input: FubonLoanStatementsInput,
): Promise<ParsedLoanStatement> {
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
      const tableRows = Array.from(doc.querySelectorAll("table"))
        .map((table) =>
          Array.from(table.querySelectorAll("tr")).map((row) => cellsFor(row)),
        )
        .find((rows) =>
          rows.some((row) =>
            headers.every((header, index) =>
              clean(row[index]).includes(header),
            ),
          ),
        );
      if (!tableRows) {
        throw new Error("Loan query response is missing the result table.");
      }

      const headerRowIndex = tableRows.findIndex((row) =>
        headers.every((header, index) => clean(row[index]).includes(header)),
      );
      const rows = tableRows
        .slice(headerRowIndex + 1)
        .map((row) => headers.map((_, index) => clean(row[index])))
        .filter((row) => /^\d{4}\/\d{2}\/\d{2}$/.test(row[0]));
      const metadataRows = Array.from(doc.querySelectorAll("table"))
        .map((table) =>
          Array.from(table.querySelectorAll("tr")).map((row) => cellsFor(row)),
        )
        .find(
          (rows) =>
            rows.some((row) => row.includes("分行名稱")) &&
            rows.some((row) => row.includes("幣別")),
        );
      const metadataValue = (label: string) => {
        for (const row of metadataRows ?? []) {
          const index = row.findIndex((cell) => clean(cell) === label);
          if (index !== -1) return clean(row[index + 1]);
        }
        return "";
      };

      return {
        accountType: metadataValue("帳號類別"),
        branchName: metadataValue("分行名稱"),
        currency: metadataValue("幣別"),
        rows,
      };
    },
    { html, headers: loanHeaders },
  )) as {
    accountType: string;
    branchName: string;
    currency: string;
    rows: string[][];
  };

  return {
    loanAccount: fallbackLoanAccount,
    loanAccountId: loanAccountIdFor(fallbackLoanAccount, fallbackLoanAccount),
    queryPeriod: loanQueryPeriod(input),
    branchName: parsed.branchName,
    accountType: parsed.accountType,
    currency: parsed.currency,
    rows: parsed.rows,
  };
}

async function fetchLoanQueryHtml(page: Page): Promise<string> {
  const scope = await findScopeWithSelector(page, "#form1\\:doValidate");
  const html = await fetchFormPostbackHtml(
    scope.locator("form").first(),
    "form1:doValidate",
  );
  await replaceDocumentHtml(scope, html);
  await findScopeWithLocator(page, loanResultTable, "loan result table");

  return html;
}

async function writeLoanStatementFiles(
  page: Page,
  html: string,
  loanAccount: string,
  queryItem: z.infer<typeof queryItemSchema>,
  input: FubonLoanStatementsInput,
): Promise<FubonLoanStatementsOutput["downloads"][number]> {
  const parsed = await parseLoanStatementHtml(page, html, loanAccount, input);

  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "fubon-loan-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `loan-${safeFilename(parsed.loanAccountId)}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const rows = parsed.rows.slice().sort(compareLoanRowsByTransactionDateDesc);

  await writeFile(csvPath, rowsToCsv([loanHeaders, ...rows]), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        貸款帳號: parsed.loanAccount,
        查詢期間: parsed.queryPeriod,
        分行名稱: parsed.branchName,
        帳號類別: parsed.accountType,
        幣別: parsed.currency,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);

  return {
    loanAccountId: parsed.loanAccountId,
    loanAccount: parsed.loanAccount,
    queryItem,
    queryPeriod: parsed.queryPeriod,
    branchName: parsed.branchName,
    accountType: parsed.accountType,
    currency: parsed.currency,
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

export async function runFubonLoanStatements(
  page: Page,
  input: FubonLoanStatementsInput,
): Promise<FubonLoanStatementsOutput> {
  if (input.downloadFormat !== "EXCEL") {
    throw new Error(
      'fubon-loan-statements normalized output currently supports downloadFormat="EXCEL" only.',
    );
  }

  let scope = await openLoanStatementsPage(page);
  const loanAccounts = await readLoanAccountOptions(
    scope,
    input.loanAccountLabels,
  );
  const queryItems = requestedQueryItems(input);
  const explicitQueryItems = hasExplicitQueryItems(input);
  const period = describeLoanPeriod(input);

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
      const reason =
        "No requested loan query items are available for this account.";
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
      scope = await configureLoanQuery(page, input, queryItem);
      const html = await fetchLoanQueryHtml(page);
      const download = await writeLoanStatementFiles(
        page,
        html,
        account.label,
        queryItem,
        input,
      );
      downloads.push(download);
    }
  }

  if (downloads.length === 0 && skippedAccounts.length > 0) {
    throw new StatementComponentAbsentError(
      `No Fubon loan statement query is available. First skipped account reason: ${skippedAccounts[0].reason}`,
    );
  }

  return {
    queryItems,
    period,
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
    const credentials = (
      input as typeof input & { credentials: FubonCredentials }
    ).credentials;

    const values = {
      userId: requireCredential(credentials, "fubon_user_id"),
      account: requireCredential(credentials, "fubon_account"),
      password: requireCredential(credentials, "fubon_password"),
    };
    await openLoanLoginForm(page);
    await completeFubonHumanLogin(page, session, values);
    return await runFubonLoanStatements(page, input);
  },
});
