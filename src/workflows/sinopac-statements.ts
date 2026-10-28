import { createHash } from "node:crypto";
import type { Page, Response } from "playwright";
import { z } from "zod";
import {
  SourceTextIntegrityError,
  strictSourceText,
  type SourceTextPort,
} from "../lib/automation/source-text.ts";
import { withAbort } from "./abort.ts";
import { signIn, type FormPlan } from "./sign-in.ts";
import { SINOPAC_SOURCE } from "../lib/automation/server/sources/sinopac.ts";
import { SourceUnavailableError } from "../lib/automation/source-access.ts";
import type { VerificationStage } from "../lib/automation/verification-stage.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import {
  StatementComponentAbsentError,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
  type ProductStageRequest,
} from "../lib/automation/product-collection.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  admitSinopacStatementCaptureEvidence,
  createSinopacDomesticDepositSourceEvidence,
  createSinopacForeignCurrencySourceEvidence,
  deriveSinopacStatementAccountNumberEvidence,
  SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  type SinopacStatementCaptureEvidence,
  type SinopacStatementValidatedCapture,
} from "../ledger/pglite/sinopac-provider-admission.ts";
import { buildSinopacDomesticDepositFinancialCaptureForPGlite } from "../ledger/pglite/sinopac-domestic-adapter.ts";
import { buildSinopacForeignCurrencyFinancialCaptureForPGlite } from "../ledger/pglite/sinopac-provider-admission.ts";
import {
  parseSinopacCurrentDepositBalanceSnapshot,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL,
  type SinopacCurrentDepositBalanceRow,
  type SinopacCurrentDepositResponseMetadata,
} from "./sinopac-current-deposit-balances.ts";
import {
  admitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/pglite/current-deposit-admission.ts";
import {
  SINOPAC_CAPTCHA_IMAGE_SELECTOR,
  SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
  SINOPAC_CAPTCHA_INPUT_SELECTOR,
  SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
} from "../lib/automation/sinopac-captcha.ts";
import {
  SINOPAC_IDENTITY_FIELD_NAMES,
  summarizeSinopacIdentityEvidence,
  type SinopacIdentityCapture,
  type SinopacIdentityEvidenceSummary,
  type SinopacIdentityRawRow,
  type SinopacIdentitySiteAssessment,
} from "./sinopac-identity-evidence.ts";
import {
  matchCurrentBalanceCaptures,
  type CurrentBalanceCaptureMatching,
} from "./current-balance-capture-match.ts";
import { PREVIEW_PRODUCTS } from "../ledger/pglite/preview-financial-data.ts";
import {
  collectSinopacCreditCards,
  sinopacCardPageTransport,
  type SinopacCardTransport,
} from "./sinopac-credit-card.ts";

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

const typedWorkflowInputSchema = z.object({
  credentials: z.object({
    sinopac_user_id: z.string().trim().min(1),
    sinopac_account: z.string().trim().min(1),
    sinopac_password: z.string().trim().min(1),
  }),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
  statementTypes: z.array(z.literal("deposit")),
  attachedPreviewProducts: z.array(z.enum(PREVIEW_PRODUCTS)).default([]),
});

type SinopacCredentials = {
  sinopac_user_id?: string;
  sinopac_account?: string;
  sinopac_password?: string;
};

export type SinopacIdentityValidationInput = z.infer<
  typeof sinopacIdentityValidationSchema
>;

export type DateRange = {
  startDate: string;
  endDate: string;
};

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

export type SinopacRawTransactionRow = Partial<
  Record<(typeof SINOPAC_IDENTITY_FIELD_NAMES)[number], string>
>;

export type SinopacStatementRow = {
  sortKey: string;
  values: string[];
};

export type SinopacJsonSourceResponse = Readonly<{
  url: string;
  status: number;
  method: string;
  contentType: string;
}>;

export type SinopacWorkflowInput = z.infer<typeof typedWorkflowInputSchema>;

type ExistingSinopacFinancialCapture = Readonly<{
  identity: Readonly<{
    integrationNamespace: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    stream: string;
  }>;
  /** The statement's typed currency scope is needed for FX identity joining. */
  sourceCurrency: string;
}>;

function sinopacCurrentDepositOpaqueKey(
  domain: string,
  ...parts: readonly string[]
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(`${domain}\u0000`)
    .update(parts.join("\u0000"))
    .digest("base64url")}`;
}

/**
 * Build a point-in-time current-balance capture from a row and an identity
 * that has already crossed the ordinary SinoPac financial admission.  The
 * provider's AvailBalance is the only observation; MaxAvail and FixBalance
 * remain source evidence and never become available or ledger amounts.
 */
export function buildSinopacCurrentDepositBalanceCapture(
  row: SinopacCurrentDepositBalanceRow,
  financialCapture: ExistingSinopacFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  if (identity.integrationNamespace !== "sinopac")
    throw new Error("SinoPac current deposit identity has the wrong source.");
  if (identity.stream !== row.stream)
    throw new Error("SinoPac current deposit row has the wrong stream.");
  if (sourceAccountKey !== row.sourceAccountKey || identity.accountNo !== row.accountNumber)
    throw new Error(
      "SinoPac current deposit account does not match an existing DataValue identity.",
    );
  if (
    (row.stream === "domestic-deposit" && financialCapture.sourceCurrency !== "TWD") ||
    (row.stream === "foreign-currency-deposit" &&
      financialCapture.sourceCurrency !== row.currency)
  ) {
    throw new Error(
      "SinoPac current deposit currency does not match the existing statement scope.",
    );
  }

  const route =
    row.stream === "domestic-deposit"
      ? "sinopac/domestic-deposit/current-balance-v1"
      : "sinopac/foreign-currency/current-balance-v1";
  const contractVersion = row.sourceEvidence.contractVersion;
  const balance: CurrentDepositExactAmount = {
    coefficient: row.ledger.coefficient,
    scale: row.ledger.scale,
  };
  const sourceField = "AvailBalance";
  const time = {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-http-date" as const,
    effectiveTimeRuleVersion: contractVersion,
    sourceField: "HTTP Date",
    sourceValue: row.providerHttpDate,
    contractVersion,
  };
  const sourceRecordKey = sinopacCurrentDepositOpaqueKey(
    "sinopac-current-deposit-source-record-v1",
    row.stream,
    sourceAccountKey,
    row.currency,
    row.effectiveAt,
    balance.coefficient,
    String(balance.scale),
  );
  const compact = {
    source: "sinopac",
    accountNumber: row.accountNumber,
    sourceAccountKey,
    accountText: row.accountText,
    accountValueFormat: row.accountValueFormat,
    currencyText: row.currencyText,
    effectiveAt: row.effectiveAt,
    effectiveTimeSourceField: "HTTP Date",
    effectiveTimeSourceValue: row.providerHttpDate,
    sourceEvidence: { ...row.sourceEvidence },
    providerFields: { ...row.providerFields },
  };
  const provisional = currentDepositSourceRecord({
    sourceRecordKey,
    providerKey: sinopacCurrentDepositOpaqueKey(
      "sinopac-current-deposit-provider-record-v1",
      row.stream,
      row.accountNumber,
      row.currency,
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
    observationKey: sinopacCurrentDepositOpaqueKey(
      "sinopac-current-deposit-observation-v1",
      row.stream,
      sourceAccountKey,
      row.currency,
    ),
    balanceKind: "ledger",
    balance,
    currency: row.currency,
    time,
    sourceRecordKey,
    sourceField,
  };
  const scopeDate = row.effectiveAt.slice(0, 10);
  return {
    captureId: `sinopac-current-${sinopacCurrentDepositOpaqueKey(
      "sinopac-current-deposit-capture-v1",
      row.stream,
      sourceAccountKey,
      row.currency,
      row.effectiveAt,
    ).slice("sha256:".length)}-${Date.now()}`,
    authorityRoute: route,
    contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "sinopac",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: row.stream,
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: { startDate: scopeDate, endDate: scopeDate },
    providerResponse: {
      endpoint: `https://mma.sinopac.com${row.sourceEvidence.endpoint}`,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: {
          source: "sinopac-current-deposit-summary",
          sourceRowCount: 1,
          balanceField: sourceField,
          contentType: row.sourceEvidence.contentType,
          providerHttpDate: row.providerHttpDate,
        },
      },
    ],
    records: [record],
    observations: [observation],
  };
}

