import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Dialog, Page } from "playwright";
import { z } from "zod";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";
import {
  admitSinopacDomesticDepositFinancialCapture,
  admitSinopacStatementCaptureEvidence,
  commitCanonicalSinopacDomesticDepositCaptureBatch,
  createSinopacPersonalAuthority,
  commitSinopacStatementSourceEvidenceBatch,
  getSinopacHumanAttestedV1Manifest,
  recordInitialSinopacHumanAttestationIfMissing,
  SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  type SinopacStatementCaptureEvidence,
  type SinopacStatementValidatedCapture,
} from "../ledger/canonical/sinopac-domestic-deposit.ts";
import type { CanonicalFinancialDepositWriterStore } from "../ledger/canonical/canonical-financial-deposit-writer.ts";
import { admitSinopacForeignCurrencyFinancialCapture } from "../ledger/canonical/sinopac-foreign-deposit.ts";
import {
  commitForeignCurrencyDepositCaptureBatch,
  type ForeignCurrencyDepositAdmittedCapture,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  SINOPAC_CAPTCHA_IMAGE_SELECTOR,
  SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
  SINOPAC_CAPTCHA_INPUT_SELECTOR,
  SINOPAC_DIALOG_DISMISS_TIMEOUT_MS,
  SINOPAC_DIALOG_OWNER_ENV,
  sinopacHostDialogOwner,
} from "../lib/automation/sinopac-captcha.ts";
import {
  SINOPAC_IDENTITY_FIELD_NAMES,
  summarizeSinopacIdentityEvidence,
  type SinopacIdentityCapture,
  type SinopacIdentityEvidenceSummary,
  type SinopacIdentityRawRow,
  type SinopacIdentitySiteAssessment,
} from "./sinopac-identity-evidence.ts";

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

export const sinopacIdentityValidationSchema = z.object({
  startDate: dateSchema,
  endDate: dateSchema,
  currency: z.literal("USD"),
  overlapStartDate: dateSchema.optional(),
  overlapEndDate: dateSchema.optional(),
  accountFilter: z.string().min(1).optional(),
});

const inputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
  identityValidation: sinopacIdentityValidationSchema.optional(),
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
  skippedAccounts: z.array(
    z.object({
      accountId: z.string(),
      currency: z.string(),
      reason: z.literal("provider-explicit-no-data"),
    }),
  ),
  status: z.enum(["source-only", "financial-admitted"]),
});

const workflowOutputSchema = z.union([
  outputSchema,
  z
    .object({
      mode: z.literal("identity-validation"),
      evidenceVersion: z.literal("sinopac-identity-evidence-v2"),
    })
    .passthrough(),
]);

type SinopacCredentials = {
  sinopac_user_id?: string;
  sinopac_account?: string;
  sinopac_password?: string;
};

type Input = z.infer<typeof inputSchema> & {
  credentials: SinopacCredentials;
};

export type SinopacIdentityValidationInput = NonNullable<
  z.infer<typeof inputSchema>["identityValidation"]
>;

export type DateRange = {
  startDate: string;
  endDate: string;
};

export type SinopacDownload = z.infer<typeof downloadSchema>;
type SinopacSkippedAccount = z.infer<
  typeof outputSchema
>["skippedAccounts"][number];

export type SinopacAccount = {
  DataText?: string;
  DataValue?: string;
  DisplayText?: string;
};

type SinopacAccountResponse = {
  Header?: string;
  Message?: string;
  SubInfo?: SinopacAccount[];
};

export type SinopacTransactionResponse = {
  Header?: string;
  Message?: string;
  MaxMonth?: string;
  RecordCount?: string;
  SubInfo?: SinopacRawTransactionRow[];
};

