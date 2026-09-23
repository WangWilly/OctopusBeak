import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Page } from "playwright";
import { z } from "zod";
import { requirePGliteChildRpcClientFromEnv } from "../../electron/pglite-child-rpc-client.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import { executePGliteWorkflowRun } from "../ledger/pglite/workflow-run.ts";
import {
  pgliteWorkflowEnabled,
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  type CathayCredentials,
  type CathaySession,
  createCathaySession,
  signInCathay,
} from "./cathay-statements.js";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import type {
  ForeignCurrencyDepositCaptureInput,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import type { CanonicalFinancialCommitItem } from "../ledger/canonical/canonical-financial-commit-execution.ts";
import { readCathayCurrentDepositBalances } from "./cathay-current-deposit-balances.ts";
import {
  buildCathayCurrentDepositBalanceCaptures,
} from "./cathay-current-deposit-canonical.ts";
import type { CathayCurrentDepositBalanceRow } from "./cathay-current-deposit-balances.ts";
import type {
  CurrentDepositBalanceCaptureInput,
  CurrentDepositBalanceCommitResult,
} from "../ledger/canonical/current-deposit-balance-writer.ts";
import { admitCurrentDepositBalanceCapture } from "../ledger/pglite/current-deposit-admission.ts";
import type { CanonicalFinancialDepositCommitResult } from "../ledger/canonical/canonical-financial-deposit-writer.ts";

const FOREIGN_STATEMENTS_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/FAcctInq/R0102_FAcctDtlInq_Qry";
const DEFAULT_LEDGER_DIR = process.env.LEDGER_DIR ?? "data/ledger";

function configuredCathayCanonicalLedgerDir(): string {
  return (
    process.env.OCTOPUSBEAK_CANONICAL_LEDGER_DIR?.trim() ||
    process.env.LEDGER_DIR?.trim() ||
    DEFAULT_LEDGER_DIR
  );
}

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

type CathayJsonParseContext = { source: string };

/**
 * Parse a provider JSON response without converting numeric tokens through a
 * binary JavaScript number first.  The reviver's third argument is the source
 * lexeme, so values such as 10.00 and 31.50 remain exact decimal strings for
 * canonical admission.
 */
export function parseCathayApiJson<T>(source: string): T {
  const reviver = function (
    this: unknown,
    _key: string,
    value: unknown,
  ): unknown {
    const context = arguments[2] as CathayJsonParseContext | undefined;
    if (typeof value !== "number") return value;
    if (!context || typeof context.source !== "string")
      throw new Error("Cathay API numeric response lacks lexical evidence.");
    return context.source;
  };
  return JSON.parse(source, reviver) as T;
}

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

export const CATHAY_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "cathay/foreign-account/account-number-v1" as const;

export type CathayForeignAccountNumberEvidence = Readonly<{
  value: string;
  kind: "depository-account";
  evidenceVersion: typeof CATHAY_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION;
  sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account";
}>;

type CathayForeignTransferInfo = {
  sequenceNumber?: number | string;
  transferDate?: string;
  txntDate?: string;
  debitCreditType?: string;
  amount?: number | string | null;
  balance?: number | string | null;
  custName?: string;
  memo?: string;
  exRate?: string;
};

type CathayForeignTransferResult = {
  currencyCode?: string;
  transferInfos?: CathayForeignTransferInfo[];
  /** Set only when the successful provider response explicitly covers this currency. */
  zeroResultAuthority?: "provider-explicit-no-data";
};

export type CathayForeignStatementObserver = (
  account: CathayForeignAccount,
  currency: string,
  statement: CathayForeignTransferResult,
) => void;

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

/**
 * The foreign-account API returns the provider account field directly.  Keep
 * opaque or masked values as source keys only; they do not satisfy the
 * account-number identifier contract.
 */
export function deriveCathayForeignAccountNumberEvidence(
  accountNumber: string,
): CathayForeignAccountNumberEvidence | null {
  const value = cleanText(accountNumber).normalize("NFKC");
  if (!/^\d{6,24}$/u.test(value)) return null;
  return {
    value,
    kind: "depository-account",
    evidenceVersion: CATHAY_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account",
  };
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

function formatNullableAmount(value: number | string | null | undefined): string {
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
  amount: number | string | null | undefined,
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

function exactCathayAmount(value: number | string | null | undefined, label: string): string {
  if (value === null || value === undefined || String(value).trim() === "")
    throw new Error(`Cathay foreign row is missing ${label}.`);
  if (typeof value === "number")
    throw new Error(`Cathay foreign ${label} must remain an exact decimal string.`);
  const source = String(value);
  if (!/^(?:0|[1-9]\d*|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u.test(source))
    throw new Error(`Cathay foreign ${label} is not an exact decimal.`);
  return source.replaceAll(",", "");
}

function cathaySequence(value: number | string | undefined): string {
  if (value === undefined || value === null)
    throw new Error("Cathay foreign row lacks source sequence identity.");
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error(
        "Cathay foreign numeric sequence must be a safe integer; exact identifiers must be strings.",
      );
    return String(value);
  }
  const sequence = cleanText(value);
  if (!sequence)
    throw new Error("Cathay foreign row lacks source sequence identity.");
  return sequence;
}

function cathayDirection(value: string | undefined): "inflow" | "outflow" {
  const type = cleanText(value).toUpperCase();
  if (type === "D" || type.includes("DEBIT") || /支出|扣|提出|轉出|匯出|買/.test(type))
    return "outflow";
  if (type === "C" || type.includes("CREDIT") || /存入|收入|轉入|匯入|賣/.test(type))
    return "inflow";
  throw new Error("Cathay foreign row lacks an explicit debit/credit direction.");
}

/** Convert one provider response into the shared exact canonical capture seam. */
export function buildCathayForeignCurrencyCaptureInput(
  account: CathayForeignAccount,
  currency: string,
  dateRange: CathayForeignDateRange,
  statement: CathayForeignTransferResult,
  observedAt = new Date().toISOString(),
  captureOccurrenceId = "",
  zeroResultAuthority?: "provider-explicit-no-data",
): ForeignCurrencyDepositCaptureInput {
  const bounds = dateRangeBounds(dateRange);
  const baseCaptureOccurrenceId = captureOccurrenceId.trim();
  if (!baseCaptureOccurrenceId)
    throw new Error("Cathay foreign capture occurrence identity is required.");
  const currencyCode = cleanText(statement.currencyCode ?? currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode))
    throw new Error("Cathay foreign statement lacks a source currency.");
  const resolvedZeroResultAuthority =
    zeroResultAuthority ?? statement.zeroResultAuthority;
  if (
    (statement.transferInfos?.length ?? 0) === 0 &&
    resolvedZeroResultAuthority !== "provider-explicit-no-data"
  )
    throw new Error(
      "Cathay foreign empty capture requires provider-explicit-no-data terminal evidence.",
    );
  return {
    source: "cathay",
    accountNo: account.account,
    accountNumber: deriveCathayForeignAccountNumberEvidence(account.account),
    sourceConnectionKey: "cathay-foreign-current-login",
    identityEpochKey: "cathay-foreign-current-identity",
    accountType: "depository",
    captureCurrencyScope: { kind: "currency", currency: currencyCode },
    captureOccurrenceId: `${baseCaptureOccurrenceId}:${currencyCode}`,
    zeroResultAuthority: resolvedZeroResultAuthority,
    observedAt,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    completeness: "complete-range",
    records: (statement.transferInfos ?? []).map((info) => {
      const sequence = cathaySequence(info.sequenceNumber);
      const amount = exactCathayAmount(info.amount, "amount");
      const balanceAfter = exactCathayAmount(info.balance, "balance");
      const observedDate = normalizeDate(info.transferDate ?? info.txntDate).replaceAll("/", "-");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate))
        throw new Error("Cathay foreign row lacks a source transaction date.");
      const reportedRateText = cleanText(info.exRate);
      return {
        sourceKey: `${account.account}:${currencyCode}:${sequence}`,
        sequence,
        amount,
        direction: cathayDirection(info.debitCreditType),
        currencyEvidence: { kind: "scope" as const, currency: currencyCode },
        balanceAfter,
        sourceTime: { localDate: observedDate, precision: "date" as const },
        originalAmount: { amount, currency: currencyCode },
        sourceReportedRate: reportedRateText
          ? {
              rate: exactCathayAmount(reportedRateText, "reported rate"),
              baseCurrency: currencyCode,
              quoteCurrency: "TWD",
              observedOn: observedDate,
            }
          : null,
        description: foreignSummary(info) || null,
        sourcePayload: { memo: info.memo ?? "", exchangeRate: info.exRate ?? "" },
      };
    }),
  };
}

