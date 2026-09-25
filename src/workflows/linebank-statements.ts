import { mkdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  librettoAuthenticate,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Locator, Page } from "playwright";
import { z } from "zod";
import { emitAutomationProgress } from "../lib/automation/progress.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { requirePGliteChildRpcClientFromEnv } from "../../electron/pglite-child-rpc-client.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import { executePGliteWorkflowRun, type PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import type {
  DomesticDepositSourceTime,
  LineBankHumanAttestedV13ValidatedCapture,
} from "../ledger/canonical/linebank-domestic-deposit-contract.ts";
import {
  admitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositValidatedCapture,
} from "../ledger/canonical/canonical-financial-deposit-admission.ts";
import {
  admitForeignCurrencyDepositCapture,
  type ForeignCurrencyDepositCaptureInput,
} from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import {
  buildLinebankCurrentDepositBalanceCaptures,
} from "./linebank-current-deposit-canonical.ts";
import {
  parseLinebankApiJson,
  parseLinebankCurrentDepositBalanceSnapshot,
  type LineBankCurrentDepositBalanceRow,
  type LineBankCurrentDepositResponseMetadata,
} from "./linebank-current-deposit-balances.ts";
import { admitCurrentDepositBalanceCapture } from "../ledger/pglite/current-deposit-admission.ts";
import { emitHumanAssistanceStage } from "./human-assistance.ts";

const LOGIN_URL = "https://accessibility.linebank.com.tw/login";
const TRANSACTION_URL = "https://accessibility.linebank.com.tw/transaction";
const ACCOUNTS_ENDPOINT = "/v1/account/common/payables?featureTypeCode=01";
const TRANSACTIONS_ENDPOINT = "/v1/account/history/transactions";
export const LINEBANK_LOGIN_TIMEOUT_MS = 120_000;

const LINEBANK_V13_AUTHORITY = "linebank/domestic-deposit/human-attested-v13";
const LINEBANK_V13_RECORD_KIND = "linebank-domestic-deposit-financial-v13";

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("LINE Bank workflow was cancelled."));
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

