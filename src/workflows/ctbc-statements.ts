import { mkdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  librettoAuthenticate,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Locator, Page, Response } from "playwright";
import { z } from "zod";
import { emitAutomationProgress } from "../lib/automation/progress.ts";
import { requirePGliteChildRpcClientFromEnv } from "../../electron/pglite-child-rpc-client.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import {
  executePGliteWorkflowRun,
  type PGliteWorkflowRunItem,
} from "../ledger/pglite/workflow-run.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  admitCtbcDomesticDepositCaptureEvidence,
  admitCtbcDomesticDepositFinancialCapture,
  createCtbcDomesticDepositSourceEvidence,
  CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  deriveCtbcDomesticDepositAccountNumberEvidence,
  type CtbcDomesticDepositCaptureEvidence,
  type CtbcDomesticDepositValidatedEvidence,
} from "../ledger/canonical/ctbc-domestic-deposit-admission.ts";
import {
  getCtbcHumanAttestedV1Manifest,
} from "../ledger/canonical/ctbc-human-attestation-contract.ts";
import {
  ctbcResponseDiagnosticDirectoryFromEnvironment,
  writeCtbcResponseDiagnostic,
} from "./ctbc-response-diagnostic.ts";
import {
  CTBC_CURRENT_DEPOSIT_BALANCE_HOST,
  CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE,
  readCtbcCurrentDepositBalances,
  type CtbcCurrentDepositBalanceRow,
} from "./ctbc-current-deposit-balances.ts";
import {
  admitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/pglite/current-deposit-admission.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { emitHumanAssistanceStage, type WorkflowHumanAssistanceStage } from "./human-assistance.ts";

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

const typedInputSchema = z.object({
  credentials: z.object({
    ctbc_user_id: z.string().trim().min(1),
    ctbc_account: z.string().trim().min(1),
    ctbc_password: z.string().trim().min(1),
  }),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountFilters: z.array(z.string()).optional(),
});

export type CtbcProviderWorkflowOutput = Readonly<{
  count: number;
  rowCount: number;
  sourceCaptureCount: number;
  status: "source-only" | "financial-admitted";
}>;

export type CtbcProviderWorkflowDependencies = Readonly<{
  collectStatements?: (
    page: Page,
    input: z.infer<typeof typedInputSchema>,
  ) => Promise<CtbcCollectedStatements>;
  readCurrentDepositBalances?: typeof readCtbcCurrentDepositBalances;
}>;

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

export type CtbcCollectedStatements = {
  output: Omit<CtbcStatementsOutput, "sourceCaptureCount" | "status">;
  captures: CtbcObservedAccountCapture[];
};

type ExistingCtbcFinancialCapture = Readonly<{
  authorityRoute: string;
  identity: Readonly<{
    integrationNamespace: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    stream: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    accountNumber?: Readonly<{ value: string }> | null;
    currency: string | null;
  }>;
}>;

export type CtbcStatementsRunDependencies = {
  collectStatements?: (
    page: Page,
    input: z.infer<typeof inputSchema>,
  ) => Promise<CtbcCollectedStatements>;
  observedAt?: string;
  /** Injected in checks; production passively reads the authenticated summary POST. */
  readCurrentDepositBalances?: typeof readCtbcCurrentDepositBalances;
};

export type CtbcStatementRow = {
  account: string;
  accountId: string;
  accountingDate: string;
  transactionDate: string;
  sortKey: string;
  values: string[];
};

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("CTBC workflow was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Decode provider JSON through the injected strict text port before use. */
export function decodeCtbcSourceJson<T>(
  bytes: Uint8Array,
  text: SourceTextPort,
): T {
  const decoded = text.decode(bytes, "utf-8");
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error("CTBC provider response is not valid JSON.");
  }
  // JSON may encode U+FFFD as an escape, so check the parsed source fields too.
  text.assertIntact(JSON.stringify(value));
  return value as T;
}

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

async function clickVisibleNow(locator: Locator, signal?: AbortSignal): Promise<boolean> {
  if (!(await withAbort(locator.isVisible().catch(() => false), signal))) return false;
  await withAbort(locator.click(), signal);
  return true;
}

async function finishCtbcSignIn(page: Page, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await clickVisibleNow(actionByText(page, "確認登入"), signal)) {
      await withAbort(page.waitForTimeout(1_000), signal);
      continue;
    }

    if (await clickVisibleNow(actionByText(page, "下次再提醒"), signal)) {
      await withAbort(page.waitForTimeout(1_000), signal);
      continue;
    }

    if (await withAbort(
      page
        .locator("#btnHeaderLogout")
        .isVisible()
        .catch(() => false),
      signal,
    )) {
      return;
    }

    await withAbort(page.waitForTimeout(500), signal);
  }

  throw new Error("Timed out waiting for CTBC sign-in to finish.");
}

