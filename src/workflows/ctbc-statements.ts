import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Locator, Page, Response } from "playwright";
import { z } from "zod";
import {
  admitCtbcDomesticDepositCaptureEvidence,
  admitCtbcDomesticDepositFinancialCapture,
  commitCanonicalCtbcDomesticDepositCaptureBatch,
  commitCtbcDomesticDepositSourceEvidenceBatch,
  CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  type CtbcDomesticDepositCaptureEvidence,
  type CtbcDomesticDepositValidatedEvidence,
} from "../ledger/canonical/ctbc-domestic-deposit.ts";
import type { CanonicalFinancialDepositWriterStore } from "../ledger/canonical/canonical-financial-deposit-writer.ts";
import {
  CTBC_HUMAN_ATTESTED_V1_CONFIRMED,
  getCtbcHumanAttestedV1Manifest,
} from "../ledger/canonical/ctbc-human-attestation.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  ctbcResponseDiagnosticDirectoryFromEnvironment,
  writeCtbcResponseDiagnostic,
} from "./ctbc-response-diagnostic.ts";

const LOGIN_URL = "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010";
const DOMESTIC_DETAILS_URL =
  "https://www.ctbcbank.com/twrbc/twrbc-deposit/qu002/010";
const EBMW_RESOURCE_PATH = "/IB/api/adapters/IB_Adapter/resource/ebmwResource";
const NO_DATA_CODE = "9201";

const ctbcStatementHeaders = [
  "帳務日期",
  "交易日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
];

const dateSchema = z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/);

const inputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountFilters: z.array(z.string()).optional(),
  telemetry: z.boolean().optional(),
});

const statementFileSchema = z.object({
  account: z.string(),
  accountId: z.string(),
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
  count: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  downloads: z.array(statementFileSchema),
  sourceCaptureCount: z.number().int().nonnegative(),
  status: z.enum(["absent", "source-only", "financial-admitted"]),
});

type CtbcCredentials = {
  ctbc_user_id?: string;
  ctbc_account?: string;
  ctbc_password?: string;
};

type Input = z.infer<typeof inputSchema> & {
  credentials: CtbcCredentials;
};

type CtbcStatementsOutput = z.infer<typeof outputSchema>;
type CtbcDownload = CtbcStatementsOutput["downloads"][number];

type CtbcResourceResponse<T> = {
  code?: string;
  message?: string;
  msg?: string;
  rsData?: T | null;
};

type CtbcAccount = {
  accountId: string;
  label: string;
  nickname?: string;
  optionIndex?: number;
};

type CtbcRawAccount = {
  accountId?: string;
  accountNickName?: string;
  accountType?: string;
  acctType?: string;
};

type CtbcDateRange = {
  firstDateYYYYMMDD?: string;
  lastDateYYYYMMDD?: string;
  currMonthYYYYMM?: string;
};

type CtbcBootstrapData = {
  accountId?: string;
  accountInfoList?: CtbcRawAccount[];
  dateRanges?: CtbcDateRange[];
};

export type CtbcDetailRow = {
  actDtFull?: string;
  trnDtFull?: string;
  actDtTm?: string;
  sortActDtTm?: string;
  memo1?: string;
  memo2?: string;
  passBookMemo?: string;
  dbAmt?: string;
  dbAmtDisplay?: string;
  crAmt?: string;
  crAmtDisplay?: string;
  balanceAmt?: string;
};

type CtbcDetailData = {
  detailList?: CtbcDetailRow[];
  nextKey?: string;
};

type CtbcAmountClass = "empty" | "valid-zero" | "valid-nonzero" | "invalid";

export type CtbcDetailTelemetry = {
  rowCount: number;
  nextKey: "empty" | "present";
  accountingDateShapes: Record<string, number>;
  transactionDateShapes: Record<string, number>;
  amountPairs: Record<string, number>;
};

type CtbcResourceCapture<T> = {
  body: CtbcResourceResponse<T>;
  request: {
    method: string;
    url: string;
    postData: string | null;
  };
  visibleMonthLabel?: string;
};