export type CathayForeignCanonicalCaptureCollector = Readonly<{
  captureOccurrenceId: string;
  captures: readonly ForeignCurrencyDepositCaptureInput[];
  reset: () => void;
  onStatement: CathayForeignStatementObserver;
}>;

export type CathayCurrentForeignDepositBalanceCaptureOptions = Readonly<{
  /** Focused-check seam; production uses the authenticated UI reader. */
  readCurrentDepositBalances?: typeof readCathayCurrentDepositBalances;
  /** Focused-check seam; production uses the canonical current-balance writer. */
  commitCurrentDepositBalances?: (
    canonicalLedgerDir: string,
    captures: readonly CurrentDepositBalanceCaptureInput[],
  ) => Promise<readonly CurrentDepositBalanceCommitResult[]>;
}>;

type CathayForeignCommitValue = ReturnType<
  typeof commitForeignCurrencyDepositCaptureInTransaction
>;
type CathayCanonicalCommitValue =
  | CathayForeignCommitValue
  | CurrentDepositBalanceCommitResult;

function cathayForeignCommitItems(
  captures: readonly ForeignCurrencyDepositCaptureInput[],
  onCommitted?: (capture: ForeignCurrencyDepositCaptureInput) => void,
): CanonicalFinancialCommitItem<CathayForeignCommitValue>[] {
  return captures.map((capture) => ({
    provider: "cathay",
    product: "foreign-currency-deposit",
    itemKey: capture.accountNo,
    commit: async ({ writer, admission }) => {
      const { commitForeignCurrencyDepositCaptureInTransaction } = await import(
        "../ledger/canonical/foreign-currency-deposit.ts"
      );
      return commitForeignCurrencyDepositCaptureInTransaction(
        writer,
        capture,
        admission,
      );
    },
    ...(onCommitted
      ? {
          // Run only after the item transaction has committed, so current
          // balances never use an uncommitted account identity.
          resolveRelations: async () => {
            onCommitted(capture);
          },
        }
      : {}),
  }));
}