async function isSignedIn(page: Page, signal?: AbortSignal): Promise<boolean> {
  return await withAbort(page
    .locator("#btnHeaderLogout")
    .isVisible()
    .catch(() => false), signal);
}

async function waitForLoginForm(page: Page, signal?: AbortSignal): Promise<void> {
  await withAbort(page.locator("form input[type=text]").first().waitFor({
    state: "visible",
    timeout: 60_000,
  }), signal);
  await withAbort(page.locator("form input[type=password]").nth(1).waitFor({
    state: "visible",
    timeout: 60_000,
  }), signal);
  await withAbort(page.getByRole("button", { name: "登入" }).waitFor({
    state: "visible",
    timeout: 60_000,
  }), signal);
  await withAbort(page.waitForTimeout(1_000), signal);
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

function ctbcManualSignInStage(page: Page): WorkflowHumanAssistanceStage {
  const body = page.locator("body");
  return {
    stageId: "ctbc-login-verification",
    title: "Complete CTBC sign-in or verification",
    targets: [{
      id: "sign-in-page",
      label: "CTBC sign-in page",
      semanticId: "ctbc.login.page",
      modes: ["click", "type", "press"],
      locator: body,
    }],
    contextRegions: [{
      id: "sign-in-context",
      label: "CTBC sign-in and verification",
      semanticId: "ctbc.login.context",
      locator: body,
    }],
    completion: { mode: "independent", targetIds: ["sign-in-page"] },
    focus: { targetId: "sign-in-page", contextRegionIds: ["sign-in-context"] },
    prompt: "Complete any provider verification in the open CTBC page, then wait for sign-in to finish.",
  };
}

async function signInCtbcForApp(
  page: Page,
  credentials: CtbcCredentials,
  context: WorkflowContext,
): Promise<void> {
  if (await isSignedIn(page, context.signal)) return;
  const userId = requireCredential(credentials, "ctbc_user_id");
  const account = requireCredential(credentials, "ctbc_account");
  const password = requireCredential(credentials, "ctbc_password");

  await withAbort(page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }), context.signal);
  await waitForLoginForm(page, context.signal);
  await withAbort(page.locator("form input[type=text]").first().fill(userId), context.signal);
  const passwordFields = page.locator("form input[type=password]");
  await withAbort(passwordFields.nth(0).fill(account), context.signal);
  await withAbort(passwordFields.nth(1).fill(password), context.signal);
  await withAbort(page.getByRole("button", { name: "登入" }).click(), context.signal);
  await withAbort(page.waitForTimeout(1_000), context.signal);
  if (await isSignedIn(page, context.signal)) return;

  const contract = await emitHumanAssistanceStage(
    ctbcManualSignInStage(page),
    () => undefined,
  );
  await context.event("authentication", "human-assistance-requested");
  const status = await context.humanAssistance.request(contract, context.signal);
  context.signal.throwIfAborted();
  if (status !== "entered" && status !== "verified") {
    await context.event("authentication", "human-assistance-failed");
    throw new Error(`CTBC human assistance ended with status ${status}.`);
  }
  await finishCtbcSignIn(page, context.signal);
  await context.event("authentication", "human-assistance-completed");
}