function sinopacCaptureAccount(capture: ExistingSinopacFinancialCapture): string {
  const sourceAccountKey = capture.identity.sourceAccountKey ?? capture.identity.accountNo;
  return `${capture.identity.stream}\u0000${sourceAccountKey}`;
}

/**
 * SinoPac keys a balance by stream, source account and currency. A row for an
 * account the run never admitted is skipped, but a row for an admitted account
 * in another currency is a currency mismatch. The first capture under a key wins.
 */
export const sinopacCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  SinopacCurrentDepositBalanceRow,
  ExistingSinopacFinancialCapture
> = {
  captureKey: (capture) => `${sinopacCaptureAccount(capture)}\u0000${capture.sourceCurrency}`,
  rowKey: (row) => `${row.stream}\u0000${row.sourceAccountKey}\u0000${row.currency}`,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest,
  ambiguousMessage: "SinoPac current deposit identities are ambiguous across financial captures.",
  unmatched: {
    kind: "skip",
    throwWhenAccountAdmitted: {
      rowAccount: (row) => `${row.stream}\u0000${row.sourceAccountKey}`,
      captureAccount: sinopacCaptureAccount,
      message: "SinoPac current deposit currency does not match the existing statement scope.",
    },
  },
};

export const SINOPAC_LOGIN_URL = LOGIN_URL;