/** Keep provider collection and canonical admission on one reusable seam.
 * Retries reset the pending batch before recollecting; only a successfully
 * completed attempt is committed by the workflow that owns the retry. */
export function createCathayForeignCanonicalCaptureCollector(
  dateRange: CathayForeignDateRange,
  captureOccurrenceId = randomUUID(),
): CathayForeignCanonicalCaptureCollector {
  const captures: ForeignCurrencyDepositCaptureInput[] = [];
  return {
    captureOccurrenceId,
    captures,
    reset: () => {
      captures.length = 0;
    },
    onStatement: (account, currency, statement) => {
      if (
        (statement.transferInfos?.length ?? 0) > 0 ||
        statement.zeroResultAuthority === "provider-explicit-no-data"
      ) {
        captures.push(
          buildCathayForeignCurrencyCaptureInput(
            account,
            currency,
            dateRange,
            statement,
            new Date().toISOString(),
            captureOccurrenceId,
            statement.zeroResultAuthority,
          ),
        );
      }
    },
  };
}

export async function commitCathayForeignCanonicalCaptures(
  canonicalLedgerDir: string | undefined,
  captures: readonly ForeignCurrencyDepositCaptureInput[],
): Promise<readonly CanonicalFinancialDepositCommitResult[]> {
  if (!canonicalLedgerDir || captures.length === 0) return [];
  const { executeCanonicalFinancialCommitRun } = await import(
    "../ledger/canonical/canonical-financial-commit-execution.ts"
  );
  const items = cathayForeignCommitItems(captures);
  const result = await executeCanonicalFinancialCommitRun<CathayForeignCommitValue>({
    canonicalLedgerDir,
    items,
    provider: "cathay",
    product: "foreign-currency-deposit",
  });
  if (result.status === "failed" || result.status === "cancelled")
    throw new Error(
      `Cathay foreign canonical persistence ${result.status}: ${result.diagnostics
        .map((diagnostic) => `${diagnostic.stage}/${diagnostic.errorCode}`)
        .join(", ")}`,
    );
  return result.items.flatMap((item) =>
    item.status === "committed" ? [item.value] : [],
  );
}