export type CtbcResponseShapeEvidence = {
  hasRsData: boolean;
  rsDataKind: "object" | "null" | "other";
  hasDetailList: boolean;
  detailListIsArray: boolean;
  detailListRowCount: number | null;
  nextKeyPresent: boolean;
};

export type CtbcObservedRangeResponse = {
  rangeOrdinal: number;
  startDate: string;
  endDate: string;
  code: "0000" | "9201";
  nextKey: string | null;
  terminal: boolean;
  rows: CtbcStatementRow[];
  responseShape: CtbcResponseShapeEvidence;
};

export type CtbcObservedAccountCapture = {
  accountId: string;
  queryPeriods: string[];
  expectedRangeCount: number;
  responses: CtbcObservedRangeResponse[];
};

type CtbcCollectedStatements = {
  output: Omit<CtbcStatementsOutput, "sourceCaptureCount" | "status">;
  captures: CtbcObservedAccountCapture[];
};

export type CtbcStatementsRunDependencies = {
  collectStatements?: (
    page: Page,
    input: z.infer<typeof inputSchema>,
  ) => Promise<CtbcCollectedStatements>;
  canonicalSourceLedgerDir?: string;
  canonicalFinancialLedgerDir?: string;
  observedAt?: string;
};

export type CtbcStatementRow = {
  account: string;
  accountId: string;
  accountingDate: string;
  transactionDate: string;
  sortKey: string;
  values: string[];
};

let lastTimestamp = 0;

function actionByText(page: Page, text: string): Locator {
  return page
    .locator("a, button, input[type=button], input[type=submit]")
    .filter({ hasText: text })
    .last();
}

function requireCredential(
  credentials: CtbcCredentials,
  name: keyof CtbcCredentials,
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
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function amountText(
  displayValue: string | undefined,
  rawValue: string | undefined,
) {
  return cleanText(displayValue) || cleanText(rawValue);
}

function amountClass(value: string): CtbcAmountClass {
  const clean = cleanText(value).replace(/,/g, "");
  if (!clean) return "empty";
  if (!/^-?\d+(?:\.\d+)?$/.test(clean)) return "invalid";
  return Number(clean) === 0 ? "valid-zero" : "valid-nonzero";
}

function dateShape(value: string | undefined): string {
  const clean = cleanText(value);
  if (!clean) return "empty";
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(clean)) return "slash-date";
  if (/^\d{8}$/.test(clean)) return "compact-date";
  if (/^\d{4}-\d{2}-\d{2}/.test(clean)) return "date-time-prefix";
  return "other";
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function ctbcDetailTelemetry(
  data: CtbcDetailData | undefined,
): CtbcDetailTelemetry {
  const accountingDateShapes: Record<string, number> = {};
  const transactionDateShapes: Record<string, number> = {};
  const amountPairs: Record<string, number> = {};
  const rows = data?.detailList ?? [];
  for (const row of rows) {
    increment(accountingDateShapes, dateShape(row.actDtFull));
    increment(transactionDateShapes, dateShape(row.trnDtFull));
    const outflow = amountText(row.dbAmtDisplay, row.dbAmt);
    const inflow = amountText(row.crAmtDisplay, row.crAmt);
    increment(amountPairs, `${amountClass(outflow)}|${amountClass(inflow)}`);
  }
  return {
    rowCount: rows.length,
    nextKey: cleanText(data?.nextKey) ? "present" : "empty",
    accountingDateShapes,
    transactionDateShapes,
    amountPairs,
  };
}

function slashDate(value: string | undefined): string {
  const clean = cleanText(value);
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(clean)) return clean;
  if (/^\d{8}$/.test(clean)) {
    return `${clean.slice(0, 4)}/${clean.slice(4, 6)}/${clean.slice(6, 8)}`;
  }
  return clean;
}

function dateKey(value: string): string {
  return digitsOnly(value).slice(0, 8);
}

