import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { librettoAuthenticate, workflow, type LibrettoWorkflowContext } from "libretto";
import type { Page } from "playwright";
import { z } from "zod";

const LOGIN_URL = "https://accessibility.linebank.com.tw/login";
const TRANSACTION_URL = "https://accessibility.linebank.com.tw/transaction";
const ACCOUNTS_ENDPOINT = "/v1/account/common/payables?featureTypeCode=01";
const TRANSACTIONS_ENDPOINT = "/v1/account/history/transactions";

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

type DateRange = {
  startDate: string;
  endDate: string;
};

type LineBankCredentials = {
  linebank_user_id?: string;
  linebank_account?: string;
  linebank_password?: string;
};

type LineBankAccount = {
  acctNbr?: string;
  arrId?: string;
  acctNick?: string;
  pdNm?: string;
  currCd?: string;
  ccyCd?: string;
  crncyCd?: string;
  currency?: string;
};

type LineBankAccountsResponse = {
  code?: string;
  message?: string;
  content?: {
    dpstAcctList?: LineBankAccount[];
  } | null;
};

type LineBankTransactionRow = {
  txSeqNbr?: number;
  txDt?: string;
  txTm?: string;
  dpstWdrwDsCd?: string;
  bizTxFuncTpNm?: string;
  txAmt?: number;
  afTxBal?: number;
  txRmkCont?: string;
  txMemoVal?: string;
};

type LineBankTransactionsResponse = {
  code?: string;
  message?: string;
  content?: {
    totTxCnt?: number;
    txLst?: LineBankTransactionRow[];
  } | null;
};

type LineBankDownload = z.infer<typeof downloadSchema>;

export type LineBankStatementRow = {
  sortKey: string;
  values: string[];
};

let lastTimestamp = 0;

