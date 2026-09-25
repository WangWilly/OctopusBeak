import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Dialog, Page, Response } from "playwright";
import { z } from "zod";
import { emitAutomationProgress } from "../lib/automation/progress.ts";
import {
  SourceTextIntegrityError,
  strictSourceText,
  type SourceTextPort,
} from "../lib/automation/source-text.ts";
import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContractInput,
} from "../lib/automation/human-assistance.ts";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";
import type {
  WorkflowContext,
  WorkflowFinancialCommitPort,
} from "../lib/automation/workflow-executor.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import { requirePGliteChildRpcClientFromEnv } from "../../electron/pglite-child-rpc-client.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import { executePGliteWorkflowRun, type PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
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
  readSinopacCurrentDepositBalances,
  parseSinopacCurrentDepositBalanceSnapshot,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_HOST,
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
  SINOPAC_DIALOG_DISMISS_TIMEOUT_MS,
  SINOPAC_DIALOG_OWNER_ENV,
  isSinopacCaptchaRejectionDialog,
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
  inMemory?: boolean;
  text?: SourceTextPort;
  signal?: AbortSignal;
  event?: WorkflowContext["event"];
  financialCommit?: WorkflowFinancialCommitPort;
  observedAt?: string;
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
  /** Injected in checks; production passively reads the authenticated balance POST. */
  readCurrentDepositBalances?: typeof readSinopacCurrentDepositBalances;
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
export type SinopacWorkflowOutput = Readonly<{
  usedExistingSession: boolean;
  dateRange: DateRange;
  accountCount: number;
  rowCount: number;
  skippedAccountCount: number;
  status: "source-only" | "financial-admitted";
}>;

export type SinopacProviderWorkflowOverrides = Readonly<Pick<
  SinopacStatementsRunDependencies,
  "readAccounts" | "queryTransactions" | "readCurrentDepositBalances"
>>;

type SinopacHumanAssistanceRequest = (
  contract: HumanAssistanceContractInput,
  signal: AbortSignal,
) => Promise<HumanAssistanceCompletionStatus>;

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

export function indexSinopacCurrentDepositFinancialCaptures(
  financialCaptures: readonly ExistingSinopacFinancialCapture[],
): ReadonlyMap<string, ExistingSinopacFinancialCapture> {
  const result = new Map<string, ExistingSinopacFinancialCapture>();
  for (const candidate of financialCaptures) {
    const sourceAccountKey =
      candidate.identity.sourceAccountKey ?? candidate.identity.accountNo;
    const key = `${candidate.identity.stream}\u0000${sourceAccountKey}\u0000${candidate.sourceCurrency}`;
    const prior = result.get(key);
    if (
      prior &&
      (prior.identity.sourceConnectionKey !== candidate.identity.sourceConnectionKey ||
        prior.identity.identityEpochKey !== candidate.identity.identityEpochKey ||
        prior.identity.subjectDigest !== candidate.identity.subjectDigest)
    ) {
      throw new Error("SinoPac current deposit identities are ambiguous across financial captures.");
    }
    if (!prior) result.set(key, candidate);
  }
  return result;
}

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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

async function isSignedIn(page: Page, signal?: AbortSignal): Promise<boolean> {
  const url = page.url();
  if (!sinopacSignedInPageUrl(url)) return false;
  return await waitForSinopacSignal(
    page
      .locator('a#user-logout:visible, a[href*="MMALogout"]:visible')
      .isVisible()
      .catch(() => false),
    signal,
  );
}

async function waitForSinopacSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await operation;
  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("SinoPac workflow was cancelled."),
    );
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  void operation.catch(() => undefined);
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

async function waitForSignedInState(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  await page.waitForURL((url) => sinopacSignedInPageUrl(url.href), {
    timeout: 300_000,
    signal,
  });
  await waitForSinopacSignal(
    page.waitForLoadState("domcontentloaded", { timeout: 60_000 }),
    signal,
  );
  await waitForSinopacSignal(
    page
      .locator('a#user-logout, a[href*="MMALogout"]')
      .first()
      .waitFor({ state: "visible", timeout: 60_000 }),
    signal,
  );
}