async function commitCathayCurrentForeignDepositBalancesThroughExecution(
  canonicalLedgerDir: string,
  captures: readonly CurrentDepositBalanceCaptureInput[],
): Promise<readonly CurrentDepositBalanceCommitResult[]> {
  const [
    { executeCanonicalFinancialCommitRun },
    { commitCurrentDepositBalanceCaptureInTransaction },
  ] = await Promise.all([
    import("../ledger/canonical/canonical-financial-commit-execution.ts"),
    import("../ledger/canonical/current-deposit-balance-writer.ts"),
  ]);
  const result = await executeCanonicalFinancialCommitRun({
    canonicalLedgerDir,
    items: captures.map((capture) => ({
      provider: "cathay",
      product: "current-deposit-balance",
      itemKey: capture.identity.sourceAccountKey,
      commit: ({ writer, admission }) =>
        commitCurrentDepositBalanceCaptureInTransaction(
          writer,
          admitCurrentDepositBalanceCapture(capture),
          admission,
        ),
    })),
    provider: "cathay",
    product: "current-deposit-balance",
  });
  if (result.status === "failed" || result.status === "cancelled")
    throw new Error(
      `Cathay current foreign balance persistence ${result.status}: ${result.diagnostics
        .map((diagnostic) => `${diagnostic.stage}/${diagnostic.errorCode}`)
        .join(", ")}`,
    );
  return result.items.flatMap((item) =>
    item.status === "committed" ? [item.value] : [],
  );
}

async function collectCathayCurrentForeignDepositBalanceCaptures(
  page: Page,
  accountCaptures: readonly ForeignCurrencyDepositCaptureInput[],
  options: Pick<
    CathayCurrentForeignDepositBalanceCaptureOptions,
    "readCurrentDepositBalances"
  > = {},
): Promise<CurrentDepositBalanceCaptureInput[]> {
  const identities = new Map<
    string,
    Readonly<{
      sourceConnectionKey: string;
      identityEpochKey: string;
      subjectDigest: string;
    }>
  >();
  for (const capture of accountCaptures) {
    const admitted = admitForeignCurrencyDepositCapture(capture);
    identities.set(capture.accountNo, {
      sourceConnectionKey: admitted.identity.sourceConnectionKey,
      identityEpochKey: admitted.identity.identityEpochKey,
      subjectDigest: admitted.identity.subjectDigest,
    });
  }
  const currentRows = await (
    options.readCurrentDepositBalances ?? readCathayCurrentDepositBalances
  )(page, "foreign", {});
  const selectedRows = currentRows.filter((row) =>
    identities.has(row.sourceAccountKey),
  );
  if (selectedRows.length === 0) {
    throw new Error(
      "Cathay current foreign balance response did not contain an admitted account.",
    );
  }
  const missingAccountKeys = [...identities.keys()].filter(
    (accountKey) =>
      !selectedRows.some((row) => row.sourceAccountKey === accountKey),
  );
  if (missingAccountKeys.length > 0) {
    throw new Error(
      "Cathay current foreign balance response omitted an admitted account.",
    );
  }
  const rowsByAccount = new Map<string, CathayCurrentDepositBalanceRow[]>();
  for (const row of selectedRows) {
    const accountRows = rowsByAccount.get(row.sourceAccountKey) ?? [];
    accountRows.push(row);
    rowsByAccount.set(row.sourceAccountKey, accountRows);
  }
  const captures: CurrentDepositBalanceCaptureInput[] = [];
  for (const [accountKey, rows] of rowsByAccount) {
    const identity = identities.get(accountKey)!;
    const observedAt = rows[0]!.observedAt;
    captures.push(
      ...buildCathayCurrentDepositBalanceCaptures(rows, {
        ...identity,
        observedAt,
        scopeDate: observedAt.slice(0, 10),
      }),
    );
  }
  return captures;
}