/** Whether the current browser page is already at SinoPac's sign-in entry. */
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

function requireCredential(
  credentials: SinopacCredentials,
  name: keyof SinopacCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing SinoPac sign-in detail: ${name}.`,
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function resolveDateRange(
  input: Pick<SinopacWorkflowInput, "startDate" | "endDate">,
): DateRange {
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

/** Decode one complete first-party SinoPac JSON response without replacement characters. */
export function decodeSinopacJsonSource(input: Readonly<{
  bytes: Uint8Array;
  response: SinopacJsonSourceResponse;
  expectedPath: string;
  text?: SourceTextPort;
}>): unknown {
  let url: URL;
  try {
    url = new URL(input.response.url);
  } catch {
    throw new Error("SinoPac source response URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "mma.sinopac.com" ||
    url.pathname !== input.expectedPath ||
    url.hash !== "" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new Error("SinoPac source response endpoint is unexpected.");
  if (input.response.method.toUpperCase() !== "POST")
    throw new Error("SinoPac source response method is not POST.");
  if (input.response.status !== 200)
    throw new Error(`SinoPac source response status is not 200 (${input.response.status}).`);

  const contentType = input.response.contentType.trim();
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json")
    throw new Error("SinoPac source response content type is not JSON.");
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(
    contentType,
  )?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8")
    throw new Error("SinoPac source response charset is not UTF-8.");

  const text = input.text ?? strictSourceText;
  const decoded = text.decode(input.bytes, "utf-8");
  text.assertIntact(decoded);
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new Error("SinoPac source response is not valid JSON.");
  }
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

function accountListFromResponse(response: unknown): SinopacAccount[] {
  const result = sinopacSingleEnvelope<SinopacAccountResponse>(response, "account list");
  if (result?.Header === "FAIL" && cleanText(result.Message) === "查無資料")
    return [];
  if (result?.Header !== "SUCCESS") {
    throw new Error(
      `SinoPac account list failed: ${result?.Message ?? "unknown"}`,
    );
  }
  if (!Array.isArray(result.SubInfo))
    throw new Error("SinoPac account list response is incomplete.");
  if (!result.SubInfo.every((account) =>
    isJsonRecord(account) &&
    typeof account.DataText === "string" &&
    typeof account.DataValue === "string" &&
    typeof account.DisplayText === "string"
  ))
    throw new Error("SinoPac account list contains a malformed account.");
  return result.SubInfo;
}

function sinopacSingleEnvelope<T>(payload: unknown, label: string): T {
  if (!Array.isArray(payload) || payload.length !== 1 || !isJsonRecord(payload[0]))
    throw new Error(`SinoPac ${label} response must contain one object envelope.`);
  return payload[0] as T;
}

function validateSinopacTransactionRows(
  response: SinopacTransactionResponse,
): SinopacTransactionResponse {
  if (
    response.Header === "FAIL" &&
    cleanText(response.Message) === "查無資料"
  )
    return response;
  if (response.Header !== "SUCCESS")
    throw new Error(`SinoPac transactions failed: ${response.Message ?? "unknown"}`);
  if (!Array.isArray(response.SubInfo))
    throw new Error("SinoPac transaction source is incomplete: SubInfo is missing.");
  if (!response.SubInfo.every((row) =>
    isJsonRecord(row) &&
    Object.values(row).every((value) => typeof value === "string")
  ))
    throw new Error("SinoPac transaction source contains a malformed row.");
  return response;
}

function queryPeriod(dateRange: DateRange): string {
  return `${formatSlashDate(dateRange.startDate)} ~ ${formatSlashDate(dateRange.endDate)}`;
}

export function sinopacSignedInPageUrl(href: string): boolean {
  return href.startsWith("https://mma.sinopac.com/mma/");
}

function isServiceErrorUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:"
      && url.hostname === "mma.sinopac.com"
      && url.pathname === "/Errors/GenericErrorPage.aspx";
  } catch {
    return false;
  }
}

/** SinoPac's generic error page would otherwise sit under the five-minute sign-in deadline. */
async function isSignedIn(page: Page, signal?: AbortSignal): Promise<boolean> {
  const url = page.url();
  if (isServiceErrorUrl(url)) throw new SourceUnavailableError();
  if (!sinopacSignedInPageUrl(url)) return false;
  return await withAbort(
    page
      .locator('a#user-logout:visible, a[href*="MMALogout"]:visible')
      .isVisible()
      .catch(() => false),
    signal,
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

async function clickLoginButton(page: Page, signal?: AbortSignal): Promise<void> {
  const visibleButton = page.locator("#MMA_Login");
  if (await withAbort(visibleButton.isVisible().catch(() => false), signal)) {
    await withAbort(visibleButton.click(), signal);
    return;
  }
  await withAbort(page.locator('input[alt="登入"]').click({ force: true }), signal);
}

async function dismissPasswordExpiryNotice(page: Page, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  for (const selector of sinopacPasswordExpiryNoticeDismissTargets()) {
    const dismiss = page.locator(selector).first();
    if (await withAbort(dismiss.isVisible().catch(() => false), signal)) {
      await withAbort(dismiss.click(), signal);
      await withAbort(
        dismiss.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {}),
        signal,
      );
      await withAbort(
        page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {}),
        signal,
      );
      return true;
    }
  }
  return false;
}

async function fillLoginForm(
  page: Page,
  credentials: SinopacCredentials,
  signal?: AbortSignal,
): Promise<void> {
  // The App may attach to an existing signed-out browser page. Navigate only
  // when it is not already at the sign-in entry to avoid duplicate requests.
  if (!sinopacLoginEntryUrl(page.url())) {
    await withAbort(page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }), signal);
  } else {
    await withAbort(page.waitForLoadState("domcontentloaded", { timeout: 60_000 }), signal);
  }
  await withAbort(page.locator("form#aspnetForm").waitFor({ timeout: 60_000 }), signal);

  const loginInputs = page.locator(
    "input.selectable:visible, input.tips:visible",
  );

  await withAbort(loginInputs
    .first()
    .fill(requireCredential(credentials, "sinopac_user_id")), signal);
  await withAbort(loginInputs
    .nth(1)
    .fill(requireCredential(credentials, "sinopac_account")), signal);
  await withAbort(loginInputs
    .nth(2)
    .fill(requireCredential(credentials, "sinopac_password")), signal);
  const captcha = page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR);
  await withAbort(captcha.fill(""), signal);
  await withAbort(captcha.focus(), signal);
}

export function sinopacCaptchaAssistanceStage(
  page: Page,
): VerificationStage {
  return {
    stageId: "sinopac-login-captcha",
    title: "Enter the SinoPac CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
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

// The logout link can render after a dismissed notice, so give it time before calling the session lost.
async function sinopacSessionProbe(page: Page, signal: AbortSignal): Promise<boolean> {
  return sinopacSignedInPageUrl(page.url()) && await withAbort(
    page.locator('a#user-logout, a[href*="MMALogout"]').first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true, () => false),
    signal,
  );
}

export function sinopacSignInPlan(credentials: SinopacCredentials): FormPlan {
  return {
    signedIn: isSignedIn,
    fill: (page, signal) => fillLoginForm(page, credentials, signal),
    captcha: {
      stage: sinopacCaptchaAssistanceStage,
      answer: (page) => page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR),
    },
    submit: clickLoginButton,
    prompts: dismissPasswordExpiryNotice,
    dialogs: "fail",
    session: sinopacSessionProbe,
    timeoutMs: 300_000,
  };
}

function isSinopacEndpointResponse(response: Response, pathname: string): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.protocol === "https:" &&
      url.hostname === "mma.sinopac.com" &&
      url.pathname === pathname &&
      url.hash === "" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      response.request().method().toUpperCase() === "POST"
    );
  } catch {
    return false;
  }
}

async function openTransactionPage(
  page: Page,
  text: SourceTextPort,
  signal: AbortSignal,
  event: ProductCollectionHandle["event"],
): Promise<SinopacAccount[]> {
  const responsePromise = page.waitForResponse(
    (response) => isSinopacEndpointResponse(response, ACCOUNT_ENDPOINT),
    { timeout: 60_000 },
  );
  void responsePromise.catch(() => undefined);
  const detailLink = page
    .locator('a[title="往來明細"], a[href*="mma_transdetail"]')
    .first();
  if (await withAbort(detailLink.isVisible().catch(() => false), signal)) {
    await withAbort(detailLink.click(), signal);
  } else {
    await withAbort(page.goto(TRANSACTION_URL, { waitUntil: "domcontentloaded" }), signal);
  }
  await withAbort(
    page.locator("#StartDate").waitFor({ state: "visible", timeout: 60_000 }),
    signal,
  );
  const response = await withAbort(responsePromise, signal);
  const [body, headers] = await Promise.all([
    withAbort(response.body(), signal),
    response.allHeaders(),
  ]);
  let payload: unknown;
  try {
    payload = decodeSinopacJsonSource({
      bytes: body,
      response: {
        url: response.url(),
        status: response.status(),
        method: response.request().method(),
        contentType: headers["content-type"] ?? "",
      },
      expectedPath: ACCOUNT_ENDPOINT,
      text,
    });
  } catch (error) {
    await event(
      error instanceof SourceTextIntegrityError ? "decoding" : "validation",
      "failed",
      error instanceof SourceTextIntegrityError
        ? "account-source-decode-rejected"
        : "account-source-response-rejected",
    );
    throw error;
  }
  if (!Array.isArray(payload) || payload.length !== 1 || !isJsonRecord(payload[0])) {
    await event("validation", "failed", "account-source-response-rejected");
    throw new Error("SinoPac account source response is incomplete.");
  }
  return accountListFromResponse(payload as SinopacAccountResponse[]);
}

class SinopacApiClient {
  private page: Page;
  private text: SourceTextPort;
  private signal?: AbortSignal;

  constructor(
    page: Page,
    text: SourceTextPort = strictSourceText,
    signal?: AbortSignal,
  ) {
    this.page = page;
    this.text = text;
    this.signal = signal;
  }

  private async postJson<T>(path: string, body: URLSearchParams): Promise<T> {
    this.signal?.throwIfAborted();
    const response = await withAbort(this.page.evaluate(
      async ({ path, bodyText }) => {
        type BrowserXhr = {
          open(method: string, url: string, async: boolean): void;
          setRequestHeader(name: string, value: string): void;
          send(body: string): void;
          onload: (() => void) | null;
          onerror: (() => void) | null;
          responseType: string;
          response: ArrayBuffer | null;
          responseURL: string;
          status: number;
          getResponseHeader(name: string): string | null;
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
          request.responseType = "arraybuffer";
          request.onload = () => {
            if (!(request.response instanceof ArrayBuffer)) {
              reject(new Error("SinoPac source response body is unavailable."));
              return;
            }
            resolve({
              url: request.responseURL,
              status: request.status,
              method: "POST",
              contentType: request.getResponseHeader("content-type") ?? "",
              bytes: Array.from(new Uint8Array(request.response)),
            });
          };
          request.onerror = () =>
            reject(new Error("SinoPac source request failed."));
          request.send(bodyText);
        });
      },
      { path, bodyText: body.toString() },
    ), this.signal) as SinopacJsonSourceResponse & Readonly<{ bytes: number[] }>;
    this.signal?.throwIfAborted();
    const expectedPath = new URL(path, "https://mma.sinopac.com").pathname;
    const payload = decodeSinopacJsonSource({
      bytes: Uint8Array.from(response.bytes),
      response,
      expectedPath,
      text: this.text,
    });
    return payload as T;
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
    const response = await this.postJson<unknown>(
      `${ACCOUNT_ENDPOINT}?${Date.now()}`,
      body,
    );
    return accountListFromResponse(response);
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
    const payload = await this.postJson<unknown>(
      `${TRANSACTION_ENDPOINT}?${Date.now()}`,
      body,
    );
    return sinopacSingleEnvelope<SinopacTransactionResponse>(payload, "transaction");
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
      const response = validateSinopacTransactionRows(await apiClient.fetchTransactions(
        accounts[0]!,
        window,
        querySet.range.endDate,
      ));
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

type PendingSinopacSource = {
  account: SinopacAccount;
  queryPeriods: string[];
  rows: SinopacStatementRow[];
};

function emptySinopacDigest(): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.alloc(0)).digest("base64url")}`;
}

