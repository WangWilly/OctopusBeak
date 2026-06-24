import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pause, workflow, type LibrettoWorkflowContext } from "libretto";
import type { Locator, Page } from "playwright";
import { z } from "zod";

const BANK_ENTRY_URL = "https://www.cathaybk.com.tw/MyBank/";
const DOMESTIC_STATEMENTS_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0103_TxnDtlInq";

export type CathayCredentials = {
  cathay_user_id?: string;
  cathay_account?: string;
  cathay_password?: string;
};

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
  trustDevice: z.boolean().default(false),
});

const outputSchema = z.object({
  dateRange: dateRangeSchema,
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

type Input = z.infer<typeof inputSchema> & {
  credentials: CathayCredentials;
};

export type CathayDateRange = z.infer<typeof dateRangeSchema>;

export type CathayStatementDownload = {
  accountId: string;
  account: string;
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

export type CathaySession = {
  jwtToken: string;
  customerId: string;
  idType: string;
};

type CathayApiResponse<T> = {
  content?: Partial<T> & {
    datas?: T[];
  };
  success?: boolean;
  returnCode?: string;
  returnDesc?: string;
};

type CathayAccount = {
  currency?: string;
  accountNo: string;
  branchName?: string;
  nickName?: string;
  accountType?: string;
};

type CathayUserProfile = {
  customerId?: string;
  idType?: string;
};

type CathayTransferDetail = {
  sequenceNumber?: number;
  txnDateTime?: string;
  accountDate?: string;
  description?: string;
  expendAmt?: number | null;
  expendBankId?: string;
  expendAcctNo?: string;
  incomeAmt?: number | null;
  balance?: number | null;
  specialMemo?: string;
  memo?: string;
};

type CathayTransferResult = {
  queryStatus?: string;
  accountNumber?: string;
  count?: number;
  startDate?: string;
  endDate?: string;
  details?: CathayTransferDetail[];
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

function requireCredential(
  credentials: CathayCredentials,
  name: keyof CathayCredentials,
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

function queryPeriodForStatement(
  dateRange: CathayDateRange,
  statement: CathayTransferResult,
): string {
  if (statement.startDate && statement.endDate) {
    return `${normalizeDate(statement.startDate)}~${normalizeDate(statement.endDate)}`;
  }

  const bounds = dateRangeBounds(dateRange);
  return `${normalizeDate(bounds.startDate)}~${normalizeDate(bounds.endDate)}`;
}

function noteForDomesticDetail(detail: CathayTransferDetail): string {
  return [
    detail.specialMemo,
    detail.memo,
    [detail.expendBankId, detail.expendAcctNo].filter(Boolean).join(" "),
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

async function clickFirstVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ force: true });
      return true;
    }
  }
  return false;
}

async function hasStartupAnnouncement(page: Page): Promise<boolean> {
  return await page
    .getByText(/系統維護公告/)
    .first()
    .isVisible()
    .catch(() => false);
}

async function dismissStartupAnnouncements(
  page: Page,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastActionAt = Date.now();

  while (Date.now() < deadline) {
    const clicked = await clickFirstVisible(
      page.locator("button").filter({
        hasText: /^\s*(下一則|我知道了|OK)\s*$/,
      }),
    );
    if (clicked) {
      lastActionAt = Date.now();
      await page.waitForTimeout(700);
      continue;
    }

    const announcementVisible = await hasStartupAnnouncement(page);
    if (!announcementVisible && Date.now() - lastActionAt >= 1_000) {
      return;
    }

    await page.waitForTimeout(250);
  }

  if (await hasStartupAnnouncement(page)) {
    throw new Error("Could not dismiss Cathay startup announcements.");
  }
}

async function isSignedIn(page: Page): Promise<boolean> {
  if (!/\/OnlineBanking\//.test(page.url())) return false;
  return await page
    .getByText(/^登出$/)
    .first()
    .isVisible()
    .catch(() => false);
}

async function fillLoginForm(
  page: Page,
  credentials: CathayCredentials,
): Promise<void> {
  const userId = requireCredential(credentials, "cathay_user_id");
  const account = requireCredential(credentials, "cathay_account");
  const password = requireCredential(credentials, "cathay_password");

  await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });
  await dismissStartupAnnouncements(page);

  await page.locator("#CustID").fill(userId);
  await page.locator("#UserIdKeyin").fill(account);
  await page.locator("#PasswordKeyin").fill(password);
  await dismissStartupAnnouncements(page, 5_000);
  await page.locator("button.js-login").click();
}

async function completeEmailOtpIfNeeded(
  page: Page,
  session: string,
): Promise<void> {
  const emailVerificationLink = page.locator("a").filter({ hasText: "Email驗證" });
  const otpField = page.locator("#OtpMailPassword");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) return;
    if (await otpField.isVisible().catch(() => false)) {
      break;
    }
    if (await emailVerificationLink.first().isVisible().catch(() => false)) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (!(await emailVerificationLink.first().isVisible().catch(() => false))) {
    if (await otpField.isVisible().catch(() => false)) {
      console.log(
        "manual-otp-required: enter the Cathay Email OTP in the browser, then run `npx libretto resume --session " +
          session +
          "`.",
      );
      await pause(session);
      if (await otpField.isVisible().catch(() => false)) {
        await page.locator("#btnConfirm").click();
      }
      return;
    }

    throw new Error(
      `Cathay sign-in did not reach Email OTP or signed-in state. Current URL: ${page.url()}`,
    );
  }

  await emailVerificationLink.first().click();

  const sendEmailOtp = page.locator("#js-otp-email-send");
  if (await sendEmailOtp.isVisible().catch(() => false)) {
    await sendEmailOtp.click();
  }

  await otpField.waitFor({ state: "visible", timeout: 30_000 });
  await otpField.focus();

  console.log(
    "manual-otp-required: enter the Cathay Email OTP in the browser, then run `npx libretto resume --session " +
      session +
      "`.",
  );
  await pause(session);

  if (await otpField.isVisible().catch(() => false)) {
    await page.locator("#btnConfirm").click();
  }
}