function linebankCanonicalToken(...parts: string[]): string {
  return `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function linebankCanonicalDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function linebankCanonicalDateTime(value: DomesticDepositSourceTime): string {
  return `${linebankCanonicalDate(value.localDate)}T${value.localTime.slice(0, 2)}:${value.localTime.slice(2, 4)}:${value.localTime.slice(4, 6)}`;
}

function linebankCompactFinancialRecord(
  capture: LineBankHumanAttestedV13ValidatedCapture,
  record: LineBankHumanAttestedV13ValidatedCapture["records"][number],
): string {
  return JSON.stringify({
    sourceOccurrenceKey: record.sourceOccurrenceKey,
    baseOccurrenceKey: record.baseOccurrenceKey,
    sourceChangeFingerprint: record.sourceChangeFingerprint,
    accountKey: capture.accountKey,
    sourceConnection: capture.sourceConnection,
    stream: capture.stream,
    contractVersion: capture.contractVersion,
    identityEpoch: capture.identityEpoch,
    sourceSequence: record.sourceSequence,
    occurrenceCounter: record.occurrenceCounter,
    sourceSequenceKey: record.sourceOccurrenceKey,
    sourceTime: record.sourceTime,
    direction: record.direction,
    sourceDirectionCode: record.sourceDirectionCode,
    amount: record.amount,
    balanceAfter: record.balanceAfter,
    currency: record.currency,
    description: record.description ?? null,
    cancellation: "N",
    cancellationFlags: record.cancellationFlags,
    provenance: { matchingRuleVersion: "occurrence-v1" },
  });
}

/** Keep LINE Bank's provider vocabulary in the adapter before execution. */
export function normalizeLineBankFinancialCapture(
  capture: LineBankHumanAttestedV13ValidatedCapture,
): CanonicalFinancialDepositValidatedCapture {
  const contractFingerprint = linebankCanonicalToken(
    "linebank-v13-contract",
    capture.contractVersion,
    capture.humanAttestation.evidenceVersion,
  );
  const preflightFingerprint = linebankCanonicalToken(
    "linebank-v13-scope",
    capture.sourceScopeEvidence.evidenceVersion,
    capture.authority.kind,
    capture.authority.membershipEffectiveDate ?? "personal-main",
  );
  return admitCanonicalFinancialDepositCapture({
    captureId: capture.captureId,
    authorityRoute: LINEBANK_V13_AUTHORITY,
    contractVersion: "human-attested-v13",
    identity: {
      integrationNamespace: "linebank",
      sourceConnectionKey: linebankCanonicalToken(
        "linebank-connection",
        capture.sourceConnection,
      ),
      identityEpochKey: linebankCanonicalToken(
        "linebank-epoch",
        capture.sourceConnection,
        String(capture.identityEpoch),
      ),
      stream: capture.stream,
      recordKind: LINEBANK_V13_RECORD_KIND,
      subjectDigest: capture.accountKey,
      accountNo: capture.accountKey,
      sourceAccountKey: capture.accountKey,
      accountNumber: capture.accountNumber ?? null,
      accountType: "depository",
      currency: "TWD",
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: linebankCanonicalDate(capture.scope.startDate),
      endDate: linebankCanonicalDate(capture.scope.endDate),
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis:
        "human-attested-requested-scope-all-pages-stable-totals",
      completenessRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      absenceAuthority: "comparable-complete-range",
      contractFingerprint,
      preflightFingerprint,
      pageCount: capture.pageCount,
    },
    semantics: {
      postingStatus: capture.postingStatus,
      postingOrigin: "human_attested_history",
      postingBasis: "human-attested-formally-posted",
      postingRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      effectiveTimeBasis: capture.effectiveTimeBasis,
      effectiveTimeRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      timeZone: capture.timeZone,
      timePrecision: "second",
      timeOrigin: "source_reported",
      requireBalance: true,
    },
    pages: capture.pages.map((page) => ({
      pageOrdinal: page.pageNbr - 1,
      responseCode: "200",
      terminal: page.pageNbr === capture.pageCount,
      rowCount: page.txCnt,
      responseDigest: linebankCanonicalToken(
        "linebank-v13-page",
        capture.captureId,
        String(page.pageNbr),
        String(page.txCnt),
      ),
      proofKind: "human-attested-requested-scope-all-pages-stable-totals",
      contractFingerprint,
      preflightFingerprint,
      metadataJson: JSON.stringify({
        pageNbr: page.pageNbr,
        pageCapacity: page.pageCnt,
        totalCount: page.totTxCnt,
        rowCount: page.txCnt,
      }),
    })),
    records: capture.records.map((record) => ({
      occurrenceKey: record.sourceOccurrenceKey,
      collisionKey: record.baseOccurrenceKey,
      providerKey: record.sourceOccurrenceKey,
      contentHash: record.sourceChangeFingerprint,
      sequenceLexeme: record.sourceOccurrenceKey,
      compactJson: linebankCompactFinancialRecord(capture, record),
      amount: record.amount,
      balanceAfter: record.balanceAfter,
      currency: record.currency,
      description: record.description ?? null,
      direction: record.direction,
      sourceTime: {
        localDate: linebankCanonicalDate(record.sourceTime.localDate),
        localTime: `${record.sourceTime.localTime.slice(0, 2)}:${record.sourceTime.localTime.slice(2, 4)}:${record.sourceTime.localTime.slice(4, 6)}`,
        timeZone: record.sourceTime.timeZone,
        epochMilliseconds: record.sourceTime.epochMilliseconds,
      },
      effectiveOn: linebankCanonicalDate(record.sourceTime.localDate),
      transactionDateTimeLocal: linebankCanonicalDateTime(record.sourceTime),
    })),
  });
}

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

const typedInputSchema = z.object({
  credentials: z.object({
    linebank_user_id: z.string().trim().min(1),
    linebank_account: z.string().trim().min(1),
    linebank_password: z.string().trim().min(1),
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
  canonicalCaptureCount: z.number().int().nonnegative(),
  downloads: z.array(downloadSchema),
});

type DateRange = {
  startDate: string;
  endDate: string;
};

export type LineBankProviderWorkflowInput = z.infer<typeof typedInputSchema>;

export type LineBankProviderWorkflowOutput = Readonly<{
  dateRange: DateRange;
  accountCount: number;
  statementRowCount: number;
  sourceCaptureCount: number;
  financialItemCount: number;
  status: "source-only" | "financial-admitted";
}>;

type LineBankCredentials = {
  linebank_user_id?: string;
  linebank_account?: string;
  linebank_password?: string;
};

export type LineBankAccount = {
  acctNbr?: string;
  arrId?: string;
  acctNick?: string;
  pdNm?: string;
  currCd?: string;
  ccyCd?: string;
  crncyCd?: string;
  currency?: string;
};

export const LINEBANK_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "linebank/foreign-account/account-number-v1" as const;

export type LineBankAccountNumberEvidence = Readonly<{
  value: string;
  kind: "depository-account";
  evidenceVersion: typeof LINEBANK_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION;
  sourceField: "GET /v1/account/common/payables content.dpstAcctList[].acctNbr";
}>;

export function deriveLinebankAccountNumberEvidence(
  account: LineBankAccount,
): LineBankAccountNumberEvidence | null {
  const value = cleanText(account.acctNbr).normalize("NFKC");
  if (!/^\d{6,24}$/.test(value)) return null;
  return {
    value,
    kind: "depository-account",
    evidenceVersion: LINEBANK_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField:
      "GET /v1/account/common/payables content.dpstAcctList[].acctNbr",
  };
}

/** The provider's account identity is a composite of the two source fields.
 * Keep the delimiter explicit so two different pairs cannot concatenate to the
 * same opaque key (for example, `12` + `3` versus `1` + `23`). */
export function linebankAccountKey(account: LineBankAccount): string {
  const accountNumber = cleanText(account.acctNbr);
  const arrangementId = cleanText(account.arrId);
  return accountNumber && arrangementId
    ? `${accountNumber}:${arrangementId}`
    : "";
}

type LineBankAccountsResponse = {
  code?: string;
  message?: string;
  content?: {
    dpstAcctList?: LineBankAccount[];
  } | null;
};

export type LineBankTransactionRow = {
  txSeqNbr?: number | string;
  txDt?: string;
  txTm?: string;
  /** Observed source type: epoch milliseconds. */
  txDtm?: number;
  dpstWdrwDsCd?: string;
  bizTxFuncTpCd?: string;
  bizTxFuncTpNm?: string;
  crrnDpstNthCnt?: number;
  ctptCustLineUid?: string | null;
  fxsTxId?: string | null;
  rltvTxArrId?: string | null;
  txCaseCd?: string;
  txAmt?: number | string;
  afTxBal?: number | string;
  cncdTxYn?: string;
  cnclTxYn?: string;
  txRmkCont?: string;
  txMemoVal?: string | null;
};

/** Scalar account/product/status fields observed in the transaction response. */
export type LineBankTransactionSourceEnvelope = {
  acctNbr?: string;
  arrId?: string;
  acctNick?: string;
  acctBal?: number | string;
  wdrwAvblAmt?: number | string;
  acctColrTpCd?: string;
  acctColrTpVal?: string;
  acctCardImgUrl?: string | null;
  pdCd?: string;
  pdNm?: string;
  simpAcctTpCd?: string | null;
  jntAcctMbrTpCd?: string;
  isSecuAcctBndg?: boolean;
  debitCardFundBlcknYn?: string;
  txBlcknYn?: string;
  opnDtm?: number;
  jntMbrListCnt?: number;
  totJntAcctMbrCnt?: number;
  rcntTxfrListCnt?: number;
};

export type LineBankTransactionResponseContent =
  LineBankTransactionSourceEnvelope & {
    pageNbr?: number;
    pageCnt?: number;
    totTxCnt?: number;
    txCnt?: number;
    txLst?: LineBankTransactionRow[];
  };

export type LineBankTransactionsResponse = {
  code?: string;
  message?: string;
  content?: LineBankTransactionResponseContent | null;
};

/** A page preserves the source response envelope instead of reducing it to
 * rendered CSV rows. The canonical contract uses these counts to prove that
 * the requested range was completely collected before admitting any record. */
export type LineBankTransactionPage = {
  pageNbr: number;
  pageCnt: number;
  totTxCnt: number;
  txCnt: number;
  rows: LineBankTransactionRow[];
  source?: LineBankTransactionSourceEnvelope;
  responseCode?: string;
  responseMessage?: string;
};

type LineBankDownload = z.infer<typeof downloadSchema>;

export type LineBankStatementRow = {
  sortKey: string;
  values: string[];
};

let lastTimestamp = 0;

function cleanText(value: unknown): string {
  return String(value ?? "")
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
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return date;
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
  if (firstStart > end)
    throw new Error("startDate must be on or before endDate.");
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

export const LINEBANK_OBSERVED_TIME_EVIDENCE_VERSION =
  "observed-time-v1" as const;

/** Reconstruct the source timestamp using Taiwan's fixed UTC+8 offset. */
export function linebankEpochMillisecondsFromSourceDateTime(
  txDt: string | undefined,
  txTm: string | undefined,
): number {
  const date = cleanText(txDt);
  const time = cleanText(txTm);
  const dateMatch = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  const timeMatch = time.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!dateMatch || !timeMatch) {
    throw new Error("LINE Bank transaction source date/time is invalid.");
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error("LINE Bank transaction source date/time is invalid.");
  }
  const epochMilliseconds = Date.UTC(
    year,
    month - 1,
    day,
    hour - 8,
    minute,
    second,
  );
  if (!Number.isSafeInteger(epochMilliseconds)) {
    throw new Error("LINE Bank transaction source time is out of range.");
  }
  return epochMilliseconds;
}

export function linebankValidateTransactionTime(
  row: LineBankTransactionRow,
): void {
  if (
    !cleanText(row.txDt) ||
    !cleanText(row.txTm) ||
    row.txDtm === undefined ||
    row.txDtm === null
  ) {
    throw new Error("LINE Bank transaction source time is incomplete.");
  }
  if (!Number.isSafeInteger(row.txDtm) || row.txDtm < 0) {
    throw new Error(
      "LINE Bank transaction source txDtm must be a safe epoch-millisecond integer.",
    );
  }
  if (
    linebankEpochMillisecondsFromSourceDateTime(row.txDt, row.txTm) !==
    row.txDtm
  ) {
    throw new Error(
      "LINE Bank transaction source txDtm does not match txDt+txTm in Asia/Taipei.",
    );
  }
}

/** Preserve and validate the provider occurrence fields before any export. */
export function linebankValidateSourceOccurrenceFields(
  row: LineBankTransactionRow,
): void {
  const txSeqNbr = row.txSeqNbr;
  const validSequence =
    (typeof txSeqNbr === "number" &&
      Number.isSafeInteger(txSeqNbr) &&
      txSeqNbr > 0) ||
    (typeof txSeqNbr === "string" &&
      /^\d+$/.test(txSeqNbr.trim()) &&
      BigInt(txSeqNbr.trim()) > 0n);
  if (!validSequence) {
    throw new Error(
      "LINE Bank transaction source txSeqNbr must be a positive integer.",
    );
  }
  if (
    typeof row.crrnDpstNthCnt !== "number" ||
    !Number.isSafeInteger(row.crrnDpstNthCnt) ||
    row.crrnDpstNthCnt <= 0
  ) {
    throw new Error(
      "LINE Bank transaction source crrnDpstNthCnt must be a positive integer.",
    );
  }
  linebankValidateTransactionTime(row);
}

const DECIMAL_AMOUNT_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function transactionAmountLexeme(value: number | string | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Invalid LINE Bank transaction amount.");
    const lexeme = String(value);
    if (!DECIMAL_AMOUNT_RE.test(lexeme)) {
      throw new Error("Invalid LINE Bank transaction amount.");
    }
    return lexeme;
  }
  if (typeof value !== "string")
    throw new Error("Invalid LINE Bank transaction amount.");
  const lexeme = value.trim();
  if (lexeme === "" || !DECIMAL_AMOUNT_RE.test(lexeme)) {
    if (lexeme === "") return "";
    throw new Error("Invalid LINE Bank transaction amount.");
  }
  return lexeme;
}

function amountText(value: number | string | undefined): string {
  return transactionAmountLexeme(value).replace(/^-/, "");
}

function validateTransactionDirection(row: LineBankTransactionRow): string {
  if (row.dpstWdrwDsCd !== "1" && row.dpstWdrwDsCd !== "2") {
    throw new Error("Unsupported LINE Bank transaction direction.");
  }
  const rawAmount = transactionAmountLexeme(row.txAmt);
  if (rawAmount.startsWith("-")) {
    throw new Error(
      `LINE Bank transaction amount conflicts with ${
        row.dpstWdrwDsCd === "1" ? "deposit" : "withdrawal"
      } direction.`,
    );
  }
  return rawAmount;
}

function amountColumns(row: LineBankTransactionRow): [string, string] {
  const rawAmount = validateTransactionDirection(row);
  const amount = rawAmount.replace(/^-/, "");
  if (!amount) return ["", ""];
  return row.dpstWdrwDsCd === "1" ? ["", amount] : [amount, ""];
}

function compareRowsDesc(
  left: LineBankStatementRow,
  right: LineBankStatementRow,
) {
  return right.sortKey.localeCompare(left.sortKey);
}

export function linebankSortStatementRows(
  rows: LineBankStatementRow[],
): LineBankStatementRow[] {
  return [...rows].sort(compareRowsDesc);
}

function linebankSourceEnvelope(
  content: LineBankTransactionResponseContent,
): LineBankTransactionSourceEnvelope {
  return {
    acctNbr: content.acctNbr,
    arrId: content.arrId,
    acctNick: content.acctNick,
    acctBal: content.acctBal,
    wdrwAvblAmt: content.wdrwAvblAmt,
    acctColrTpCd: content.acctColrTpCd,
    acctColrTpVal: content.acctColrTpVal,
    acctCardImgUrl: content.acctCardImgUrl,
    pdCd: content.pdCd,
    pdNm: content.pdNm,
    simpAcctTpCd: content.simpAcctTpCd,
    jntAcctMbrTpCd: content.jntAcctMbrTpCd,
    isSecuAcctBndg: content.isSecuAcctBndg,
    debitCardFundBlcknYn: content.debitCardFundBlcknYn,
    txBlcknYn: content.txBlcknYn,
    opnDtm: content.opnDtm,
    jntMbrListCnt: content.jntMbrListCnt,
    totJntAcctMbrCnt: content.totJntAcctMbrCnt,
    rcntTxfrListCnt: content.rcntTxfrListCnt,
  };
}

/** Preserve the source response as a typed staged page without projecting it
 * into CSV fields. This helper is deliberately pure so its shape can be
 * checked without a browser or a live request. */
export function linebankTransactionPageFromResponse(
  response: LineBankTransactionsResponse,
): LineBankTransactionPage {
  if (response.code !== "200") {
    throw new Error("LINE Bank transactions failed.");
  }
  const content = response.content;
  const pageRows = content?.txLst;
  if (!content || !Array.isArray(pageRows)) {
    throw new Error("LINE Bank transaction response is missing its page rows.");
  }
  const pageNbr = content.pageNbr;
  const pageCnt = content.pageCnt;
  const totTxCnt = content.totTxCnt;
  const txCnt = content.txCnt;
  if (
    typeof pageNbr !== "number" ||
    typeof pageCnt !== "number" ||
    typeof totTxCnt !== "number" ||
    typeof txCnt !== "number" ||
    !Number.isInteger(pageNbr) ||
    !Number.isInteger(pageCnt) ||
    !Number.isInteger(totTxCnt) ||
    !Number.isInteger(txCnt) ||
    pageNbr < 1 ||
    pageCnt < 1 ||
    totTxCnt < 0 ||
    txCnt < 0 ||
    txCnt !== pageRows.length
  ) {
    throw new Error(
      "LINE Bank transaction response has invalid page/count metadata.",
    );
  }
  for (const balance of [content.acctBal, content.wdrwAvblAmt]) {
    if (balance !== undefined && balance !== null) {
      transactionAmountLexeme(balance);
    }
  }
  for (const row of pageRows) {
    linebankValidateSourceOccurrenceFields(row);
    if (row.txAmt !== undefined && row.txAmt !== null) {
      transactionAmountLexeme(row.txAmt);
    }
    if (row.afTxBal !== undefined && row.afTxBal !== null) {
      transactionAmountLexeme(row.afTxBal);
    }
    if (
      row.txDtm !== undefined &&
      (!Number.isSafeInteger(row.txDtm) || row.txDtm < 0)
    ) {
      throw new Error("LINE Bank transaction response has invalid txDtm type.");
    }
  }
  return {
    pageNbr,
    pageCnt,
    totTxCnt,
    txCnt,
    rows: pageRows,
    source: linebankSourceEnvelope(content),
    responseCode: response.code,
    responseMessage: response.message,
  };
}

function noteText(row: LineBankTransactionRow): string {
  return [row.txRmkCont, row.txMemoVal]
    .map(cleanText)
    .filter(Boolean)
    .join(" ");
}

export function linebankApiRowsToStatementRows(
  rows: LineBankTransactionRow[],
): LineBankStatementRow[] {
  for (const row of rows) {
    validateTransactionDirection(row);
    if (row.afTxBal !== undefined && row.afTxBal !== null) {
      transactionAmountLexeme(row.afTxBal);
    }
  }
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

export function linebankValidateTransactionPageSequence(
  pages: readonly LineBankTransactionPage[],
  options: {
    requireComplete?: boolean;
    expectedAccount?: LineBankAccount;
  } = {},
): void {
  if (pages.length === 0)
    throw new Error("LINE Bank transaction pages are empty.");
  const first = pages[0];
  let collectedRows = 0;
  let sourceIdentity: string | undefined;
  const expectedIdentity = options.expectedAccount
    ? linebankAccountKey(options.expectedAccount)
    : "";
  const hasSourceEnvelope = pages.some((page) => page.source !== undefined);
  if (expectedIdentity && pages.some((page) => page.source === undefined)) {
    throw new Error(
      "LINE Bank source account identity metadata is missing for requested account.",
    );
  }
  if (hasSourceEnvelope && pages.some((page) => page.source === undefined)) {
    throw new Error("LINE Bank source account identity metadata is missing.");
  }
  for (const [index, page] of pages.entries()) {
    if (
      !Number.isInteger(page.pageNbr) ||
      page.pageNbr !== index + 1 ||
      !Number.isInteger(page.pageCnt) ||
      page.pageCnt < 1 ||
      !Number.isInteger(page.totTxCnt) ||
      page.totTxCnt < 0 ||
      !Number.isInteger(page.txCnt) ||
      page.txCnt < 0 ||
      page.txCnt !== page.rows.length
    ) {
      throw new Error("LINE Bank transaction page metadata is invalid.");
    }
    if (page.responseCode !== undefined && page.responseCode !== "200") {
      throw new Error("LINE Bank transaction response status is invalid.");
    }
    if (page.source !== undefined) {
      const acctNbr = cleanText(page.source.acctNbr);
      const arrId = cleanText(page.source.arrId);
      if (!acctNbr || !arrId) {
        throw new Error(
          "LINE Bank source account identity metadata is incomplete.",
        );
      }
      const pageSourceIdentity = `${acctNbr}:${arrId}`;
      if (expectedIdentity && pageSourceIdentity !== expectedIdentity) {
        throw new Error(
          "LINE Bank source account identity does not match requested account.",
        );
      }
      if (
        sourceIdentity !== undefined &&
        pageSourceIdentity !== sourceIdentity
      ) {
        throw new Error("LINE Bank source account identity drift detected.");
      }
      sourceIdentity = pageSourceIdentity;
    }
    if (page.pageCnt !== first.pageCnt)
      throw new Error("LINE Bank pageCnt drift detected.");
    if (page.totTxCnt !== first.totTxCnt)
      throw new Error("LINE Bank totTxCnt drift detected.");
    for (const row of page.rows) {
      if (
        row.txDtm !== undefined &&
        (!Number.isSafeInteger(row.txDtm) || row.txDtm < 0)
      ) {
        throw new Error("LINE Bank transaction txDtm type is invalid.");
      }
    }
    collectedRows += page.rows.length;
  }
  if (options.requireComplete && collectedRows !== first.totTxCnt) {
    throw new Error("LINE Bank transaction total row count mismatch.");
  }
}

export function linebankStatementRowsToCsv(
  rows: LineBankStatementRow[],
): string {
  return rowsToCsv([statementHeaders, ...rows.map((row) => row.values)]);
}

function exactLinebankAmount(value: number | string | undefined, label: string): string {
  if (typeof value === "number")
    throw new Error(`LINE Bank foreign ${label} must remain an exact decimal string.`);
  const lexeme = transactionAmountLexeme(value);
  if (!lexeme) throw new Error(`LINE Bank foreign row is missing ${label}.`);
  return lexeme;
}

/** Public adapter from typed LINE Bank response rows to foreign canonical rows. */
export function buildLinebankForeignCurrencyCaptureInput(input: {
  account: LineBankAccount;
  dateRange: DateRange;
  pages: readonly LineBankTransactionPage[];
  observedAt?: string;
  captureOccurrenceId?: string;
}): ForeignCurrencyDepositCaptureInput {
  const currency = linebankAccountCurrency(input.account);
  if (currency === "TWD" || !/^[A-Z]{3}$/.test(currency))
    throw new Error("LINE Bank foreign capture requires a source-proven currency.");
  const accountNo = linebankAccountKey(input.account);
  if (!accountNo) throw new Error("LINE Bank foreign account identity is incomplete.");
  const accountNumber = deriveLinebankAccountNumberEvidence(input.account);
  linebankValidateTransactionPageSequence(input.pages, {
    requireComplete: true,
    expectedAccount: input.account,
  });
  const rows = input.pages.flatMap((page) => page.rows);
  const identityEpoch = input.pages[0]?.source?.opnDtm;
  if (
    typeof identityEpoch !== "number" ||
    !Number.isSafeInteger(identityEpoch) ||
    identityEpoch < 0
  )
    throw new Error("LINE Bank foreign capture requires a source identity epoch.");
  const zeroResultAuthority =
    rows.length === 0 &&
    input.pages.every(
      (page) =>
        page.rows.length === 0 &&
        page.totTxCnt === 0 &&
        page.responseCode === "200",
    )
      ? ("provider-explicit-no-data" as const)
      : undefined;
  if (rows.length === 0 && zeroResultAuthority === undefined)
    throw new Error(
      "LINE Bank foreign empty capture requires provider-explicit-no-data terminal evidence.",
    );
  return {
    source: "linebank",
    accountNo,
    accountNumber,
    sourceConnectionKey: "linebank-foreign-current-login",
    identityEpochKey: String(identityEpoch),
    accountType: "depository",
    captureCurrencyScope: { kind: "currency", currency },
    captureOccurrenceId: input.captureOccurrenceId ?? "",
    zeroResultAuthority,
    observedAt: input.observedAt ?? new Date().toISOString(),
    startDate: formatSlashDate(input.dateRange.startDate).replaceAll("/", "-"),
    endDate: formatSlashDate(input.dateRange.endDate).replaceAll("/", "-"),
    completeness: "complete-range",
    records: rows.map((row) => {
      linebankValidateSourceOccurrenceFields(row);
      const signedAmount = exactLinebankAmount(row.txAmt, "amount");
      const signedBalanceAfter = exactLinebankAmount(row.afTxBal, "balance");
      if (row.dpstWdrwDsCd !== "1" && row.dpstWdrwDsCd !== "2")
        throw new Error("LINE Bank foreign row lacks an explicit direction.");
      if (signedAmount.startsWith("-"))
        throw new Error("LINE Bank foreign amount must be an unsigned exact magnitude; direction is separate evidence.");
      if (signedBalanceAfter.startsWith("-"))
        throw new Error("LINE Bank foreign negative balance is unsupported by the canonical contract.");
      const amount = signedAmount;
      const balanceAfter = signedBalanceAfter;
      const transactionDate = cleanText(row.txDt).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      const transactionTime = formatTime(row.txTm);
      return {
        sourceKey: `${accountNo}:${currency}:${String(row.txSeqNbr)}:${String(row.crrnDpstNthCnt)}:${String(row.txDtm)}`,
        sequence: String(row.txSeqNbr),
        amount,
        direction: row.dpstWdrwDsCd === "1" ? "inflow" : "outflow",
        currencyEvidence: { kind: "scope" as const, currency },
        balanceAfter,
        sourceTime: { localDate: transactionDate, localTime: transactionTime },
        originalAmount: { amount, currency },
        description: cleanText(row.bizTxFuncTpNm) || null,
        sourcePayload: {
          transactionSequence: String(row.txSeqNbr),
          occurrenceCounter: String(row.crrnDpstNthCnt),
          transactionEpochMilliseconds: String(row.txDtm),
          functionCode: row.bizTxFuncTpCd ?? "",
          transactionId: row.fxsTxId ?? "",
          signedAmount,
        },
      };
    }),
  };
}

function accountId(account: LineBankAccount): string {
  return cleanText(account.acctNbr);
}

function accountLabel(account: LineBankAccount): string {
  return (
    cleanText(account.acctNick) || cleanText(account.pdNm) || accountId(account)
  );
}

export function linebankAccountCurrency(account: LineBankAccount): string {
  return cleanText(
    account.currCd ??
      account.ccyCd ??
      account.crncyCd ??
      account.currency ??
      "TWD",
  ).toUpperCase();
}

function matchesFilters(account: LineBankAccount, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const haystack =
    `${accountLabel(account)} ${accountId(account)}`.toLowerCase();
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

function transactionLinkLocator(page: Page): Locator {
  return page.getByRole("link", { name: "帳戶交易明細查詢" });
}

function authenticatedMarkerLocator(page: Page): Locator {
  return page.locator(
    'a[href="/transaction"]:visible, #account-dropdown:visible',
  );
}

async function visibleMatches(locator: Locator): Promise<Locator[]> {
  const count = await locator.count();
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
  }
  return matches;
}

async function firstVisibleMatch(locator: Locator): Promise<Locator | null> {
  return (await visibleMatches(locator))[0] ?? null;
}

/**
 * Close only the explicitly approved, non-form dismissal button on one
 * visible alertdialog. Never inspect dialog text, click unknown controls, or
 * force a click; anything ambiguous remains a hard pre-query blocker.
 */
export async function linebankAutoDismissApprovedAlert(
  page: Page,
): Promise<void> {
  const dialogs = page.getByRole("alertdialog");
  const visibleDialogs = await visibleMatches(dialogs);
  if (visibleDialogs.length === 0) return;
  if (visibleDialogs.length !== 1) {
    throw new Error(
      "LINE Bank requires exactly one visible alert dialog before navigation.",
    );
  }

  const dialog = visibleDialogs[0];
  const approvedButtons = dialog.getByRole("button", {
    name: /^(?:確定|關閉|知道了)$/,
  });
  if ((await approvedButtons.count()) !== 1) {
    throw new Error(
      "LINE Bank alert dialog requires exactly one approved dismissal button.",
    );
  }
  const button = approvedButtons.nth(0);
  if (!(await button.isVisible().catch(() => false))) {
    throw new Error("LINE Bank approved dismissal button is not visible.");
  }
  await button.click();
  await dialog.waitFor({
    state: "hidden",
    timeout: LINEBANK_LOGIN_TIMEOUT_MS,
  });
  if ((await visibleMatches(dialogs)).length !== 0) {
    throw new Error("LINE Bank alert dialog remained visible after dismissal.");
  }
}

export async function linebankIsSignedIn(page: Page): Promise<boolean> {
  const pathname = new URL(page.url()).pathname;
  if (pathname === "/login") return false;
  if (pathname === "/transaction") {
    return (
      (await firstVisibleMatch(page.locator("#account-dropdown"))) !== null
    );
  }
  return (await firstVisibleMatch(transactionLinkLocator(page))) !== null;
}

function requireLineBankCredential(
  credentials: LineBankCredentials,
  key: keyof LineBankCredentials,
): string {
  const value = credentials[key]?.trim();
  if (!value) throw new Error(`${key} credential is required.`);
  return value;
}

/** Sign in from a clean headless session using the declared device-local credentials. */
export async function linebankSignIn(
  page: Page,
  credentials: LineBankCredentials,
): Promise<void> {
  if (await linebankIsSignedIn(page)) return;

  const nationalId = requireLineBankCredential(credentials, "linebank_user_id");
  const userId = requireLineBankCredential(credentials, "linebank_account");
  const password = requireLineBankCredential(credentials, "linebank_password");
  if (new URL(page.url()).pathname !== "/login") {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  }

  await page.locator("#nationalId").fill(nationalId);
  await page.locator("#userId").fill(userId);
  await page.locator("#pw").fill(password);

  const loginButtons = page.getByRole("button", {
    name: "登入友善網路銀行",
    exact: true,
  });
  if ((await loginButtons.count()) !== 1) {
    throw new Error("LINE Bank login requires exactly one submit button.");
  }
  const loginButton = loginButtons.first();
  if (!(await loginButton.isVisible().catch(() => false))) {
    throw new Error("LINE Bank login submit button is not visible.");
  }
  await loginButton.click();

  const deadline = Date.now() + LINEBANK_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await linebankAutoDismissApprovedAlert(page);
    if (await linebankIsSignedIn(page)) return;
    await page.waitForTimeout(250);
  }
  throw new Error("Timed out waiting for LINE Bank signed-in state.");
}

/** Enter the transaction stage only after authentication has completed. */
export async function linebankEnsureTransactionPage(page: Page): Promise<void> {
  if (new URL(page.url()).pathname === "/transaction") {
    await page.locator("#account-dropdown").waitFor({
      state: "visible",
      timeout: LINEBANK_LOGIN_TIMEOUT_MS,
    });
    return;
  }

  const transactionLink = await firstVisibleMatch(transactionLinkLocator(page));
  if (transactionLink) {
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/transaction", {
        timeout: LINEBANK_LOGIN_TIMEOUT_MS,
      }),
      transactionLink.click(),
    ]);
  } else {
    await page.goto(TRANSACTION_URL, { waitUntil: "domcontentloaded" });
  }
  await page.locator("#account-dropdown").waitFor({
    state: "visible",
    timeout: LINEBANK_LOGIN_TIMEOUT_MS,
  });
}

function responseCharset(headers: Readonly<Record<string, string>>): string {
  const contentType = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1] ?? "";
  const match = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(contentType);
  return match?.[1] ?? "utf-8";
}

export class LineBankApiClient {
  private page: Page;
  private text?: SourceTextPort;
  private signal?: AbortSignal;

  constructor(
    page: Page,
    options: { text?: SourceTextPort; signal?: AbortSignal } = {},
  ) {
    this.page = page;
    this.text = options.text;
    this.signal = options.signal;
  }

  private async apiResponse(
    path: string,
    options?: { body?: unknown },
  ): Promise<{
    body: string;
    url: string;
    status: number;
    method: string;
    headers: Record<string, string>;
  }> {
    const response = await withAbort(this.page.evaluate<{
      body?: string;
      bodyBytes?: number[];
      url: string;
      status: number;
      method: string;
      headers: Record<string, string>;
    }, { path: string; body?: unknown; includeBytes: boolean }>(
      async ({ path, body, includeBytes }) => {
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
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return {
          ...(includeBytes
            ? { bodyBytes: Array.from(new Uint8Array(await response.arrayBuffer())) }
            : { body: await response.text() }),
          url: response.url,
          status: response.status,
          method: init.method ?? "GET",
          headers: responseHeaders,
        };
      },
      { path, body: options?.body, includeBytes: Boolean(this.text) },
    ), this.signal);
    if (!this.text) {
      if (typeof response.body !== "string")
        throw new Error("LINE Bank API response body is unavailable.");
      return { ...response, body: response.body };
    }
    if (!Array.isArray(response.bodyBytes))
      throw new Error("LINE Bank source response bytes are unavailable.");
    const body = this.text.decode(
      Uint8Array.from(response.bodyBytes),
      responseCharset(response.headers),
    );
    this.text.assertIntact(body);
    return { ...response, body };
  }

  private async apiJson<T>(
    path: string,
    options?: { body?: unknown },
  ): Promise<T> {
    const response = await this.apiResponse(path, options);
    if (response.status < 200 || response.status >= 300)
      throw new Error(`${response.status} for ${path}`);
    const value = parseLinebankApiJson<T>(response.body);
    this.text?.assertIntact(JSON.stringify(value));
    return value;
  }

  private async accountResponse(): Promise<{
    accounts: LineBankAccount[];
    response: LineBankCurrentDepositResponseMetadata;
    rawBody: string;
  }> {
    const response = await this.apiResponse(ACCOUNTS_ENDPOINT);
    if (response.status < 200 || response.status >= 300)
      throw new Error(`${response.status} for ${ACCOUNTS_ENDPOINT}`);
    const payload = parseLinebankApiJson<LineBankAccountsResponse>(response.body);
    this.text?.assertIntact(JSON.stringify(payload));
    if (payload.code !== "200") {
      throw new Error(
        `LINE Bank account list failed: ${payload.message ?? "unknown"}`,
      );
    }
    if (!payload.content || !Array.isArray(payload.content.dpstAcctList))
      throw new Error("LINE Bank account list is incomplete.");
    return {
      accounts: payload.content.dpstAcctList,
      response: {
        url: response.url,
        status: response.status,
        method: response.method,
        headers: response.headers,
      },
      rawBody: response.body,
    };
  }

  async fetchAccounts(): Promise<LineBankAccount[]> {
    const snapshot = await this.accountResponse();
    // Parse the same response through the bounded current-balance contract so
    // every account's available field is present and exact, even when a
    // non-TWD account is excluded from this domestic route.
    parseLinebankCurrentDepositBalanceSnapshot({
      response: snapshot.response,
      rawBody: snapshot.rawBody,
      observedAt: new Date().toISOString(),
    });
    return snapshot.accounts;
  }

  async fetchAccountSnapshot(observedAt?: string): Promise<{
    accounts: LineBankAccount[];
    currentBalances: readonly LineBankCurrentDepositBalanceRow[];
  }> {
    const snapshot = await this.accountResponse();
    const effectiveObservedAt = observedAt ?? new Date().toISOString();
    const currentBalances = parseLinebankCurrentDepositBalanceSnapshot({
      response: snapshot.response,
      rawBody: snapshot.rawBody,
      observedAt: effectiveObservedAt,
    });
    return { accounts: snapshot.accounts, currentBalances };
  }

  async fetchTransactionPages(
    account: LineBankAccount,
    dateRange: DateRange,
  ): Promise<LineBankTransactionPage[]> {
    const pages: LineBankTransactionPage[] = [];
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
      const page = linebankTransactionPageFromResponse(response);
      if (page.pageNbr !== pageNbr) {
        throw new Error(
          "LINE Bank transaction page metadata does not match the requested page.",
        );
      }
      if (page.totTxCnt < rows.length + page.rows.length) {
        throw new Error(
          "LINE Bank transaction page rows exceed the reported total.",
        );
      }
      pages.push(page);
      linebankValidateTransactionPageSequence(pages, {
        expectedAccount: account,
      });
      rows.push(...page.rows);
      total = page.totTxCnt;
      if (page.rows.length === 0 && rows.length < total) {
        throw new Error(
          "LINE Bank transaction pagination ended before the reported total.",
        );
      }
      if (rows.length >= total) break;
      pageNbr += 1;
    }

    linebankValidateTransactionPageSequence(pages, {
      requireComplete: true,
      expectedAccount: account,
    });
    return pages;
  }

  async fetchTransactions(
    account: LineBankAccount,
    dateRange: DateRange,
  ): Promise<LineBankTransactionRow[]> {
    const pages = await this.fetchTransactionPages(account, dateRange);
    return pages.flatMap((page) => page.rows);
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

/** Build the privacy-bounded v13 canonical capture for one personal TWD
 * account/range. Shared-member captures remain outside the first admission
 * contract and are skipped without affecting statement downloads. */
export async function linebankHumanAttestedCapture(input: {
  account: LineBankAccount;
  dateRange: DateRange;
  pages: LineBankTransactionPage[];
  captureId: string;
  observedAt: string;
}): Promise<LineBankHumanAttestedV13ValidatedCapture | null> {
  const source = input.pages[0]?.source;
  const {
    LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
    LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
    linebankHumanAttestedV13AuthorityKind,
    validateLineBankHumanAttestedV13Capture,
  } = await import("../ledger/canonical/linebank-domestic-deposit.ts");
  if (
    !source ||
    linebankHumanAttestedV13AuthorityKind(source) !== "personal-main"
  ) {
    return null;
  }
  const validation = validateLineBankHumanAttestedV13Capture({
    account: input.account,
    scope: input.dateRange,
    pages: input.pages,
    captureId: input.captureId,
    sourceConnection: "accessibility.linebank.com.tw",
    identityEpoch: Number(source.opnDtm),
    observedAt: input.observedAt,
    sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
    humanAttestation: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
    authority: { kind: "personal-main", membershipEffectiveDate: null },
  });
  if (validation.status !== "admissible" || !validation.capture) {
    throw new Error(
      `LINE Bank canonical capture rejected: ${validation.diagnostics.join(",") || "unknown"}`,
    );
  }
  return validation.capture;
}

async function downloadLineBankStatements(
  page: Page,
  input: z.infer<typeof inputSchema>,
): Promise<z.infer<typeof outputSchema>> {
  const dateRange = resolveDateRange(input);
  const windows = linebankQueryWindows(dateRange);
  const apiClient = new LineBankApiClient(page);
  const accountSnapshot = await apiClient.fetchAccountSnapshot();
  const accounts = filterAccounts(
    accountSnapshot.accounts,
    input.accountFilters,
    input.currencyFilters,
  );

  if (accounts.length === 0) {
    throw new Error(
      "No LINE Bank accounts matched accountFilters/currencyFilters.",
    );
  }
  const selectedAccountKeys = new Set(
    accounts.map((account) => linebankAccountKey(account)).filter(Boolean),
  );
  const currentBalanceRows = accountSnapshot.currentBalances.filter((row) =>
    selectedAccountKeys.has(linebankAccountKey(row.account)),
  );

  const downloads: LineBankDownload[] = [];
  const canonicalCaptures: LineBankHumanAttestedV13ValidatedCapture[] = [];
  const foreignCanonicalCaptures: ForeignCurrencyDepositCaptureInput[] = [];
  const captureOccurrenceId = randomUUID();
  for (const account of accounts) {
    const rows: LineBankStatementRow[] = [];
    for (const window of windows) {
      const pages = await apiClient.fetchTransactionPages(account, window);
      rows.push(
        ...linebankApiRowsToStatementRows(pages.flatMap((page) => page.rows)),
      );
      if (linebankAccountCurrency(account) === "TWD") {
        const capture = await linebankHumanAttestedCapture({
          account,
          dateRange: window,
          pages,
          captureId: `linebank-${randomUUID()}`,
          observedAt: new Date().toISOString(),
        });
        if (capture) canonicalCaptures.push(capture);
      } else {
        foreignCanonicalCaptures.push(
          buildLinebankForeignCurrencyCaptureInput({
            account,
            dateRange: window,
            pages,
            captureOccurrenceId,
          }),
        );
      }
    }
    downloads.push(
      await writeStatementFiles(
        account,
        windows.map(queryPeriod),
        linebankSortStatementRows(rows),
      ),
    );
  }

  const client = requirePGliteChildRpcClientFromEnv();
  try {
    await client.ready;
    const statementItems = [
      ...canonicalCaptures.map((capture) => ({
        provider: "linebank", product: "domestic-deposit", itemKey: capture.captureId,
        command: {
          kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
          request: { capture: normalizeLineBankFinancialCapture(capture) },
        },
      } as const)),
      ...foreignCanonicalCaptures.map((capture, index) => ({
        provider: "linebank", product: "foreign-currency",
        itemKey: `foreign-currency:${captureOccurrenceId}:${index}`,
        command: {
          kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
          request: { capture: admitForeignCurrencyDepositCapture(capture) },
        },
      } as const)),
    ];
    const statements = await executePGliteWorkflowRun({
      client: client.workflow, items: statementItems,
      provider: "linebank", product: "financial",
    });
    if (statements.status !== "completed")
      throw new Error(`LINE Bank PGlite commit ${statements.status}: ${statements.diagnostics.map((d) => `${d.stage}/${d.errorCode}`).join(", ")}`);
    let balanceItems: PGliteWorkflowRunItem[] = [];
    if (currentBalanceRows.length > 0 && canonicalCaptures.length > 0) {
      const currentBalanceCaptures = buildLinebankCurrentDepositBalanceCaptures(
        currentBalanceRows,
        canonicalCaptures.map((capture) => ({
          accountKey: capture.accountKey,
          sourceConnection: capture.sourceConnection,
          identityEpoch: capture.identityEpoch,
          observedAt: capture.observedAt,
        })),
      );
      balanceItems = currentBalanceCaptures.map((capture, index) => ({
        provider: "linebank", product: "current-balance",
        itemKey: `current-balance:${index}`,
        command: {
          kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
          request: currentDepositBalanceCommandRequest(admitCurrentDepositBalanceCapture(capture)),
        },
      }));
    }
    const balances = await executePGliteWorkflowRun({
      client: client.workflow, items: balanceItems,
      provider: "linebank", product: "current-balance",
    });
    if (balances.status !== "completed")
      throw new Error(`LINE Bank PGlite balance commit ${balances.status}: ${balances.diagnostics.map((d) => `${d.stage}/${d.errorCode}`).join(", ")}`);
    const canonicalCaptureCount = [...statements.items, ...balances.items].reduce(
      (count, item) => count + (item.status === "committed" ? item.admissionSummaries.length : 0), 0,
    );
    return {
      dateRange,
      count: downloads.length,
      rowCount: downloads.reduce((sum, download) => sum + download.rowCount, 0),
      canonicalCaptureCount,
      downloads,
    };
  } finally {
    client.close();
  }

}

function linebankHumanVerificationStage(page: Page) {
  const body = page.locator("body");
  return {
    stageId: "linebank-login-verification",
    title: "Complete LINE Bank sign-in or verification",
    targets: [{
      id: "sign-in-page",
      label: "LINE Bank sign-in page",
      semanticId: "linebank.login.page",
      modes: ["click", "type", "press"] as const,
      locator: body,
    }],
    contextRegions: [{
      id: "sign-in-context",
      label: "LINE Bank sign-in and verification",
      semanticId: "linebank.login.context",
      locator: body,
    }],
    completion: { mode: "independent" as const, targetIds: ["sign-in-page"] },
    focus: { targetId: "sign-in-page", contextRegionIds: ["sign-in-context"] },
    prompt: "Complete any LINE Bank verification in the open page, then wait for sign-in to finish.",
  };
}

async function waitForLineBankSignIn(
  page: Page,
  context: WorkflowContext,
): Promise<void> {
  const deadline = Date.now() + LINEBANK_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    context.signal.throwIfAborted();
    await withAbort(linebankAutoDismissApprovedAlert(page), context.signal);
    if (await withAbort(linebankIsSignedIn(page), context.signal)) return;
    await withAbort(page.waitForTimeout(250), context.signal);
  }
  throw new Error("Timed out waiting for LINE Bank signed-in state.");
}

async function linebankSignInForApp(
  page: Page,
  credentials: LineBankCredentials,
  context: WorkflowContext,
): Promise<void> {
  if (await withAbort(linebankIsSignedIn(page), context.signal)) return;
  const nationalId = requireLineBankCredential(credentials, "linebank_user_id");
  const userId = requireLineBankCredential(credentials, "linebank_account");
  const password = requireLineBankCredential(credentials, "linebank_password");
  if (new URL(page.url()).pathname !== "/login")
    await withAbort(page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }), context.signal);

  await withAbort(page.locator("#nationalId").fill(nationalId), context.signal);
  await withAbort(page.locator("#userId").fill(userId), context.signal);
  await withAbort(page.locator("#pw").fill(password), context.signal);
  const loginButtons = page.getByRole("button", {
    name: "登入友善網路銀行",
    exact: true,
  });
  if (await withAbort(loginButtons.count(), context.signal) !== 1)
    throw new Error("LINE Bank login requires exactly one submit button.");
  const loginButton = loginButtons.first();
  if (!(await withAbort(loginButton.isVisible().catch(() => false), context.signal)))
    throw new Error("LINE Bank login submit button is not visible.");
  await withAbort(loginButton.click(), context.signal);
  await withAbort(page.waitForTimeout(250), context.signal);
  await withAbort(linebankAutoDismissApprovedAlert(page), context.signal);
  if (await withAbort(linebankIsSignedIn(page), context.signal)) return;

  const contract = await withAbort(
    emitHumanAssistanceStage(linebankHumanVerificationStage(page), () => undefined),
    context.signal,
  );
  await context.event("authentication", "human-assistance-requested");
  const status = await withAbort(
    context.humanAssistance.request(contract, context.signal),
    context.signal,
  );
  context.signal.throwIfAborted();
  if (status !== "entered" && status !== "verified") {
    await context.event("authentication", "human-assistance-failed");
    throw new Error(`LINE Bank human assistance ended with status ${status}.`);
  }
  await waitForLineBankSignIn(page, context);
  await context.event("authentication", "human-assistance-completed");
}

function sourceDecodeError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "SourceTextIntegrityError" ||
    /API response body is not valid JSON/u.test(error.message)
  );
}

function sourceValidationError(error: unknown): boolean {
  return error instanceof Error && /pagination|page metadata|pageCnt|totTxCnt|transaction page|source account identity|total row count|transaction source/u.test(error.message);
}

/** App-owned LINE Bank provider. All selected source pages are collected and admitted before commit. */
export async function runLineBankProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
): Promise<LineBankProviderWorkflowOutput> {
  const parsed = typedInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("LINE Bank workflow credentials or input are missing or invalid.");
  if (!context.financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");
  const financialCommit = context.financialCommit;
  context.signal.throwIfAborted();
  const dateRange = resolveDateRange(parsed.data);
  const windows = linebankQueryWindows(dateRange);
  await context.event("preparation", "input-validated");

  return context.browser.withPage(async (page) => {
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-started");
    await linebankSignInForApp(page, parsed.data.credentials, context);
    context.signal.throwIfAborted();
    await withAbort(linebankAutoDismissApprovedAlert(page), context.signal);
    await withAbort(linebankEnsureTransactionPage(page), context.signal);
    await context.event("authentication", "authentication-completed");

    const client = new LineBankApiClient(page, {
      text: context.text,
      signal: context.signal,
    });
    await context.event("collection", "collection-started");
    await context.event("decoding", "source-decoding-started");
    await context.event("collection", "current-balance-collection-started");
    await context.event("decoding", "current-balance-decoding-started");
    let accountSnapshot: Awaited<ReturnType<LineBankApiClient["fetchAccountSnapshot"]>>;
    let accounts: LineBankAccount[];
    let currentBalanceRows: LineBankCurrentDepositBalanceRow[];
    try {
      accountSnapshot = await client.fetchAccountSnapshot(context.now());
      accounts = filterAccounts(
        accountSnapshot.accounts,
        parsed.data.accountFilters,
        parsed.data.currencyFilters,
      );
      if (accounts.length === 0)
        throw new Error("No LINE Bank accounts matched accountFilters/currencyFilters.");
      const selectedAccountKeys = new Set(
        accounts.map((account) => linebankAccountKey(account)).filter(Boolean),
      );
      currentBalanceRows = accountSnapshot.currentBalances.filter((row) =>
        selectedAccountKeys.has(linebankAccountKey(row.account)),
      );
    } catch (error) {
      if (sourceDecodeError(error))
        await context.event("decoding", "source-decoding-failed");
      else
        await context.event("collection", "current-balance-collection-failed");
      throw error;
    }
    await context.event("decoding", "current-balance-decoding-completed");
    await context.event("collection", "current-balance-collection-completed", {
      completed: currentBalanceRows.length,
      total: currentBalanceRows.length,
    });

    const selectedSources: Array<{
      account: LineBankAccount;
      dateRange: DateRange;
      pages: LineBankTransactionPage[];
    }> = [];
    let statementRowCount = 0;
    const expectedSourceCount = accounts.length * windows.length;
    try {
      for (const account of accounts) {
        for (const window of windows) {
          context.signal.throwIfAborted();
          const pages = await client.fetchTransactionPages(account, window);
          selectedSources.push({ account, dateRange: window, pages });
          statementRowCount += linebankApiRowsToStatementRows(
            pages.flatMap((page) => page.rows),
          ).length;
        }
        await context.event("collection", "account-collected", {
          completed: selectedSources.length,
          total: expectedSourceCount,
        });
      }
    } catch (error) {
      if (sourceDecodeError(error))
        await context.event("decoding", "source-decoding-failed");
      else if (sourceValidationError(error)) {
        await context.event("validation", "source-validation-rejected", {
          completed: selectedSources.length,
          total: expectedSourceCount,
        });
      }
      await context.event("collection", "collection-failed");
      throw error;
    }
    context.signal.throwIfAborted();
    await context.event("decoding", "source-decoding-completed");
    await context.event("collection", "collection-completed", {
      completed: selectedSources.length,
      total: expectedSourceCount,
    });
    if (selectedSources.length !== expectedSourceCount || selectedSources.length === 0) {
      await context.event("validation", "source-validation-rejected", {
        completed: selectedSources.length,
        total: expectedSourceCount,
      });
      throw new Error("LINE Bank source does not contain every selected account and date window.");
    }

    await context.event("validation", "source-validation-started", {
      completed: 0,
      total: selectedSources.length,
    });
    const observedAt = context.now();
    const domesticCaptures: LineBankHumanAttestedV13ValidatedCapture[] = [];
    const financialCaptures: CanonicalFinancialDepositValidatedCapture[] = [];
    const statementItems: PGliteWorkflowRunItem[] = [];
    const captureOccurrenceId = randomUUID();
    await context.event("validation", "canonical-admission-started", {
      completed: 0,
      total: selectedSources.length,
    });
    try {
      for (const [index, selected] of selectedSources.entries()) {
        context.signal.throwIfAborted();
        const captureId = `linebank-${randomUUID()}`;
        if (linebankAccountCurrency(selected.account) === "TWD") {
          const capture = await linebankHumanAttestedCapture({
            account: selected.account,
            dateRange: selected.dateRange,
            pages: selected.pages,
            captureId,
            observedAt,
          });
          if (!capture)
            throw new Error("LINE Bank selected domestic source authority is not supported.");
          const admitted = normalizeLineBankFinancialCapture(capture);
          domesticCaptures.push(capture);
          financialCaptures.push(admitted);
          statementItems.push({
            provider: "linebank",
            product: "domestic-deposit",
            itemKey: captureId,
            command: {
              kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
              request: { capture: admitted },
            },
          });
        } else {
          const capture = buildLinebankForeignCurrencyCaptureInput({
            account: selected.account,
            dateRange: selected.dateRange,
            pages: selected.pages,
            observedAt,
            captureOccurrenceId: `${captureOccurrenceId}:${index}`,
          });
          const admitted = admitForeignCurrencyDepositCapture(capture);
          statementItems.push({
            provider: "linebank",
            product: "foreign-currency",
            itemKey: `foreign-currency:${captureOccurrenceId}:${index}`,
            command: {
              kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
              request: { capture: admitted },
            },
          });
          financialCaptures.push(admitted);
        }
        await context.event("validation", "account-source-admitted", {
          completed: index + 1,
          total: selectedSources.length,
        });
      }
    } catch (error) {
      await context.event("validation", "source-validation-rejected", {
        completed: statementItems.length,
        total: selectedSources.length,
      });
      throw error;
    }

    await context.event("validation", "canonical-admission-completed", {
      completed: statementItems.length,
      total: selectedSources.length,
    });
    const balanceItems: PGliteWorkflowRunItem[] = [];
    if (domesticCaptures.length > 0) {
      const selectedTwdAccountKeys = new Set(
        accounts
          .filter((account) => linebankAccountCurrency(account) === "TWD")
          .map((account) => linebankAccountKey(account)),
      );
      const admittedTwdAccountKeys = new Set(
        domesticCaptures.map((capture) => capture.accountKey),
      );
      const selectedTwdSourceKeys = new Set(
        currentBalanceRows.map((row) => row.sourceAccountKey),
      );
      if (selectedTwdAccountKeys.size !== admittedTwdAccountKeys.size ||
        currentBalanceRows.length !== selectedTwdAccountKeys.size ||
        selectedTwdSourceKeys.size !== admittedTwdAccountKeys.size ||
        [...selectedTwdSourceKeys].some((key) => !admittedTwdAccountKeys.has(key))) {
        await context.event("validation", "current-balance-validation-rejected", {
          completed: currentBalanceRows.length,
          total: selectedTwdAccountKeys.size,
        });
        throw new Error("LINE Bank current balance source does not cover every selected domestic account.");
      }
      await context.event("validation", "current-balance-validation-started", {
        completed: 0,
        total: currentBalanceRows.length,
      });
      try {
        const currentBalanceCaptures = buildLinebankCurrentDepositBalanceCaptures(
          currentBalanceRows,
          domesticCaptures.map((capture) => ({
            accountKey: capture.accountKey,
            sourceConnection: capture.sourceConnection,
            identityEpoch: capture.identityEpoch,
            observedAt: capture.observedAt,
          })),
        );
        for (const [index, capture] of currentBalanceCaptures.entries()) {
          context.signal.throwIfAborted();
          balanceItems.push({
            provider: "linebank",
            product: "current-balance",
            itemKey: `current-balance:${index}`,
            command: {
              kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
              request: currentDepositBalanceCommandRequest(
                admitCurrentDepositBalanceCapture(capture),
              ),
            },
          });
        }
      } catch {
        await context.event("validation", "current-balance-validation-rejected", {
          completed: 0,
          total: currentBalanceRows.length,
        });
        throw new Error("LINE Bank current balance source admission was rejected.");
      }
      await context.event("validation", "current-balance-validation-completed", {
        completed: balanceItems.length,
        total: currentBalanceRows.length,
      });
    }
    await context.event("validation", "source-validation-completed", {
      completed: selectedSources.length,
      total: expectedSourceCount,
    });
    context.signal.throwIfAborted();

    const commitItems = [...statementItems, ...balanceItems];
    await context.event("commit", "canonical-commit-started", {
      completed: 0,
      total: commitItems.length,
    });
    if (balanceItems.length > 0)
      await context.event("commit", "current-balance-commit-started", {
        completed: 0,
        total: balanceItems.length,
      });
    const committed = await financialCommit.execute(commitItems, {
      provider: "linebank",
      product: "financial",
      signal: context.signal,
    });
    if (
      committed.status !== "completed" ||
      committed.items.length !== commitItems.length ||
      committed.items.some((item) => item.status !== "committed")
    ) {
      const codes = committed.diagnostics.map((diagnostic) => diagnostic.errorCode).join(", ");
      await context.event("commit", context.signal.aborted ? "canonical-commit-cancelled" : "canonical-commit-failed");
      throw new Error(`LINE Bank Canonical Financial Commit failed: ${codes || committed.status}.`);
    }
    await context.event("commit", "canonical-commit-completed", {
      completed: commitItems.length,
      total: commitItems.length,
    });
    if (balanceItems.length > 0)
      await context.event("commit", "current-balance-commit-completed", {
        completed: balanceItems.length,
        total: balanceItems.length,
      });
    const hasFinancialRecords = financialCaptures.some((capture) => capture.records.length > 0);
    return {
      dateRange,
      accountCount: accounts.length,
      statementRowCount,
      sourceCaptureCount: selectedSources.length,
      financialItemCount: commitItems.length,
      status: hasFinancialRecords ? "financial-admitted" : "source-only",
    };
  });
}

export default workflow("linebankStatements", {
  startUrl: LOGIN_URL,
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
      isSignedIn: async () => await linebankIsSignedIn(page),
      signIn: async (signInContext) => {
        await linebankSignIn(signInContext.page, input.credentials);
      },
    });

    await linebankAutoDismissApprovedAlert(page);
    emitAutomationProgress({ phaseCode: "workflow", completed: 25, total: 100, percent: 25 });
    await linebankEnsureTransactionPage(page);
    const result = await downloadLineBankStatements(page, input);
    emitAutomationProgress({ phaseCode: "workflow", completed: 100, total: 100, percent: 100 });
    return result;
  },
});