export type SinopacStatementsRunDependencies = {
  readAccounts?: (dateRange: DateRange) => Promise<SinopacAccount[]>;
  queryTransactions?: (
    account: SinopacAccount,
    dateRange: DateRange,
    businessDate: string,
  ) => Promise<SinopacTransactionResponse>;
  writeStatementFile?: (
    account: SinopacAccount,
    queryPeriods: string[],
    rows: SinopacStatementRow[],
  ) => Promise<SinopacDownload>;
  canonicalSourceLedgerDir?: string;
  /** Canonical financial mutation is opt-in for both domestic and foreign deposits. */
  canonicalFinancialLedgerDir?: string;
};

export type SinopacRawTransactionRow = Partial<
  Record<(typeof SINOPAC_IDENTITY_FIELD_NAMES)[number], string>
>;

export type SinopacStatementRow = {
  sortKey: string;
  values: string[];
};

export const SINOPAC_LOGIN_URL = LOGIN_URL;

/** Whether Libretto's preloaded startUrl is already the login entry page. */
export function sinopacLoginEntryUrl(href: string): boolean {
  try {
    const current = new URL(href);
    const entry = new URL(LOGIN_URL);
    return (
      current.origin === entry.origin && current.pathname === entry.pathname
    );
  } catch {
    return false;
  }
}

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
  maxMonths = 1,
): DateRange[] {
  // Keep the low-level argument for compatibility, but never permit a
  // provider request wider than one calendar month.
  const windowMonths =
    Number.isSafeInteger(maxMonths) && maxMonths > 0
      ? Math.min(maxMonths, 1)
      : 1;
  const firstStart = dateFromYYYYMMDD(dateRange.startDate);
  let end = dateFromYYYYMMDD(dateRange.endDate);
  const windows: DateRange[] = [];

  while (end >= firstStart) {
    const maxStart = addMonths(end, -windowMonths);
    const start = maxStart > firstStart ? maxStart : firstStart;
    windows.push({
      startDate: formatYYYYMMDD(start),
      endDate: formatYYYYMMDD(end),
    });
    if (formatYYYYMMDD(start) === dateRange.startDate) break;
    // Keep adjacent provider requests disjoint.  A transaction at a window
    // boundary is therefore never replayed merely because the provider
    // accepts inclusive start/end dates.
    end = addDays(start, -1);
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

function compareRowsDesc(
  left: SinopacStatementRow,
  right: SinopacStatementRow,
) {
  return right.sortKey.localeCompare(left.sortKey);
}

function sortRows(rows: SinopacStatementRow[]): SinopacStatementRow[] {
  return [...rows].sort(compareRowsDesc);
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

export function sinopacSortAccounts(
  accounts: readonly SinopacAccount[],
): SinopacAccount[] {
  return [...accounts].sort((left, right) => {
    const currencyOrder = accountCurrency(left).localeCompare(
      accountCurrency(right),
    );
    if (currencyOrder !== 0) return currencyOrder;
    const idOrder = accountId(left).localeCompare(accountId(right));
    if (idOrder !== 0) return idOrder;
    return accountLabel(left).localeCompare(accountLabel(right));
  });
}

export function sinopacFilterAccounts(
  accounts: SinopacAccount[],
  accountFilters: string[],
  currencyFilters: string[],
): SinopacAccount[] {
  const currencies = new Set(
    currencyFilters.map((currency) => currency.toUpperCase()),
  );
  return sinopacSortAccounts(
    accounts.filter((account) => {
      const currency = accountCurrency(account);
      return (
        accountId(account) &&
        accountLabel(account) &&
        matchesFilters(account, accountFilters) &&
        (currencies.size === 0 || currencies.has(currency))
      );
    }),
  );
}

function accountListFromResponse(
  response: SinopacAccountResponse[],
): SinopacAccount[] {
  const result = response[0];
  if (result?.Header === "FAIL" && cleanText(result.Message) === "查無資料")
    return [];
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

async function waitForSignedInState(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  await page.waitForURL((url) => sinopacSignedInPageUrl(url.href), {
    timeout: 300_000,
    signal,
  });
  await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
  await page
    .locator('a#user-logout, a[href*="MMALogout"]')
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
}

export type SinopacLoginAttemptDependencies = {
  submit: () => Promise<void>;
  waitForSuccess: (signal: AbortSignal) => Promise<void>;
};

/**
 * The desktop host owns provider dialogs when the workflow has a host
 * transport.  A direct CLI run has no host and keeps the local fail-fast
 * fallback so it cannot wait for the full navigation timeout.
 */
export function sinopacPostSubmitDialogOwner(
  session: string,
  env: NodeJS.ProcessEnv = process.env,
): "host" | "workflow" {
  return env[SINOPAC_DIALOG_OWNER_ENV]?.trim() === sinopacHostDialogOwner(session)
    ? "host"
    : "workflow";
}

export async function runSinopacLoginAttempt(
  page: Page,
  session: string,
  dependencies: SinopacLoginAttemptDependencies,
): Promise<void> {
  if (sinopacPostSubmitDialogOwner(session) === "host") {
    const successProbe = dependencies.waitForSuccess(new AbortController().signal);
    await dependencies.submit();
    await successProbe;
    return;
  }

  const probeAbortController = new AbortController();
  let rejectDialog!: (error: Error) => void;
  const dialogDetected = new Promise<never>((_resolve, reject) => {
    rejectDialog = reject;
  });
  let dialogHandled = false;
  const dialogHandler = async (dialog: Dialog): Promise<void> => {
    if (dialogHandled) return;
    dialogHandled = true;
    let type = "unknown";
    try {
      type = dialog.type();
    } catch {
      // Keep the fail-fast path usable if the browser closes the dialog while
      // it is being inspected.
    }
    console.warn("sinopac-login-dialog", { type });
    const dismissal = Promise.resolve().then(() => dialog.dismiss());
    void dismissal.catch(() => undefined);
    let dismissalTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      dismissal.catch(() => undefined),
      new Promise<void>((resolve) => {
        dismissalTimer = setTimeout(resolve, SINOPAC_DIALOG_DISMISS_TIMEOUT_MS);
      }),
    ]);
    if (dismissalTimer) clearTimeout(dismissalTimer);
    probeAbortController.abort();
    rejectDialog(new Error("SinoPac login was interrupted by a browser dialog."));
  };

  page.on("dialog", dialogHandler);
  try {
    const successProbe = dependencies.waitForSuccess(probeAbortController.signal);
    void successProbe.catch(() => undefined);
    const loginOutcome = (async () => {
      await dependencies.submit();
      await successProbe;
    })();
    await Promise.race([loginOutcome, dialogDetected]);
  } finally {
    probeAbortController.abort();
    page.off("dialog", dialogHandler);
  }
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
      await dismiss
        .waitFor({ state: "hidden", timeout: 10_000 })
        .catch(() => {});
      await page
        .waitForLoadState("domcontentloaded", { timeout: 10_000 })
        .catch(() => {});
      return;
    }
  }
}