export type SinopacLoginAttemptDependencies = {
  submit: () => Promise<void>;
  waitForSuccess: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  dialogOwner?: "host" | "workflow";
  onDialog?: (captchaRejected: boolean) => void | Promise<void>;
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
  const dialogOwner = dependencies.dialogOwner
    ?? sinopacPostSubmitDialogOwner(session);
  if (dialogOwner === "host") {
    dependencies.signal?.throwIfAborted();
    const probeAbortController = new AbortController();
    const successSignal = dependencies.signal
      ? AbortSignal.any([probeAbortController.signal, dependencies.signal])
      : probeAbortController.signal;
    const successProbe = dependencies.waitForSuccess(successSignal);
    void successProbe.catch(() => undefined);
    try {
      await waitForSinopacSignal(dependencies.submit(), dependencies.signal);
      await waitForSinopacSignal(successProbe, dependencies.signal);
    } finally {
      probeAbortController.abort();
    }
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
    let captchaRejected = false;
    try {
      type = dialog.type();
      // Diagnostic only: the host probe, not workflow logs, owns retry routing.
      captchaRejected = isSinopacCaptchaRejectionDialog(type, dialog.message());
    } catch {
      // Keep the fail-fast path usable if the browser closes the dialog while
      // it is being inspected.
    }
    console.warn("sinopac-login-dialog", { type, captchaRejected });
    try {
      await dependencies.onDialog?.(captchaRejected);
    } catch {
      // Operational event persistence must not change the authentication outcome.
    }
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
      await waitForSinopacSignal(dependencies.submit(), dependencies.signal);
      await successProbe;
    })();
    await waitForSinopacSignal(Promise.race([loginOutcome, dialogDetected]), dependencies.signal);
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

async function clickLoginButton(page: Page, signal?: AbortSignal): Promise<void> {
  const visibleButton = page.locator("#MMA_Login");
  if (await waitForSinopacSignal(visibleButton.isVisible().catch(() => false), signal)) {
    await waitForSinopacSignal(visibleButton.click(), signal);
    return;
  }
  await waitForSinopacSignal(page.locator('input[alt="登入"]').click({ force: true }), signal);
}

async function dismissPasswordExpiryNotice(page: Page, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  for (const selector of sinopacPasswordExpiryNoticeDismissTargets()) {
    const dismiss = page.locator(selector).first();
    if (await waitForSinopacSignal(dismiss.isVisible({ timeout: 5_000 }).catch(() => false), signal)) {
      await waitForSinopacSignal(dismiss.click(), signal);
      await waitForSinopacSignal(
        dismiss.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {}),
        signal,
      );
      await waitForSinopacSignal(
        page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {}),
        signal,
      );
      return;
    }
  }
}

async function fillLoginForm(
  page: Page,
  credentials: SinopacCredentials,
  signal?: AbortSignal,
): Promise<void> {
  // Libretto preloads startUrl before the handler.  Only navigate when a CDP
  // attachment or a signed-out page is elsewhere, avoiding duplicate login
  // requests on normal workflow launches.
  if (!sinopacLoginEntryUrl(page.url())) {
    await waitForSinopacSignal(page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }), signal);
  } else {
    await waitForSinopacSignal(page.waitForLoadState("domcontentloaded", { timeout: 60_000 }), signal);
  }
  await waitForSinopacSignal(page.locator("form#aspnetForm").waitFor({ timeout: 60_000 }), signal);

  const loginInputs = page.locator(
    "input.selectable:visible, input.tips:visible",
  );

  await waitForSinopacSignal(loginInputs
    .first()
    .fill(requireCredential(credentials, "sinopac_user_id")), signal);
  await waitForSinopacSignal(loginInputs
    .nth(1)
    .fill(requireCredential(credentials, "sinopac_account")), signal);
  await waitForSinopacSignal(loginInputs
    .nth(2)
    .fill(requireCredential(credentials, "sinopac_password")), signal);
  const captcha = page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR);
  await waitForSinopacSignal(captcha.fill(""), signal);
  await waitForSinopacSignal(captcha.focus(), signal);
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