export function buildSinopacCapture(
  account: SinopacAccount,
  dateRange: DateRange,
  observedAt: string,
  pending: PendingSinopacSource,
  providerNoData: boolean,
): SinopacStatementCaptureEvidence {
  const currency = accountCurrency(account);
  const product = currency === "TWD" ? "domestic-deposit" : "foreign-currency";
  const csv = sinopacStatementRowsToCsv(pending.rows);
  const hasRows = pending.rows.length > 0;
  const accountNumber = deriveSinopacStatementAccountNumberEvidence(
    accountId(account),
  );
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
      ...(accountNumber ? { accountNumber } : {}),
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

async function readSinopacCurrentDepositBalancesWithText(
  page: Page,
  text: SourceTextPort,
  signal: AbortSignal,
  input: Readonly<{ observedAt: string; timeoutMs?: number }>,
): Promise<readonly SinopacCurrentDepositBalanceRow[]> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  signal.throwIfAborted();
  const responsePromise = page.waitForResponse((response) => {
    if (!isSinopacEndpointResponse(response, SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH))
      return false;
    try {
      const url = new URL(response.url());
      const keys = [...url.searchParams.keys()];
      return keys.length === 0 || (keys.length === 1 && /^\d{13}$/u.test(keys[0]!));
    } catch {
      return false;
    }
  }, { timeout: timeoutMs });
  void responsePromise.catch(() => undefined);
  await withAbort(
    page.goto(SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    }),
    signal,
  );
  const response = await withAbort(responsePromise, signal);
  const [bytes, headers] = await Promise.all([
    withAbort(response.body(), signal),
    response.allHeaders(),
  ]);
  const payload = decodeSinopacJsonSource({
    bytes,
    response: {
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      contentType: headers["content-type"] ?? "",
    },
    expectedPath: SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
    text,
  });
  const metadata: SinopacCurrentDepositResponseMetadata = {
    url: response.url(),
    status: response.status(),
    method: response.request().method(),
    headers,
  };
  return parseSinopacCurrentDepositBalanceSnapshot({
    payload,
    response: metadata,
    observedAt: input.observedAt,
  });
}