async function fillLoginForm(
  page: Page,
  credentials: SinopacCredentials,
): Promise<void> {
  // Libretto preloads startUrl before the handler.  Only navigate when a CDP
  // attachment or a signed-out page is elsewhere, avoiding duplicate login
  // requests on normal workflow launches.
  if (!sinopacLoginEntryUrl(page.url())) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  } else {
    await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
  }
  await page.locator("form#aspnetForm").waitFor({ timeout: 60_000 });

  const loginInputs = page.locator(
    "input.selectable:visible, input.tips:visible",
  );

  await loginInputs
    .first()
    .fill(requireCredential(credentials, "sinopac_user_id"));
  await loginInputs
    .nth(1)
    .fill(requireCredential(credentials, "sinopac_account"));
  await loginInputs
    .nth(2)
    .fill(requireCredential(credentials, "sinopac_password"));
  const captcha = page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR);
  await captcha.fill("");
  await captcha.focus();
}

export function sinopacCaptchaAssistanceStage(
  page: Page,
): WorkflowHumanAssistanceStage {
  return {
    stageId: "sinopac-login-captcha",
    title: "Enter the SinoPac CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "sinopac.login.captcha-input",
        modes: ["click", "type"],
        locator: page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR),
      },
    ],
    contextRegions: [
      {
        id: "captcha-challenge",
        label: "CAPTCHA challenge and instructions",
        semanticId: "sinopac.login.captcha-challenge",
      },
    ],
    challengeKind: "text-captcha",
    charset: "digits",
    ocrPageSegmentationMode: "single-line",
    ocrAttemptPlan: [
      { imagePreprocessing: ["remove-interference-lines"] },
    ],
    solveAcceptancePolicy: { mode: "confidence-only" },
    solverConfidenceThreshold: 0.9,
    expectedAnswerLength: 6,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
      locator: page.locator(SINOPAC_CAPTCHA_IMAGE_SELECTOR),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  };
}

