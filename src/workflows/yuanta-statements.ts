import { createHash, randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { z } from "zod";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import { parseCsvMatrix } from "../lib/tabular-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import { periodSpans, type CollectionPeriod, type CollectionSpan } from "../lib/automation/collection-period.ts";
import { hasAttachedLocator } from "./browser-interaction.js";
import type { BrowserScope } from "./frame-scope.ts";
import { yuantaEbankSite, type YuantaEbankSite, type YuantaRoute } from "./yuanta-ebank-site.ts";
import {
  StatementComponentAbsentError,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
  type ProductStageRequest,
} from "../lib/automation/product-collection.ts";
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
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
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
  type YuantaCurrentDepositFinancialAuthority,
} from "./yuanta-current-deposit-balances.ts";
import {
  matchCurrentBalanceCaptures,
  type CurrentBalanceCaptureMatching,
} from "./current-balance-capture-match.ts";
import {
  admitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/pglite/current-deposit-admission.ts";
/** Yuanta's quick date-range links: the link text and the span it covers, both ends inclusive. */
export const YUANTA_QUICK_RANGES = [
  { dateRange: "one_week", label: "一週", span: { days: 7 } },
  { dateRange: "one_month", label: "一個月", span: { months: 1, days: 1 } },
  { dateRange: "three_months", label: "三個月", span: { months: 3, days: 1 } },
] as const satisfies readonly Readonly<{ dateRange: string; label: string; span: CollectionSpan }>[];

type YuantaQuickRange = (typeof YUANTA_QUICK_RANGES)[number];

/** The quick link that covers the collection period exactly, if any. */
export function yuantaQuickRange(period: CollectionPeriod): YuantaQuickRange | undefined {
  return YUANTA_QUICK_RANGES.find(({ span }) => periodSpans(period, span));
}

/** The range a deposit query records: its quick link and dates as YYYY-MM-DD. */
export type YuantaDepositQueryRange = Readonly<{
  dateRange: YuantaQuickRange["dateRange"];
  startDate: string;
  endDate: string;
}>;

/** The deposit query for the product's collection period; the deposit page offers only quick links. */
export function yuantaDepositQueryRange(period: CollectionPeriod): YuantaDepositQueryRange {
  const quick = yuantaQuickRange(period);
  if (!quick) throw new Error("No Yuanta quick range covers the deposit collection period.");
  return { dateRange: quick.dateRange, startDate: period.start, endDate: period.end };
}

export const yuantaStatementsInputSchema = z.object({
  accountFilters: z.array(z.string()).default([]),
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
  /** Set only when the bank's result table said 查無資料 instead of offering a CSV. */
  zeroResultAuthority?: "provider-explicit-no-data";
  /** Optional exact evidence from a provider detail/mandate page. */
  counterpartyAccountEvidence?: readonly YuantaCounterpartyAccountEvidence[];
};

type BankTransactionRow = {
  accountLabel: string;
  values: string[];
  sourceRowOrdinal: number;
};

type YuantaStatementsInput = z.infer<typeof yuantaStatementsInputSchema>;

export type YuantaStatementsCollectionInput = YuantaStatementsInput & Readonly<{
  /** Stable provider-login scope; never contains a password or session. */
  sourceConnectionScope: string;
  /** Stable source key derived from the provider-login scope. */
  sourceConnectionKey: string;
}>;

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

/**
 * Yuanta keys a domestic balance by the source account key. A row with no
 * admitted capture fails the run. The first capture under a key wins.
 */
export const yuantaCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ sourceAccountKey: string }>,
  ExistingYuantaFinancialCapture
> = {
  captureKey: ({ identity }) => identity.sourceAccountKey ?? identity.accountNo,
  rowKey: (row) => row.sourceAccountKey,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest,
  ambiguousMessage: "Yuanta current deposit identities are ambiguous across financial captures.",
  unmatched: {
    kind: "throw",
    message:
      "Yuanta current deposit snapshot contains an account without exactly one existing financial identity.",
  },
};

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

/** The domestic transaction-details page: ready once a scope holds the account selector. */
const TRANSACTION_DETAILS_ROUTE: YuantaRoute = {
  path: "transactiondetails",
  description: 'selector "#acctno"',
  ready: async (scope) => await hasAttachedLocator(scope.locator("#acctno")),
  menuId: "menu_transactiondetails",
};

/**
 * After a submit the previous account's result can still be on the page, and
 * no captured page shows what marks the new result, so the query waits as long
 * as it always has before it looks for one.
 */
const QUERY_SUBMIT_PAUSE_MS = 750;

async function prepareYuantaDepositPage(
  site: YuantaEbankSite,
  queryRange: YuantaDepositQueryRange,
): Promise<void> {
  const scope = await site.open(TRANSACTION_DETAILS_ROUTE);
  const { label } = YUANTA_QUICK_RANGES.find(({ dateRange }) => dateRange === queryRange.dateRange)!;
  await site.chooseDuration(scope, { label });
  await site.frames.scopeWith("#acctno");
}

export async function readYuantaDepositAccountOptions(
  site: YuantaEbankSite,
  _filters: string[] = [],
) {
  const { frames } = site;
  const scope = await frames.scopeWith("#acctno");
  const options = scope.locator("#acctno option");
  const count = await frames.race(options.count());
  const availableAccounts: Array<{ label: string; value: string }> = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await frames.race(option.getAttribute("value"))) ?? "";
    const label = cleanText(await frames.race(option.textContent()));
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

export type YuantaDepositQueryResult = "download-ready" | "provider-explicit-no-data";

const csvDownloadLink = (scope: BrowserScope) =>
  scope.locator("a.order_2.m_color_check").filter({ hasText: "下載CSV檔" });

/** Waits for the submitted query to show either a CSV link or the bank's 查無資料 row. */
export async function waitForYuantaDepositQueryResult(
  site: YuantaEbankSite,
  timeoutMs = 60_000,
): Promise<YuantaDepositQueryResult> {
  const { frames } = site;
  return await frames.until<YuantaDepositQueryResult>(async () => {
    for (const scope of frames.scopes()) {
      if (await hasAttachedLocator(csvDownloadLink(scope))) return "download-ready";
      if (await hasAttachedLocator(scope.getByText("查無資料", { exact: true }))) {
        return "provider-explicit-no-data";
      }
    }
    return null;
  }, "Could not find YuanTa CSV download link or a no-data result in any frame.", { timeoutMs });
}

async function queryAccount(
  site: YuantaEbankSite,
  account: { label: string; value: string },
): Promise<YuantaDepositQueryResult> {
  const { frames } = site;
  const scope = await frames.scopeWith("#acctno");
  await frames.race(scope.locator("#acctno").selectOption(account.value));
  await frames.race(scope.locator("#submitbutton").click());
  await frames.settle();
  await frames.pause(QUERY_SUBMIT_PAUSE_MS);
  return await waitForYuantaDepositQueryResult(site);
}

const YUANTA_EXPLICIT_NO_DATA_FILENAME = "yuanta-provider-explicit-no-data";

/** A terminal zero-row download standing in for the CSV the bank does not offer. */
function yuantaExplicitNoDataDownload(): YuantaStatementDownload {
  return {
    filename: YUANTA_EXPLICIT_NO_DATA_FILENAME,
    rows: [],
    zeroResultAuthority: "provider-explicit-no-data",
    source: {
      filename: YUANTA_EXPLICIT_NO_DATA_FILENAME,
      byteLength: 0,
      contentDigest: `sha256:${createHash("sha256").digest("base64url")}`,
      columnNames: YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      terminal: true,
      rows: [],
    },
  };
}

export async function downloadYuantaStatementRows(
  site: YuantaEbankSite,
  account: { label: string; value: string },
): Promise<YuantaStatementDownload> {
  const scope = await site.frames.scopeWith(csvDownloadLink, "YuanTa CSV download link");
  const exportLink = csvDownloadLink(scope).first();
  await site.frames.race(exportLink.waitFor({ state: "attached", timeout: 60_000 }));
  const downloaded = await site.readCsv(exportLink);
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
  queryRange: YuantaDepositQueryRange,
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
    ...(download.zeroResultAuthority
      ? { zeroResultAuthority: download.zeroResultAuthority }
      : {}),
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
    sequenceLexeme: string;
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
    const position = /^(\d+):(\d+)$/u.exec(record.sequenceLexeme);
    return position !== null && Number(position[2]) === evidence.rowOrdinal &&
      (evidence.pageOrdinal === undefined || Number(position[1]) === evidence.pageOrdinal);
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

export type YuantaDepositAccount = Readonly<{ label: string; value: string }>;

/** What the transaction-details page returned for one account's query. */
export type YuantaDepositAccountRead =
  | Readonly<{ account: YuantaDepositAccount; query: "provider-explicit-no-data" }>
  | Readonly<{ account: YuantaDepositAccount; query: "download-ready"; download: YuantaStatementDownload }>;

export type YuantaDepositSourceSnapshot = Readonly<{
  observedAt: string;
  /** The range the read half selected, from the product's collection period. */
  queryRange: YuantaDepositQueryRange;
  accounts: readonly YuantaDepositAccountRead[];
}>;

export type YuantaReadCurrentDepositBalances = (
  input: Readonly<{
    observedAt: string;
    financialAuthority: YuantaCurrentDepositFinancialAuthority;
  }>,
) => Promise<readonly YuantaCurrentDepositBalanceRow[]>;

/** Read every visible account's query result from the transaction-details page (ADR 0065). */
export async function readYuantaDepositSource(
  page: Page,
  input: YuantaStatementsCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<YuantaDepositSourceSnapshot> {
  const observedAt = yuantaObservedAt(new Date(context.now()));
  const queryRange = yuantaDepositQueryRange(product.collectionPeriod());
  // The canonical domestic scope is all visible TWD selectors. Input
  // accountFilters remains accepted for compatibility but never narrows it.
  context.signal.throwIfAborted();
  const site = yuantaEbankSite(page, context);
  await prepareYuantaDepositPage(site, queryRange);
  context.signal.throwIfAborted();
  const accounts: YuantaDepositAccountRead[] = [];
  for (const account of await readYuantaDepositAccountOptions(site, [])) {
    context.signal.throwIfAborted();
    await product.reportActivity("query");
    const query = await queryAccount(site, account);
    context.signal.throwIfAborted();
    if (query === "provider-explicit-no-data") {
      accounts.push({ account, query });
      continue;
    }
    await product.reportActivity("download");
    const download = await downloadYuantaStatementRows(site, account);
    context.text.assertIntact(JSON.stringify(download));
    accounts.push({ account, query, download });
  }
  return { observedAt, queryRange, accounts };
}

/** Build and stage domestic-deposit source items from a read snapshot. */
export async function stageYuantaDeposit(
  snapshot: YuantaDepositSourceSnapshot,
  input: YuantaStatementsCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
  readCurrentBalances: YuantaReadCurrentDepositBalances,
): Promise<ProductCollectionSummary> {
  const { sourceConnectionScope, sourceConnectionKey } =
    requireSourceConnectionIdentity("yuanta", "Yuanta deposit", input);
  const stableSourceIdentity = {
    sourceConnectionScope,
    sourceConnectionKey,
  } as const;
  const nextTimestamp = createTimestampGenerator();
  const { observedAt, queryRange } = snapshot;
  let rowCount = 0;
  let sourceCaptureCount = 0;
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

  for (const read of snapshot.accounts) {
    const { account } = read;
    const downloaded = read.query === "provider-explicit-no-data"
      ? yuantaExplicitNoDataDownload()
      : read.download;
    if (downloaded.source.terminal !== true)
      throw new Error(
        "Yuanta domestic deposit download did not reach a terminal CSV state.",
      );
    rowCount += downloaded.rows.length;
    sourceCaptureCount += 1;
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
      humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
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
    context.signal.throwIfAborted();
    const authority = financialDepositCaptures[0]!.identity;
    const currentRows = await readCurrentBalances({
      observedAt: yuantaObservedAt(new Date(context.now())),
      financialAuthority: {
        sourceConnectionKey: authority.sourceConnectionKey,
        identityEpochKey: authority.identityEpochKey,
        authorityClass: "existing-financial-admission",
      },
    });
    context.text.assertIntact(JSON.stringify(currentRows));
    const currentObservedAt = yuantaObservedAt(new Date(context.now()));
    const { matched } = matchCurrentBalanceCaptures(
      currentRows.map((row) => ({ ...row, observedAt: currentObservedAt })),
      financialDepositCaptures,
      yuantaCurrentBalanceCaptureMatching,
    );
    currentBalanceCaptures = matched.map(({ row, capture }) =>
      admitCurrentDepositBalanceCapture(buildYuantaCurrentDepositBalanceCapture(row, capture)),
    );
  }

  context.signal.throwIfAborted();
  const items: ProductStageRequest[] = [];
  for (const entry of sourceOnlyEntries) items.push({
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
    product: "current-balance",
    itemKey: `current-balance:${capture.identity.sourceAccountKey}`,
    command: {
      kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
      request: currentDepositBalanceCommandRequest(capture),
    },
  });
  product.stage(...items);

  return { sourceCaptureCount, rowCount };
}

/** Collect domestic-deposit source items for the App-owned financial commit. */
export async function runYuantaStatements(
  page: Page,
  input: YuantaStatementsCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<ProductCollectionSummary> {
  requireSourceConnectionIdentity("yuanta", "Yuanta deposit", input);
  const snapshot = await readYuantaDepositSource(page, input, context, product);
  return await stageYuantaDeposit(
    snapshot,
    input,
    context,
    product,
    (options) => readYuantaCurrentDepositBalances(yuantaEbankSite(page, context), "domestic", options),
  );
}