function sinopacCaptureId(observedAt: string): string {
  return `sinopac-source-${createHash("sha256")
    .update(`sinopac-source-capture-v1\0${observedAt}`)
    .digest("hex")
    .slice(0, 24)}-${Date.now()}`;
}

/** SinoPac's own account counts for one deposit collection. */
type SinopacDepositCollection = Readonly<{
  accountCount: number;
  rowCount: number;
  skippedAccountCount: number;
}>;

export type SinopacReadCurrentDepositBalances = (
  input: Readonly<{ observedAt: string }>,
) => Promise<readonly SinopacCurrentDepositBalanceRow[]>;

/** SinoPac's signed-in deposit pages, read as the verbs the deposit runner needs (ADR 0065). */
export type SinopacDepositSource = Readonly<{
  /** Opens the transaction-details page and reads the account list it requests. */
  listAccounts: () => Promise<SinopacAccount[]>;
  queryTransactions: (
    account: SinopacAccount,
    window: DateRange,
    businessDate: string,
  ) => Promise<SinopacTransactionResponse>;
  readCurrentBalances: SinopacReadCurrentDepositBalances;
}>;

export function sinopacDepositSource(
  page: Page,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): SinopacDepositSource {
  const apiClient = new SinopacApiClient(page, context.text, context.signal);
  return {
    listAccounts: () => openTransactionPage(page, context.text, context.signal, product.event),
    queryTransactions: (account, window, businessDate) =>
      apiClient.fetchTransactions(account, window, businessDate),
    readCurrentBalances: (input) =>
      readSinopacCurrentDepositBalancesWithText(page, context.text, context.signal, input),
  };
}