async function signInSinopac(
  ctx: LibrettoWorkflowContext,
  credentials: SinopacCredentials,
): Promise<void> {
  const { page, session } = ctx;
  await fillLoginForm(page, credentials);
  const captcha = page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR);
  try {
    await emitHumanAssistanceStage(sinopacCaptchaAssistanceStage(page));
  } catch (error) {
    // A plain CLI run has no desktop host contract channel.  Keep the
    // headed-browser CAPTCHA pause usable while preserving all other errors.
    if (
      !(error instanceof Error) ||
      error.message !== "Human assistance host API is unavailable for this workflow run."
    ) {
      throw error;
    }
    console.warn("human-assistance-host-unavailable; use the headed browser directly");
  }

  console.log(sinopacManualAuthMessage(session));
  await pause(session);
  if (await isSignedIn(page)) return;

  if (!(await captcha.inputValue()).trim()) {
    throw new Error(
      "SinoPac CAPTCHA is empty. Enter it in the browser before resuming.",
    );
  }
  await runSinopacLoginAttempt(page, session, {
    submit: () => clickLoginButton(page),
    waitForSuccess: (signal) => waitForSignedInState(page, signal),
  });
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
    .then(
      async (response) => (await response.json()) as SinopacAccountResponse[],
    );
  const detailLink = page
    .locator('a[title="往來明細"], a[href*="mma_transdetail"]')
    .first();
  if (await detailLink.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await detailLink.click();
  } else {
    await page.goto(TRANSACTION_URL, { waitUntil: "domcontentloaded" });
  }
  await page
    .locator("#StartDate")
    .waitFor({ state: "visible", timeout: 60_000 });
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
        const Xhr = (
          globalThis as unknown as {
            XMLHttpRequest: new () => BrowserXhr;
          }
        ).XMLHttpRequest;
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
          request.onerror = () =>
            reject(new Error(`Network error for ${path}`));
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
    if (result?.Header === "FAIL" && cleanText(result.Message) === "查無資料")
      return [];
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
    if (result.Header === "FAIL" && cleanText(result.Message) === "查無資料")
      return result;
    if (result.Header !== "SUCCESS") {
      throw new Error(
        `SinoPac transactions failed: ${result.Message ?? "unknown"}`,
      );
    }
    return result;
  }
}

type SinopacWrapperCategory = "native" | "patched" | "unknown";

function classifyWrapperSource(source: unknown): SinopacWrapperCategory {
  if (typeof source !== "string" || source.length === 0) return "unknown";
  return source.includes("[native code]") ? "native" : "patched";
}

