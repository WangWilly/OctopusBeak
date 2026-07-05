import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Page } from "playwright";
import { z } from "zod";

const LOGIN_URL = "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx";
const TRANSACTION_URL =
  "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx";
const ACCOUNT_ENDPOINT = "/ws/bank/transdetail/ws_debitacct.ashx";
const TRANSACTION_ENDPOINT = "/ws/bank/transdetail/ws_transdetailMerge.ashx";

const statementHeaders = [
  "帳務日期",
  "交易日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
  "匯率",
];

const dateSchema = z.string().regex(/^\d{8}$/);

const inputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
});

const downloadSchema = z.object({
  accountId: z.string(),
  account: z.string(),
  currency: z.string(),
  kind: z.enum(["domestic", "foreign"]),
  queryPeriods: z.array(z.string()),
  baseName: z.string(),
  csvFilename: z.string(),
  csvPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonFilename: z.string(),
  jsonPath: z.string(),
  jsonBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: z.object({
    startDate: dateSchema,
    endDate: dateSchema,
  }),
  count: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  downloads: z.array(downloadSchema),
});

type SinopacCredentials = {
  sinopac_user_id?: string;
  sinopac_account?: string;
  sinopac_password?: string;
};

type Input = z.infer<typeof inputSchema> & {
  credentials: SinopacCredentials;
};

type DateRange = {
  startDate: string;
  endDate: string;
};

type SinopacDownload = z.infer<typeof downloadSchema>;

type SinopacAccount = {
  DataText?: string;
  DataValue?: string;
  DisplayText?: string;
};

type SinopacAccountResponse = {
  Header?: string;
  Message?: string;
  SubInfo?: SinopacAccount[];
};

type SinopacTransactionResponse = {
  Header?: string;
  Message?: string;
  MaxMonth?: string;
  RecordCount?: string;
  SubInfo?: SinopacRawTransactionRow[];
};

type SinopacRawTransactionRow = {
  DataText1?: string;
  DataText2?: string;
  DataText3?: string;
  DataText4?: string;
  DataText5?: string;
  DataText6?: string;
  DataText7?: string;
  DataText8?: string;
  DataText9?: string;
  DataText10?: string;
  DataText11?: string;
};

export type SinopacStatementRow = {
  sortKey: string;
  values: string[];
};

let lastTimestamp = 0;

function requireCredential(
  credentials: SinopacCredentials,
  name: keyof SinopacCredentials,
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
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function dateFromYYYYMMDD(value: string): Date {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) throw new Error(`Invalid date: ${value}`);
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
}

