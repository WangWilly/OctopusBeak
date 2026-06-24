import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Page } from "playwright";
import { z } from "zod";
import {
  type CathayCredentials,
  type CathaySession,
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
      account: z.string(),
      currencies: z.array(z.string()),
      dateRange: dateRangeSchema,
      filename: z.string(),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      rows: z.number().int().nonnegative(),
    }),
  ),
});

type Input = z.infer<typeof inputSchema> & {
  credentials: CathayCredentials;
};

export type CathayForeignDateRange = z.infer<typeof dateRangeSchema>;

export type CathayForeignStatementDownload = {
  account: string;
  currencies: string[];
  dateRange: CathayForeignDateRange;
  filename: string;
  path: string;
  bytes: number;
  rows: number;
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

type CathayUserProfile = {
  customerId?: string;
  idType?: string;
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

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\u00a0/g, " ").replace(/\r?\n/g, " ");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

class CathayForeignApiClient {
  constructor(private page: Page) {}

  async createSession(): Promise<CathaySession> {
    const result = (await this.page.evaluate(async () => {
      const response = await fetch("/MyBank/Customized/GetJWT", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json, text/plain, */*",
        },
      });
      if (!response.ok) throw new Error(`${response.status} for GetJWT`);
      return await response.json();
    })) as {
      IsSuccess?: boolean;
      Msg?: string | null;
      Data?: {
        JwtToken?: string;
        CustomerId?: string;
      };
    };

    if (!result.IsSuccess || !result.Data?.JwtToken || !result.Data.CustomerId) {
      throw new Error(result.Msg ?? "Cathay GetJWT did not return a token.");
    }

    const tokenSession = {
      jwtToken: result.Data.JwtToken,
      customerId: result.Data.CustomerId,
    };

    const profile = await this.apiPost<CathayUserProfile>(
      "/OnlineBankingApi/Common/Api/ClientCommon/G_COMM_Q_UserProfile",
      tokenSession,
      {
        functionSeqNo: functionSeqNo(),
        content: { customerId: tokenSession.customerId },
      },
    );
    const userProfile = profile.content;
    if (!userProfile?.idType) {
      throw new Error("Cathay user profile did not return idType.");
    }

    return {
      ...tokenSession,
      idType: userProfile.idType,
    };
  }

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

async function writeForeignStatementCsv(
  account: string,
  currencies: string[],
  dateRange: CathayForeignDateRange,
  statements: CathayForeignTransferResult[],
) {
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "cathay-foreign-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const columns: Array<keyof CathayForeignTransferInfo | "account" | "currencyCode"> = [
    "account",
    "currencyCode",
    "sequenceNumber",
    "transferDate",
    "txntDate",
    "debitCreditType",
    "amount",
    "balance",
    "custName",
    "memo",
    "exRate",
  ];
  const rows = [
    columns.join(","),
    ...statements.flatMap((statement) =>
      (statement.transferInfos ?? []).map((info) =>
        columns
          .map((column) =>
            csvEscape(
              column === "account"
                ? account
                : column === "currencyCode"
                  ? statement.currencyCode
                  : info[column],
            ),
          )
          .join(","),
      ),
    ),
  ];

  const filename = `${safeFilename(account)}-${safeFilename(currencies.join("-"))}-${dateRange}-${Date.now()}.csv`;
  const path = join(downloadsDir, filename);
  await writeFile(path, `${rows.join("\n")}\n`, "utf8");

  const fileStat = await stat(path);
  return { filename, path, bytes: fileStat.size, rows: rows.length - 1 };
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
  const session = cathaySession ?? (await apiClient.createSession());
  const accounts = await apiClient.fetchForeignAccounts(
    session,
    accountFilters,
    currencyFilters,
  );

  const downloads: CathayForeignStatementDownload[] = [];
  for (const account of accounts) {
    const maskedAccount = maskAccountLabel(foreignAccountLabel(account));
    const currencies = (account.currencyList ?? [])
      .map(currencyCodeOf)
      .filter((currency): currency is string => Boolean(currency));
    const statements = await apiClient.fetchTransferDetails(
      session,
      account,
      dateRange,
    );
    const download = await writeForeignStatementCsv(
      maskedAccount,
      currencies,
      dateRange,
      statements,
    );
    downloads.push({
      account: maskedAccount,
      currencies,
      dateRange,
      ...download,
    });
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