async function assessSinopacSiteSecurity(
  page: Page,
): Promise<SinopacIdentitySiteAssessment> {
  // Keep the probe aggregate-only: browser globals are classified in-page and
  // cookie/script values never leave this function.
  const browserSignals = (await page.evaluate(`(() => {
    const root = globalThis;
    const fetchSource = Function.prototype.toString.call(root.fetch);
    const xhr = root.XMLHttpRequest;
    const openSource = xhr?.prototype?.open
      ? Function.prototype.toString.call(xhr.prototype.open)
      : "";
    return {
      botGlobal: ["_pxAppId", "bmak", "ddjskey"].some((key) => key in root),
      fetchSource,
      openSource,
    };
  })()`)) as {
    botGlobal: boolean;
    fetchSource: string;
    openSource: string;
  };
  const cookies = await page.context().cookies(page.url());
  const cookieBotSignal = cookies.some((cookie) =>
    /(?:_abck|_px|datadome|cf_clearance|_imp_apg_|x-kpsdk-)/i.test(cookie.name),
  );
  let scriptBotSignal = false;
  for (const script of await page.locator("script[src]").all()) {
    const source = await script.getAttribute("src");
    if (
      source &&
      /(?:akamaized|perimeterx|datadome|kasada|cloudflare)/i.test(source)
    ) {
      scriptBotSignal = true;
      break;
    }
  }

  const captchaMarkers = await page
    .locator('iframe[src*="captcha" i]:visible, iframe[title*="captcha" i]:visible')
    .count();
  const cloudflareMarkers = await page
    .locator(
      'iframe[src*="challenge" i]:visible, [data-cf-chl-widget]:visible',
    )
    .count();
  const genericChallengeMarkers = await page
    .getByText(/checking your browser|verify you are human|bot check/i)
    .count()
    .catch(() => 0);
  const challengeType: SinopacIdentitySiteAssessment["challengeType"] =
    captchaMarkers > 0
      ? "captcha"
      : cloudflareMarkers > 0
        ? "cloudflare"
        : genericChallengeMarkers > 0
          ? "generic-bot-check"
          : "none";

  return {
    botProtectionDetected:
      cookieBotSignal || scriptBotSignal || browserSignals.botGlobal || challengeType !== "none",
    fetchXhrWrapperCategory: {
      fetch: classifyWrapperSource(browserSignals.fetchSource),
      xhr: classifyWrapperSource(browserSignals.openSource),
    },
    challengeType,
  };
}

function cloneSinopacRawRow(row: SinopacRawTransactionRow): SinopacIdentityRawRow {
  return { ...row };
}

function identityValidationOverlapRange(
  validation: SinopacIdentityValidationInput,
): DateRange {
  const primary = {
    startDate: validation.startDate,
    endDate: validation.endDate,
  };
  const defaultStart = formatYYYYMMDD(
    addMonths(dateFromYYYYMMDD(primary.endDate), -6),
  );
  const startDate = validation.overlapStartDate ??
    (dateFromYYYYMMDD(defaultStart) < dateFromYYYYMMDD(primary.startDate)
      ? primary.startDate
      : defaultStart);
  const endDate = validation.overlapEndDate ?? primary.endDate;
  if (
    dateFromYYYYMMDD(startDate) < dateFromYYYYMMDD(primary.startDate) ||
    dateFromYYYYMMDD(endDate) > dateFromYYYYMMDD(primary.endDate) ||
    dateFromYYYYMMDD(startDate) > dateFromYYYYMMDD(endDate)
  ) {
    throw new Error("identityValidation overlap range must be within the primary range.");
  }
  return { startDate, endDate };
}