function requireCtbcOk<T>(
  response: CtbcResourceResponse<T>,
  resource: string,
  typedPath = false,
): void {
  if (response.code === "0000") return;
  const code = response.code ?? "unknown";
  throw new Error(typedPath
    ? `CTBC resource ${resource} returned ${code}.`
    : `CTBC resource ${resource} returned ${code}: ${cleanText(response.message ?? response.msg)}`);
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
  options: { allowNoData?: boolean; context?: WorkflowContext } = {},
): Promise<CtbcResourceCapture<T>> {
  const response = await withAbort(page.waitForResponse(
    isCtbcResourceResponse(resource),
    {
      timeout: 60_000,
    },
  ), options.context?.signal);
  let body: CtbcResourceResponse<T>;
  if (options.context) {
    try {
      const bytes = await withAbort(response.body(), options.context.signal);
      body = decodeCtbcSourceJson<CtbcResourceResponse<T>>(
        bytes,
        options.context.text,
      );
    } catch (error) {
      await options.context.event("decoding", "source-decoding-failed");
      throw error;
    }
  } else {
    body = (await response.json()) as CtbcResourceResponse<T>;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    if (options.context)
      await options.context.event("validation", "source-response-rejected");
    throw new Error("CTBC provider response shape is invalid.");
  }
  if (!(body.code === NO_DATA_CODE && options.allowNoData)) {
    requireCtbcOk(body, resource, options.context !== undefined);
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

async function openDomesticDetailsPage(
  page: Page,
  telemetry = false,
  context?: WorkflowContext,
) {
  const bootstrapPromise = nextCtbcResource<CtbcBootstrapData>(
    page,
    "/twrbc-deposit/qu002/010",
    { context },
  );
  const initialDetailsPromise = nextCtbcResource<CtbcDetailData>(
    page,
    "/twrbc-deposit/qu002/011",
    { allowNoData: true, context },
  );

  await withAbort(page.goto(DOMESTIC_DETAILS_URL, { waitUntil: "domcontentloaded" }), context?.signal);
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
  context?: WorkflowContext,
): Promise<CtbcAccount[]> {
  const dropdown = detailAccountDropdown(page);
  if (!(await withAbort(dropdown.isVisible().catch(() => false), context?.signal))) {
    return resolveCtbcAccountScope([], fallbackAccounts);
  }
  await withAbort(dropdown.click(), context?.signal);
  const optionVisible = await withAbort(detailAccountOptions(page)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false), context?.signal);
  if (!optionVisible) {
    await withAbort(page.keyboard.press("Escape").catch(() => undefined), context?.signal);
    return resolveCtbcAccountScope([], fallbackAccounts);
  }

  const count = await withAbort(detailAccountOptions(page).count(), context?.signal);
  const accounts: CtbcAccount[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = cleanText(
      await withAbort(detailAccountOptions(page).nth(index).textContent(), context?.signal),
    );
    const account = accountFromOptionText(text, index);
    if (account) accounts.push(account);
  }
  await withAbort(page.keyboard.press("Escape"), context?.signal);

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
  context?: WorkflowContext,
) {
  if (account.optionIndex === undefined) {
    throw new Error(`No CTBC page option index for ${account.label}.`);
  }

  await withAbort(detailAccountDropdown(page).click(), context?.signal);
  const option = detailAccountOptions(page).nth(account.optionIndex);
  await withAbort(option.waitFor({ state: "visible", timeout: 60_000 }), context?.signal);

  const bootstrapPromise = nextCtbcResource<CtbcBootstrapData>(
    page,
    "/twrbc-deposit/qu002/010",
    { context },
  );
  const initialDetailsPromise = nextCtbcResource<CtbcDetailData>(
    page,
    "/twrbc-deposit/qu002/011",
    { allowNoData: true, context },
  );
  await withAbort(option.click(), context?.signal);
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
  context?: WorkflowContext,
): Promise<Array<CtbcResourceCapture<CtbcDetailData>>> {
  const tabs = monthTabs(page);
  await withAbort(tabs.first().waitFor({ state: "visible", timeout: 60_000 }), context?.signal);
  const captures = [
    {
      ...initialCapture,
      visibleMonthLabel: cleanText(await withAbort(tabs.first().textContent(), context?.signal)),
    },
  ];
  detailsFromCapture(initialCapture, telemetry);

  const count = await withAbort(tabs.count(), context?.signal);
  for (let index = 1; index < count; index += 1) {
    context?.signal.throwIfAborted();
    const visibleMonthLabel = cleanText(await withAbort(tabs.nth(index).textContent(), context?.signal));
    const detailPromise = nextCtbcResource<CtbcDetailData>(
      page,
      "/twrbc-deposit/qu002/011",
      { allowNoData: true, context },
    );
    await withAbort(tabs.nth(index).click(), context?.signal);
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
  context?: WorkflowContext,
): Promise<{
  queryPeriods: string[];
  rows: CtbcStatementRow[];
  responses: CtbcObservedRangeResponse[];
}> {
  const captures = await captureVisibleMonthDetails(
    page,
    initialCapture,
    context ? false : input.telemetry,
    context,
  );
  const ranges = bootstrap.dateRanges ?? [];
  const queryPeriods = queryPeriodsForBootstrap(bootstrap, input);
  if (!context) {
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

async function collectCtbcStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
  context?: WorkflowContext,
): Promise<CtbcCollectedStatements> {
  const opened = await openDomesticDetailsPage(page, input.telemetry, context);
  const allAccounts = await readDetailAccountOptions(
    page,
    accountsFromBootstrap(opened.data),
    context,
  );
  const accounts = filterAccounts(allAccounts, input.accountFilters);

  if (input.telemetry && !context) {
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
  let rowCount = 0;
  for (const account of accounts) {
    context?.signal.throwIfAborted();
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
        context,
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
      context,
    );
    rowCount += rows.length;
    if (!context) {
      downloads.push(await writeStatementFiles(account, queryPeriods, rows));
    }
    captures.push({
      accountId: account.accountId,
      queryPeriods,
      expectedRangeCount: bootstrap.dateRanges?.length ?? 0,
      responses,
    });
    if (context) {
      await context.event("collection", "account-collected", {
        completed: captures.length,
        total: accounts.length,
      });
    }
  }

  return {
    output: {
      count: accounts.length,
      rowCount,
      downloads,
    },
    captures,
  };
}

async function downloadCtbcStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
): Promise<CtbcCollectedStatements> {
  return collectCtbcStatements(page, input);
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
  const accountNumber = deriveCtbcDomesticDepositAccountNumberEvidence(
    observed.accountId,
  );
  return {
    evidenceVersion: CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "ctbc",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt,
    account: {
      accountId: observed.accountId,
      ...(accountNumber ? { accountNumber } : {}),
    },
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

function ctbcCurrentDepositOpaqueKey(
  domain: string,
  ...parts: readonly string[]
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(`${domain}\u0000`)
    .update(parts.join("\u0000"))
    .digest("base64url")}`;
}

/**
 * Join the current summary to an already admitted CTBC statement identity.
 * The provider accountId is retained as exact evidence, including leading
 * zeroes; no current-summary row can create a new canonical account.
 */
export function buildCtbcCurrentDepositBalanceCapture(
  row: CtbcCurrentDepositBalanceRow,
  financialCapture: ExistingCtbcFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  if (
    financialCapture.authorityRoute !== "ctbc/domestic-deposit/human-attested-v1" ||
    identity.integrationNamespace !== "ctbc" ||
    identity.stream !== "domestic-deposit" ||
    identity.currency !== "TWD"
  )
    throw new Error("CTBC current deposit identity is not an admitted TWD CTBC account.");
  if (
    identity.accountNo !== row.accountNumber ||
    sourceAccountKey !== row.sourceAccountKey ||
    identity.accountNumber?.value !== row.accountNumber
  )
    throw new Error(
      "CTBC current deposit accountId does not exactly match existing account evidence.",
    );

  const contractVersion = row.sourceEvidence.contractVersion;
  const balance: CurrentDepositExactAmount = {
    coefficient: row.ledger.coefficient,
    scale: row.ledger.scale,
  };
  const sourceField = "balance";
  const time = {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-system-time" as const,
    effectiveTimeRuleVersion: contractVersion,
    sourceField: "serverTime",
    sourceValue: String(row.providerServerTime),
    contractVersion,
  };
  const sourceRecordKey = ctbcCurrentDepositOpaqueKey(
    "ctbc-current-deposit-source-record-v1",
    sourceAccountKey,
    row.effectiveAt,
    balance.coefficient,
    String(balance.scale),
  );
  const compact = {
    source: "ctbc",
    accountId: row.accountNumber,
    sourceAccountKey,
    currency: row.currency,
    sourceLexeme: row.ledger.sourceLexeme,
    providerFields: { ...row.providerFields },
    providerServerTime: row.providerServerTime,
    providerDataTime: row.providerDataTime,
    providerHttpDate: row.providerHttpDate,
    requestResource: row.sourceEvidence.requestResource,
    sourceEvidence: { ...row.sourceEvidence },
  };
  const provisional = currentDepositSourceRecord({
    sourceRecordKey,
    providerKey: ctbcCurrentDepositOpaqueKey(
      "ctbc-current-deposit-provider-record-v1",
      sourceAccountKey,
      row.effectiveAt,
    ),
    contentHash: "sha256:placeholder",
    sourceField,
    balanceKind: "ledger",
    currency: row.currency,
    value: balance,
    time,
    compact,
  });
  const record: CurrentDepositSourceRecordInput = {
    ...provisional,
    contentHash: currentDepositSourceRecordContentHash(provisional.compact),
  };
  const observation: CurrentDepositBalanceObservationInput = {
    observationKey: ctbcCurrentDepositOpaqueKey(
      "ctbc-current-deposit-observation-v1",
      sourceAccountKey,
    ),
    balanceKind: "ledger",
    balance,
    currency: row.currency,
    time,
    sourceRecordKey,
    sourceField,
  };
  const scopeDate = row.providerDataTime.slice(0, 10).replaceAll("/", "-");
  const route = "ctbc/domestic-deposit/current-balance-v1";
  return {
    captureId: `ctbc-current-${randomUUID()}`,
    authorityRoute: route,
    contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "ctbc",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: scopeDate,
      endDate: scopeDate,
      contractFingerprint: ctbcCurrentDepositOpaqueKey("ctbc-current-deposit-contract-v1", route),
      preflightFingerprint: ctbcCurrentDepositOpaqueKey(
        "ctbc-current-deposit-preflight-v1",
        identity.subjectDigest,
        scopeDate,
      ),
    },
    providerResponse: {
      endpoint: `https://${CTBC_CURRENT_DEPOSIT_BALANCE_HOST}${row.sourceEvidence.endpoint}`,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
      requestResource: row.sourceEvidence.requestResource,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: {
          source: "ctbc-current-deposit-summary",
          endpoint: row.sourceEvidence.endpoint,
          resource: row.sourceEvidence.requestResource,
          accountId: row.accountNumber,
          providerServerTime: row.providerServerTime,
          providerDataTime: row.providerDataTime,
          providerHttpDate: row.providerHttpDate,
        },
      },
    ],
    records: [record],
    observations: [observation],
  };
}