/** Execute foreign statements and current balances through one lifecycle-owned
 * handle. Only foreign captures that committed may feed current-balance items.
 */
export async function commitCathayForeignAndCurrentCanonicalCaptures(
  page: Page,
  canonicalLedgerDir: string | undefined,
  captures: readonly ForeignCurrencyDepositCaptureInput[],
  options: {
    requireComplete?: boolean;
    readCurrentDepositBalances?: CathayCurrentForeignDepositBalanceCaptureOptions["readCurrentDepositBalances"];
  } = {},
): Promise<void> {
  if (captures.length === 0) return;
  if (pgliteWorkflowEnabled(process.env)) {
    const client = requirePGliteChildRpcClientFromEnv();
    try {
      await client.ready;
      const financial = await executePGliteWorkflowRun({
        client: client.workflow,
        provider: "cathay",
        product: "foreign-currency-deposit",
        items: captures.map((capture) => ({
          provider: "cathay",
          product: "foreign-currency-deposit",
          itemKey: capture.accountNo,
          command: {
            kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
            request: { capture: admitForeignCurrencyDepositCapture(capture) },
          },
        } as const)),
      });
      if (options.requireComplete ? financial.status !== "completed"
        : financial.status === "failed" || financial.status === "cancelled")
        throw new Error(`Cathay foreign PGlite persistence ${financial.status}: ${financial.diagnostics.map((d) => `${d.stage}/${d.errorCode}`).join(", ")}`);
      const committedCaptures = captures.filter((_, index) => financial.items[index]?.status === "committed");
      if (committedCaptures.length === 0) return;
      const currentCaptures = await collectCathayCurrentForeignDepositBalanceCaptures(
        page, committedCaptures, options,
      );
      const balances = await executePGliteWorkflowRun({
        client: client.workflow,
        provider: "cathay",
        product: "current-deposit-balance",
        items: currentCaptures.map((capture) => ({
          provider: "cathay",
          product: "current-deposit-balance",
          itemKey: capture.identity.sourceAccountKey,
          command: {
            kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
            request: currentDepositBalanceCommandRequest(admitCurrentDepositBalanceCapture(capture)),
          },
        } as const)),
      });
      if (options.requireComplete ? balances.status !== "completed"
        : balances.status === "failed" || balances.status === "cancelled")
        throw new Error(`Cathay foreign PGlite balance persistence ${balances.status}: ${balances.diagnostics.map((d) => `${d.stage}/${d.errorCode}`).join(", ")}`);
      return;
    } finally {
      client.close();
    }
  }
  if (!canonicalLedgerDir) return;
  const [
    { executeCanonicalFinancialCommitRun },
    { commitForeignCurrencyDepositCaptureInTransaction },
    { commitCurrentDepositBalanceCaptureInTransaction },
  ] = await Promise.all([
    import("../ledger/canonical/canonical-financial-commit-execution.ts"),
    import("../ledger/canonical/foreign-currency-deposit.ts"),
    import("../ledger/canonical/current-deposit-balance-writer.ts"),
  ]);
  const committedForeignCaptures: ForeignCurrencyDepositCaptureInput[] = [];
  const items = async function* (): AsyncGenerator<
    CanonicalFinancialCommitItem<CathayCanonicalCommitValue>
  > {
    for (const capture of captures) {
      yield {
        provider: "cathay",
        product: "foreign-currency-deposit",
        itemKey: capture.accountNo,
        commit: ({ writer, admission }) =>
          commitForeignCurrencyDepositCaptureInTransaction(
            writer,
            capture,
            admission,
          ),
        resolveRelations: async () => {
          committedForeignCaptures.push(capture);
        },
      };
    }
    if (committedForeignCaptures.length === 0) return;
    const currentCaptures =
      await collectCathayCurrentForeignDepositBalanceCaptures(
        page,
        committedForeignCaptures,
      );
    for (const capture of currentCaptures) {
      yield {
        provider: "cathay",
        product: "current-deposit-balance",
        itemKey: capture.identity.sourceAccountKey,
        commit: ({ writer, admission }) =>
          commitCurrentDepositBalanceCaptureInTransaction(
            writer,
            admitCurrentDepositBalanceCapture(capture),
            admission,
          ),
      };
    }
  };
  const result = await executeCanonicalFinancialCommitRun({
    canonicalLedgerDir,
    items: items(),
    provider: "cathay",
    product: "financial",
  });
  if (result.status === "failed" || result.status === "cancelled")
    throw new Error(
      `Cathay foreign canonical persistence ${result.status}: ${result.diagnostics
        .map((diagnostic) => `${diagnostic.stage}/${diagnostic.errorCode}`)
        .join(", ")}`,
    );
}