function timeFromDetail(detail: CtbcDetailRow): string {
  const actDtTm = cleanText(detail.actDtTm);
  const dotted = actDtTm.match(/\d{4}-\d{2}-\d{2}-(\d{2})\.(\d{2})\.(\d{2})/);
  if (dotted) return `${dotted[1]}:${dotted[2]}:${dotted[3]}`;

  const sortActDtTm = cleanText(detail.sortActDtTm);
  const clock = sortActDtTm.match(/\b(\d{2}:\d{2}:\d{2})\b/);
  return clock?.[1] ?? "";
}

function noteForDetail(detail: CtbcDetailRow): string {
  const parts = [
    cleanText(detail.passBookMemo),
    cleanText(detail.memo2),
  ].filter(Boolean);
  return [...new Set(parts)].join(" ");
}

function detailSortKey(detail: CtbcDetailRow): string {
  return cleanText(detail.sortActDtTm) || cleanText(detail.actDtTm);
}

function sortedStatementRows(rows: CtbcStatementRow[]): CtbcStatementRow[] {
  return [...rows].sort((left, right) =>
    right.sortKey.localeCompare(left.sortKey),
  );
}

export function ctbcDetailRowsToStatementRows(
  account: CtbcAccount,
  details: CtbcDetailRow[],
): CtbcStatementRow[] {
  return details.map((detail) => {
    const accountingDate = slashDate(detail.actDtFull);
    const transactionDate = slashDate(detail.trnDtFull);
    const row = [
      accountingDate,
      transactionDate,
      timeFromDetail(detail),
      cleanText(detail.memo1),
      amountText(detail.dbAmtDisplay, detail.dbAmt),
      amountText(detail.crAmtDisplay, detail.crAmt),
      cleanText(detail.balanceAmt),
      noteForDetail(detail),
    ];

    return {
      account: account.label,
      accountId: account.accountId,
      accountingDate,
      transactionDate,
      sortKey: detailSortKey(detail),
      values: row,
    };
  });
}

export function ctbcStatementRowsToCsv(rows: CtbcStatementRow[]): string {
  return rowsToCsv([
    ctbcStatementHeaders,
    ...sortedStatementRows(rows).map((row) => row.values),
  ]);
}

function rowWithinDateRange(
  row: CtbcStatementRow,
  input: z.infer<typeof inputSchema>,
): boolean {
  const key = dateKey(row.accountingDate || row.transactionDate);
  if (!key) return true;
  if (input.startDate && key < dateKey(input.startDate)) return false;
  if (input.endDate && key > dateKey(input.endDate)) return false;
  return true;
}

async function clickVisibleNow(locator: Locator): Promise<boolean> {
  if (!(await locator.isVisible().catch(() => false))) return false;
  await locator.click();
  return true;
}

async function finishCtbcSignIn(page: Page): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await clickVisibleNow(actionByText(page, "確認登入"))) {
      await page.waitForTimeout(1_000);
      continue;
    }

    if (await clickVisibleNow(actionByText(page, "下次再提醒"))) {
      await page.waitForTimeout(1_000);
      continue;
    }

    if (
      await page
        .locator("#btnHeaderLogout")
        .isVisible()
        .catch(() => false)
    ) {
      return;
    }

    await page.waitForTimeout(500);
  }

  throw new Error("Timed out waiting for CTBC sign-in to finish.");
}

async function isSignedIn(page: Page): Promise<boolean> {
  return await page
    .locator("#btnHeaderLogout")
    .isVisible()
    .catch(() => false);
}

async function waitForLoginForm(page: Page): Promise<void> {
  await page.locator("form input[type=text]").first().waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await page.locator("form input[type=password]").nth(1).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "登入" }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await page.waitForTimeout(1_000);
}

async function signInCtbc(
  page: Page,
  credentials: CtbcCredentials,
): Promise<void> {
  const userId = requireCredential(credentials, "ctbc_user_id");
  const account = requireCredential(credentials, "ctbc_account");
  const password = requireCredential(credentials, "ctbc_password");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
      await waitForLoginForm(page);
      await page.locator("form input[type=text]").first().fill(userId);
      const passwordFields = page.locator("form input[type=password]");
      await passwordFields.nth(0).fill(account);
      await passwordFields.nth(1).fill(password);
      await page.getByRole("button", { name: "登入" }).click();
      break;
    } catch {
      if (attempt === 2) {
        throw new Error("Timed out waiting for the CTBC login form.");
      }
      await page.waitForTimeout(1_000);
    }
  }
  await finishCtbcSignIn(page);
}