export function indexCtbcCurrentDepositFinancialCaptures(
  financialCaptures: readonly ExistingCtbcFinancialCapture[],
): ReadonlyMap<string, ExistingCtbcFinancialCapture> {
  const result = new Map<string, ExistingCtbcFinancialCapture>();
  for (const candidate of financialCaptures) {
    const identity = candidate.identity;
    const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
    const key = `${identity.sourceConnectionKey}\u0000${identity.identityEpochKey}\u0000${identity.stream}\u0000${sourceAccountKey}`;
    const prior = result.get(key);
    if (
      prior &&
      (prior.authorityRoute !== candidate.authorityRoute ||
        prior.identity.accountNo !== identity.accountNo ||
        prior.identity.accountNumber?.value !== identity.accountNumber?.value ||
        prior.identity.subjectDigest !== identity.subjectDigest ||
        prior.identity.currency !== identity.currency)
    )
      throw new Error("CTBC current deposit identities are ambiguous across financial captures.");
    if (!prior) result.set(key, candidate);
  }
  return result;
}

async function readCtbcCurrentDepositBalancesForApp(
  page: Page,
  context: WorkflowContext,
  reader: typeof readCtbcCurrentDepositBalances,
): Promise<readonly CtbcCurrentDepositBalanceRow[]> {
  const responses: Response[] = [];
  const listener = (candidate: Response) => {
    const request = candidate.request();
    if (request.method() !== "POST" || !candidate.url().startsWith(
      `https://${CTBC_CURRENT_DEPOSIT_BALANCE_HOST}${CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`,
    )) return;
    try {
      const body = JSON.parse(request.postData() ?? "") as { resource?: unknown };
      if (body.resource === CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE)
        responses.push(candidate);
    } catch {
      // The established reader validates the request and reports a safe error.
    }
  };

  page.on("response", listener);
  try {
    const rows = await withAbort(reader(page, {
      observedAt: ctbcObservedAt(new Date(context.now()).getTime()),
    }), context.signal);
    context.signal.throwIfAborted();
    if (reader === readCtbcCurrentDepositBalances) {
      if (responses.length !== 1)
        throw new Error("CTBC current balance source response was missing or ambiguous.");
      const bytes = await withAbort(responses[0]!.body(), context.signal);
      decodeCtbcSourceJson(bytes, context.text);
    }
    return rows;
  } finally {
    page.off("response", listener);
  }
}