function formatYYYYMMDD(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

function formatSlashDate(value: string): string {
  return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

function defaultEndDate(): string {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
}

function resolveDateRange(input: z.infer<typeof inputSchema>): DateRange {
  const endDate = input.endDate ?? defaultEndDate();
  const startDate =
    input.startDate ??
    formatYYYYMMDD(addDays(addMonths(dateFromYYYYMMDD(endDate), -12), 1));
  if (dateFromYYYYMMDD(startDate) > dateFromYYYYMMDD(endDate)) {
    throw new Error("startDate must be on or before endDate.");
  }
  return { startDate, endDate };
}

export function sinopacQueryWindows(
  dateRange: DateRange,
  maxMonths = 3,
): DateRange[] {
  const firstStart = dateFromYYYYMMDD(dateRange.startDate);
  let end = dateFromYYYYMMDD(dateRange.endDate);
  const windows: DateRange[] = [];

  while (end >= firstStart) {
    const maxStart = addMonths(end, -maxMonths);
    const start = maxStart > firstStart ? maxStart : firstStart;
    windows.push({
      startDate: formatYYYYMMDD(start),
      endDate: formatYYYYMMDD(end),
    });
    if (formatYYYYMMDD(start) === dateRange.startDate) break;
    end = start;
  }

  return windows;
}

function splitDateTime(value: string): { date: string; time: string } {
  const text = cleanText(value);
  const match = text.match(/^(\d{4}\/\d{2}\/\d{2})(?:\s+(.+))?$/);
  return {
    date: match?.[1] ?? text,
    time: match?.[2] ?? "",
  };
}

function amountColumns(value: string | undefined): [string, string] {
  const amount = cleanText(value).replace(/^\+/, "");
  if (!amount) return ["", ""];
  if (amount.startsWith("-")) return [amount.slice(1), ""];
  return ["", amount];
}

function compareRowsDesc(left: SinopacStatementRow, right: SinopacStatementRow) {
  return right.sortKey.localeCompare(left.sortKey);
}

function dedupeRows(rows: SinopacStatementRow[]): SinopacStatementRow[] {
  return Array.from(
    new Map(rows.map((row) => [row.values.join("\u001f"), row])).values(),
  ).sort(compareRowsDesc);
}

export function sinopacApiRowsToStatementRows(
  rows: SinopacRawTransactionRow[],
): SinopacStatementRow[] {
  return rows
    .filter((row) => cleanText(row.DataText1) || cleanText(row.DataText3))
    .map((row) => {
      const transaction = splitDateTime(row.DataText1 ?? "");
      const [withdrawal, deposit] = amountColumns(row.DataText4);
      const values = [
        transaction.date,
        cleanText(row.DataText2),
        transaction.time,
        cleanText(row.DataText3),
        withdrawal,
        deposit,
        cleanText(row.DataText5),
        cleanText(row.DataText8),
        cleanText(row.DataText7),
      ];
      return {
        sortKey: `${values[0]} ${values[2]}`,
        values,
      };
    });
}

export function sinopacStatementRowsToCsv(rows: SinopacStatementRow[]): string {
  return rowsToCsv([statementHeaders, ...rows.map((row) => row.values)]);
}

function accountLabel(account: SinopacAccount): string {
  return cleanText(account.DataText);
}

function accountId(account: SinopacAccount): string {
  return cleanText(account.DataValue);
}

function accountCurrency(account: SinopacAccount): string {
  return cleanText(account.DisplayText).toUpperCase();
}

function matchesFilters(account: SinopacAccount, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const haystack =
    `${accountLabel(account)} ${accountId(account)}`.toLowerCase();
  return filters.some((filter) => haystack.includes(filter.toLowerCase()));
}

function filterAccounts(
  accounts: SinopacAccount[],
  accountFilters: string[],
  currencyFilters: string[],
): SinopacAccount[] {
  const currencies = new Set(
    currencyFilters.map((currency) => currency.toUpperCase()),
  );
  return accounts.filter((account) => {
    const currency = accountCurrency(account);
    return (
      accountId(account) &&
      accountLabel(account) &&
      matchesFilters(account, accountFilters) &&
      (currencies.size === 0 || currencies.has(currency))
    );
  });
}

function accountListFromResponse(response: SinopacAccountResponse[]): SinopacAccount[] {
  const result = response[0];
  if (result?.Header !== "SUCCESS") {
    throw new Error(
      `SinoPac account list failed: ${result?.Message ?? "unknown"}`,
    );
  }
  return result.SubInfo ?? [];
}

function queryPeriod(dateRange: DateRange): string {
  return `${formatSlashDate(dateRange.startDate)} ~ ${formatSlashDate(dateRange.endDate)}`;
}

export function sinopacSignedInPageUrl(href: string): boolean {
  return href.startsWith("https://mma.sinopac.com/mma/");
}

async function isSignedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (!sinopacSignedInPageUrl(url)) return false;
  return await page
    .locator('a#user-logout:visible, a[href*="MMALogout"]:visible')
    .isVisible()
    .catch(() => false);
}

async function waitForSignedInState(page: Page): Promise<void> {
  await page.waitForURL((url) => sinopacSignedInPageUrl(url.href), {
    timeout: 300_000,
  });
  await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
  await page
    .locator('a#user-logout, a[href*="MMALogout"]')
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
}

export function sinopacManualAuthMessage(session: string): string {
  return (
    "manual-auth-required: enter the SinoPac CAPTCHA in the browser, then run `npx libretto resume --session " +
    session +
    "`."
  );
}

export function sinopacPasswordExpiryNoticeDismissTargets(): string[] {
  return [
    'a:has-text("延用舊密碼"):visible',
    'button:has-text("延用舊密碼"):visible',
    'input[value*="延用舊密碼"]:visible',
    "a.close_x.close:visible",
    ".close_x.close:visible",
  ];
}

async function clickLoginButton(page: Page): Promise<void> {
  const visibleButton = page.locator("#MMA_Login");
  if (await visibleButton.isVisible().catch(() => false)) {
    await visibleButton.click();
    return;
  }
  await page.locator('input[alt="登入"]').click({ force: true });
}

async function dismissPasswordExpiryNotice(page: Page): Promise<void> {
  for (const selector of sinopacPasswordExpiryNoticeDismissTargets()) {
    const dismiss = page.locator(selector).first();
    if (await dismiss.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await dismiss.click();
      await dismiss.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(
        () => {},
      );
      return;
    }
  }
}

async function fillLoginForm(
  page: Page,
  credentials: SinopacCredentials,
): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator("form#aspnetForm").waitFor({ timeout: 60_000 });

  const loginInputs = page.locator("input.selectable:visible, input.tips:visible");

  await loginInputs.first().fill(requireCredential(credentials, "sinopac_user_id"));
  await loginInputs.nth(1).fill(
    requireCredential(credentials, "sinopac_account"),
  );
  await loginInputs.nth(2).fill(
    requireCredential(credentials, "sinopac_password"),
  );
  const captcha = page
    .locator('input[placeholder="驗證碼"], input[id$="sino_keyword3"]')
    .first();
  await captcha.fill("");
  await captcha.focus();
}