function requireCtbcOk<T>(
  response: CtbcResourceResponse<T>,
  resource: string,
): void {
  if (response.code === "0000") return;
  throw new Error(
    `CTBC resource ${resource} returned ${response.code ?? "unknown"}: ${cleanText(response.message ?? response.msg)}`,
  );
}

function isCtbcResourceResponse(resource: string) {
  return (response: Response): boolean => {
    const request = response.request();
    const postData = request.postData() ?? "";
    return (
      request.method() === "POST" &&
      response.url().includes(EBMW_RESOURCE_PATH) &&
      postData.includes(`"resource":"${resource}"`)
    );
  };
}

async function nextCtbcResource<T>(
  page: Page,
  resource: string,
  options: { allowNoData?: boolean } = {},
): Promise<CtbcResourceCapture<T>> {
  const response = await page.waitForResponse(
    isCtbcResourceResponse(resource),
    {
      timeout: 60_000,
    },
  );
  const body = (await response.json()) as CtbcResourceResponse<T>;
  if (!(body.code === NO_DATA_CODE && options.allowNoData)) {
    requireCtbcOk(body, resource);
  }
  const request = response.request();
  return {
    body,
    request: {
      method: request.method(),
      url: request.url(),
      postData: request.postData(),
    },
  };
}

function detailsFromCapture(
  capture: CtbcResourceCapture<CtbcDetailData>,
  telemetry = false,
) {
  if (telemetry) {
    console.log("ctbc-domestic-detail-telemetry", {
      responseClass:
        capture.body.code === NO_DATA_CODE ? "provider-no-data" : "ok",
      ...ctbcDetailTelemetry(capture.body.rsData ?? undefined),
    });
  }
  if (capture.body.code === NO_DATA_CODE) return [];
  if (
    !capture.body.rsData ||
    typeof capture.body.rsData !== "object" ||
    !Array.isArray(capture.body.rsData.detailList)
  )
    throw new Error(
      "CTBC successful detail response lacks an explicit detailList array.",
    );
  return capture.body.rsData.detailList;
}

export function ctbcResponseShape(
  body: CtbcResourceResponse<CtbcDetailData>,
): CtbcResponseShapeEvidence {
  const hasRsData = Object.prototype.hasOwnProperty.call(body, "rsData");
  const rsData = body.rsData;
  const rsDataKind =
    rsData === null
      ? ("null" as const)
      : rsData && typeof rsData === "object" && !Array.isArray(rsData)
        ? ("object" as const)
        : ("other" as const);
  const hasDetailList =
    rsDataKind === "object" &&
    Object.prototype.hasOwnProperty.call(rsData, "detailList");
  const detailListIsArray = Array.isArray(rsData?.detailList);
  return {
    hasRsData,
    rsDataKind,
    hasDetailList,
    detailListIsArray,
    detailListRowCount: detailListIsArray ? rsData.detailList!.length : null,
    nextKeyPresent:
      typeof rsData?.nextKey === "string" && rsData.nextKey.trim().length > 0,
  };
}

async function openDomesticDetailsPage(page: Page, telemetry = false) {
  const bootstrapPromise = nextCtbcResource<CtbcBootstrapData>(
    page,
    "/twrbc-deposit/qu002/010",
  );
  const initialDetailsPromise = nextCtbcResource<CtbcDetailData>(
    page,
    "/twrbc-deposit/qu002/011",
    { allowNoData: true },
  );

  await page.goto(DOMESTIC_DETAILS_URL, { waitUntil: "domcontentloaded" });
  const [bootstrap, initialDetails] = await Promise.all([
    bootstrapPromise,
    initialDetailsPromise,
  ]);
  return {
    data: bootstrap.body.rsData ?? {},
    initialCapture: initialDetails,
  };
}