async function waitForSignedInState(page: Page): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) return;
    await page.waitForTimeout(500);
  }

  throw new Error("Timed out waiting for Cathay signed-in state.");
}

async function dismissPostLoginPrompts(
  page: Page,
  trustDevice: boolean,
): Promise<void> {
  const trustDeviceModal = page.getByText("信任這台裝置？");
  const deadline = Date.now() + 15_000;
  const stableLoggedInAt = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await trustDeviceModal.first().isVisible().catch(() => false)) {
      break;
    }
    if (
      Date.now() >= stableLoggedInAt &&
      (await page.getByText(/^登出$/).first().isVisible().catch(() => false))
    ) {
      return;
    }
    await page.waitForTimeout(250);
  }

  if (await trustDeviceModal.first().isVisible().catch(() => false)) {
    if (trustDevice) {
      const clicked = await clickFirstVisible(
        page.getByText(/^信任這台裝置$/),
      );
      if (!clicked) {
        throw new Error("Could not click Cathay trusted-device opt-in.");
      }
    } else {
      const clicked = await clickFirstVisible(
        page.getByText("暫時不用加入信任裝置"),
      );
      if (!clicked) {
        throw new Error("Could not click Cathay trusted-device opt-out.");
      }
    }

    const confirm = page.locator('button[aria-label="確定"]');
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
      await page.waitForTimeout(500);
    }

    await trustDeviceModal
      .first()
      .waitFor({ state: "hidden", timeout: 15_000 })
      .catch(() => undefined);
  }
}

export async function signInCathay(
  ctx: LibrettoWorkflowContext,
  credentials: CathayCredentials,
  trustDevice: boolean,
): Promise<{ usedExistingSession: boolean }> {
  const { page, session } = ctx;
  if (await isSignedIn(page)) return { usedExistingSession: true };

  await fillLoginForm(page, credentials);
  await completeEmailOtpIfNeeded(page, session);
  await waitForSignedInState(page);
  await dismissPostLoginPrompts(page, trustDevice);

  return { usedExistingSession: false };
}