async function signInSinopac(
  ctx: LibrettoWorkflowContext,
  credentials: SinopacCredentials,
): Promise<void> {
  const { page, session } = ctx;
  await fillLoginForm(page, credentials);

  console.log(sinopacManualAuthMessage(session));
  await pause(session);
  if (await isSignedIn(page)) return;

  const captcha = page
    .locator('input[placeholder="驗證碼"], input[id$="sino_keyword3"]')
    .first();
  if (!(await captcha.inputValue()).trim()) {
    throw new Error(
      "SinoPac CAPTCHA is empty. Enter it in the browser before resuming.",
    );
  }
  await clickLoginButton(page);
  await waitForSignedInState(page);
  await dismissPasswordExpiryNotice(page);
}

async function openTransactionPage(page: Page): Promise<SinopacAccount[]> {
  const accountResponse = page
    .waitForResponse(
      (response) =>
        response.url().includes(ACCOUNT_ENDPOINT) &&
        response.request().method() === "POST",
      { timeout: 60_000 },
    )
    .then(async (response) => (await response.json()) as SinopacAccountResponse[]);
  const detailLink = page
    .locator('a[title="往來明細"], a[href*="mma_transdetail"]')
    .first();
  if (await detailLink.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await detailLink.click();
  } else {
    await page.goto(TRANSACTION_URL, { waitUntil: "domcontentloaded" });
  }
  await page.locator("#StartDate").waitFor({ state: "visible", timeout: 60_000 });
  return accountListFromResponse(await accountResponse);
}

class SinopacApiClient {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  private async postJson<T>(path: string, body: URLSearchParams): Promise<T> {
    return (await this.page.evaluate(
      async ({ path, bodyText }) => {
        type BrowserXhr = {
          open(method: string, url: string, async: boolean): void;
          setRequestHeader(name: string, value: string): void;
          send(body: string): void;
          onload: (() => void) | null;
          onerror: (() => void) | null;
          status: number;
          responseText: string;
        };
        const Xhr = (globalThis as unknown as {
          XMLHttpRequest: new () => BrowserXhr;
        }).XMLHttpRequest;
        return await new Promise((resolve, reject) => {
          const request = new Xhr();
          request.open("POST", path, true);
          request.setRequestHeader(
            "Accept",
            "application/json, text/javascript, */*; q=0.01",
          );
          request.setRequestHeader(
            "Content-Type",
            "application/x-www-form-urlencoded; charset=UTF-8",
          );
          request.setRequestHeader("X-Requested-With", "XMLHttpRequest");
          request.onload = () => {
            if (request.status < 200 || request.status >= 300) {
              reject(new Error(`${request.status} for ${path}`));
              return;
            }
            try {
              resolve(JSON.parse(request.responseText));
            } catch (error) {
              reject(error);
            }
          };
          request.onerror = () => reject(new Error(`Network error for ${path}`));
          request.send(bodyText);
        });
      },
      { path, bodyText: body.toString() },
    )) as T;
  }