function detailAccountDropdown(page: Page): Locator {
  return page.locator("div.btn.dropdown-toggle").first();
}

function detailAccountOptions(page: Page): Locator {
  return page.locator("a.dropdown-item").filter({ hasText: "帳戶餘額" });
}

function accountFromOptionText(
  text: string,
  optionIndex: number,
): CtbcAccount | null {
  const accountId = text.match(/\d{10,16}/)?.[0] ?? "";
  if (!accountId) return null;
  return {
    accountId,
    optionIndex,
    label: `新臺幣-${accountId}`,
  };
}

async function readDetailAccountOptions(
  page: Page,
  fallbackAccounts: CtbcAccount[],
): Promise<CtbcAccount[]> {
  const dropdown = detailAccountDropdown(page);
  if (!(await dropdown.isVisible().catch(() => false))) {
    return resolveCtbcAccountScope([], fallbackAccounts);
  }
  await dropdown.click();
  const optionVisible = await detailAccountOptions(page)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!optionVisible) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return resolveCtbcAccountScope([], fallbackAccounts);
  }

  const count = await detailAccountOptions(page).count();
  const accounts: CtbcAccount[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = cleanText(
      await detailAccountOptions(page).nth(index).textContent(),
    );
    const account = accountFromOptionText(text, index);
    if (account) accounts.push(account);
  }
  await page.keyboard.press("Escape");

  return resolveCtbcAccountScope(accounts, fallbackAccounts);
}

export function resolveCtbcAccountScope(
  uiAccounts: CtbcAccount[],
  fallbackAccounts: CtbcAccount[],
): CtbcAccount[] {
  if (uiAccounts.length > 0) return uiAccounts;
  if (fallbackAccounts.length <= 1) return fallbackAccounts;
  throw new Error(
    "CTBC account selector did not expose stable options for every account.",
  );
}

async function selectDetailAccount(
  page: Page,
  account: CtbcAccount,
  telemetry = false,
) {
  if (account.optionIndex === undefined) {
    throw new Error(`No CTBC page option index for ${account.label}.`);
  }

  await detailAccountDropdown(page).click();
  const option = detailAccountOptions(page).nth(account.optionIndex);
  await option.waitFor({ state: "visible", timeout: 60_000 });

  const bootstrapPromise = nextCtbcResource<CtbcBootstrapData>(
    page,
    "/twrbc-deposit/qu002/010",
  );
  const initialDetailsPromise = nextCtbcResource<CtbcDetailData>(
    page,
    "/twrbc-deposit/qu002/011",
    { allowNoData: true },
  );
  await option.click();
  const [bootstrap, initialDetails] = await Promise.all([
    bootstrapPromise,
    initialDetailsPromise,
  ]);

  return {
    data: bootstrap.body.rsData ?? {},
    initialCapture: initialDetails,
  };
}

function accountFromRaw(raw: CtbcRawAccount): CtbcAccount | null {
  const accountId = cleanText(raw.accountId);
  if (!accountId) return null;
  const nickname = cleanText(raw.accountNickName);
  return {
    accountId,
    nickname,
    label: nickname ? `新臺幣-${accountId} ${nickname}` : `新臺幣-${accountId}`,
  };
}

function accountsFromBootstrap(data: CtbcBootstrapData): CtbcAccount[] {
  const accounts = (data.accountInfoList ?? [])
    .map(accountFromRaw)
    .filter((account): account is CtbcAccount => account !== null);
  if (accounts.length === 0 && cleanText(data.accountId)) {
    accounts.push({
      accountId: cleanText(data.accountId),
      label: `新臺幣-${cleanText(data.accountId)}`,
    });
  }

  return [
    ...new Map(
      accounts.map((account) => [account.accountId, account]),
    ).values(),
  ];
}

function filterAccounts(
  accounts: CtbcAccount[],
  filters: string[] | undefined,
): CtbcAccount[] {
  const cleanFilters = filters?.map(cleanText).filter(Boolean) ?? [];
  if (cleanFilters.length === 0) return accounts;
  return accounts.filter((account) =>
    cleanFilters.some((filter) =>
      `${account.label} ${account.accountId}`.includes(filter),
    ),
  );
}