export async function requestSinopacCaptchaAssistance(
  stage: WorkflowHumanAssistanceStage,
  request: SinopacHumanAssistanceRequest,
  signal: AbortSignal,
): Promise<Exclude<HumanAssistanceCompletionStatus, "pending">> {
  signal.throwIfAborted();
  const contract = await waitForSinopacSignal(
    emitHumanAssistanceStage(stage, (value) => value),
    signal,
  );
  const status = await waitForSinopacSignal(request(contract, signal), signal);
  signal.throwIfAborted();
  if (status !== "entered" && status !== "verified") {
    throw new Error(`SinoPac human assistance ended with status ${status}.`);
  }
  return status;
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

async function signInSinopacForApp(
  page: Page,
  credentials: SinopacCredentials,
  context: WorkflowContext,
): Promise<void> {
  context.signal.throwIfAborted();
  await fillLoginForm(page, credentials, context.signal);
  await context.event("authentication", "human-assistance-requested");
  const status = await requestSinopacCaptchaAssistance(
    sinopacCaptchaAssistanceStage(page),
    (contract, signal) => context.humanAssistance.request(contract, signal),
    context.signal,
  );
  await context.event("authentication", "human-assistance-completed");
  context.signal.throwIfAborted();
  if (await isSignedIn(page, context.signal)) return;

  const captcha = page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR);
  if (!(await waitForSinopacSignal(captcha.inputValue(), context.signal)).trim()) {
    throw new Error(
      `SinoPac CAPTCHA assistance ended with ${status}, but no answer was entered.`,
    );
  }
  await runSinopacLoginAttempt(page, context.runId, {
    // App-owned runs do not have the legacy Libretto dialog-retry host. Own
    // the native dialog here so navigation waits cannot hang without an
    // observer; App retry routing is handled as a separate host integration.
    dialogOwner: "workflow",
    signal: context.signal,
    onDialog: async (captchaRejected) => {
      await context.event(
        "authentication",
        captchaRejected ? "captcha-rejected" : "unrecognized-login-dialog",
      );
    },
    submit: () => clickLoginButton(page, context.signal),
    waitForSuccess: (signal) => waitForSignedInState(page, signal),
  });
  await dismissPasswordExpiryNotice(page, context.signal);
  if (!(await isSignedIn(page, context.signal))) {
    throw new Error("SinoPac sign-in did not reach a confirmed authenticated page.");
  }
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
  text: SourceTextPort = strictSourceText,
  signal?: AbortSignal,
  event?: WorkflowContext["event"],
): Promise<SinopacAccount[]> {
  const responsePromise = page.waitForResponse(
    (response) => isSinopacEndpointResponse(response, ACCOUNT_ENDPOINT),
    { timeout: 60_000 },
  );
  void responsePromise.catch(() => undefined);
  const detailLink = page
    .locator('a[title="往來明細"], a[href*="mma_transdetail"]')
    .first();
  if (await waitForSinopacSignal(detailLink.isVisible({ timeout: 10_000 }).catch(() => false), signal)) {
    await waitForSinopacSignal(detailLink.click(), signal);
  } else {
    await waitForSinopacSignal(page.goto(TRANSACTION_URL, { waitUntil: "domcontentloaded" }), signal);
  }
  await waitForSinopacSignal(
    page.locator("#StartDate").waitFor({ state: "visible", timeout: 60_000 }),
    signal,
  );
  const response = await waitForSinopacSignal(responsePromise, signal);
  const [body, headers] = await Promise.all([
    waitForSinopacSignal(response.body(), signal),
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
    await event?.(
      error instanceof SourceTextIntegrityError ? "decoding" : "validation",
      error instanceof SourceTextIntegrityError
        ? "account-source-decode-rejected"
        : "account-source-response-rejected",
    );
    throw error;
  }
  if (!Array.isArray(payload) || payload.length !== 1 || !isJsonRecord(payload[0])) {
    await event?.("validation", "account-source-response-rejected");
    throw new Error("SinoPac account source response is incomplete.");
  }
  const accounts = accountListFromResponse(payload as SinopacAccountResponse[]);
  await event?.("collection", "account-list-collected", {
    completed: accounts.length,
    total: accounts.length,
  });
  return accounts;
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
    const response = await waitForSinopacSignal(this.page.evaluate(
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
    return validateSinopacTransactionRows(
      sinopacSingleEnvelope<SinopacTransactionResponse>(payload, "transaction"),
    );
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

export function buildSinopacCapture(
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
  await waitForSinopacSignal(
    page.goto(SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    }),
    signal,
  );
  const response = await waitForSinopacSignal(responsePromise, signal);
  const [bytes, headers] = await Promise.all([
    waitForSinopacSignal(response.body(), signal),
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

export async function runSinopacStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
  initialAccounts?: SinopacAccount[],
  overrides: SinopacStatementsRunDependencies = {},
): Promise<z.infer<typeof outputSchema>> {
  const inMemory = overrides.inMemory === true;
  if (inMemory && !overrides.financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");
  const signal = overrides.signal;
  const text = overrides.text ?? strictSourceText;
  signal?.throwIfAborted();
  const dateRange = resolveDateRange(input);
  const windows = sinopacQueryWindows(dateRange);
  const apiClient = new SinopacApiClient(page, text, signal);
  const readCurrent =
    overrides.readCurrentDepositBalances ?? readSinopacCurrentDepositBalances;
  const accounts = sinopacFilterAccounts(
    initialAccounts ??
      (await waitForSinopacSignal(
        (overrides.readAccounts ?? ((range) => apiClient.fetchAccounts(range)))(dateRange),
        signal,
      )),
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

  const observedAt = overrides.observedAt ?? new Date().toISOString();
  const captureOccurrenceId = sinopacCaptureId(observedAt);
  const captureInputs: Array<{
    capture: SinopacStatementValidatedCapture;
    pending: PendingSinopacDownload;
  }> = [];
  const skippedAccounts: SinopacSkippedAccount[] = [];
  const financialCapturesForCurrent: Array<{
    sourceCapture: SinopacStatementValidatedCapture;
    financialCapture: ExistingSinopacFinancialCapture;
  }> = [];
  const sourceTotal = accounts.length * windows.length;
  let sourceCompleted = 0;
  await overrides.event?.("collection", "source-collection-started", {
    completed: 0,
    total: sourceTotal,
  });
  for (const account of accounts) {
    const rows: SinopacStatementRow[] = [];
    let explicitNoData = true;
    for (const window of windows) {
      signal?.throwIfAborted();
      await overrides.event?.("decoding", "source-decoding-started", {
        completed: sourceCompleted,
        total: sourceTotal,
      });
      let response: SinopacTransactionResponse;
      try {
        response = await waitForSinopacSignal((
          overrides.queryTransactions ??
          ((candidate, range, businessDate) =>
            apiClient.fetchTransactions(candidate, range, businessDate))
        )(account, window, dateRange.endDate), signal);
      } catch (error) {
        await overrides.event?.(
          error instanceof SourceTextIntegrityError ? "decoding" : "validation",
          error instanceof SourceTextIntegrityError
            ? "source-decode-rejected"
            : "source-response-rejected",
          { completed: sourceCompleted, total: sourceTotal },
        );
        throw error;
      }
      signal?.throwIfAborted();
      response = validateSinopacTransactionRows(response);
      const windowRows = sinopacApiRowsToStatementRows(response.SubInfo ?? []);
      if (
        response.Header !== "FAIL" ||
        cleanText(response.Message) !== "查無資料"
      )
        explicitNoData = false;
      rows.push(...windowRows);
      sourceCompleted += 1;
      await overrides.event?.("decoding", "source-decoding-completed", {
        completed: sourceCompleted,
        total: sourceTotal,
      });
      await overrides.event?.("collection", "account-window-collected", {
        completed: sourceCompleted,
        total: sourceTotal,
      });
    }
    const pending: PendingSinopacDownload = {
      account,
      queryPeriods: windows.map(queryPeriod),
      rows: sortRows(rows),
    };
    await overrides.event?.("validation", "source-validation-started", {
      completed: captureInputs.length,
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
      await overrides.event?.("validation", "source-admission-rejected", {
        completed: captureInputs.length,
        total: accounts.length,
      });
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
    await overrides.event?.("validation", "source-validation-completed", {
      completed: captureInputs.length,
      total: accounts.length,
    });
  }
  const items: PGliteWorkflowRunItem[] = [];
  for (const [index, { capture }] of captureInputs.entries()) {
    const sourceEvidence = capture.product === "domestic-deposit"
      ? createSinopacDomesticDepositSourceEvidence(capture, `${captureOccurrenceId}:source:${index}`)
      : createSinopacForeignCurrencySourceEvidence(capture, `${captureOccurrenceId}:source:${index}`);
    const empty = capture.downloads.every((download) => download.rows.length === 0);
    if (empty) {
      items.push({
        provider: "sinopac", product: capture.product, itemKey: `${capture.product}:${index}`,
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
    if (financial && (financial.status !== "admitted" || !financial.capture)) {
      await overrides.event?.("validation", "financial-admission-rejected", {
        completed: index,
        total: captureInputs.length,
      });
      throw new Error(`SinoPac ${capture.product} financial admission failed: ${financial.diagnostics.join(", ")}`);
    }
    const financialCapture = financial.capture;
    if (!financialCapture) {
      await overrides.event?.("validation", "financial-admission-rejected", {
        completed: index,
        total: captureInputs.length,
      });
      throw new Error("SinoPac financial capture is missing.");
    }
    const occurrenceKeys = new Set<string>();
    const collisionKeys = new Map<string, string>();
    const ambiguous = financialCapture.records.some((record) => {
      if (occurrenceKeys.has(record.occurrenceKey)) return true;
      occurrenceKeys.add(record.occurrenceKey);
      if (record.collisionKey) {
        const prior = collisionKeys.get(record.collisionKey);
        if (prior && prior !== record.occurrenceKey) return true;
        collisionKeys.set(record.collisionKey, record.occurrenceKey);
      }
      return false;
    });
    if (ambiguous) {
      items.push({
        provider: "sinopac", product: capture.product, itemKey: `${capture.product}:${index}`,
        command: { kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND, request: sourceEvidence },
      });
      continue;
    }
    items.push({
      provider: "sinopac", product: capture.product, itemKey: `${capture.product}:${index}`,
      command: {
        kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
        request: { steps: [
          { kind: "source", request: sourceEvidence },
          { kind: "deposit", request: { capture: financialCapture } },
        ] },
      },
    });
    financialCapturesForCurrent.push({
      sourceCapture: capture,
      financialCapture: {
        identity: financialCapture.identity,
        sourceCurrency: capture.product === "domestic-deposit" ? "TWD" : capture.account.currency,
      },
    });
  }

  if (inMemory) {
    const balanceItems: PGliteWorkflowRunItem[] = [];
    if (financialCapturesForCurrent.length > 0) {
      await overrides.event?.("collection", "current-balance-collection-started");
      let currentRows: readonly SinopacCurrentDepositBalanceRow[];
      try {
        currentRows = await waitForSinopacSignal(
          readCurrent(page, { observedAt }),
          signal,
        );
      } catch (error) {
        await overrides.event?.("validation", "current-balance-source-rejected");
        throw error;
      }
      signal?.throwIfAborted();
      const existingByIdentity = indexSinopacCurrentDepositFinancialCaptures(
        financialCapturesForCurrent.map(({ financialCapture }) => financialCapture),
      );
      for (const row of currentRows) {
        const exactKey = `${row.stream}\u0000${row.sourceAccountKey}\u0000${row.currency}`;
        const matching = existingByIdentity.get(exactKey);
        if (!matching) {
          const prefix = `${row.stream}\u0000${row.sourceAccountKey}\u0000`;
          if ([...existingByIdentity.keys()].some((key) => key.startsWith(prefix)))
            throw new Error("SinoPac current deposit currency does not match the existing statement scope.");
          continue;
        }
        try {
          const balanceCapture = buildSinopacCurrentDepositBalanceCapture(row, matching);
          balanceItems.push({
            provider: "sinopac", product: "current-balance",
            itemKey: `current-balance:${row.stream}:${row.sourceAccountKey}`,
            command: {
              kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
              request: currentDepositBalanceCommandRequest(
                admitCurrentDepositBalanceCapture(balanceCapture),
              ),
            },
          });
        } catch (error) {
          await overrides.event?.("validation", "current-balance-admission-rejected");
          throw error;
        }
      }
      await overrides.event?.("validation", "current-balance-validation-completed", {
        completed: balanceItems.length,
        total: currentRows.length,
      });
    }
    signal?.throwIfAborted();
    const commitItems = [...items, ...balanceItems];
    await overrides.event?.("commit", "canonical-commit-started", {
      completed: 0,
      total: commitItems.length,
    });
    const committed = await overrides.financialCommit!.execute(commitItems, {
      provider: "sinopac",
      product: "financial",
      ...(signal ? { signal } : {}),
    });
    if (committed.status !== "completed") {
      await overrides.event?.("commit", "canonical-commit-rejected", {
        completed: committed.committedCount,
        total: commitItems.length,
      });
      throw new Error(
        `SinoPac Canonical Financial Commit ${committed.status}: ${committed.diagnostics.map((item) => `${item.stage}/${item.errorCode}`).join(", ")}`,
      );
    }
    await overrides.event?.("commit", "canonical-commit-completed", {
      completed: committed.committedCount,
      total: commitItems.length,
    });
    return {
      dateRange,
      count: captureInputs.filter(({ pending }) => pending.rows.length > 0).length,
      rowCount: captureInputs.reduce((count, { pending }) => count + pending.rows.length, 0),
      downloads: [],
      skippedAccounts,
      status: financialCapturesForCurrent.length > 0 ? "financial-admitted" : "source-only",
    };
  }

  const client = requirePGliteChildRpcClientFromEnv();
  try {
    await client.ready;
    const statements = await executePGliteWorkflowRun({
      client: client.workflow, provider: "sinopac", product: "financial", items,
    });
    if (statements.status !== "completed")
      throw new Error(`SinoPac PGlite financial commit ${statements.status}: ${statements.diagnostics.map((item) => `${item.stage}/${item.errorCode}`).join(", ")}`);
    if (financialCapturesForCurrent.length > 0) {
      const currentRows = await readCurrent(page, { observedAt: new Date().toISOString() });
      const existingByIdentity = indexSinopacCurrentDepositFinancialCaptures(
        financialCapturesForCurrent.map(({ financialCapture }) => financialCapture),
      );
      const balanceItems: PGliteWorkflowRunItem[] = [];
      for (const row of currentRows) {
        const exactKey = `${row.stream}\u0000${row.sourceAccountKey}\u0000${row.currency}`;
        const matching = existingByIdentity.get(exactKey);
        if (!matching) {
          const prefix = `${row.stream}\u0000${row.sourceAccountKey}\u0000`;
          if ([...existingByIdentity.keys()].some((key) => key.startsWith(prefix)))
            throw new Error("SinoPac current deposit currency does not match the existing statement scope.");
          continue;
        }
        const balanceCapture = buildSinopacCurrentDepositBalanceCapture(row, matching);
        balanceItems.push({
          provider: "sinopac", product: "current-balance",
          itemKey: `current-balance:${row.stream}:${row.sourceAccountKey}`,
          command: {
            kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
            request: currentDepositBalanceCommandRequest(admitCurrentDepositBalanceCapture(balanceCapture)),
          },
        });
      }
      if (balanceItems.length > 0) {
        const balances = await executePGliteWorkflowRun({
          client: client.workflow, provider: "sinopac", product: "current-balance", items: balanceItems,
        });
        if (balances.status !== "completed")
          throw new Error(`SinoPac PGlite current balance commit ${balances.status}: ${balances.diagnostics.map((item) => `${item.stage}/${item.errorCode}`).join(", ")}`);
      }
    }
  } finally {
    client.close();
  }
  const downloads: SinopacDownload[] = [];
  for (const { pending } of captureInputs) {
    if (pending.rows.length === 0) continue;
    downloads.push(await (overrides.writeStatementFile ?? writeStatementFiles)(
      pending.account, pending.queryPeriods, pending.rows,
    ));
  }
  return {
    dateRange, count: downloads.length,
    rowCount: downloads.reduce((sum, download) => sum + download.rowCount, 0),
    downloads, skippedAccounts,
    status: financialCapturesForCurrent.length > 0 ? "financial-admitted" : "source-only",
  };

}

/** App-owned entry point. The legacy Libretto handler remains available during migration. */
export async function runSinopacProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
  overrides: SinopacProviderWorkflowOverrides = {},
): Promise<SinopacWorkflowOutput> {
  const parsed = typedWorkflowInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("SinoPac workflow credentials or input are missing or invalid.");
  if (!context.financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");
  context.signal.throwIfAborted();
  await context.event("preparation", "input-validated");

  return await context.browser.withPage(async (page) => {
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-started");
    const usedExistingSession = await isSignedIn(page, context.signal);
    if (!usedExistingSession)
      await signInSinopacForApp(page, parsed.data.credentials, context);
    context.signal.throwIfAborted();
    await dismissPasswordExpiryNotice(page, context.signal);
    await context.event("authentication", "authentication-completed");

    const endDate = parsed.data.endDate ?? formatYYYYMMDD(new Date(context.now()));
    const startDate = parsed.data.startDate ?? formatYYYYMMDD(
      addDays(addMonths(dateFromYYYYMMDD(endDate), -12), 1),
    );
    const workflowInput = {
      ...parsed.data,
      startDate,
      endDate,
    };
    const dateRange = resolveDateRange(workflowInput);
    context.signal.throwIfAborted();

    let accounts: SinopacAccount[];
    if (overrides.readAccounts) {
      await context.event("collection", "account-list-collection-started");
      accounts = await waitForSinopacSignal(
        overrides.readAccounts(dateRange),
        context.signal,
      );
      context.signal.throwIfAborted();
      await context.event("collection", "account-list-collected", {
        completed: accounts.length,
        total: accounts.length,
      });
    } else {
      accounts = await openTransactionPage(
        page,
        context.text,
        context.signal,
        context.event,
      );
    }

    const result = await runSinopacStatements(
      page,
      workflowInput,
      accounts,
      {
        inMemory: true,
        text: context.text,
        signal: context.signal,
        event: context.event,
        financialCommit: context.financialCommit,
        observedAt: context.now(),
        ...(overrides.queryTransactions
          ? { queryTransactions: overrides.queryTransactions }
          : {}),
        readCurrentDepositBalances: overrides.readCurrentDepositBalances ??
          ((target, balanceInput) => readSinopacCurrentDepositBalancesWithText(
            target,
            context.text,
            context.signal,
            balanceInput,
          )),
      },
    );
    context.signal.throwIfAborted();
    return {
      usedExistingSession,
      dateRange: result.dateRange,
      accountCount: result.count + result.skippedAccounts.length,
      rowCount: result.rowCount,
      skippedAccountCount: result.skippedAccounts.length,
      status: result.status,
    };
  });
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

    emitAutomationProgress({ phaseCode: "workflow", completed: 25, total: 100, percent: 25 });
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
      emitAutomationProgress({ phaseCode: "workflow", completed: 100, total: 100, percent: 100 });
      return evidence;
    }
    const result = await runSinopacStatements(page, input, accounts);
    emitAutomationProgress({ phaseCode: "workflow", completed: 100, total: 100, percent: 100 });
    return result;
  },
});