export async function runSinopacIdentityValidation(
  page: Page,
  validation: SinopacIdentityValidationInput,
  initialAccounts: SinopacAccount[],
): Promise<SinopacIdentityEvidenceSummary> {
  if (validation.currency !== "USD")
    throw new Error("SinoPac identity validation only supports USD foreign accounts.");
  const accounts = sinopacFilterAccounts(
    initialAccounts,
    validation.accountFilter ? [validation.accountFilter] : [],
    ["USD"],
  );
  if (accounts.length === 0)
    throw new Error("No USD foreign account matched identityValidation.");
  if (accounts.length !== 1)
    throw new Error(
      "identityValidation requires exactly one USD foreign account; provide accountFilter.",
    );

  const primaryRange: DateRange = {
    startDate: validation.startDate,
    endDate: validation.endDate,
  };
  if (dateFromYYYYMMDD(primaryRange.startDate) > dateFromYYYYMMDD(primaryRange.endDate))
    throw new Error("identityValidation startDate must be on or before endDate.");
  const overlapRange = identityValidationOverlapRange(validation);
  const apiClient = new SinopacApiClient(page);
  const siteAssessment = await assessSinopacSiteSecurity(page);
  const querySets: Array<{
    label: SinopacIdentityCapture["label"];
    range: DateRange;
  }> = [
    { label: "exact-repeat-1", range: primaryRange },
    { label: "exact-repeat-2", range: primaryRange },
    { label: "overlap", range: overlapRange },
  ];
  const captures: SinopacIdentityCapture[] = [];

  // Query exactly three sequential sets.  Monthly windows remain the normal
  // provider boundary so the validation does not introduce a new request shape.
  for (const querySet of querySets) {
    const windows: SinopacIdentityCapture["windows"] = [];
    for (const window of sinopacQueryWindows(querySet.range)) {
      const response = await apiClient.fetchTransactions(
        accounts[0]!,
        window,
        querySet.range.endDate,
      );
      windows.push({
        window,
        response: { ...response },
        rows: (response.SubInfo ?? []).map(cloneSinopacRawRow),
      });
    }
    captures.push({ label: querySet.label, range: querySet.range, windows });
  }

  return summarizeSinopacIdentityEvidence(
    captures as [
      SinopacIdentityCapture,
      SinopacIdentityCapture,
      SinopacIdentityCapture,
    ],
    siteAssessment,
    accounts.length,
  );
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

type PendingSinopacDownload = {
  account: SinopacAccount;
  queryPeriods: string[];
  rows: SinopacStatementRow[];
};

function emptySinopacDigest(): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.alloc(0)).digest("base64url")}`;
}

function buildSinopacCapture(
  account: SinopacAccount,
  dateRange: DateRange,
  observedAt: string,
  pending: PendingSinopacDownload,
  providerNoData: boolean,
): SinopacStatementCaptureEvidence {
  const currency = accountCurrency(account);
  const product = currency === "TWD" ? "domestic-deposit" : "foreign-currency";
  const csv = sinopacStatementRowsToCsv(pending.rows);
  const hasRows = pending.rows.length > 0;
  return {
    evidenceVersion: "capture-evidence-v1",
    source: "sinopac",
    product,
    providerGuaranteed: false,
    observedAt,
    account: {
      value: accountId(account),
      label: accountLabel(account),
      currency,
    },
    queryRange: dateRange,
    downloads: [
      {
        filename: hasRows
          ? "sinopac-statement-export.csv"
          : "provider-no-data.csv",
        byteLength: hasRows ? Buffer.byteLength(csv) : 0,
        contentDigest: hasRows
          ? `sha256:${createHash("sha256").update(csv).digest("base64url")}`
          : emptySinopacDigest(),
        columnNames: SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
        rows: pending.rows.map((row, rowOrdinal) => ({
          rowOrdinal,
          values: row.values,
        })),
        queryPeriods: pending.queryPeriods,
        terminal: true,
      },
    ],
    ...(hasRows || !providerNoData
      ? {}
      : { zeroResultAuthority: "provider-explicit-no-data" as const }),
    provenance: {
      source: "sinopac-mma-json-statement-query",
      responseBodyRetained: false,
      semantics: "unresolved",
      accountEndpoint: "ws_debitacct.ashx",
      transactionEndpoint: "ws_transdetailMerge.ashx",
    },
  };
}

function sinopacCaptureId(observedAt: string): string {
  return `sinopac-source-${createHash("sha256")
    .update(`sinopac-source-capture-v1\0${observedAt}`)
    .digest("hex")
    .slice(0, 24)}-${Date.now()}`;
}

export async function runSinopacStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
  initialAccounts?: SinopacAccount[],
  overrides: SinopacStatementsRunDependencies = {},
): Promise<z.infer<typeof outputSchema>> {
  const dateRange = resolveDateRange(input);
  const windows = sinopacQueryWindows(dateRange);
  const apiClient = new SinopacApiClient(page);
  const accounts = sinopacFilterAccounts(
    initialAccounts ??
      (await (
        overrides.readAccounts ?? ((range) => apiClient.fetchAccounts(range))
      )(dateRange)),
    input.accountFilters,
    input.currencyFilters,
  );

  if (accounts.length === 0) {
    if (
      input.accountFilters.length === 0 &&
      input.currencyFilters.length === 0
    ) {
      throw new StatementComponentAbsentError(
        "SinoPac did not expose any bank account or currency for this login.",
      );
    }
    throw new Error(
      "No SinoPac accounts matched accountFilters/currencyFilters.",
    );
  }

  const observedAt = new Date().toISOString();
  const captureOccurrenceId = sinopacCaptureId(observedAt);
  const captureInputs: Array<{
    capture: SinopacStatementValidatedCapture;
    pending: PendingSinopacDownload;
  }> = [];
  const skippedAccounts: SinopacSkippedAccount[] = [];
  for (const account of accounts) {
    const rows: SinopacStatementRow[] = [];
    let explicitNoData = true;
    for (const window of windows) {
      const response = await (
        overrides.queryTransactions ??
        ((candidate, range, businessDate) =>
          apiClient.fetchTransactions(candidate, range, businessDate))
      )(account, window, dateRange.endDate);
      const windowRows = sinopacApiRowsToStatementRows(response.SubInfo ?? []);
      if (
        response.Header !== "FAIL" ||
        cleanText(response.Message) !== "查無資料"
      )
        explicitNoData = false;
      rows.push(...windowRows);
    }
    const pending: PendingSinopacDownload = {
      account,
      queryPeriods: windows.map(queryPeriod),
      rows: sortRows(rows),
    };
    const structural = admitSinopacStatementCaptureEvidence(
      buildSinopacCapture(
        account,
        dateRange,
        observedAt,
        pending,
        explicitNoData,
      ),
    );
    if (structural.status !== "admissible" || !structural.capture) {
      throw new Error(
        `SinoPac statement source admission blocked: ${structural.diagnostics.join(", ")}`,
      );
    }
    captureInputs.push({ capture: structural.capture, pending });
    if (explicitNoData) {
      skippedAccounts.push({
        accountId: accountId(account),
        currency: accountCurrency(account),
        reason: "provider-explicit-no-data",
      });
    }
  }

  // Commit only after every provider account reached a terminal result.  This
  // prevents a later timeout/parser failure from leaving a partial source run.
  const sourceLedgerDir =
    overrides.canonicalSourceLedgerDir ??
    process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
    process.env.LEDGER_DIR ??
    DEFAULT_LEDGER_DIR;
  const sourceStore = createCanonicalSourceStore(
    canonicalSqlitePath(sourceLedgerDir),
  );
  const financialLedgerDir = overrides.canonicalFinancialLedgerDir;
  const financialStore = financialLedgerDir
    ? canonicalSqlitePath(financialLedgerDir) ===
      canonicalSqlitePath(sourceLedgerDir)
      ? sourceStore
      : createCanonicalSourceStore(canonicalSqlitePath(financialLedgerDir))
    : null;
  const financialWriter: CanonicalFinancialDepositWriterStore | null =
    financialStore
      ? {
          db: financialStore.db,
          databasePath: financialStore.databasePath,
          commitClock: () => financialStore.commitClock(),
        }
      : null;
  let status: "source-only" | "financial-admitted" = "source-only";
  try {
    await commitSinopacStatementSourceEvidenceBatch(
      sourceStore,
      captureInputs.map(({ capture }) => capture),
      captureOccurrenceId,
    );
    if (financialWriter) {
      const manifest = getSinopacHumanAttestedV1Manifest();
      const hasDomesticCapture = captureInputs.some(
        ({ capture }) => capture.product === "domestic-deposit",
      );
      if (hasDomesticCapture)
        recordInitialSinopacHumanAttestationIfMissing(
          financialWriter.db,
          observedAt,
        );
      const personalAuthority = hasDomesticCapture
        ? createSinopacPersonalAuthority(financialWriter.db)
        : null;
      const financialInputs = captureInputs.flatMap(({ capture }, index) =>
        capture.product === "domestic-deposit"
          ? [
              {
                capture,
                captureId: `sinopac-financial-${sinopacCaptureId(observedAt)}-${index}`,
                humanAttestation: manifest,
                personalAuthority: personalAuthority!,
              },
            ]
          : [],
      );
      const admissions = financialInputs.map((input) =>
        admitSinopacDomesticDepositFinancialCapture(input),
      );
      const blocked = admissions.find(
        (admission) => admission.status !== "admitted",
      );
      if (blocked)
        throw new Error(
          `SinoPac domestic deposit financial admission failed: ${blocked.diagnostics.join(", ")}`,
        );
      const foreignAdmissions: ForeignCurrencyDepositAdmittedCapture[] =
        captureInputs.flatMap(({ capture }, index) =>
          capture.product === "foreign-currency"
            ? [
                admitSinopacForeignCurrencyFinancialCapture(
                  capture,
                  `${captureOccurrenceId}:foreign:${index}`,
                ),
              ]
            : [],
        );
      if (financialInputs.length > 0) {
        await commitCanonicalSinopacDomesticDepositCaptureBatch(
          financialWriter,
          financialInputs,
        );
        if (
          admissions.some(
            (admission) => (admission.capture?.records.length ?? 0) > 0,
          )
        )
          status = "financial-admitted";
      }
      if (foreignAdmissions.length > 0) {
        await commitForeignCurrencyDepositCaptureBatch(
          financialWriter,
          foreignAdmissions,
        );
        if (foreignAdmissions.some((capture) => capture.records.length > 0))
          status = "financial-admitted";
      }
    }
  } finally {
    if (financialStore && financialStore !== sourceStore)
      financialStore.close();
    sourceStore.close();
  }

  const downloads: SinopacDownload[] = [];
  for (const { pending } of captureInputs) {
    if (pending.rows.length === 0) continue;
    downloads.push(
      await (overrides.writeStatementFile ?? writeStatementFiles)(
        pending.account,
        pending.queryPeriods,
        pending.rows,
      ),
    );
  }

  return {
    dateRange,
    count: downloads.length,
    rowCount: downloads.reduce((sum, download) => sum + download.rowCount, 0),
    downloads,
    skippedAccounts,
    status,
  };
}

export default workflow("sinopacStatements", {
  startUrl: LOGIN_URL,
  credentials: ["sinopac_user_id", "sinopac_account", "sinopac_password"],
  input: inputSchema,
  output: workflowOutputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const { page } = ctx;

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
    if (input.identityValidation) {
      const evidence = await runSinopacIdentityValidation(
        page,
        input.identityValidation,
        accounts,
      );
      console.log("sinopac-identity-validation-complete", {
        mode: evidence.mode,
        captureCount: evidence.captures.length,
        accountCount: evidence.accountCount,
        rawValuesReturned: evidence.sideEffects.rawValuesReturned,
      });
      console.log("sinopac-identity-validation-summary", evidence);
      console.log("automation-progress: 100");
      return evidence;
    }
    const result = await runSinopacStatements(page, input, accounts, {
      canonicalFinancialLedgerDir:
        process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR,
    });
    console.log("automation-progress: 100");
    return result;
  },
});