function requireCredential(
  credentials: LineBankCredentials,
  name: keyof LineBankCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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

export function linebankQueryWindows(dateRange: DateRange): DateRange[] {
  const firstStart = dateFromYYYYMMDD(dateRange.startDate);
  let end = dateFromYYYYMMDD(dateRange.endDate);
  const windows: DateRange[] = [];

  while (end >= firstStart) {
    const maxStart = addDays(addMonths(end, -12), 1);
    const start = maxStart > firstStart ? maxStart : firstStart;
    windows.push({
      startDate: formatYYYYMMDD(start),
      endDate: formatYYYYMMDD(end),
    });
    if (formatYYYYMMDD(start) === dateRange.startDate) break;
    end = addDays(start, -1);
  }

  return windows;
}

function formatSlashDate(value: string): string {
  return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`;
}

function formatTime(value: string | undefined): string {
  const raw = cleanText(value).padStart(6, "0");
  if (!/^\d{6}$/.test(raw)) return cleanText(value);
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}:${raw.slice(4, 6)}`;
}

function amountText(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return String(Math.abs(value));
}

function amountColumns(row: LineBankTransactionRow): [string, string] {
  const amount = amountText(row.txAmt);
  if (!amount) return ["", ""];
  if (row.dpstWdrwDsCd === "2" || (row.txAmt ?? 0) < 0) return [amount, ""];
  return ["", amount];
}

function compareRowsDesc(left: LineBankStatementRow, right: LineBankStatementRow) {
  return right.sortKey.localeCompare(left.sortKey);
}

function dedupeRows(rows: LineBankStatementRow[]): LineBankStatementRow[] {
  return Array.from(
    new Map(rows.map((row) => [row.values.join("\u001f"), row])).values(),
  ).sort(compareRowsDesc);
}

function noteText(row: LineBankTransactionRow): string {
  return [row.txRmkCont, row.txMemoVal].map(cleanText).filter(Boolean).join(" ");
}

export function linebankApiRowsToStatementRows(
  rows: LineBankTransactionRow[],
): LineBankStatementRow[] {
  return rows
    .filter((row) => cleanText(row.txDt) || cleanText(row.bizTxFuncTpNm))
    .map((row) => {
      const [withdrawal, deposit] = amountColumns(row);
      const values = [
        formatSlashDate(cleanText(row.txDt)),
        formatSlashDate(cleanText(row.txDt)),
        formatTime(row.txTm),
        cleanText(row.bizTxFuncTpNm),
        withdrawal,
        deposit,
        amountText(row.afTxBal),
        noteText(row),
        "",
      ];
      return {
        sortKey: `${cleanText(row.txDt)} ${cleanText(row.txTm)} ${row.txSeqNbr ?? ""}`,
        values,
      };
    });
}

export function linebankStatementRowsToCsv(rows: LineBankStatementRow[]): string {
  return rowsToCsv([statementHeaders, ...rows.map((row) => row.values)]);
}

function accountId(account: LineBankAccount): string {
  return cleanText(account.acctNbr);
}

function accountLabel(account: LineBankAccount): string {
  return cleanText(account.acctNick) || cleanText(account.pdNm) || accountId(account);
}

export function linebankAccountCurrency(account: LineBankAccount): string {
  return cleanText(
    account.currCd ?? account.ccyCd ?? account.crncyCd ?? account.currency ?? "TWD",
  ).toUpperCase();
}

function matchesFilters(account: LineBankAccount, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const haystack = `${accountLabel(account)} ${accountId(account)}`.toLowerCase();
  return filters.some((filter) => haystack.includes(filter.toLowerCase()));
}

function filterAccounts(
  accounts: LineBankAccount[],
  accountFilters: string[],
  currencyFilters: string[],
): LineBankAccount[] {
  const currencies = new Set(
    currencyFilters.map((currency) => currency.toUpperCase()),
  );
  return accounts.filter((account) => {
    const currency = linebankAccountCurrency(account);
    return (
      accountId(account) &&
      account.arrId &&
      matchesFilters(account, accountFilters) &&
      (currencies.size === 0 || currencies.has(currency))
    );
  });
}

function queryPeriod(dateRange: DateRange): string {
  return `${formatSlashDate(dateRange.startDate)} ~ ${formatSlashDate(dateRange.endDate)}`;
}

async function isSignedIn(page: Page): Promise<boolean> {
  return await page
    .locator('a[href="/logout"], a[aria-label*="登出"]')
    .first()
    .isVisible()
    .catch(() => false);
}

async function signInLineBank(
  ctx: LibrettoWorkflowContext,
  credentials: LineBankCredentials,
): Promise<void> {
  const { page } = ctx;
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#nationalId").fill(
    requireCredential(credentials, "linebank_user_id"),
  );
  await page
    .locator("#userId")
    .fill(requireCredential(credentials, "linebank_account"));
  await page
    .locator("#pw")
    .fill(requireCredential(credentials, "linebank_password"));
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login", { timeout: 60_000 }),
    page.getByRole("button", { name: "登入友善網路銀行" }).click(),
  ]);

  const confirm = page.getByRole("button", { name: "確定" });
  if (await confirm.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await confirm.click();
  }
  await page
    .locator('a[href="/logout"], a[aria-label*="登出"]')
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
}

class LineBankApiClient {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  private async apiJson<T>(path: string, options?: { body?: unknown }): Promise<T> {
    return (await this.page.evaluate(
      async ({ path, body }) => {
        const headers = {
          accept: "application/json",
          chnldscd: "IBK",
          lclcd: "zh-TW",
        };
        const init: RequestInit = {
          credentials: "include",
          headers,
        };
        if (body) {
          init.method = "POST";
          init.headers = {
            ...headers,
            "Content-Type": "application/json;charset=UTF-8",
          };
          init.body = JSON.stringify(body);
        }
        const response = await fetch(path, init);
        if (!response.ok) throw new Error(`${response.status} for ${path}`);
        return await response.json();
      },
      { path, body: options?.body },
    )) as T;
  }