function queryPeriodForDateRange(dateRange: CtbcDateRange): string {
  const startDate = slashDate(dateRange.firstDateYYYYMMDD);
  const endDate = slashDate(dateRange.lastDateYYYYMMDD);
  if (startDate && endDate) return `${startDate}~${endDate}`;
  return cleanText(dateRange.currMonthYYYYMM);
}

function queryPeriodsForBootstrap(
  bootstrap: CtbcBootstrapData,
  input: z.infer<typeof inputSchema>,
): string[] {
  if (input.startDate || input.endDate) {
    return [`${input.startDate ?? ""}~${input.endDate ?? ""}`];
  }

  return (bootstrap.dateRanges ?? [])
    .map(queryPeriodForDateRange)
    .filter(Boolean);
}

function monthTabs(page: Page): Locator {
  return page.locator("a.nav-link").filter({ hasText: /\d{4}\/\d{2}/ });
}

async function captureVisibleMonthDetails(
  page: Page,
  initialCapture: CtbcResourceCapture<CtbcDetailData>,
  telemetry = false,
): Promise<Array<CtbcResourceCapture<CtbcDetailData>>> {
  const tabs = monthTabs(page);
  await tabs.first().waitFor({ state: "visible", timeout: 60_000 });
  const captures = [
    {
      ...initialCapture,
      visibleMonthLabel: cleanText(await tabs.first().textContent()),
    },
  ];
  detailsFromCapture(initialCapture, telemetry);

  const count = await tabs.count();
  for (let index = 1; index < count; index += 1) {
    const visibleMonthLabel = cleanText(await tabs.nth(index).textContent());
    const detailPromise = nextCtbcResource<CtbcDetailData>(
      page,
      "/twrbc-deposit/qu002/011",
      { allowNoData: true },
    );
    await tabs.nth(index).click();
    const capture = await detailPromise;
    detailsFromCapture(capture, telemetry);
    captures.push({ ...capture, visibleMonthLabel });
  }

  return captures;
}

async function accountRowsFromCurrentPage(
  page: Page,
  account: CtbcAccount,
  bootstrap: CtbcBootstrapData,
  initialCapture: CtbcResourceCapture<CtbcDetailData>,
  input: z.infer<typeof inputSchema>,
): Promise<{
  queryPeriods: string[];
  rows: CtbcStatementRow[];
  responses: CtbcObservedRangeResponse[];
}> {
  const captures = await captureVisibleMonthDetails(
    page,
    initialCapture,
    input.telemetry,
  );
  const ranges = bootstrap.dateRanges ?? [];
  const queryPeriods = queryPeriodsForBootstrap(bootstrap, input);
  const diagnosticDirectory =
    ctbcResponseDiagnosticDirectoryFromEnvironment();
  for (const [rangeOrdinal, capture] of captures.entries()) {
    await writeCtbcResponseDiagnostic(diagnosticDirectory, {
      capturedAt: new Date().toISOString(),
      resource: "/twrbc-deposit/qu002/011",
      account: {
        accountId: account.accountId,
        label: account.label,
      },
      rangeOrdinal,
      visibleMonthLabel: capture.visibleMonthLabel ?? null,
      expectedRange: ranges[rangeOrdinal] ?? null,
      queryPeriods,
      request: capture.request,
      response: capture.body,
    });
  }
  const responses = captures.map((capture, rangeOrdinal) => {
    const code = capture.body.code === NO_DATA_CODE ? NO_DATA_CODE : "0000";
    const nextKey = cleanText(capture.body.rsData?.nextKey) || null;
    const range = ranges[rangeOrdinal];
    return {
      rangeOrdinal,
      startDate: slashDate(range?.firstDateYYYYMMDD),
      endDate: slashDate(range?.lastDateYYYYMMDD),
      code,
      nextKey,
      terminal: nextKey === null,
      rows: ctbcDetailRowsToStatementRows(account, detailsFromCapture(capture)),
      responseShape: ctbcResponseShape(capture.body),
    } satisfies CtbcObservedRangeResponse;
  });
  const rows = responses
    .flatMap((response) => response.rows)
    .filter((row) => rowWithinDateRange(row, input));
  return {
    queryPeriods,
    rows,
    responses,
  };
}