/** App-owned CTBC statement provider. Source admission completes before either commit. */
export async function runCtbcProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
  dependencies: CtbcProviderWorkflowDependencies = {},
): Promise<CtbcProviderWorkflowOutput> {
  const parsed = typedInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("CTBC workflow credentials or input are missing or invalid.");
  if (!context.financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");
  const financialCommit = context.financialCommit;
  context.signal.throwIfAborted();
  await context.event("preparation", "input-validated");

  return context.browser.withPage(async (page) => {
    context.signal.throwIfAborted();
    page.on("dialog", (dialog) => {
      void dialog.accept().catch(() => undefined);
    });

    await context.event("authentication", "authentication-started");
    await signInCtbcForApp(page, parsed.data.credentials, context);
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-completed");

    await context.event("collection", "collection-started");
    await context.event("decoding", "source-decoding-started");
    let collected: CtbcCollectedStatements;
    try {
      collected = await (dependencies.collectStatements ??
        ((target, input) => collectCtbcStatements(
          target,
          { ...input, telemetry: false },
          context,
        )))(page, parsed.data);
    } catch (error) {
      await context.event("collection", "collection-failed");
      throw error;
    }
    context.signal.throwIfAborted();
    await context.event("decoding", "source-decoding-completed");
    if (collected.captures.length === 0 ||
      collected.output.count !== collected.captures.length) {
      await context.event("validation", "source-validation-rejected", {
        completed: collected.captures.length,
        total: collected.output.count,
      });
      throw new Error("CTBC source has no complete selected account capture.");
    }
    await context.event("collection", "collection-completed", {
      completed: collected.captures.length,
      total: collected.output.count,
    });

    await context.event("validation", "source-validation-started", {
      completed: 0,
      total: collected.captures.length,
    });
    const observedAt = ctbcObservedAt(new Date(context.now()).getTime());
    const validatedCaptures: CtbcDomesticDepositValidatedEvidence[] = [];
    for (const observed of collected.captures) {
      context.signal.throwIfAborted();
      const admission = admitCtbcDomesticDepositCaptureEvidence(
        buildCtbcCapture(observed, observedAt),
      );
      if (admission.status !== "admissible" || !admission.capture) {
        await context.event("validation", "source-validation-rejected", {
          completed: validatedCaptures.length,
          total: collected.captures.length,
        });
        throw new Error(
          `CTBC domestic deposit source admission blocked: ${admission.diagnostics.join(", ")}`,
        );
      }
      validatedCaptures.push(admission.capture);
    }

    const manifest = getCtbcHumanAttestedV1Manifest();
    const financialCaptures: ExistingCtbcFinancialCapture[] = [];
    const items: PGliteWorkflowRunItem[] = [];
    await context.event("validation", "canonical-admission-started", {
      completed: 0,
      total: validatedCaptures.length,
    });
    for (const capture of validatedCaptures) {
      context.signal.throwIfAborted();
      const captureId = `ctbc-${randomUUID()}`;
      const source = createCtbcDomesticDepositSourceEvidence(capture, captureId);
      if (capture.responses.every((response) => response.rows.length === 0)) {
        items.push({
          provider: "ctbc",
          product: "domestic-deposit",
          itemKey: captureId,
          command: { kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND, request: source },
        });
        continue;
      }
      const admission = admitCtbcDomesticDepositFinancialCapture({
        capture,
        captureId: `ctbc-financial-${captureId}`,
        humanAttestation: manifest,
      });
      if (admission.status !== "admitted" || !admission.capture) {
        await context.event("validation", "canonical-admission-rejected", {
          completed: financialCaptures.length,
          total: validatedCaptures.length,
        });
        throw new Error(
          `CTBC domestic deposit financial admission failed: ${admission.diagnostics.join(", ")}`,
        );
      }
      financialCaptures.push(admission.capture);
      items.push({
        provider: "ctbc",
        product: "domestic-deposit",
        itemKey: captureId,
        command: {
          kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
          request: { steps: [
            { kind: "source", request: source },
            { kind: "deposit", request: { capture: admission.capture } },
          ] },
        },
      });
    }
    await context.event("validation", "canonical-admission-completed", {
      completed: validatedCaptures.length,
      total: validatedCaptures.length,
    });
    context.signal.throwIfAborted();
    const readCurrent = dependencies.readCurrentDepositBalances ?? readCtbcCurrentDepositBalances;
    const balances: PGliteWorkflowRunItem[] = [];
    if (financialCaptures.length > 0) {
      await context.event("collection", "current-balance-collection-started");
      await context.event("decoding", "current-balance-decoding-started");
      let currentRows: readonly CtbcCurrentDepositBalanceRow[];
      try {
        currentRows = await readCtbcCurrentDepositBalancesForApp(page, context, readCurrent);
      } catch {
        await context.event("decoding", "current-balance-decoding-failed");
        await context.event("collection", "current-balance-collection-failed");
        throw new Error("CTBC current balance source collection failed.");
      }
      await context.event("decoding", "current-balance-decoding-completed");
      await context.event("collection", "current-balance-collection-completed", {
        completed: currentRows.length,
        total: currentRows.length,
      });
      const existing = indexCtbcCurrentDepositFinancialCaptures(financialCaptures);
      const firstIdentity = financialCaptures[0]!.identity;
      await context.event("validation", "current-balance-validation-started", {
        completed: 0,
        total: currentRows.length,
      });
      try {
        for (const row of currentRows) {
          context.signal.throwIfAborted();
          const matching = existing.get(
            `${firstIdentity.sourceConnectionKey}\u0000${firstIdentity.identityEpochKey}\u0000${row.stream}\u0000${row.sourceAccountKey}`,
          );
          if (!matching)
            throw new Error("CTBC current deposit snapshot has no admitted account identity.");
          balances.push({
            provider: "ctbc",
            product: "current-balance",
            itemKey: `current-balance:${row.stream}:${row.sourceAccountKey}`,
            command: {
              kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
              request: currentDepositBalanceCommandRequest(admitCurrentDepositBalanceCapture(
                buildCtbcCurrentDepositBalanceCapture(row, matching),
              )),
            },
          });
        }
      } catch {
        await context.event("validation", "current-balance-validation-rejected", {
          completed: 0,
          total: currentRows.length,
        });
        throw new Error("CTBC current balance source admission was rejected.");
      }
      await context.event("validation", "current-balance-validation-completed", {
        completed: balances.length,
        total: currentRows.length,
      });
    }

    await context.event("validation", "source-validation-completed", {
      completed: validatedCaptures.length,
      total: collected.captures.length,
    });
    context.signal.throwIfAborted();
    const commitItems = [...items, ...balances];
    await context.event("commit", "canonical-commit-started", {
      completed: 0,
      total: commitItems.length,
    });
    if (balances.length > 0) {
      await context.event("commit", "current-balance-commit-started", {
        completed: 0,
        total: balances.length,
      });
    }
    const committed = await financialCommit.execute(commitItems, {
      provider: "ctbc",
      product: "financial",
      signal: context.signal,
    });
    if (committed.status !== "completed" || committed.items.length !== commitItems.length ||
      committed.items.some((item) => item.status !== "committed")) {
      const codes = committed.diagnostics.map((diagnostic) => diagnostic.errorCode).join(", ");
      await context.event("commit", context.signal.aborted ? "canonical-commit-cancelled" : "canonical-commit-failed");
      throw new Error(`CTBC Canonical Financial Commit failed: ${codes || committed.status}.`);
    }
    await context.event("commit", "canonical-commit-completed", {
      completed: commitItems.length,
      total: commitItems.length,
    });
    if (balances.length > 0) {
      await context.event("commit", "current-balance-commit-completed", {
        completed: balances.length,
        total: balances.length,
      });
    }

    return {
      count: collected.output.count,
      rowCount: collected.output.rowCount,
      sourceCaptureCount: validatedCaptures.length,
      status: financialCaptures.length > 0 ? "financial-admitted" : "source-only",
    };
  });
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

  const captureEntries = captures.map((capture, index) => ({
    capture,
    captureId: `ctbc-${observedAt}-${index}`,
  }));
  const readCurrent =
    overrides.readCurrentDepositBalances ?? readCtbcCurrentDepositBalances;
  const manifest = getCtbcHumanAttestedV1Manifest();
  const client = requirePGliteChildRpcClientFromEnv();
  try {
    await client.ready;
    const financialCaptures: ExistingCtbcFinancialCapture[] = [];
    const items = captureEntries.map(({ capture, captureId }) => {
      const source = createCtbcDomesticDepositSourceEvidence(capture, captureId);
      if (capture.responses.every((response) => response.rows.length === 0))
        return {
          provider: "ctbc", product: "domestic-deposit", itemKey: captureId,
          command: { kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND, request: source },
        } as const;
      const admission = admitCtbcDomesticDepositFinancialCapture({
        capture, captureId: `ctbc-financial-${captureId}`, humanAttestation: manifest,
      });
      if (admission.status !== "admitted" || !admission.capture)
        throw new Error(`CTBC domestic deposit financial admission failed: ${admission.diagnostics.join(", ")}`);
      financialCaptures.push(admission.capture);
      return {
        provider: "ctbc", product: "domestic-deposit", itemKey: captureId,
        command: {
          kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
          request: { steps: [
            { kind: "source", request: source },
            { kind: "deposit", request: { capture: admission.capture } },
          ] },
        },
      } as const;
    });
    const committed = await executePGliteWorkflowRun({
      client: client.workflow, items, provider: "ctbc", product: "financial",
    });
    if (committed.status !== "completed")
      throw new Error(`CTBC PGlite commit ${committed.status}: ${committed.diagnostics.map((d) => `${d.stage}/${d.errorCode}`).join(", ")}`);
    if (financialCaptures.length > 0) {
      const currentRows = await readCurrent(page, { observedAt: ctbcObservedAt() });
      const existing = indexCtbcCurrentDepositFinancialCaptures(financialCaptures);
      const balances = currentRows.map((row) => {
        const matching = existing.get(
          `${financialCaptures[0]!.identity.sourceConnectionKey}\u0000${financialCaptures[0]!.identity.identityEpochKey}\u0000${row.stream}\u0000${row.sourceAccountKey}`,
        );
        if (!matching)
          throw new Error("CTBC current deposit snapshot contains an account without an existing admitted identity.");
        return {
          provider: "ctbc", product: "current-balance",
          itemKey: `current-balance:${row.stream}:${row.sourceAccountKey}`,
          command: {
            kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
            request: currentDepositBalanceCommandRequest(admitCurrentDepositBalanceCapture(
              buildCtbcCurrentDepositBalanceCapture(row, matching),
            )),
          },
        } as const;
      });
      const balanceResult = await executePGliteWorkflowRun({
        client: client.workflow, items: balances, provider: "ctbc", product: "current-balance",
      });
      if (balanceResult.status !== "completed")
        throw new Error(`CTBC PGlite balance commit ${balanceResult.status}: ${balanceResult.diagnostics.map((d) => `${d.stage}/${d.errorCode}`).join(", ")}`);
    }
    return {
      ...collected.output,
      sourceCaptureCount: captures.length,
      status: financialCaptures.length > 0 ? "financial-admitted" : "source-only",
    };
  } finally {
    client.close();
  }
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

    emitAutomationProgress({ phaseCode: "workflow", completed: 25, total: 100, percent: 25 });
    const result = await runCtbcStatements(page, input);
    emitAutomationProgress({ phaseCode: "workflow", completed: 100, total: 100, percent: 100 });
    return result;
  },
});