async function openDomesticStatementsPage(page: Page): Promise<void> {
  await page.goto(DOMESTIC_STATEMENTS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("domcontentloaded");
}

function functionSeqNo(): string {
  return `${Date.now()}${randomUUID()}`;
}

function accountLabel(account: CathayAccount): string {
  return cleanText(
    [
      account.accountNo,
      account.nickName,
      account.accountType,
      account.branchName,
    ]
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

class CathayApiClient {
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

  async fetchDomesticAccounts(
    session: CathaySession,
    filters: string[],
  ): Promise<CathayAccount[]> {
    const response = await this.apiPost<CathayAccount>(
      "/OnlineBankingApi/Common/Api/ClientCommon/G_CUST_Q_TransAccountList",
      session,
      {
        functionSeqNo: functionSeqNo(),
        content: {
          customerId: session.customerId,
          idType: session.idType,
          queryType: "TWD",
          isNickNameRequired: false,
        },
      },
    );
    const accounts = (response.content?.datas ?? [])
      .filter((account) => account.currency === "TWD" && account.accountNo)
      .filter((account) =>
        matchesAccountFilter(
          { label: accountLabel(account), value: account.accountNo },
          filters,
        ),
      );

    if (accounts.length === 0) {
      throw new Error("No Cathay domestic-currency account options matched.");
    }

    return accounts;
  }

  async fetchTransferDetails(
    session: CathaySession,
    accountNo: string,
    dateRange: z.infer<typeof dateRangeSchema>,
  ): Promise<CathayTransferResult> {
    const bounds = dateRangeBounds(dateRange);
    const response = await this.apiPost<CathayTransferResult>(
      "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_TransferDetail",
      session,
      {
        functionSeqNo: functionSeqNo(),
        content: {
          customerId: session.customerId,
          queryFilters: [
            {
              accountNumber: accountNo,
              startDate: bounds.startDate,
              endDate: bounds.endDate,
            },
          ],
        },
      },
    );
    const result = response.content?.datas?.[0];
    if (!result) {
      throw new Error(`Cathay returned no statement data for ${maskAccountLabel(accountNo)}.`);
    }
    return result;
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

export async function createCathaySession(page: Page): Promise<CathaySession> {
  return await new CathayApiClient(page).createSession();
}

async function writeStatementFiles(
  account: CathayAccount,
  dateRange: CathayDateRange,
  statement: CathayTransferResult,
): Promise<CathayStatementDownload> {
  const downloadsDir = join(process.cwd(), "downloads", "cathay-statements");
  await mkdir(downloadsDir, { recursive: true });

  const accountId = digitsOnly(statement.accountNumber ?? account.accountNo);
  const accountName = accountLabel(account);
  const queryPeriods = [queryPeriodForStatement(dateRange, statement)];
  const rows = (statement.details ?? [])
    .map((detail) => [
      normalizeDate(detail.accountDate),
      cleanText(detail.txnDateTime),
      cleanText(detail.description),
      formatNullableAmount(detail.expendAmt),
      formatNullableAmount(detail.incomeAmt),
      formatNullableAmount(detail.balance),
      noteForDomesticDetail(detail),
    ])
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
        分行名稱: cleanText(account.branchName),
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
    queryPeriods,
    branchName: cleanText(account.branchName),
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

export async function downloadCathayStatements(
  page: Page,
  dateRange: CathayDateRange,
  accountFilters: string[],
  cathaySession?: CathaySession,
): Promise<CathayStatementDownload[]> {
  const apiClient = new CathayApiClient(page);
  const session = cathaySession ?? (await apiClient.createSession());
  const accounts = await apiClient.fetchDomesticAccounts(
    session,
    accountFilters,
  );

  await openDomesticStatementsPage(page);

  const downloads: CathayStatementDownload[] = [];
  for (const account of accounts) {
    const statement = await apiClient.fetchTransferDetails(
      session,
      account.accountNo,
      dateRange,
    );
    downloads.push(await writeStatementFiles(account, dateRange, statement));
  }

  return downloads;
}

export default workflow("cathayStatements", {
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
    const downloads = await downloadCathayStatements(
      page,
      input.dateRange,
      input.accountFilters,
    );

    return {
      dateRange: input.dateRange,
      count: downloads.length,
      downloads,
    };
  },
});
