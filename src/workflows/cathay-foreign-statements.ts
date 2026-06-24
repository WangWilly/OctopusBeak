import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Page } from "playwright";
import { z } from "zod";
import {
  type CathayCredentials,
  type CathaySession,
  createCathaySession,
  signInCathay,
} from "./cathay-statements.js";

const FOREIGN_STATEMENTS_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/FAcctInq/R0102_FAcctDtlInq_Qry";

const dateRangeSchema = z.enum([
  "one_week",
  "one_month",
  "three_months",
  "six_months",
  "one_year",
]);

const inputSchema = z.object({
  dateRange: dateRangeSchema.default("one_year"),
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
  trustDevice: z.boolean().default(false),
});

const outputSchema = z.object({
  dateRange: dateRangeSchema,
  count: z.number().int().nonnegative(),
  downloads: z.array(
    z.object({
      accountId: z.string(),
      account: z.string(),
      currencies: z.array(z.string()),
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

type Input = z.infer<typeof inputSchema> & {
  credentials: CathayCredentials;
};

export type CathayForeignDateRange = z.infer<typeof dateRangeSchema>;

export type CathayForeignStatementDownload = {
  accountId: string;
  account: string;
  currencies: string[];
  queryPeriods: string[];
  branchName: string;
  baseName: string;
  csvFilename: string;
  csvPath: string;
  csvBytes: number;
  jsonFilename: string;
  jsonPath: string;
  jsonBytes: number;
  rowCount: number;
};

type CathayApiResponse<T> = {
  content?: Partial<T> & {
    datas?: T[];
    detailAccounts?: T[];
    transferDetails?: T[];
  };
  success?: boolean;
  returnCode?: string;
  returnDesc?: string;
};

type CathayForeignCurrency = {
  currencyCode?: string;
  currency?: string;
  currencyName?: string;
};

type CathayForeignAccount = {
  account: string;
  currencyList?: CathayForeignCurrency[];
  nickName?: string | null;
  demandType?: string;
};

type CathayForeignTransferInfo = {
  sequenceNumber?: number;
  transferDate?: string;
  txntDate?: string;
  debitCreditType?: string;
  amount?: number | null;
  balance?: number | null;
  custName?: string;
  memo?: string;
  exRate?: string;
};

type CathayForeignTransferResult = {
  currencyCode?: string;
  transferInfos?: CathayForeignTransferInfo[];
};

const statementHeaders = [
  "帳務日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
];

let lastTimestamp = 0;

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

function formatNullableAmount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeDate(value: string | null | undefined): string {
  const text = cleanText(value);
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}/${compact[2]}/${compact[3]}`;

  const date = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (date) return `${date[1]}/${date[2]}/${date[3]}`;

  return text;
}

function statementRowSortKey(row: string[]): string {
  return cleanText(row[1]) || cleanText(row[0]);
}

function compareStatementRowsByTransactionTimeDesc(
  left: string[],
  right: string[],
): number {
  return statementRowSortKey(right).localeCompare(statementRowSortKey(left));
}

function queryPeriodForDateRange(dateRange: CathayForeignDateRange): string {
  const bounds = dateRangeBounds(dateRange);
  return `${normalizeDate(bounds.startDate)}~${normalizeDate(bounds.endDate)}`;
}

function foreignAmountColumns(
  debitCreditType: string | undefined,
  amount: number | null | undefined,
): [string, string] {
  const formattedAmount = formatNullableAmount(amount);
  if (!formattedAmount) return ["", ""];

  const type = cleanText(debitCreditType).toUpperCase();
  const isDebit =
    type === "D" ||
    type.includes("DEBIT") ||
    /支出|扣|提出|轉出|匯出|買/.test(type);
  const isCredit =
    type === "C" ||
    type.includes("CREDIT") ||
    /存入|收入|轉入|匯入|賣/.test(type);

  if (isDebit) return [formattedAmount, ""];
  if (isCredit) return ["", formattedAmount];
  return ["", formattedAmount];
}

function foreignSummary(info: CathayForeignTransferInfo): string {
  return [info.debitCreditType, info.custName]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");
}

function foreignNote(info: CathayForeignTransferInfo): string {
  return [
    info.memo,
    info.exRate ? `匯率 ${cleanText(info.exRate)}` : "",
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");
}

function matchesAccountFilter(
  account: { label: string; value: string },
  filters: string[],
): boolean {
  if (filters.length === 0) return true;

  const normalizedLabel = toAsciiDigits(account.label).toLowerCase();
  const normalizedValue = toAsciiDigits(account.value).toLowerCase();
  const accountDigits = digitsOnly(`${account.label} ${account.value}`);

  return filters.some((filter) => {
    const normalizedFilter = toAsciiDigits(filter).toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      normalizedLabel.includes(normalizedFilter) ||
      normalizedValue.includes(normalizedFilter) ||
      (filterDigits.length > 0 && accountDigits.endsWith(filterDigits))
    );
  });
}

function matchesCurrencyFilter(
  currency: CathayForeignCurrency,
  filters: string[],
): boolean {
  if (filters.length === 0) return true;

  const haystack = [
    currency.currency,
    currency.currencyCode,
    currency.currencyName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return filters.some((filter) =>
    haystack.includes(toAsciiDigits(filter).toLowerCase().trim()),
  );
}

function currencyCodeOf(currency: CathayForeignCurrency): string | undefined {
  return currency.currency ?? currency.currencyCode;
}

async function openForeignStatementsPage(page: Page): Promise<void> {
  await page.goto(FOREIGN_STATEMENTS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("domcontentloaded");
}

function functionSeqNo(): string {
  return `${Date.now()}${randomUUID()}`;
}

function foreignAccountLabel(account: CathayForeignAccount): string {
  return cleanText(
    [account.account, account.nickName, account.demandType]
      .filter(Boolean)
      .join(" "),
  );
}

function dateRangeBounds(dateRange: z.infer<typeof dateRangeSchema>): {
  startDate: string;
  endDate: string;
} {
  const end = new Date();
  const start = new Date(end);

  if (dateRange === "one_week") {
    start.setDate(start.getDate() - 7);
  } else if (dateRange === "one_month") {
    start.setMonth(start.getMonth() - 1);
  } else if (dateRange === "three_months") {
    start.setMonth(start.getMonth() - 3);
  } else if (dateRange === "six_months") {
    start.setMonth(start.getMonth() - 6);
  } else {
    start.setFullYear(start.getFullYear() - 1);
  }

  return {
    startDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

class CathayForeignApiClient {
  constructor(private page: Page) {}

  async fetchForeignAccounts(
    session: CathaySession,
    accountFilters: string[],
    currencyFilters: string[],
  ): Promise<CathayForeignAccount[]> {
    const response = await this.apiPost<CathayForeignAccount>(
      "/OnlineBankingApi/ClientForeign/Api/ClientForeign/R_ACCT_Q_DetailAccount",
      session,
      {
        functionSeqNo: functionSeqNo(),
        content: {
          customerId: session.customerId,
          isNickNameRequired: false,
        },
      },
    );
    const accounts = (response.content?.detailAccounts ?? [])
      .map((account) => ({
        ...account,
        currencyList: (account.currencyList ?? []).filter((currency) =>
          matchesCurrencyFilter(currency, currencyFilters),
        ),
      }))
      .filter((account) => account.account && account.currencyList.length > 0)
      .filter((account) =>
        matchesAccountFilter(
          { label: foreignAccountLabel(account), value: account.account },
          accountFilters,
        ),
      );

    if (accounts.length === 0) {
      throw new Error("No Cathay foreign-currency account options matched.");
    }

    return accounts;
  }

  async fetchTransferDetails(
    session: CathaySession,
    account: CathayForeignAccount,
    dateRange: z.infer<typeof dateRangeSchema>,
  ): Promise<CathayForeignTransferResult[]> {
    const bounds = dateRangeBounds(dateRange);
    const currencyList = (account.currencyList ?? [])
      .map(currencyCodeOf)
      .filter((currency): currency is string => Boolean(currency));
    if (currencyList.length === 0) {
      throw new Error(`No currencies selected for ${maskAccountLabel(account.account)}.`);
    }

    const response = await this.apiPost<CathayForeignTransferResult>(
      "/OnlineBankingApi/ClientForeign/Api/ClientForeign/R_ACCT_Q_TransferDetail",
      session,
      {
        functionSeqNo: functionSeqNo(),
        content: {
          custID: session.customerId,
          account: account.account,
          currencyList,
          startDate: bounds.startDate,
          endDate: bounds.endDate,
        },
      },
    );

    return response.content?.transferDetails ?? [];
  }

  private async apiPost<T>(
    path: string,
    session: Pick<CathaySession, "jwtToken">,
    body: unknown,
  ): Promise<CathayApiResponse<T>> {
    const result = (await this.page.evaluate(
      async ({ path, token, body }) => {
        const response = await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json, text/plain, */*",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`${response.status} for ${path}`);
        return await response.json();
      },
      { path, token: session.jwtToken, body },
    )) as CathayApiResponse<T>;

    if (!result.success) {
      throw new Error(
        `Cathay API failed: ${result.returnCode ?? "unknown"} ${result.returnDesc ?? ""}`.trim(),
      );
    }

    return result;
  }
}

async function writeForeignStatementFiles(
  account: CathayForeignAccount,
  currency: string,
  dateRange: CathayForeignDateRange,
  statement: CathayForeignTransferResult,
): Promise<CathayForeignStatementDownload> {
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "cathay-foreign-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const currencyCode = cleanText(statement.currencyCode ?? currency);
  const accountId = `${digitsOnly(account.account)}-${currencyCode}`;
  const accountName = foreignAccountLabel(account);
  const queryPeriods = [queryPeriodForDateRange(dateRange)];
  const rows = (statement.transferInfos ?? [])
    .map((info) => {
      const [withdrawal, deposit] = foreignAmountColumns(
        info.debitCreditType,
        info.amount,
      );
      return [
        normalizeDate(info.transferDate ?? info.txntDate),
        cleanText(info.txntDate ?? info.transferDate),
        foreignSummary(info),
        withdrawal,
        deposit,
        formatNullableAmount(info.balance),
        foreignNote(info),
      ];
    })
    .sort(compareStatementRowsByTransactionTimeDesc);
  const baseName = `${safeFilename(accountId)}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);

  await writeFile(csvPath, rowsToCsv([statementHeaders, ...rows]), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: accountName,
        查詢期間: queryPeriods,
        分行名稱: cleanText(account.demandType),
        幣別: currencyCode,
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
    account: accountName,
    currencies: [currencyCode],
    queryPeriods,
    branchName: cleanText(account.demandType),
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

export async function downloadCathayForeignStatements(
  page: Page,
  dateRange: CathayForeignDateRange,
  accountFilters: string[],
  currencyFilters: string[],
  cathaySession?: CathaySession,
): Promise<CathayForeignStatementDownload[]> {
  await openForeignStatementsPage(page);

  const apiClient = new CathayForeignApiClient(page);
  const session = cathaySession ?? (await createCathaySession(page));
  const accounts = await apiClient.fetchForeignAccounts(
    session,
    accountFilters,
    currencyFilters,
  );

  const downloads: CathayForeignStatementDownload[] = [];
  for (const account of accounts) {
    const currencies = (account.currencyList ?? [])
      .map(currencyCodeOf)
      .filter((currency): currency is string => Boolean(currency));
    const statements = await apiClient.fetchTransferDetails(
      session,
      account,
      dateRange,
    );
    const statementsByCurrency = new Map(
      statements.map((statement) => [cleanText(statement.currencyCode), statement]),
    );

    for (const currency of currencies) {
      const statement =
        statementsByCurrency.get(cleanText(currency)) ?? {
          currencyCode: currency,
          transferInfos: [],
        };
      downloads.push(
        await writeForeignStatementFiles(account, currency, dateRange, statement),
      );
    }
  }

  return downloads;
}

export default workflow("cathayForeignStatements", {
  credentials: ["cathay_user_id", "cathay_account", "cathay_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const { page } = ctx;

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await signInCathay(ctx, input.credentials, input.trustDevice);
    const downloads = await downloadCathayForeignStatements(
      page,
      input.dateRange,
      input.accountFilters,
      input.currencyFilters,
    );

    return {
      dateRange: input.dateRange,
      count: downloads.length,
      downloads,
    };
  },
});