/** Capture current FX balances only after the statement capture has admitted the
 * existing account identity. The provider response is grouped by account so
 * multiple currencies remain one canonical depository identity. */
export async function captureCathayCurrentForeignDepositBalances(
  page: Page,
  accountCaptures: readonly ForeignCurrencyDepositCaptureInput[],
  canonicalLedgerDir: string | undefined,
  options: CathayCurrentForeignDepositBalanceCaptureOptions = {},
): Promise<readonly CurrentDepositBalanceCommitResult[]> {
  if (accountCaptures.length === 0) return [];
  if (!canonicalLedgerDir) {
    throw new Error(
      "Cathay current foreign balance capture requires the canonical ledger directory.",
    );
  }
  const captures = await collectCathayCurrentForeignDepositBalanceCaptures(
    page,
    accountCaptures,
    options,
  );
  return await (
    options.commitCurrentDepositBalances ??
    commitCathayCurrentForeignDepositBalancesThroughExecution
  )(canonicalLedgerDir, captures);
}

class CathayForeignApiClient {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
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

    return (response.content?.transferDetails ?? []).map((statement) => ({
      ...statement,
      ...(statement.transferInfos?.length === 0
        ? { zeroResultAuthority: "provider-explicit-no-data" as const }
        : {}),
    }));
  }

  private async apiPost<T>(
    path: string,
    session: Pick<CathaySession, "jwtToken">,
    body: unknown,
  ): Promise<CathayApiResponse<T>> {
    const responseText = (await this.page.evaluate(
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
        return await response.text();
      },
      { path, token: session.jwtToken, body },
    )) as string;
    const result = parseCathayApiJson<CathayApiResponse<T>>(responseText);

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
  onStatement?: CathayForeignStatementObserver,
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
      onStatement?.(account, currency, statement);
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
    const canonicalCollector = createCathayForeignCanonicalCaptureCollector(
      input.dateRange,
    );
    const downloads = await downloadCathayForeignStatements(
      page,
      input.dateRange,
      input.accountFilters,
      input.currencyFilters,
      undefined,
      canonicalCollector.onStatement,
    );

    const canonicalLedgerDir = configuredCathayCanonicalLedgerDir();
    await commitCathayForeignAndCurrentCanonicalCaptures(
      page,
      canonicalLedgerDir,
      canonicalCollector.captures,
    );

    return {
      dateRange: input.dateRange,
      count: downloads.length,
      downloads,
    };
  },
});
