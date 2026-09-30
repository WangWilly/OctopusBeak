import { createHash, randomUUID } from "node:crypto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import { parseCsvMatrix } from "../lib/tabular-text.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { hasAttachedLocator } from "./browser-interaction.js";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import {
  admitYuantaDomesticDepositFinancialCapture,
  admitYuantaDomesticDepositCaptureEvidence,
  createYuantaDomesticDepositSourceEvidence,
  isYuantaSourceOnlyFinancialDiagnostic,
  YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
  type YuantaDomesticDepositCaptureEvidence,
  type YuantaDomesticDepositValidatedEvidence,
  type YuantaDomesticDepositDownloadEvidence,
  type YuantaDomesticDepositAccountNumberEvidence,
} from "../ledger/canonical/yuanta-domestic-deposit-admission.ts";
import {
  getYuantaHumanAttestedV2Manifest,
  isYuantaHumanAttestedV2Active,
} from "../ledger/canonical/yuanta-human-attestation-contract.ts";
import {
  requireSourceConnectionIdentity,
} from "../ledger/canonical/source-connection-identity.ts";
import {
  admitCounterpartyAccountEvidence,
  YUANTA_LOAN_ACCOUNT_NOTE_NORMALIZATION_CONTRACT_VERSION,
} from "../ledger/canonical/counterparty-account-evidence.ts";
import type { TransactionCounterpartyAccountEvidenceInput } from "../ledger/canonical/counterparty-account-evidence.ts";
import {
  readYuantaCurrentDepositBalances,
  YUANTA_CURRENT_DEPOSIT_BALANCE_HOST,
  type YuantaCurrentDepositBalanceRow,
} from "./yuanta-current-deposit-balances.ts";
import {
  admitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/pglite/current-deposit-admission.ts";
const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";
const YUANTA_DOMESTIC_EXPORT_MAX_BYTES = 25 * 1024 * 1024;
type BrowserScope = Page | Frame;
const dateRangeSchema = z.enum(["one_week", "one_month", "three_months"]);
const dateRangeLabels: Record<z.infer<typeof dateRangeSchema>, string> = {
  one_week: "一週",
  one_month: "一個月",
  three_months: "三個月",
};

export const yuantaStatementsInputSchema = z.object({
  dateRange: dateRangeSchema.default("three_months"),
  accountFilters: z.array(z.string()).default([]),
  replaceActiveSession: z.boolean().default(true),
});

/**
 * Evidence supplied by a Yuanta detail or repayment-setting page.  The
 * regular domestic CSV does not populate this shape: its account column is
 * the selected account itself, so treating it as a counterparty would be an
 * identity guess.  A future live adapter may provide an exact source row
 * ordinal, or an exact canonical source-record key after inspecting the
 * provider page.
 */
export type YuantaCounterpartyAccountEvidence = Readonly<
  Omit<
    TransactionCounterpartyAccountEvidenceInput,
    | "captureId"
    | "sourceRecordKey"
    | "sourceConnectionKey"
    | "identityEpochKey"
  > & {
    sourceRecordKey?: string;
    pageOrdinal?: number;
    rowOrdinal?: number;
  }
>;

export type YuantaStatementDownload = {
  filename: string;
  rows: BankTransactionRow[];
  source: YuantaDomesticDepositDownloadEvidence;
  /** Optional exact evidence from a provider detail/mandate page. */
  counterpartyAccountEvidence?: readonly YuantaCounterpartyAccountEvidence[];
};

export type YuantaStatementsRunDependencies = {
  preparePage?: (
    page: Page,
    dateRange: z.infer<typeof dateRangeSchema>,
  ) => Promise<void>;
  readDepositAccountOptions?: (
    page: Page,
  ) => Promise<Array<{ label: string; value: string }>>;
  queryAccount?: (
    page: Page,
    account: { label: string; value: string },
  ) => Promise<void>;
  downloadStatementRows?: (
    page: Page,
    account: { label: string; value: string },
  ) => Promise<YuantaStatementDownload>;
  /** Stable provider-login scope; never contains a password or session. */
  sourceConnectionScope: string;
  /** Stable source key derived from the provider-login scope. */
  sourceConnectionKey: string;
  /** Deterministic capture clock for checks; production uses Taiwan local time. */
  observedAt?: () => string;
  /** Injected in checks; production reads the authenticated current-balance page. */
  readCurrentDepositBalances?: typeof readYuantaCurrentDepositBalances;
  /** Item sink owned by the App's existing Canonical Financial Commit port. */
  deferredCommitItems: PGliteWorkflowRunItem[];
  sourceText: SourceTextPort;
  signal: AbortSignal;
};

export type YuantaDepositWorkflowCollection = Readonly<{
  sourceCount: number;
  rowCount: number;
  itemCount: number;
  financialAdmissionCount: number;
}>;

type BankTransactionRow = {
  accountLabel: string;
  values: string[];
  sourceRowOrdinal: number;
};

type YuantaStatementsInput = z.infer<typeof yuantaStatementsInputSchema>;

type ExistingYuantaFinancialCapture = Readonly<{
  identity: Readonly<{
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
  }>;
}>;

function yuantaCurrentDepositOpaqueKey(
  domain: string,
  ...parts: readonly string[]
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(parts.join("\0"))
    .digest("base64url")}`;
}

/**
 * Build the current-balance capture only after the ordinary financial
 * admission has supplied the existing identity.  The provider's HTTP Date
 * is the only effective-time authority here; observedAt is retained solely
 * as the local knowledge time.
 */
export function buildYuantaCurrentDepositBalanceCapture(
  row: YuantaCurrentDepositBalanceRow,
  financialCapture: ExistingYuantaFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  if (row.kind !== "domestic" || row.stream !== "domestic-deposit")
    throw new Error("Yuanta domestic current-balance row has the wrong stream.");
  const identity = financialCapture.identity;
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  if (sourceAccountKey !== row.sourceAccountKey)
    throw new Error("Yuanta current-balance row does not match an existing account.");
  const route = "yuanta/domestic-deposit/current-balance-v1" as const;
  const records: CurrentDepositSourceRecordInput[] = [];
  const observations: CurrentDepositBalanceObservationInput[] = [];
  const amountPairs: readonly [
    "ledger" | "available",
    string,
    CurrentDepositExactAmount,
  ][] = [
    ["ledger", "帳面餘額", row.ledger],
    ["available", "可用餘額", row.available],
  ];
  for (const [balanceKind, sourceField, balance] of amountPairs) {
    const sourceRecordKey = yuantaCurrentDepositOpaqueKey(
      "yuanta-current-deposit-source-record-v1",
      sourceAccountKey,
      row.currency,
      balanceKind,
      row.effectiveAt,
      balance.coefficient,
      String(balance.scale),
    );
    const compact = {
      accountNumber: row.accountNumber,
      sourceAccountKey,
      currencySourceLexeme: row.currency,
      effectiveAt: row.effectiveAt,
      effectiveTimeSourceField: "HTTP Date",
      effectiveTimeSourceValue: row.providerHttpDate,
      sourceEvidence: { ...row.sourceEvidence },
    };
    const record = currentDepositSourceRecord({
      sourceRecordKey,
      providerKey: yuantaCurrentDepositOpaqueKey(
        "yuanta-current-deposit-provider-record-v1",
        row.accountNumber,
        row.currency,
        balanceKind,
        row.effectiveAt,
      ),
      contentHash: "sha256:placeholder",
      sourceField,
      balanceKind,
      currency: row.currency,
      value: balance,
      compact,
    });
    records.push({
      ...record,
      contentHash: currentDepositSourceRecordContentHash(record.compact),
    });
    observations.push({
      observationKey: yuantaCurrentDepositOpaqueKey(
        "yuanta-current-deposit-observation-v1",
        sourceAccountKey,
      ),
      balanceKind,
      balance,
      currency: row.currency,
      time: {
        effectiveAt: row.effectiveAt,
        effectiveTimeBasis: "provider-http-date",
        effectiveTimeRuleVersion: row.sourceEvidence.contractVersion,
        sourceField: "HTTP Date",
        sourceValue: row.providerHttpDate,
        contractVersion: row.sourceEvidence.contractVersion,
      },
      sourceRecordKey,
      sourceField,
    });
  }
  const endpoint = `https://${YUANTA_CURRENT_DEPOSIT_BALANCE_HOST}${row.sourceEvidence.endpoint}`;
  return {
    captureId: randomUUID(),
    authorityRoute: route,
    contractVersion: row.sourceEvidence.contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "yuanta",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: row.effectiveAt.slice(0, 10),
      endDate: row.effectiveAt.slice(0, 10),
    },
    providerResponse: {
      endpoint,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: records.length,
        terminal: true,
        metadata: {
          source: "yuanta-current-deposit-summary",
          sourceRowCount: 1,
          balanceFieldCount: records.length,
        },
      },
    ],
    records,
    observations,
  };
}