async function writeStatementFiles(
  account: CtbcAccount,
  queryPeriods: string[],
  rows: CtbcStatementRow[],
): Promise<CtbcDownload> {
  const downloadsDir = join(process.cwd(), "downloads", "ctbc-statements");
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${safeFilename(account.accountId)}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);

  await writeFile(csvPath, ctbcStatementRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: account.label,
        查詢期間: queryPeriods,
        分行名稱: "",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    account: account.label,
    accountId: account.accountId,
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

async function downloadCtbcStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
): Promise<CtbcCollectedStatements> {
  const opened = await openDomesticDetailsPage(page, input.telemetry);
  const allAccounts = await readDetailAccountOptions(
    page,
    accountsFromBootstrap(opened.data),
  );
  const accounts = filterAccounts(allAccounts, input.accountFilters);

  if (input.telemetry) {
    console.log("ctbc-domestic-account-scope-telemetry", {
      providerAccountCount: accountsFromBootstrap(opened.data).length,
      uiAccountCount: allAccounts.length,
      selectedAccountCount: accounts.length,
      dateRangeCount: opened.data.dateRanges?.length ?? 0,
    });
  }

  if (accounts.length === 0) {
    return {
      output: { count: 0, rowCount: 0, downloads: [] },
      captures: [],
    };
  }

  const downloads: CtbcDownload[] = [];
  const captures: CtbcObservedAccountCapture[] = [];
  let currentOptionIndex = 0;
  for (const account of accounts) {
    let bootstrap = opened.data;
    let initialCapture = opened.initialCapture;

    if (
      account.optionIndex !== undefined &&
      account.optionIndex !== currentOptionIndex
    ) {
      const selected = await selectDetailAccount(
        page,
        account,
        input.telemetry,
      );
      bootstrap = selected.data;
      initialCapture = selected.initialCapture;
      currentOptionIndex = account.optionIndex;
    }

    const { queryPeriods, rows, responses } = await accountRowsFromCurrentPage(
      page,
      account,
      bootstrap,
      initialCapture,
      input,
    );
    downloads.push(await writeStatementFiles(account, queryPeriods, rows));
    captures.push({
      accountId: account.accountId,
      queryPeriods,
      expectedRangeCount: bootstrap.dateRanges?.length ?? 0,
      responses,
    });
  }

  return {
    output: {
      count: downloads.length,
      rowCount: downloads.reduce((sum, download) => sum + download.rowCount, 0),
      downloads,
    },
    captures,
  };
}

function ctbcObservedAt(now = Date.now()): string {
  return new Date(now + 8 * 60 * 60 * 1_000)
    .toISOString()
    .replace("Z", "+08:00");
}

function buildCtbcCapture(
  observed: CtbcObservedAccountCapture,
  observedAt: string,
): CtbcDomesticDepositCaptureEvidence {
  const starts = observed.responses
    .map((response) => response.startDate)
    .sort();
  const ends = observed.responses.map((response) => response.endDate).sort();
  return {
    evidenceVersion: CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "ctbc",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt,
    account: { accountId: observed.accountId },
    queryRange: {
      startDate: starts[0] ?? "",
      endDate: ends.at(-1) ?? "",
    },
    responses: observed.responses.map((response) => ({
      rangeOrdinal: response.rangeOrdinal,
      startDate: response.startDate,
      endDate: response.endDate,
      code: response.code,
      nextKey: response.nextKey,
      terminal: response.terminal,
      responseShape: response.responseShape,
      rows: response.rows.map((row, rowOrdinal) => ({
        rowOrdinal,
        values: row.values,
      })),
    })),
    provenance: {
      source: "ctbc-ebmw-qu002-011-natural-response",
      rangeInventorySource: "ctbc-ebmw-qu002-010-dateRanges",
      expectedRangeCount: observed.expectedRangeCount,
      responseBodyRetained: false,
      authority: "personal-main",
    },
  };
}