/** One selected account's statement capture, structurally admitted as it was read. */
export type SinopacDepositAccountRead = Readonly<{
  capture: SinopacStatementValidatedCapture;
  rowCount: number;
  providerNoData: boolean;
}>;

export type SinopacDepositSourceSnapshot = Readonly<{
  observedAt: string;
  accounts: readonly SinopacDepositAccountRead[];
}>;

/** Read every selected account's query windows from SinoPac (ADR 0065). */
export async function readSinopacDepositSource(
  source: SinopacDepositSource,
  input: SinopacWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<SinopacDepositSourceSnapshot> {
  const { signal } = context;
  const { event } = product;
  await event("collection", "started", "account-list-collection-started");
  const listed = await withAbort(source.listAccounts(), signal);
  signal.throwIfAborted();
  await event("collection", "advanced", "account-list-collected", {
    completed: listed.length,
    total: listed.length,
  });
  const observedAt = context.now();
  const dateRange = resolveDateRange(input);
  const windows = sinopacQueryWindows(dateRange);
  const accounts = sinopacFilterAccounts(
    listed,
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

  const reads: SinopacDepositAccountRead[] = [];
  const sourceTotal = accounts.length * windows.length;
  let sourceCompleted = 0;
  await event("collection", "started", "source-collection-started", {
    completed: 0,
    total: sourceTotal,
  });
  for (const account of accounts) {
    const rows: SinopacStatementRow[] = [];
    let explicitNoData = true;
    for (const window of windows) {
      signal.throwIfAborted();
      await event("decoding", "started", "source-decoding-started", {
        completed: sourceCompleted,
        total: sourceTotal,
      });
      let response: SinopacTransactionResponse;
      try {
        response = validateSinopacTransactionRows(await withAbort(
          source.queryTransactions(account, window, dateRange.endDate),
          signal,
        ));
      } catch (error) {
        await event(
          error instanceof SourceTextIntegrityError ? "decoding" : "validation",
          "failed",
          error instanceof SourceTextIntegrityError
            ? "source-decode-rejected"
            : "source-response-rejected",
          { completed: sourceCompleted, total: sourceTotal },
        );
        throw error;
      }
      signal.throwIfAborted();
      if (
        response.Header !== "FAIL" ||
        cleanText(response.Message) !== "查無資料"
      )
        explicitNoData = false;
      rows.push(...sinopacApiRowsToStatementRows(response.SubInfo ?? []));
      sourceCompleted += 1;
      await event("decoding", "advanced", "source-decoding-completed", {
        completed: sourceCompleted,
        total: sourceTotal,
      });
      await event("collection", "advanced", "account-window-collected", {
        completed: sourceCompleted,
        total: sourceTotal,
      });
    }
    const pending: PendingSinopacSource = {
      account,
      queryPeriods: windows.map(queryPeriod),
      rows: sortRows(rows),
    };
    await event("validation", "started", "source-validation-started", {
      completed: reads.length,
      total: accounts.length,
    });
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
      await event("validation", "failed", "source-admission-rejected", {
        completed: reads.length,
        total: accounts.length,
      });
      throw new Error(
        `SinoPac statement source admission blocked: ${structural.diagnostics.join(", ")}`,
      );
    }
    reads.push({
      capture: structural.capture,
      rowCount: pending.rows.length,
      providerNoData: explicitNoData,
    });
    await event("validation", "advanced", "source-validation-completed", {
      completed: reads.length,
      total: accounts.length,
    });
  }
  return { observedAt, accounts: reads };
}

/**
 * Build and stage deposit items from a read snapshot. Current balances are
 * read only when at least one account was admitted as financial data.
 */
export async function stageSinopacDeposit(
  snapshot: SinopacDepositSourceSnapshot,
  _input: SinopacWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
  readCurrentBalances: SinopacReadCurrentDepositBalances,
): Promise<SinopacDepositCollection & ProductCollectionSummary> {
  const { signal } = context;
  const { event } = product;
  const { observedAt } = snapshot;
  const captureOccurrenceId = sinopacCaptureId(observedAt);
  const financialCapturesForCurrent: ExistingSinopacFinancialCapture[] = [];
  const items: ProductStageRequest[] = [];
  for (const [index, { capture }] of snapshot.accounts.entries()) {
    const sourceEvidence = capture.product === "domestic-deposit"
      ? createSinopacDomesticDepositSourceEvidence(capture, `${captureOccurrenceId}:source:${index}`)
      : createSinopacForeignCurrencySourceEvidence(capture, `${captureOccurrenceId}:source:${index}`);
    const empty = capture.downloads.every((download) => download.rows.length === 0);
    if (empty) {
      items.push({
        product: capture.product, itemKey: `${capture.product}:${index}`,
        command: { kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND, request: sourceEvidence },
      });
      continue;
    }
    const financial = capture.product === "domestic-deposit"
      ? buildSinopacDomesticDepositFinancialCaptureForPGlite({
          capture,
          captureId: `sinopac-financial-${sinopacCaptureId(observedAt)}-${index}`,
        })
      : buildSinopacForeignCurrencyFinancialCaptureForPGlite(
          capture,
          `${captureOccurrenceId}:foreign:${index}`,
        );
    if (financial.status !== "admitted" || !financial.capture) {
      await event("validation", "failed", "financial-admission-rejected", {
        completed: index,
        total: snapshot.accounts.length,
      });
      throw new Error(`SinoPac ${capture.product} financial admission failed: ${financial.diagnostics.join(", ")}`);
    }
    const financialCapture = financial.capture;
    items.push({
      product: capture.product, itemKey: `${capture.product}:${index}`,
      command: {
        kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
        request: { steps: [
          { kind: "source", request: sourceEvidence },
          { kind: "deposit", request: { capture: financialCapture } },
        ] },
      },
    });
    financialCapturesForCurrent.push({
      identity: financialCapture.identity,
      sourceCurrency: capture.product === "domestic-deposit" ? "TWD" : capture.account.currency,
    });
  }

  const balanceItems: ProductStageRequest[] = [];
  if (financialCapturesForCurrent.length > 0) {
    await event("collection", "started", "current-balance-collection-started");
    let currentRows: readonly SinopacCurrentDepositBalanceRow[];
    try {
      currentRows = await withAbort(readCurrentBalances({ observedAt }), signal);
    } catch (error) {
      await event("validation", "failed", "current-balance-source-rejected");
      throw error;
    }
    signal.throwIfAborted();
    const { matched } = matchCurrentBalanceCaptures(
      currentRows,
      financialCapturesForCurrent,
      sinopacCurrentBalanceCaptureMatching,
    );
    for (const { row, capture: matching } of matched) {
      try {
        const balanceCapture = buildSinopacCurrentDepositBalanceCapture(row, matching);
        balanceItems.push({
          product: "current-balance",
          itemKey: `current-balance:${row.stream}:${row.sourceAccountKey}`,
          command: {
            kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
            request: currentDepositBalanceCommandRequest(
              admitCurrentDepositBalanceCapture(balanceCapture),
            ),
          },
        });
      } catch (error) {
        await event("validation", "failed", "current-balance-admission-rejected");
        throw error;
      }
    }
    await event("validation", "completed", "current-balance-validation-completed", {
      completed: balanceItems.length,
      total: currentRows.length,
    });
  }
  product.stage(...items, ...balanceItems);
  return {
    accountCount: snapshot.accounts.length,
    rowCount: snapshot.accounts.reduce((count, read) => count + read.rowCount, 0),
    skippedAccountCount: snapshot.accounts.filter((read) => read.providerNoData).length,
    sourceCaptureCount: snapshot.accounts.length,
  };
}

/** Read SinoPac's deposit source from the signed-in page, then build and stage from it. */
export async function runSinopacDeposit(
  page: Page,
  input: SinopacWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<SinopacDepositCollection & ProductCollectionSummary> {
  const source = sinopacDepositSource(page, context, product);
  const snapshot = await readSinopacDepositSource(source, input, context, product);
  return await stageSinopacDeposit(snapshot, input, context, product, source.readCurrentBalances);
}

export type SinopacProviderWorkflowDependencies = Readonly<{
  collectDeposit?: typeof runSinopacDeposit;
  cardTransport?: SinopacCardTransport;
}>;

/** App-owned entry point for SinoPac statement collection and canonical admission. */
export async function runSinopacProviderWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products", "previewWrite">,
  rawInput: unknown,
  dependencies: SinopacProviderWorkflowDependencies = {},
): Promise<WorkflowRunResult> {
  const parsed = typedWorkflowInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("SinoPac workflow credentials or input are missing or invalid.");
  if (parsed.data.statementTypes.length === 0 && parsed.data.attachedPreviewProducts.length === 0)
    throw new Error("SinoPac workflow has no statement type or attached product selected.");
  context.signal.throwIfAborted();
  await context.event("preparation", "completed", "input-validated");
  const collectDeposit = dependencies.collectDeposit ?? runSinopacDeposit;

  return await context.browser.withPage(async (page) => {
    const { assertSession } = await signIn(context, page, SINOPAC_SOURCE, sinopacSignInPlan(parsed.data.credentials));

    const endDate = parsed.data.endDate ?? formatYYYYMMDD(new Date(context.now()));
    const startDate = parsed.data.startDate ?? formatYYYYMMDD(
      addDays(addMonths(dateFromYYYYMMDD(endDate), -12), 1),
    );
    const workflowInput = {
      ...parsed.data,
      startDate,
      endDate,
    };
    // An inverted range fails the run before any product starts.
    resolveDateRange(workflowInput);
    context.signal.throwIfAborted();

    let deposit: SinopacDepositCollection | null = null;
    const summary = await context.products.collect({
      deposit: async (product): Promise<ProductCollectionSummary> => {
        const { sourceCaptureCount, ...collected } = await collectDeposit(page, workflowInput, context, product);
        deposit = collected;
        return { sourceCaptureCount, rowCount: collected.rowCount };
      },
    }, {
      assertSession,
      attached: {
        collectors: () => {
          const transport = dependencies.cardTransport ?? sinopacCardPageTransport(page, context.signal);
          return {
            // Attached products have no structure report yet, so responses are validated but not kept.
            credit_card: () => collectSinopacCreditCards({ transport, collectedAt: context.now(), observe: () => undefined }),
          };
        },
        assertSession,
      },
    });
    // SinoPac's account counts describe the verified deposit only.
    const [verified, ...attached] = summary.products;
    const succeeded = verified?.status === "success" ? deposit as SinopacDepositCollection | null : null;
    return productRunResult(summary, {
      counts: {
        accountCount: succeeded?.accountCount ?? attached.reduce((total, product) => total + product.itemCount, 0),
        skippedAccountCount: succeeded?.skippedAccountCount ?? 0,
      },
    });
  });
}