  async fetchAccounts(dateRange: DateRange): Promise<SinopacAccount[]> {
    const endDate = dateFromYYYYMMDD(dateRange.endDate);
    const body = new URLSearchParams({
      Acct: "",
      AcctValue: "",
      CurrName: "",
      QueryType: "",
      AcctName: "",
      Curr: "",
      TextType: "",
      BusinessDate: dateRange.endDate,
      StartDate: formatYYYYMMDD(addMonths(endDate, -1)),
      EndDate: dateRange.endDate,
    });
    const response = await this.postJson<SinopacAccountResponse[]>(
      `${ACCOUNT_ENDPOINT}?${Date.now()}`,
      body,
    );
    const result = response[0];
    if (result?.Header !== "SUCCESS") {
      throw new Error(
        `SinoPac account list failed: ${result?.Message ?? "unknown"}`,
      );
    }
    return result.SubInfo ?? [];
  }

  async fetchTransactions(
    account: SinopacAccount,
    dateRange: DateRange,
    businessDate: string,
  ): Promise<SinopacTransactionResponse> {
    const body = new URLSearchParams({
      Acct: accountLabel(account),
      AcctValue: accountId(account),
      CurrName: "",
      QueryType: "3",
      AcctName: "",
      Curr: accountCurrency(account),
      TextType: "",
      BusinessDate: businessDate,
      StartDate: dateRange.startDate,
      EndDate: dateRange.endDate,
    });
    const response = await this.postJson<SinopacTransactionResponse[]>(
      `${TRANSACTION_ENDPOINT}?${Date.now()}`,
      body,
    );
    const result = response[0];
    if (!result) throw new Error("SinoPac transaction response was empty.");
    if (result.Header === "FAIL" && result.Message === "查無資料") return result;
    if (result.Header !== "SUCCESS") {
      throw new Error(`SinoPac transactions failed: ${result.Message ?? "unknown"}`);
    }
    return result;
  }
}

async function writeStatementFiles(
  account: SinopacAccount,
  queryPeriods: string[],
  rows: SinopacStatementRow[],
): Promise<SinopacDownload> {
  const currency = accountCurrency(account);
  const kind = currency === "TWD" ? "domestic" : "foreign";
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    kind === "domestic" ? "sinopac-statements" : "sinopac-foreign-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${safeFilename(accountId(account))}-${currency}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);

  await writeFile(csvPath, sinopacStatementRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: accountLabel(account),
        查詢期間: queryPeriods,
        分行名稱: "",
        幣別: currency,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    accountId: accountId(account),
    account: accountLabel(account),
    currency,
    kind,
    queryPeriods,
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

async function downloadSinopacStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
  initialAccounts?: SinopacAccount[],
): Promise<z.infer<typeof outputSchema>> {
  const dateRange = resolveDateRange(input);
  const windows = sinopacQueryWindows(dateRange);
  const apiClient = new SinopacApiClient(page);
  const accounts = filterAccounts(
    initialAccounts ?? (await apiClient.fetchAccounts(dateRange)),
    input.accountFilters,
    input.currencyFilters,
  );

  if (accounts.length === 0) {
    throw new Error("No SinoPac accounts matched accountFilters/currencyFilters.");
  }

  const downloads: SinopacDownload[] = [];
  for (const account of accounts) {
    const rows: SinopacStatementRow[] = [];
    for (const window of windows) {
      const response = await apiClient.fetchTransactions(
        account,
        window,
        dateRange.endDate,
      );
      rows.push(...sinopacApiRowsToStatementRows(response.SubInfo ?? []));
    }
    downloads.push(
      await writeStatementFiles(account, windows.map(queryPeriod), dedupeRows(rows)),
    );
  }

  return {
    dateRange,
    count: downloads.length,
    rowCount: downloads.reduce((sum, download) => sum + download.rowCount, 0),
    downloads,
  };
}

export default workflow("sinopacStatements", {
  credentials: ["sinopac_user_id", "sinopac_account", "sinopac_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const { page } = ctx;

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await librettoAuthenticate(ctx, {
      credentials: input.credentials,
      isSignedIn: async () => await isSignedIn(page),
      signIn: async () => {
        await signInSinopac(ctx, input.credentials);
      },
    });
    await dismissPasswordExpiryNotice(page);

    console.log("automation-progress: 25");
    const accounts = await openTransactionPage(page);
    const result = await downloadSinopacStatements(page, input, accounts);
    console.log("automation-progress: 100");
    return result;
  },
});