export async function runCtbcStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
  overrides: CtbcStatementsRunDependencies = {},
): Promise<CtbcStatementsOutput> {
  const collected = await (
    overrides.collectStatements ?? downloadCtbcStatements
  )(page, input);
  if (collected.captures.length === 0) {
    return {
      ...collected.output,
      sourceCaptureCount: 0,
      status: "absent",
    };
  }

  const observedAt = overrides.observedAt ?? ctbcObservedAt();
  const captures: CtbcDomesticDepositValidatedEvidence[] = [];
  for (const observed of collected.captures) {
    const admission = admitCtbcDomesticDepositCaptureEvidence(
      buildCtbcCapture(observed, observedAt),
    );
    if (admission.status !== "admissible" || !admission.capture) {
      throw new Error(
        `CTBC domestic deposit source admission blocked: ${admission.diagnostics.join(", ")}`,
      );
    }
    captures.push(admission.capture);
  }

  const sourceLedgerDir =
    overrides.canonicalSourceLedgerDir ??
    process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
    process.env.LEDGER_DIR ??
    DEFAULT_LEDGER_DIR;
  const sourceStore = createCanonicalSourceStore(
    canonicalSqlitePath(sourceLedgerDir),
  );
  const financialLedgerDir = overrides.canonicalFinancialLedgerDir;
  const financialDatabasePath = financialLedgerDir
    ? canonicalSqlitePath(financialLedgerDir)
    : null;
  const financialStore = financialDatabasePath
    ? financialDatabasePath === canonicalSqlitePath(sourceLedgerDir)
      ? sourceStore
      : createCanonicalSourceStore(financialDatabasePath)
    : null;
  const financialWriter: CanonicalFinancialDepositWriterStore | null =
    financialStore
      ? {
          db: financialStore.db,
          databasePath: financialStore.databasePath,
          commitClock: () => financialStore.commitClock(),
        }
      : null;
  const financialUsesSourceStore = financialStore === sourceStore;
  const captureEntries = captures.map((capture, index) => ({
    capture,
    captureId: `ctbc-${observedAt}-${index}`,
  }));
  let status: CtbcStatementsOutput["status"] = "source-only";

  try {
    if (!financialWriter || !financialUsesSourceStore) {
      await commitCtbcDomesticDepositSourceEvidenceBatch(
        sourceStore,
        captureEntries,
      );
    }
    if (financialWriter) {
      const manifest = getCtbcHumanAttestedV1Manifest();
      const financialInputs = captureEntries.map(({ capture, captureId }) => ({
        capture,
        captureId: `ctbc-financial-${captureId}`,
        humanAttestation: manifest,
      }));
      const admissions = financialInputs.map(
        admitCtbcDomesticDepositFinancialCapture,
      );
      if (admissions.every((admission) => admission.status === "admitted")) {
        await commitCanonicalCtbcDomesticDepositCaptureBatch(
          financialWriter,
          financialInputs,
        );
        status = "financial-admitted";
      } else if (financialUsesSourceStore) {
        await commitCtbcDomesticDepositSourceEvidenceBatch(
          sourceStore,
          captureEntries,
        );
      }
    }
  } finally {
    if (financialStore && !financialUsesSourceStore) financialStore.close();
    sourceStore.close();
  }

  return {
    ...collected.output,
    sourceCaptureCount: captures.length,
    status,
  };
}

export default workflow("ctbcStatements", {
  startUrl: LOGIN_URL,
  credentials: ["ctbc_user_id", "ctbc_account", "ctbc_password"],
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
        await signInCtbc(page, input.credentials);
      },
    });

    console.log("automation-progress: 25");
    const result = await runCtbcStatements(page, input, {
      canonicalFinancialLedgerDir: CTBC_HUMAN_ATTESTED_V1_CONFIRMED
        ? process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR
        : undefined,
    });
    console.log("automation-progress: 100");
    return result;
  },
});