export function indexYuantaCurrentDepositFinancialCaptures(
  financialCaptures: readonly ExistingYuantaFinancialCapture[],
): ReadonlyMap<string, ExistingYuantaFinancialCapture> {
  const existingBySourceAccount = new Map<string, ExistingYuantaFinancialCapture>();
  for (const candidate of financialCaptures) {
    const sourceAccountKey =
      candidate.identity.sourceAccountKey ?? candidate.identity.accountNo;
    const prior = existingBySourceAccount.get(sourceAccountKey);
    if (
      prior &&
      (prior.identity.sourceConnectionKey !==
        candidate.identity.sourceConnectionKey ||
        prior.identity.identityEpochKey !== candidate.identity.identityEpochKey ||
        prior.identity.subjectDigest !== candidate.identity.subjectDigest)
    )
      throw new Error(
        "Yuanta current deposit identities are ambiguous across financial captures.",
      );
    if (!prior) existingBySourceAccount.set(sourceAccountKey, candidate);
  }
  return existingBySourceAccount;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Produce a bank-local observation timestamp without exposing user data. */
export function yuantaObservedAt(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

/**
 * The bank's date-link semantics are intentionally not asserted here. This
 * records only the bounded range requested by the UI and the local date used
 * to anchor it, for later evidence review.
 */
export function deriveYuantaDomesticDepositQueryRange(
  dateRange: z.infer<typeof dateRangeSchema>,
  observedAt: string,
): {
  dateRange: z.infer<typeof dateRangeSchema>;
  startDate: string;
  endDate: string;
} {
  const endDate = new Date(`${observedAt.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(endDate.getTime()))
    throw new Error("Yuanta telemetry observedAt has an invalid local date.");
  const startDate = new Date(endDate);
  if (dateRange === "one_week") {
    startDate.setUTCDate(startDate.getUTCDate() - 6);
  } else {
    const monthOffset = dateRange === "one_month" ? 1 : 3;
    const targetMonth = endDate.getUTCMonth() - monthOffset;
    const targetYear = endDate.getUTCFullYear() + Math.floor(targetMonth / 12);
    const normalizedMonth = ((targetMonth % 12) + 12) % 12;
    const lastTargetDay = new Date(
      Date.UTC(targetYear, normalizedMonth + 1, 0),
    ).getUTCDate();
    startDate.setUTCFullYear(
      targetYear,
      normalizedMonth,
      Math.min(endDate.getUTCDate(), lastTargetDay),
    );
  }
  return {
    dateRange,
    startDate: formatDateOnly(startDate),
    endDate: formatDateOnly(endDate),
  };
}

const downloadedBankHeaders = [
  "帳號",
  "帳務日期",
  "交易日期",
  "交易時間",
  "交易說明",
  "支出金額",
  "存入金額",
  "帳面餘額",
  "票據號碼",
  "備註",
];

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Provider-versioned live rule: Yuanta domestic-deposit CSV 備註 contains a
 * complete loan account as `00` + the 14-digit loan selector account.  The
 * source 16 digits remain durable evidence while the normalized 14 digits
 * are used only for equality with the canonical loan account identity.
 */
export function yuantaLoanAccountEvidenceFromTransactionNote(
  noteValue: string,
  rowOrdinal: number,
): YuantaCounterpartyAccountEvidence | null {
  const sourceValue = toAsciiDigits(cleanText(noteValue));
  if (!/^00\d{14}$/u.test(sourceValue)) return null;
  return {
    rowOrdinal,
    accountValue: sourceValue,
    normalizedAccountValue: sourceValue.slice(2),
    role: "beneficiary",
    purpose: "loan_repayment",
    scope: "loan_contract",
    evidenceKind: "transaction-counterparty-account",
    sourceField: "備註",
    contractVersion:
      YUANTA_LOAN_ACCOUNT_NOTE_NORMALIZATION_CONTRACT_VERSION,
  };
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function digitsOnly(value: string): string {
  return toAsciiDigits(value).replace(/\D/g, "");
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The domestic selector is accepted as an account number only when the
 * complete unmasked option value is repeated by the provider in its label.
 * This keeps opaque selector tokens and masked labels out of the identifier
 * contract while preserving leading zeroes.
 */
export function deriveYuantaDomesticDepositAccountNumberEvidence(
  account: Readonly<{ label: string; value: string }>,
): YuantaDomesticDepositAccountNumberEvidence | null {
  const value = cleanText(account.value);
  const label = toAsciiDigits(cleanText(account.label));
  if (!/^\d{6,24}$/.test(value) || !label) return null;
  const exactValue = new RegExp(`(?:^|\\D)${escapedRegExp(value)}(?=\\D|$)`);
  if (!exactValue.test(label)) return null;
  return {
    value,
    kind: "depository-account",
    evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField: "#acctno option.value",
  };
}

function maskAccountLabel(value: string): string {
  return cleanText(value).replace(/[0-9０-９]{4,}/g, (digits) => {
    const normalized = toAsciiDigits(digits);
    return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
  });
}

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

function stripSpreadsheetTextPrefix(value: string): string {
  const text = cleanText(value);
  return text.replace(/^'+/, "").replace(/'+$/, "");
}

function isRepeatedHeaderRow(values: string[]): boolean {
  return (
    values.length === downloadedBankHeaders.length &&
    values.every((value, index) => value === downloadedBankHeaders[index])
  );
}

export function statementRowsFromDownloadedCsv(
  content: string,
  accountLabel: string,
): BankTransactionRow[] {
  const rows = parseCsvMatrix(content).map((row) =>
    row.map(stripSpreadsheetTextPrefix),
  );
  const headerIndex = rows.findIndex(isRepeatedHeaderRow);
  if (headerIndex < 0) {
    throw new Error(
      "Downloaded YuanTa statement CSV did not contain expected headers.",
    );
  }

  const statements: BankTransactionRow[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    if (!values.some((value) => value.length > 0)) continue;
    if (isRepeatedHeaderRow(values)) continue;
    if (values.length !== downloadedBankHeaders.length) {
      throw new Error(
        `Downloaded YuanTa statement CSV row had ${values.length} columns; expected ${downloadedBankHeaders.length}.`,
      );
    }

    statements.push({
      accountLabel,
      values,
      sourceRowOrdinal: statements.length,
    });
  }

  return statements;
}

type DownloadText = {
  content: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
  contentDisposition: string;
  exportUrl: string;
};

type BrowserCsvResponse = Readonly<{
  status: number;
  byteLength: number;
  base64: string;
  contentDisposition: string;
  exportUrl: string;
}>;

function filenameFromCsvResponse(
  contentDisposition: string,
  exportUrl: string,
): string {
  const extendedFilename = contentDisposition.match(
    /(?:^|;)\s*filename\*\s*=\s*([^;]+)/iu,
  )?.[1]?.trim();
  const plainFilename = contentDisposition.match(
    /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/iu,
  );
  let filename: string | undefined;
  if (extendedFilename) {
    const encoded = extendedFilename.replace(/^"|"$/gu, "");
    const parts = encoded.match(/^([^']*)'[^']*'(.*)$/u);
    if (!parts || parts[1]?.toLowerCase() !== "utf-8") {
      throw new Error("Yuanta domestic CSV filename encoding is unsupported.");
    }
    try {
      filename = decodeURIComponent(parts[2] ?? "");
    } catch {
      throw new Error("Yuanta domestic CSV filename is malformed.");
    }
  } else {
    filename = plainFilename?.[1] ?? plainFilename?.[2]?.trim();
  }

  if (!filename) {
    const pathName = new URL(exportUrl).pathname;
    const urlName = pathName.slice(pathName.lastIndexOf("/") + 1);
    const decoded = urlName ? decodeURIComponent(urlName) : "";
    filename = /\.csv$/iu.test(decoded)
      ? decoded
      : "yuanta-domestic-deposit.csv";
  }
  if (
    filename.length > 255 ||
    Buffer.byteLength(filename, "utf8") > 255 ||
    filename === "." ||
    filename === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(filename)
  ) {
    throw new Error("Yuanta domestic CSV filename is unsafe.");
  }
  return filename;
}

export async function readYuantaBig5CsvFromAnchor(
  exportLink: Locator,
  text: SourceTextPort,
  signal: AbortSignal,
): Promise<DownloadText> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Yuanta CSV retrieval was canceled."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let response: BrowserCsvResponse;
  try {
    const read = exportLink.evaluate(
      async (element, maxBytes): Promise<BrowserCsvResponse> => {
        const anchor = element as HTMLAnchorElement;
        const href = anchor.getAttribute("href")?.trim();
        const documentUrl = new URL(anchor.ownerDocument.baseURI);
        const pageOrigin = anchor.ownerDocument.location.origin;
        let url: URL;
        let requestBody: URLSearchParams | undefined;
        if (
          /^javascript:void\(0\);?$/iu.test(href ?? "") &&
          /^\s*getDownload\(\s*['"]csv['"]\s*\)\s*;?\s*$/iu.test(anchor.getAttribute("onclick") ?? "")
        ) {
          const foreignForm = anchor.ownerDocument.querySelector('form[name="mform"]') as HTMLFormElement | null;
          const isForeignExport = foreignForm !== null &&
            /\/fxtransactiondetails$/iu.test(new URL(foreignForm.action, documentUrl).pathname);
          const form = isForeignExport
            ? foreignForm
            : anchor.ownerDocument.querySelector('form[name="jform"]') as HTMLFormElement | null;
          if (!form || form.method.toLowerCase() !== "post") {
            throw new Error("Yuanta CSV export form is unavailable.");
          }
          url = new URL(form.action, documentUrl);
          if (!(isForeignExport
            ? /\/fxtransactiondetails$/iu.test(url.pathname)
            : /\/transactiondetails$/iu.test(url.pathname))) {
            throw new Error("Yuanta CSV export form has an unexpected action.");
          }
          if (!isForeignExport) url.searchParams.set("method", "downloadcsv");
          requestBody = new URLSearchParams();
          for (const [name, value] of new FormData(form)) {
            if (typeof value !== "string") {
              throw new Error("Yuanta CSV export form contains a file input.");
            }
            requestBody.append(name, value);
          }
          if (isForeignExport) {
            const transactionType = anchor.ownerDocument.getElementById("txntype") as HTMLInputElement | null;
            if (!transactionType || transactionType.form !== form || !transactionType.name) {
              throw new Error("Yuanta foreign CSV export type is unavailable.");
            }
            requestBody.set(transactionType.name, "downloadcsv");
          }
        } else {
          if (!href || /^(?:javascript|data):/iu.test(href)) {
            throw new Error("Yuanta CSV link has no fetchable URL.");
          }
          url = new URL(href, documentUrl);
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username.length > 0 ||
          url.password.length > 0 ||
          url.origin !== pageOrigin
        ) {
          throw new Error("Yuanta CSV link left the authenticated origin.");
        }

        const fetched = await fetch(url.href, {
          ...(requestBody ? { method: "POST", body: requestBody } : {}),
          mode: "same-origin",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "follow",
        });
        if (new URL(fetched.url).origin !== pageOrigin) {
          throw new Error("Yuanta CSV redirected outside the authenticated origin.");
        }
        if (fetched.status !== 200 || !fetched.ok) {
          throw new Error("Yuanta CSV request did not return a complete response.");
        }
        const contentLength = fetched.headers.get("content-length");
        if (contentLength !== null) {
          if (!/^\d+$/u.test(contentLength)) {
            throw new Error("Yuanta CSV response length is invalid.");
          }
          const declaredLength = Number(contentLength);
          if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
            throw new Error("Yuanta CSV exceeded the in-memory size limit.");
          }
        }

        const reader = fetched.body?.getReader();
        if (!reader) throw new Error("Yuanta CSV response body is missing.");
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            byteLength += next.value.byteLength;
            if (byteLength > maxBytes) {
              await reader.cancel().catch(() => undefined);
              throw new Error("Yuanta CSV exceeded the in-memory size limit.");
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return {
          status: fetched.status,
          byteLength,
          base64: btoa(binary),
          contentDisposition: fetched.headers.get("content-disposition") ?? "",
          exportUrl: fetched.url,
        };
      },
      YUANTA_DOMESTIC_EXPORT_MAX_BYTES,
    );
    response = await Promise.race([read, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  signal.throwIfAborted();
  const bytes = Buffer.from(response.base64, "base64");
  if (bytes.byteLength !== response.byteLength) {
    throw new Error("Yuanta CSV response was incomplete in memory.");
  }
  return {
    content: text.decode(bytes, "big5"),
    byteLength: bytes.byteLength,
    contentDigest: `sha256:${createHash("sha256").update(bytes).digest("base64url")}`,
    contentDisposition: response.contentDisposition,
    exportUrl: response.exportUrl,
  };
}

function isYuantaDomesticAccountPlaceholder(option: {
  label: string;
  value: string;
}): boolean {
  const value = cleanText(option.value).toLowerCase();
  const label = cleanText(option.label).toLowerCase();
  if (!value || !label) return true;
  if (["0", "-1", "none", "null", "undefined"].includes(value)) return true;
  return (
    /^(?:請|请)?選擇(?:帳戶|账戶)?$/.test(label) ||
    /^(?:無|无)(?:可用)?(?:帳戶|账戶)$/.test(label)
  );
}

function cidFromUrl(url: string): string | null {
  const match = url.match(/[?&]cid=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function currentCidFromFrameUrls(page: Page): string | null {
  for (const frame of page.frames()) {
    const cid = cidFromUrl(frame.url());
    if (cid) return cid;
  }
  return cidFromUrl(page.url());
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(scope.locator(selector))) {
        return scope;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find selector "${selector}" in any frame.`);
}

async function findScopeWithLocator(
  page: Page,
  locatorFor: (scope: BrowserScope) => Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(locatorFor(scope))) {
        return scope;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find ${description} in any frame.`);
}

async function firstVisibleLocator(
  locator: Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await locator.page().waitForTimeout(500);
  }

  throw new Error(`Could not find a visible ${description}.`);
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // YuanTa keeps frames and timers alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
}

async function openTransactionDetailsPage(page: Page): Promise<BrowserScope> {
  const existing = await findScopeWithSelector(page, "#acctno", 5_000).catch(
    () => null,
  );
  if (existing) return existing;

  const fmain = page.frame({ name: "fmain" });
  const cid = currentCidFromFrameUrls(page);
  if (fmain && cid) {
    await fmain.goto(
      `${BANK_ORIGIN}/nib/tx/transactiondetails?type=page&cid=${encodeURIComponent(
        cid,
      )}`,
      { waitUntil: "domcontentloaded" },
    );
    await settleAfterNavigation(page);

    const direct = await findScopeWithSelector(page, "#acctno", 15_000).catch(
      () => null,
    );
    if (direct) return direct;
  }

  const menuScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("#menu_transactiondetails")
        .or(candidate.locator("a").filter({ hasText: "臺幣交易明細查詢" }))
        .first(),
    "YuanTa transaction-details menu link",
  );
  const links = menuScope
    .locator("#menu_transactiondetails")
    .or(menuScope.locator("a").filter({ hasText: "臺幣交易明細查詢" }));
  const link = await firstVisibleLocator(
    links,
    "YuanTa transaction-details menu link",
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);

  return await findScopeWithSelector(page, "#acctno");
}

async function prepareYuantaDepositPage(
  page: Page,
  dateRange: z.infer<typeof dateRangeSchema>,
): Promise<void> {
  const scope = await openTransactionDetailsPage(page);
  const label = dateRangeLabels[dateRange];
  const link = await firstVisibleLocator(
    scope.locator("#duration a").filter({ hasText: label }),
    `YuanTa date range link "${label}"`,
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  await findScopeWithSelector(page, "#acctno");
}

export async function readYuantaDepositAccountOptions(
  page: Page,
  _filters: string[] = [],
) {
  const scope = await findScopeWithSelector(page, "#acctno");
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const availableAccounts: Array<{ label: string; value: string }> = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    const account = { label, value };
    if (isYuantaDomesticAccountPlaceholder(account)) continue;
    availableAccounts.push(account);
  }

  if (availableAccounts.length === 0) {
    throw new StatementComponentAbsentError(
      "No YuanTa domestic-currency account is available for this login.",
    );
  }
  // Account filters are legacy persisted UI state. Yuanta domestic capture
  // always includes every visible account; provider absence is the only skip.
  return availableAccounts;
}

async function queryAccount(
  page: Page,
  account: { label: string; value: string },
): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator("#acctno").selectOption(account.value);
  await scope.locator("#submitbutton").click();
  await settleAfterNavigation(page);

  const resultScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa CSV download link",
  );
  await resultScope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first()
    .waitFor({ state: "attached", timeout: 60_000 });
}

async function downloadStatementRows(
  page: Page,
  account: { label: string; value: string },
  sourceText: SourceTextPort,
  signal: AbortSignal,
): Promise<YuantaStatementDownload> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa CSV download link",
  );

  const exportLink = scope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first();
  await exportLink.waitFor({ state: "attached", timeout: 60_000 });
  const downloaded = await readYuantaBig5CsvFromAnchor(exportLink, sourceText, signal);
  const filename = filenameFromCsvResponse(
    downloaded.contentDisposition,
    downloaded.exportUrl,
  );
  const publicAccountLabel = maskAccountLabel(account.label);
  const rows = statementRowsFromDownloadedCsv(
    downloaded.content,
    publicAccountLabel,
  );
  const counterpartyAccountEvidence = rows.flatMap((row) => {
    const evidence = yuantaLoanAccountEvidenceFromTransactionNote(
      row.values[9] ?? "",
      row.sourceRowOrdinal,
    );
    return evidence ? [evidence] : [];
  });
  return {
    filename,
    rows,
    ...(counterpartyAccountEvidence.length > 0
      ? { counterpartyAccountEvidence }
      : {}),
    source: {
      filename,
      byteLength: downloaded.byteLength,
      contentDigest: downloaded.contentDigest,
      columnNames: YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      terminal: true,
      rows: rows.map((row) => ({
        rowOrdinal: row.sourceRowOrdinal,
        values: [publicAccountLabel, ...row.values],
      })),
    },
  };
}

function digestAccountValue(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("yuanta-workflow-account-value-v1\0")
    .update(value)
    .digest("base64url")}`;
}

export function buildYuantaCapture(
  account: { label: string; value: string },
  queryRange: ReturnType<typeof deriveYuantaDomesticDepositQueryRange>,
  observedAt: string,
  download: YuantaStatementDownload,
): YuantaDomesticDepositCaptureEvidence {
  const accountNumber =
    deriveYuantaDomesticDepositAccountNumberEvidence(account);
  return {
    evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "yuanta",
    observedAt,
    account: {
      value: account.value,
      label: account.label,
      ...(accountNumber ? { accountNumber } : {}),
    },
    queryRange,
    downloads: [download.source],
    provenance: {
      source: "yuanta-ebank-domestic-deposit-csv",
      encoding: "big5",
      responseBodyRetained: false,
      semantics: "unresolved",
      querySelector: "#acctno",
      submitSelector: "#submitbutton",
      downloadSelector: "a.order_2.m_color_check",
      telemetryVersion: YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
    },
  };
}

type YuantaFinancialCaptureForEvidence = {
  captureId: string;
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
  };
  records: readonly {
    occurrenceKey: string;
    compactJson: string;
  }[];
};

function sourceRecordKeyForYuantaEvidence(
  capture: YuantaFinancialCaptureForEvidence,
  evidence: YuantaCounterpartyAccountEvidence,
): string {
  if (evidence.sourceRecordKey?.trim()) return evidence.sourceRecordKey.trim();
  if (evidence.rowOrdinal === undefined)
    throw new Error(
      "Yuanta counterparty evidence must identify a source record or row ordinal.",
    );
  if (!Number.isSafeInteger(evidence.rowOrdinal) || evidence.rowOrdinal < 0)
    throw new Error("Yuanta counterparty evidence row ordinal is invalid.");

  const candidates = capture.records.filter((record) => {
    try {
      const compact = JSON.parse(record.compactJson) as {
        pageOrdinal?: unknown;
        rowOrdinal?: unknown;
      };
      return (
        compact.rowOrdinal === evidence.rowOrdinal &&
        (evidence.pageOrdinal === undefined ||
          compact.pageOrdinal === evidence.pageOrdinal)
      );
    } catch {
      return false;
    }
  });
  if (candidates.length !== 1)
    throw new Error(
      "Yuanta counterparty evidence row does not identify exactly one canonical source record.",
    );
  return candidates[0]!.occurrenceKey;
}

function materializeYuantaCounterpartyEvidence(
  capture: YuantaFinancialCaptureForEvidence,
  evidence: YuantaCounterpartyAccountEvidence,
): TransactionCounterpartyAccountEvidenceInput {
  return {
    ...evidence,
    captureId: capture.captureId,
    sourceRecordKey: sourceRecordKeyForYuantaEvidence(capture, evidence),
    sourceConnectionKey: capture.identity.sourceConnectionKey,
    identityEpochKey: capture.identity.identityEpochKey,
  };
}

/** Collect domestic-deposit source items for the App-owned financial commit. */
export async function runYuantaStatements(
  page: Page,
  input: YuantaStatementsInput,
  overrides: YuantaStatementsRunDependencies,
): Promise<YuantaDepositWorkflowCollection> {
  const { sourceConnectionScope, sourceConnectionKey } =
    requireSourceConnectionIdentity("yuanta", "Yuanta deposit", overrides);
  const prepare = overrides.preparePage ?? prepareYuantaDepositPage;
  const stableSourceIdentity = {
    sourceConnectionScope,
    sourceConnectionKey,
  } as const;
  const readAccounts =
    overrides.readDepositAccountOptions ??
    ((candidatePage: Page) =>
      readYuantaDepositAccountOptions(candidatePage, []));
  const query = overrides.queryAccount ?? queryAccount;
  const download =
    overrides.downloadStatementRows ??
    ((candidatePage: Page, account: { label: string; value: string }) =>
      downloadStatementRows(
        candidatePage,
        account,
        overrides.sourceText,
        overrides.signal,
      ));
  const readCurrent =
    overrides.readCurrentDepositBalances ?? readYuantaCurrentDepositBalances;
  const nextTimestamp = createTimestampGenerator();
  const observedAt = overrides.observedAt?.() ?? yuantaObservedAt();
  const queryRange = deriveYuantaDomesticDepositQueryRange(
    input.dateRange,
    observedAt,
  );
  let rowCount = 0;
  let sourceCount = 0;
  const financialDepositCaptures: Array<NonNullable<ReturnType<typeof admitYuantaDomesticDepositFinancialCapture>["capture"]>> = [];
  const sourceOnlyEntries: Array<{
    capture: YuantaDomesticDepositValidatedEvidence;
    captureId: string;
  }> = [];
  const relationInputs: Array<{
    captureId: string;
    evidence: TransactionCounterpartyAccountEvidenceInput[];
  }> = [];
  let currentBalanceCaptures: Awaited<ReturnType<typeof admitCurrentDepositBalanceCapture>>[] = [];

  // The canonical domestic scope is all visible TWD selectors. Input
  // accountFilters remains accepted for compatibility but never narrows it.
  overrides.signal.throwIfAborted();
  await prepare(page, input.dateRange);
  overrides.signal.throwIfAborted();
  const accounts = await readAccounts(page);
  for (const account of accounts) {
    overrides.signal.throwIfAborted();
    await query(page, account);
    overrides.signal.throwIfAborted();
    const downloaded = await download(page, account);
    overrides.sourceText.assertIntact(JSON.stringify(downloaded));
    if (downloaded.source.terminal !== true)
      throw new Error(
        "Yuanta domestic deposit download did not reach a terminal CSV state.",
      );
    rowCount += downloaded.rows.length;
    sourceCount += 1;
    const structural = admitYuantaDomesticDepositCaptureEvidence(
      buildYuantaCapture(account, queryRange, observedAt, downloaded),
    );
    if (structural.status !== "admissible" || !structural.capture)
      throw new Error(
        `Yuanta domestic deposit source admission blocked: ${structural.diagnostics.join(", ")}`,
      );
    const capture = structural.capture;
    const captureIdSuffix = digestAccountValue(account.value).slice(7, 19);
    const financialInput = {
      capture,
      captureId: `yuanta-financial-${nextTimestamp()}-${captureIdSuffix}`,
      humanAttestation: getYuantaHumanAttestedV2Manifest(),
      // Financial Source Connection identity comes only from the stable
      // login pair. The attestation manifest remains provenance for the
      // independently versioned account/identity epoch.
      sourceConnectionScope,
      sourceConnectionKey,
    };
    const financialAdmission =
      admitYuantaDomesticDepositFinancialCapture(financialInput);
    const sourceCaptureId = `yuanta-source-${nextTimestamp()}-${captureIdSuffix}`;

    if (financialAdmission.status !== "admitted") {
      const disallowed = financialAdmission.diagnostics.filter(
        (diagnostic) => !isYuantaSourceOnlyFinancialDiagnostic(diagnostic),
      );
      if (disallowed.length > 0)
        throw new Error(
          `Yuanta domestic deposit financial admission failed: ${disallowed.join(", ")}`,
        );
      sourceOnlyEntries.push({ capture, captureId: sourceCaptureId });
      continue;
    }
    if (!isYuantaHumanAttestedV2Active()) {
      sourceOnlyEntries.push({ capture, captureId: sourceCaptureId });
      continue;
    }
    if (!financialAdmission.capture)
      throw new Error(
        "Yuanta domestic deposit admission lost its canonical capture.",
      );
    financialDepositCaptures.push(financialAdmission.capture);
    relationInputs.push({
      captureId: financialInput.captureId,
      evidence: (downloaded.counterpartyAccountEvidence ?? []).map(
        (evidence) => {
          const materialized = materializeYuantaCounterpartyEvidence(
            financialAdmission.capture!,
            evidence,
          );
          admitCounterpartyAccountEvidence(materialized, "yuanta");
          return materialized;
        },
      ),
    });
  }

  // Read and validate the point-in-time page before returning any items. A
  // failure here must not leave statement captures from this run behind.
  if (financialDepositCaptures.length > 0) {
    const authority = financialDepositCaptures[0]!.identity;
    const currentRows = await readCurrent(page, "domestic", {
      observedAt: yuantaObservedAt(),
      financialAuthority: {
        sourceConnectionKey: authority.sourceConnectionKey,
        identityEpochKey: authority.identityEpochKey,
        authorityClass: "existing-financial-admission",
      },
    });
    overrides.sourceText.assertIntact(JSON.stringify(currentRows));
    const currentObservedAt = overrides.observedAt?.() ?? yuantaObservedAt();
    const existingBySourceAccount = indexYuantaCurrentDepositFinancialCaptures(
      financialDepositCaptures,
    );
    currentBalanceCaptures = currentRows.map((unadjustedRow) => {
      const row = { ...unadjustedRow, observedAt: currentObservedAt };
      const matching = existingBySourceAccount.get(row.sourceAccountKey);
      if (!matching)
        throw new Error(
          "Yuanta current deposit snapshot contains an account without exactly one existing financial identity.",
        );
      return admitCurrentDepositBalanceCapture(
        buildYuantaCurrentDepositBalanceCapture(row, matching),
      );
    });
  }

  overrides.signal.throwIfAborted();
  const items: PGliteWorkflowRunItem[] = [];
  for (const entry of sourceOnlyEntries) items.push({
    provider: "yuanta",
    product: "domestic-deposit",
    itemKey: entry.captureId,
    command: {
      kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
      request: createYuantaDomesticDepositSourceEvidence(
        entry.capture,
        entry.captureId,
        stableSourceIdentity,
      ),
    },
  });
  for (const capture of financialDepositCaptures) {
    const relation = relationInputs.find((item) => item.captureId === capture.captureId);
    items.push({
      provider: "yuanta",
      product: "domestic-deposit",
      itemKey: capture.captureId,
      command: { kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND, request: { capture } },
      ...(relation ? {
        relationCommands: () => [{
          kind: PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
          request: {
            sourceConnectionKey,
            integrationNamespace: "yuanta",
            observedAt: capture.observedAt,
            counterpartyEvidence: relation.evidence,
          },
        }],
      } : {}),
    });
  }
  for (const capture of currentBalanceCaptures) items.push({
    provider: "yuanta",
    product: "current-balance",
    itemKey: `current-balance:${capture.identity.sourceAccountKey}`,
    command: {
      kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
      request: currentDepositBalanceCommandRequest(capture),
    },
  });
  for (const item of items) {
    overrides.signal.throwIfAborted();
    overrides.sourceText.assertIntact(JSON.stringify(item.command));
  }
  overrides.deferredCommitItems.push(...items);

  return {
    sourceCount,
    rowCount,
    itemCount: items.length,
    financialAdmissionCount: financialDepositCaptures.length + currentBalanceCaptures.length,
  };
}