  async fetchAccounts(): Promise<LineBankAccount[]> {
    const response = await this.apiJson<LineBankAccountsResponse>(ACCOUNTS_ENDPOINT);
    if (response.code !== "200") {
      throw new Error(
        `LINE Bank account list failed: ${response.message ?? "unknown"}`,
      );
    }
    return response.content?.dpstAcctList ?? [];
  }

  async fetchTransactions(
    account: LineBankAccount,
    dateRange: DateRange,
  ): Promise<LineBankTransactionRow[]> {
    const rows: LineBankTransactionRow[] = [];
    const pageCnt = 1000;
    let pageNbr = 1;
    let total = Number.POSITIVE_INFINITY;

    while (rows.length < total) {
      const response = await this.apiJson<LineBankTransactionsResponse>(
        TRANSACTIONS_ENDPOINT,
        {
          body: {
            acctNbr: accountId(account),
            arrId: account.arrId,
            dpstWdrwDsCd: "",
            inqrStrtDt: dateRange.startDate,
            inqrEndDt: dateRange.endDate,
            sortTpCd: 2,
            pageNbr,
            pageCnt,
            totCnt: pageCnt,
            txDtlDsCd: "01",
          },
        },
      );
      if (response.code !== "200") {
        throw new Error(
          `LINE Bank transactions failed: ${response.message ?? "unknown"}`,
        );
      }
      const pageRows = response.content?.txLst ?? [];
      rows.push(...pageRows);
      total = response.content?.totTxCnt ?? rows.length;
      if (pageRows.length === 0) break;
      pageNbr += 1;
    }

    return rows;
  }
}

async function writeStatementFiles(
  account: LineBankAccount,
  queryPeriods: string[],
  rows: LineBankStatementRow[],
): Promise<LineBankDownload> {
  const currency = linebankAccountCurrency(account);
  const kind = currency === "TWD" ? "domestic" : "foreign";
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    kind === "domestic" ? "linebank-statements" : "linebank-foreign-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${safeFilename(accountId(account))}-${currency}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);

  await writeFile(csvPath, linebankStatementRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: `${accountId(account)} ${accountLabel(account)}`.trim(),
        查詢期間: queryPeriods,
        分行名稱: "LINE Bank",
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

async function downloadLineBankStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
): Promise<z.infer<typeof outputSchema>> {
  const dateRange = resolveDateRange(input);
  const windows = linebankQueryWindows(dateRange);
  const apiClient = new LineBankApiClient(page);
  const accounts = filterAccounts(
    await apiClient.fetchAccounts(),
    input.accountFilters,
    input.currencyFilters,
  );

  if (accounts.length === 0) {
    throw new Error("No LINE Bank accounts matched accountFilters/currencyFilters.");
  }

  const downloads: LineBankDownload[] = [];
  for (const account of accounts) {
    const rows: LineBankStatementRow[] = [];
    for (const window of windows) {
      rows.push(
        ...linebankApiRowsToStatementRows(
          await apiClient.fetchTransactions(account, window),
        ),
      );
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

export default workflow("linebankStatements", {
  credentials: ["linebank_user_id", "linebank_account", "linebank_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as z.infer<typeof inputSchema> & {
      credentials: LineBankCredentials;
    };
    const { page } = ctx;

    await librettoAuthenticate(ctx, {
      credentials: input.credentials,
      isSignedIn: async () => await isSignedIn(page),
      signIn: async () => {
        await signInLineBank(ctx, input.credentials);
      },
    });

    console.log("automation-progress: 25");
    await page.goto(TRANSACTION_URL, { waitUntil: "domcontentloaded" });
    await page.locator("#account-dropdown").waitFor({ timeout: 60_000 });
    const result = await downloadLineBankStatements(page, input);
    console.log("automation-progress: 100");
    return result;
  },
});
