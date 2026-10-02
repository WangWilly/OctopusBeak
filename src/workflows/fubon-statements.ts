import { createHash, randomUUID } from "node:crypto";
import type { Frame, Locator, Page, Response } from "playwright";
import { z } from "zod";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  activateControlWithoutPointer,
  selectOptionWithoutPointer,
} from "./browser-interaction.ts";
import { fetchFormPostbackHtml, replaceDocumentHtml } from "./form-postback.ts";
import {
  admitFubonDomesticDepositCaptureEvidence,
  admitFubonDomesticDepositSourceOnlyEvidence,
  admitFubonDomesticDepositFinancialCapture,
  createFubonDomesticDepositSourceEvidence,
  deriveFubonDomesticDepositAccountIdentity,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
  FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
  FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
  FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
  FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
  FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_PATH,
  FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_CONTRACT,
  FUBON_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION_V2,
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  isFubonHumanAttestedV1Active,
  isFubonSourceOnlyFinancialDiagnostic,
  isSourceOnlyFubonDomesticDepositCaptureEvidence,
  type FubonDomesticDepositSourceOnlyEvidence,
  type FubonDomesticDepositValidatedEvidence,
  type FubonDomesticDepositAccountNumberEvidence,
} from "../ledger/canonical/fubon-domestic-deposit-admission.ts";
import type {
  TransactionCounterpartyAccountEvidenceInput,
} from "../ledger/canonical/counterparty-account-evidence.ts";
import { requireSourceConnectionIdentity } from "../ledger/canonical/source-connection-identity.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import {
  readFubonCurrentDepositBalances,
  FUBON_CURRENT_DEPOSIT_BALANCE_HOST,
  type FubonCurrentDepositBalanceRow,
} from "./fubon-current-deposit-balances.ts";
import {
  admitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/pglite/current-deposit-admission.ts";

const BANK_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";
const depositAccountSelectSelector = 'select[id="form1:comboAccount"]';
const depositQueryPath = "/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces";
export const FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION =
  "capture-evidence-v2" as const;
export const FUBON_DEPOSIT_TELEMETRY_VERSION = "deposit-telemetry-v1" as const;
export const FUBON_LOAN_PAYMENT_ACCOUNT_EVIDENCE_CONTRACT_VERSION =
  "fubon/deposit-loan-payment-account/v1" as const;

type BrowserScope = Page | Frame;

export const fubonStatementDateRangeSchema = z.enum([
  "1",
  "3",
  "7",
  "14",
  "21",
  "30",
  "60",
  "90",
  "180",
  "180_365",
]);

export const fubonStatementsInputSchema = z.object({
  dateRanges: z
    .array(fubonStatementDateRangeSchema)
    .min(1)
    .default(["180", "180_365"]),
  downloadFormat: z.enum(["TXT", "EXCEL", "PDF"]).default("EXCEL"),
});

/**
 * Read-only probe controls. The workflow intentionally keeps this separate
 * from the normal statement export path so a telemetry run cannot create
 * downloads or canonical financial rows.
 */
export const fubonDepositTelemetryInputSchema = z.object({
  repeatDateRange: fubonStatementDateRangeSchema.default("180"),
  zeroDateRange: fubonStatementDateRangeSchema.default("1"),
});

const fubonDepositTelemetryFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
});

const fubonDepositTelemetryPaginationSchema = z.object({
  name: z.string(),
  value: z.number().int().nonnegative().nullable(),
});

export const fubonDepositTelemetryRecordSchema = z.object({
  telemetryVersion: z.literal(FUBON_DEPOSIT_TELEMETRY_VERSION),
  queryId: z.enum(["A1", "A2", "B"]),
  queryScope: z.object({
    rangeCode: fubonStatementDateRangeSchema,
    startDate: z.string(),
    endDate: z.string(),
    explicitZeroProbe: z.boolean(),
  }),
  endpoint: z.object({
    path: z.string().nullable(),
    method: z.string().nullable(),
    status: z.number().int().nullable(),
    contentType: z.string().nullable(),
    bodyLength: z.number().int().nonnegative(),
    bodySha256: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
    requestHeaderNames: z.array(z.string()),
    responseHeaderNames: z.array(z.string()),
  }),
  form: z.object({
    fieldNames: z.array(z.string()),
    fields: z.array(fubonDepositTelemetryFieldSchema),
  }),
  response: z.object({
    fieldNames: z.array(z.string()),
    fields: z.array(fubonDepositTelemetryFieldSchema),
    candidateProviderKeyNames: z.array(z.string()),
    candidateProviderKeyDigests: z.array(
      z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
    ),
    statusFieldNames: z.array(z.string()),
    correctionFieldNames: z.array(z.string()),
    transactionTimeFieldNames: z.array(z.string()),
    accountScopeFieldNames: z.array(z.string()),
    pagination: z.array(fubonDepositTelemetryPaginationSchema),
  }),
  observed: z.object({
    pageCount: z.number().int().nonnegative(),
    rowCount: z.number().int().nonnegative(),
    zeroResult: z.boolean(),
    terminalPage: z.boolean(),
  }),
});

export const fubonDepositTelemetryOutputSchema = z.object({
  telemetryVersion: z.literal(FUBON_DEPOSIT_TELEMETRY_VERSION),
  account: z.object({
    valueDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
    label: z.string(),
    branchName: z.string(),
  }),
  records: z.array(fubonDepositTelemetryRecordSchema),
  comparison: z.object({
    repeatStability: z.enum([
      "observed-stable",
      "observed-drift",
      "not-observed",
    ]),
    fieldShapeEqual: z.boolean(),
    paginationShapeEqual: z.boolean(),
    candidateKeyNameIntersection: z.array(z.string()),
    candidateKeyDigestIntersection: z.array(
      z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
    ),
  }),
  zeroResultAuthority: z.enum([
    "provider-explicit-no-data",
    "empty-result-table",
    "non-empty-observation",
  ]),
});

export type FubonCredentials = {
  fubon_user_id?: string;
  fubon_account?: string;
  fubon_password?: string;
};

export type FubonStatementsInput = z.infer<typeof fubonStatementsInputSchema>;
export type FubonDepositTelemetryInput = z.infer<
  typeof fubonDepositTelemetryInputSchema
>;
export type FubonDepositTelemetryOutput = z.infer<
  typeof fubonDepositTelemetryOutputSchema
>;

export type FubonParsedDepositStatement = {
  account: string;
  accountId: string;
  queryPeriod: string;
  branchName: string;
  rows: string[][];
  pages: Array<
    FubonDepositStatementPageEvidence & {
      responseMetadata?: FubonDepositResponseMetadata;
      bodyLength?: number;
      bodySha256?: `sha256:${string}`;
    }
  >;
  accountOption: FubonDepositAccountOptionEvidence;
};

export type FubonStatementsRunDependencies = Readonly<{
  /** Stable login-derived Source Connection identity shared with loan runs. */
  sourceConnectionKey: string;
  /** Raw, non-secret stable login scope used by the canonical adapter. */
  sourceConnectionScope: string;
  deferredCommitItems: PGliteWorkflowRunItem[];
  sourceText: SourceTextPort;
  signal: AbortSignal;
  openTransactionDetailForAccountIndex?: (
    page: Page,
    accountIndex: number,
  ) => Promise<string>;
  readDepositAccountOptions?: (
    page: Page,
  ) => Promise<FubonDepositAccountOption[]>;
  selectDepositAccount?: (
    page: Page,
    account: FubonDepositAccountOption,
  ) => Promise<void>;
  fetchDepositStatement?: (
    page: Page,
    dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
    account: FubonDepositAccountOption,
  ) => Promise<FubonParsedDepositStatement>;
  readCurrentDepositBalances?: typeof readFubonCurrentDepositBalances;
}>;

export type FubonDepositWorkflowCollection = Readonly<{
  sourceCount: number;
  rowCount: number;
  itemCount: number;
  financialAdmissionCount: number;
}>;

type ExistingFubonFinancialCapture = Readonly<{
  identity: Readonly<{
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    accountNumber?: Readonly<{ value: string }> | null;
  }>;
}>;

function fubonCurrentDepositOpaqueKey(
  domain: string,
  ...parts: readonly string[]
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(parts.join("\0"))
    .digest("base64url")}`;
}

/** Preserve the provider's full account-number evidence while joining the
 * current snapshot to the existing hashed canonical account identity. */
export function buildFubonCurrentDepositBalanceCapture(
  row: FubonCurrentDepositBalanceRow,
  financialCapture: ExistingFubonFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  if (identity.accountNumber?.value !== row.accountNumber)
    throw new Error(
      "Fubon current deposit account does not match the existing full account-number evidence.",
    );
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  const records: CurrentDepositSourceRecordInput[] = [];
  const observations: CurrentDepositBalanceObservationInput[] = [];
  const amountPairs: readonly [
    "ledger" | "available",
    string,
    CurrentDepositExactAmount,
  ][] = [
    ["ledger", "即時餘額", row.instantBalance],
    ["available", "可用餘額", row.availableBalance],
  ];
  for (const [balanceKind, sourceField, balance] of amountPairs) {
    const sourceRecordKey = fubonCurrentDepositOpaqueKey(
      "fubon-current-deposit-source-record-v1",
      sourceAccountKey,
      row.currency,
      balanceKind,
      row.effectiveAt,
      balance.coefficient,
      String(balance.scale),
    );
    const compact = {
      accountNumber: row.accountNumber,
      accountNickname: row.accountNickname,
      depositType: row.depositType,
      branchName: row.branchName,
      currencySourceLexeme: row.currencySourceLexeme,
      effectiveAt: row.effectiveAt,
      effectiveTimeSourceField: "HTTP Date",
      effectiveTimeSourceValue: row.providerHttpDate,
      sourceEvidence: { ...row.sourceEvidence },
    };
    const record = currentDepositSourceRecord({
      sourceRecordKey,
      providerKey: fubonCurrentDepositOpaqueKey(
        "fubon-current-deposit-provider-record-v1",
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
      observationKey: fubonCurrentDepositOpaqueKey(
        "fubon-current-deposit-observation-v1",
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
  const endpoint = `https://${FUBON_CURRENT_DEPOSIT_BALANCE_HOST}${row.sourceEvidence.endpoint}`;
  return {
    captureId: randomUUID(),
    authorityRoute: "fubon/domestic-deposit/current-balance-v1",
    contractVersion: row.sourceEvidence.contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "fubon",
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
          source: "fubon-current-deposit-summary",
          sourceRowCount: 1,
          balanceFieldCount: records.length,
        },
      },
    ],
    records,
    observations,
  };
}

export function indexFubonCurrentDepositFinancialCaptures(
  financialCaptures: readonly ExistingFubonFinancialCapture[],
): ReadonlyMap<string, ExistingFubonFinancialCapture> {
  const existingByAccountNumber = new Map<string, ExistingFubonFinancialCapture>();
  for (const candidate of financialCaptures) {
    const accountNumber = candidate.identity.accountNumber?.value;
    if (!accountNumber) continue;
    const prior = existingByAccountNumber.get(accountNumber);
    if (
      prior &&
      (prior.identity.sourceConnectionKey !==
        candidate.identity.sourceConnectionKey ||
        prior.identity.identityEpochKey !== candidate.identity.identityEpochKey ||
        (prior.identity.sourceAccountKey ?? prior.identity.accountNo) !==
          (candidate.identity.sourceAccountKey ?? candidate.identity.accountNo) ||
        prior.identity.subjectDigest !== candidate.identity.subjectDigest)
    )
      throw new Error(
        "Fubon current deposit identities are ambiguous across financial captures.",
      );
    if (!prior) existingByAccountNumber.set(accountNumber, candidate);
  }
  return existingByAccountNumber;
}

export type ParsedDepositStatementPage = {
  account: string;
  accountId: string;
  branchName: string;
  queryPeriod: string;
  rows: string[][];
  nextPage: string | null;
  pageFieldName: string | null;
  paginationEvidence?: "next-page" | "terminal-no-next";
  /** No traversable next page was parsed, but provider pagination controls were ambiguous. */
  paginationAmbiguous?: true;
  paginationAmbiguityReason?: FubonDepositPaginationAmbiguityReason;
  pageOrdinal: number;
  responseSequence: number;
  terminal: boolean;
  startDate: string;
  endDate: string;
  selectedAccountValue: string;
  selectedAccountLabel: string;
  evidenceRows: FubonDepositStatementRowEvidence[];
  responseMetadata: FubonDepositResponseMetadata;
  bodyLength: number;
  bodySha256: `sha256:${string}`;
  providerPageSize?: number;
  providerTotalCount?: number;
};

type FubonDepositResponseMetadata = {
  fieldNames: string[];
  fields: Array<{ name: string; type: string }>;
  candidateProviderKeyNames: string[];
  candidateProviderKeyDigests: `sha256:${string}`[];
  statusFieldNames: string[];
  correctionFieldNames: string[];
  transactionTimeFieldNames: string[];
  accountScopeFieldNames: string[];
  pagination: Array<{ name: string; value: number | null }>;
};

type FubonDepositResponseObservation = {
  path: string;
  method: string;
  status: number;
  contentType: string | null;
  requestHeaderNames: string[];
  responseHeaderNames: string[];
};

class FubonDepositResponseTracker {
  private readonly page: Page;
  private readonly observations: FubonDepositResponseObservation[] = [];

  private readonly listener = (response: {
    url(): string;
    status(): number;
    headers(): Record<string, string>;
    request(): {
      method(): string;
      headers(): Record<string, string>;
    };
  }) => {
    const request = response.request();
    const url = new URL(response.url());
    const responseHeaders = response.headers();
    const requestHeaders = request.headers();
    this.observations.push({
      path: url.pathname,
      method: request.method(),
      status: response.status(),
      contentType:
        Object.entries(responseHeaders).find(
          ([name]) => name.toLowerCase() === "content-type",
        )?.[1] ?? null,
      requestHeaderNames: Object.keys(requestHeaders),
      responseHeaderNames: Object.keys(responseHeaders),
    });
  };

  constructor(page: Page) {
    this.page = page;
    page.on("response", this.listener as never);
  }

  snapshot(): number {
    return this.observations.length;
  }

  since(snapshot: number): FubonDepositResponseObservation[] {
    return this.observations.slice(snapshot);
  }

  close(): void {
    this.page.off("response", this.listener as never);
  }
}

export type FubonDepositAccountOption = {
  label: string;
  value: string;
};

/**
 * Versioned evidence emitted at the existing Fubon form-postback boundary.
 * The values are retained only as a typed hand-off to the Fubon adapter; no
 * provider financial semantics are inferred from the HTML table.
 */
export type FubonDepositAccountOptionEvidence = {
  value: string;
  label: string;
  branchName: string;
  accountNumber?: FubonDomesticDepositAccountNumberEvidence;
};

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The Fubon domestic selector's option value is an account number only when
 * the unmasked value is also rendered as the account label. Preserve leading
 * zeroes and reject masked values or selector tokens that lack that evidence.
 */
export function deriveFubonDomesticDepositAccountNumberEvidence(
  account: Pick<FubonDepositAccountOption, "value" | "label">,
): FubonDomesticDepositAccountNumberEvidence | null {
  const value = cleanText(account.value);
  const label = cleanText(account.label);
  if (!label) return null;
  const composite = value.match(
    /^(?:\d{3})-(\d{16})-TWD-(?:\d{2})$/u,
  );
  const displayLabel = label.match(
    /^(\d{14})\s*(?:\([^()（）]+\)|（[^()（）]+）)$/u,
  );
  if (
    composite &&
    displayLabel &&
    composite[1] === `00${displayLabel[1]}`
  ) {
    return {
      value: displayLabel[1]!,
      kind: "depository-account",
      evidenceVersion:
        FUBON_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION_V2,
      sourceField: "form1:comboAccount option.value + option.text",
    };
  }
  if (!/^\d{6,24}$/.test(value)) return null;
  const exactValue = new RegExp(`(?:^|\\D)${escapedRegExp(value)}(?=\\D|$)`);
  if (!exactValue.test(label)) return null;
  return {
    value,
    kind: "depository-account",
    evidenceVersion: FUBON_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField: "form1:comboAccount option.value",
  };
}

export type FubonDepositStatementRowEvidence = {
  rowOrdinal: number;
  /** The seven cells in the source table's declared header order. */
  cells: readonly [string, string, string, string, string, string, string];
  /** Reserved for a provider-emitted transaction identifier; never inferred. */
  sourceOccurrenceId?: string;
};

export type FubonDepositStatementPageEvidence = {
  pageOrdinal: number;
  responseSequence: number;
  terminal: boolean;
  nextPage: string | null;
  pageFieldName: string | null;
  /** Provider-derived pagination signal; absent means pagination is ambiguous. */
  paginationEvidence?: "next-page" | "terminal-no-next";
  /** No traversable next page was parsed, but provider pagination controls were ambiguous. */
  paginationAmbiguous?: true;
  paginationAmbiguityReason?: FubonDepositPaginationAmbiguityReason;
  queryRange: { startDate: string; endDate: string };
  selectedAccount: FubonDepositAccountOptionEvidence;
  /** Provider page-size evidence used to distinguish a short terminal page from a truncated full page. */
  providerPageSize?: number;
  /** Provider result-count evidence used to prove a complete terminal page. */
  providerTotalCount?: number;
  rows: readonly FubonDepositStatementRowEvidence[];
  zeroObservation: "empty-page" | "non-empty-page";
};

export type FubonDepositStatementEvidence = {
  evidenceVersion: typeof FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION;
  source: "fubon";
  observedAt: string;
  account: FubonDepositAccountOptionEvidence;
  queryRange: { startDate: string; endDate: string };
  pages: readonly FubonDepositStatementPageEvidence[];
  zeroObservation: "empty-range" | "non-empty-range";
  /** Positive evidence that this capture came from the exact domestic TWD endpoint. */
  providerRouteEvidence?: {
    endpointPath: string;
    contract: string;
    currency: "TWD" | "FX" | "unknown";
  };
  /** Empty ranges are canonical only when the provider explicitly says no data. */
  zeroResultAuthority?: "provider-explicit-no-data" | "unproven";
  provenance: {
    source: "fubon-ebank-domestic-deposit-form-postback";
    responseBodyRetained: false;
    semantics: "unresolved";
  };
};

type FubonFinancialCaptureForCounterpartyEvidence = {
  captureId: string;
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    accountNo: string;
    sourceAccountKey?: string;
  };
  records: readonly {
    occurrenceKey: string;
    sequenceLexeme: string;
  }[];
};

function fullUnmaskedFubonLoanAccountFromPaymentNote(
  value: string,
): string | null {
  const source = cleanText(value);
  if (!source || /[*xX•]/u.test(source)) return null;
  const normalized = source.replace(/[\s-]/gu, "");
  // Live Fubon observations expose a 14-digit loan account at the start of
  // 附註, followed either by a branch label or by a six-digit provider suffix.
  // Both shapes retain the complete loan account; no masked or arbitrary
  // substring is admitted as exact evidence.
  const match = normalized.match(/^(\d{14})(?:\d{6}|[\p{Script=Han}]{2,12})$/u);
  return match?.[1] ?? null;
}

/**
 * Versioned live rule confirmed against Fubon's domestic-deposit page:
 * provider summary "放款繳款" plus an unmasked full account in 附註 is an
 * exact repayment-destination assertion.  Date/amount are corroboration for
 * allocation, never a substitute for this account evidence.
 */
export function buildFubonLoanPaymentAccountEvidence(
  capture: FubonDepositStatementEvidence,
  financialCapture: FubonFinancialCaptureForCounterpartyEvidence,
): TransactionCounterpartyAccountEvidenceInput[] {
  const records = new Map<string, string>();
  for (const record of financialCapture.records) {
    if (/^\d+:\d+$/u.test(record.sequenceLexeme))
      records.set(record.sequenceLexeme, record.occurrenceKey);
  }

  const evidence: TransactionCounterpartyAccountEvidenceInput[] = [];
  for (const page of capture.pages) {
    for (const row of page.rows) {
      if (cleanText(row.cells[2]) !== "放款繳款") continue;
      const accountValue = fullUnmaskedFubonLoanAccountFromPaymentNote(
        row.cells[6],
      );
      if (!accountValue) continue;
      const sourceRecordKey = records.get(`${page.pageOrdinal}:${row.rowOrdinal}`);
      if (!sourceRecordKey)
        throw new Error(
          "Fubon loan-payment evidence row has no unique canonical source record.",
        );
      evidence.push({
        captureId: financialCapture.captureId,
        sourceRecordKey,
        sourceConnectionKey: financialCapture.identity.sourceConnectionKey,
        identityEpochKey: financialCapture.identity.identityEpochKey,
        accountKey: financialCapture.identity.sourceAccountKey ?? financialCapture.identity.accountNo,
        accountValue,
        role: "beneficiary",
        purpose: "loan_repayment",
        scope: "loan_contract",
        evidenceKind: "transaction-counterparty-account",
        sourceField: "附註",
        contractVersion: FUBON_LOAN_PAYMENT_ACCOUNT_EVIDENCE_CONTRACT_VERSION,
      });
    }
  }
  return evidence;
}

function digestEvidenceValue(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function digestTelemetryValue(value: string): `sha256:${string}` {
  return digestEvidenceValue(value);
}

/**
 * Keep a compatibility fallback for standalone legacy callers that do not
 * provide a login identity. Normal workflow runs pass the stable key and
 * scope through the canonical admission input below.
 */
function safeTelemetryFieldName(value: string): string | null {
  const name = cleanText(value);
  if (!name || name.length > 96 || !/^[A-Za-z0-9_:.#-]+$/.test(name)) {
    return null;
  }
  return name;
}

function numericCounter(value: string | undefined): number | null {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000) return null;
  return number;
}

function isFubonProviderTotalCountFieldName(name: string): boolean {
  return /^(?:resultGrid:)?(?:totalCount|recordCount)$/iu.test(name.trim());
}

/**
 * Extracts only structural metadata from a response body. Values are never
 * returned; candidate values are reduced to one-way digests immediately.
 * This is deliberately a pure seam so adversarial privacy fixtures can prove
 * that account numbers, descriptions, amounts, and notes do not escape.
 */
export function inspectFubonDepositResponseMetadata(
  html: string,
): FubonDepositResponseMetadata {
  const fields = new Map<string, { name: string; type: string }>();
  const candidateDigests = new Set<`sha256:${string}`>();
  const candidateNames = new Set<string>();
  const statusNames = new Set<string>();
  const correctionNames = new Set<string>();
  const transactionTimeNames = new Set<string>();
  const accountScopeNames = new Set<string>();
  const pagination = new Map<string, number | null>();
  const candidatePattern =
    /(?:txn|trans|transaction|trace|serial|sequence|seq|reference|ref|occurrence|unique|流水|序號|交易編號|識別)/i;
  const statusPattern = /(?:status|state|posted|入帳|狀態|處理)/i;
  const correctionPattern = /(?:cancel|reverse|adjust|correct|沖正|更正|撤銷)/i;
  const timePattern =
    /(?:date|time|effective|posted|帳務日期|交易時間|入帳日期)/i;
  const accountPattern = /(?:account|acct|comboAccount|帳戶|賬戶)/i;
  const pagePattern = /(?:page|currentPage|pageSize|total|record|筆數)/i;

  const inputPattern = /<(input|select|textarea)\b([^>]*)>/gi;
  for (const match of html.matchAll(inputPattern)) {
    const attributes = match[2] ?? "";
    const name =
      attributes.match(/\bname\s*=\s*["']([^"']*)["']/i)?.[1] ??
      attributes.match(/\bid\s*=\s*["']([^"']*)["']/i)?.[1] ??
      "";
    const safeName = safeTelemetryFieldName(name);
    if (!safeName) continue;
    const type =
      attributes.match(/\btype\s*=\s*["']([^"']*)["']/i)?.[1] ??
      (match[1] === "select"
        ? "select"
        : match[1] === "textarea"
          ? "textarea"
          : "text");
    fields.set(safeName, {
      name: safeName,
      type: cleanText(type).toLowerCase(),
    });

    const value = attributes.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1];
    if (candidatePattern.test(safeName)) {
      candidateNames.add(safeName);
      if (value) candidateDigests.add(digestTelemetryValue(value));
    }
    if (statusPattern.test(safeName)) statusNames.add(safeName);
    if (correctionPattern.test(safeName)) correctionNames.add(safeName);
    if (timePattern.test(safeName)) transactionTimeNames.add(safeName);
    if (accountPattern.test(safeName)) accountScopeNames.add(safeName);
    if (pagePattern.test(safeName)) {
      pagination.set(safeName, numericCounter(value));
    }
  }

  for (const header of depositHeaders) {
    if (header === "帳務日期") transactionTimeNames.add(header);
    if (header === "交易時間") transactionTimeNames.add(header);
    if (header === "支出金額" || header === "存入金額") statusNames.add(header);
  }
  if (/無(?:符合|相關)?資料|查無資料|沒有資料|no\s+data/i.test(html)) {
    statusNames.add("provider-no-data-message");
  }

  const paginationPatterns = [
    /dataGridCurrentPage\s*[=:]\s*["']?(\d+)/gi,
    /currentPage\s*[=:]\s*["']?(\d+)/gi,
    /pageSize\s*[=:]\s*["']?(\d+)/gi,
    /(?:resultGrid:)?(?:totalCount|recordCount)\s*[=:]\s*["']?(\d+)/gi,
  ];
  for (const pattern of paginationPatterns) {
    for (const match of html.matchAll(pattern)) {
      const rawName = pattern.source.includes("dataGridCurrentPage")
        ? "dataGridCurrentPage"
        : pattern.source.includes("pageSize")
          ? "pageSize"
          : pattern.source.includes("total")
            ? "totalCount"
            : "currentPage";
      pagination.set(rawName, numericCounter(match[1]));
    }
  }

  return {
    fieldNames: [...fields.keys()].sort(),
    fields: [...fields.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    candidateProviderKeyNames: [...candidateNames].sort(),
    candidateProviderKeyDigests: [...candidateDigests].sort(),
    statusFieldNames: [...statusNames].sort(),
    correctionFieldNames: [...correctionNames].sort(),
    transactionTimeFieldNames: [...transactionTimeNames].sort(),
    accountScopeFieldNames: [...accountScopeNames].sort(),
    pagination: [...pagination.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function buildFubonDepositStatementEvidence(
  statements: readonly FubonParsedDepositStatement[],
  observedAt = new Date().toISOString(),
): FubonDepositStatementEvidence[] {
  return statements.map((statement) => ({
    evidenceVersion: FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "fubon",
    observedAt,
    account: { ...statement.accountOption },
    queryRange: {
      startDate: statement.pages[0]?.queryRange.startDate ?? "",
      endDate: statement.pages[0]?.queryRange.endDate ?? "",
    },
    pages: statement.pages.map((page) => ({
      pageOrdinal: page.pageOrdinal,
      responseSequence: page.responseSequence,
      terminal: page.terminal,
      nextPage: page.nextPage,
      pageFieldName: page.pageFieldName,
      ...(page.paginationEvidence !== undefined
        ? { paginationEvidence: page.paginationEvidence }
        : {}),
      ...(page.paginationAmbiguous === true
        ? { paginationAmbiguous: true as const }
        : {}),
      ...(page.paginationAmbiguityReason !== undefined
        ? { paginationAmbiguityReason: page.paginationAmbiguityReason }
        : {}),
      queryRange: { ...page.queryRange },
      selectedAccount: { ...page.selectedAccount },
      ...(page.providerPageSize !== undefined
        ? { providerPageSize: page.providerPageSize }
        : {}),
      ...(page.providerTotalCount !== undefined
        ? { providerTotalCount: page.providerTotalCount }
        : {}),
      rows: page.rows.map((row) => ({
        rowOrdinal: row.rowOrdinal,
        cells: [...row.cells] as FubonDepositStatementRowEvidence["cells"],
        ...(row.sourceOccurrenceId
          ? { sourceOccurrenceId: row.sourceOccurrenceId }
          : {}),
      })),
      zeroObservation: page.zeroObservation,
    })),
    zeroObservation: statement.pages.every(
      (page) => page.zeroObservation === "empty-page",
    )
      ? "empty-range"
      : "non-empty-range",
    zeroResultAuthority: statement.pages.every(
      (page) => page.zeroObservation === "empty-page",
    )
      ? statement.pages.every((page) =>
          page.responseMetadata?.statusFieldNames.includes(
            "provider-no-data-message",
          ),
        )
        ? "provider-explicit-no-data"
        : "unproven"
      : "unproven",
    providerRouteEvidence: {
      endpointPath: FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_PATH,
      contract: FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_CONTRACT,
      currency: "TWD",
    },
    provenance: {
      source: "fubon-ebank-domestic-deposit-form-postback",
      responseBodyRetained: false,
      semantics: "unresolved",
    },
  }));
}

function buildFubonHumanAttestedFinancialSemantics(
  capture: FubonDomesticDepositValidatedEvidence,
  sourceConnectionKey?: string,
) {
  const identity = deriveFubonDomesticDepositAccountIdentity(
    capture.account,
    undefined,
    sourceConnectionKey as `sha256:${string}` | undefined,
  );
  return {
    evidenceVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    account: {
      accountNo: identity.accountNo,
      ...(capture.account.accountNumber
        ? { accountNumber: capture.account.accountNumber }
        : {}),
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      subjectDigest: identity.subjectDigest,
      accountType: "depository" as const,
      currency: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
    },
    authority: {
      route: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      scope: "personal-owned-accounts" as const,
      membershipEffectiveDate: null,
    },
    posting: {
      status: "posted" as const,
      origin: FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
      basis: FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    direction: {
      outflowCellIndex: 3 as const,
      inflowCellIndex: 4 as const,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    effectiveTime: {
      basis: FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
      timeZone: FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    cancellation: {
      rule: "explicit-none-only" as const,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    completeness: {
      basis: FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      absenceAuthority: FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
    },
    occurrence: {
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
      providerGuaranteed: false as const,
    },
  };
}

let lastTimestamp = 0;

const depositHeaders = [
  "帳務日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
];

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function maskAccount(account: string): string {
  const accountPart = (account.split(/[（(]/)[0] ?? account).trim();
  const existingMask = accountPart.match(/^\*+(\d{4})$/);
  if (existingMask) return accountPart;
  const digits = digitsOnly(accountPart);
  if (digits.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

function safeAccountKeyFallback(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type FubonDepositPaginationSignal = {
  nextPage: string | null;
  pageFieldName: string | null;
  terminal: boolean;
  evidence: "next-page" | "terminal-no-next" | null;
  /** No traversable next page was parsed, but provider pagination was ambiguous. */
  paginationAmbiguous?: true;
  paginationAmbiguityReason?: FubonDepositPaginationAmbiguityReason;
  providerPageSize?: number;
};

export type FubonDepositPaginationAmbiguityReason =
  | "result-context-missing"
  | "malformed-result-action"
  | "forward-control-unrecognized"
  | "forward-target-untraversable"
  | "current-page-unresolved"
  | "terminal-proof-missing";

function fubonHtmlAttribute(openingTag: string, name: string): string {
  const match = [
    ...openingTag.matchAll(
      /\s([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu,
    ),
  ].find((entry) => entry[1]?.toLowerCase() === name.toLowerCase());
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? "";
}

function fubonHasHtmlBooleanAttribute(openingTag: string, name: string): boolean {
  return [
    ...openingTag.matchAll(
      /\s([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gu,
    ),
  ].some((entry) => entry[1]?.toLowerCase() === name.toLowerCase());
}

function fubonHasHtmlClassToken(openingTag: string, token: string): boolean {
  return fubonHtmlAttribute(openingTag, "class")
    .split(/\s+/u)
    .some((value) => value.toLowerCase() === token.toLowerCase());
}

function fubonHasHtmlClassOrIdToken(openingTag: string, token: string): boolean {
  return [
    fubonHtmlAttribute(openingTag, "class"),
    fubonHtmlAttribute(openingTag, "id"),
  ]
    .flatMap((value) => value.split(/\s+/u))
    .some((value) => value.toLowerCase() === token.toLowerCase());
}

function fubonStripHtml(value: string): string {
  return cleanText(value.replace(/<[^>]*>/gu, " "));
}

function fubonExtractBalancedHtmlElement(
  html: string,
  openingStart: number,
  openingTag: string,
): string {
  const tagName = openingTag.match(/^<([a-z][\w:-]*)\b/iu)?.[1];
  if (!tagName || /\/>$/u.test(openingTag)) return openingTag;
  const tokens = [
    ...html
      .slice(openingStart)
      .matchAll(new RegExp(`<\\/?${tagName}\\b[^>]*>`, "giu")),
  ];
  let depth = 0;
  for (const token of tokens) {
    const value = token[0];
    if (/^<\//u.test(value)) {
      depth -= 1;
      if (depth === 0) {
        const end = (token.index ?? 0) + value.length;
        return html.slice(openingStart, openingStart + end);
      }
    } else if (!/\/>$/u.test(value)) {
      depth += 1;
    }
  }
  return html.slice(openingStart);
}

function fubonHtmlAncestorOpenings(
  markup: string,
  offset: number,
): string[] {
  const voidElements = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const stack: Array<{ tagName: string; opening: string }> = [];
  for (const token of markup.slice(0, offset).matchAll(
    /<\/?([a-z][\w:-]*)\b[^>]*>/giu,
  )) {
    const value = token[0] ?? "";
    const tagName = token[1]?.toLowerCase();
    if (!tagName) continue;
    if (/^<\//u.test(value)) {
      const index = stack.map((entry) => entry.tagName).lastIndexOf(tagName);
      if (index >= 0) stack.splice(index, 1);
    } else if (!voidElements.has(tagName) && !/\/\s*>$/u.test(value)) {
      stack.push({ tagName, opening: value });
    }
  }
  return stack.map((entry) => entry.opening);
}

type FubonDepositPaginationContext = {
  markup: string;
  providerResultTable: boolean;
  currentPageFieldCount: number;
  currentPage: number | null;
  currentPageFieldNames: string[];
  providerPageSize: number | null;
  pageSizeControlPresent: boolean;
  providerPager: boolean;
  controls: Array<{
    tagName: string;
    opening: string;
    text: string;
    onclick: string;
    ancestorOpenings: string[];
  }>;
};

function fubonPaginationFieldNames(openingTag: string): string[] {
  return [
    fubonHtmlAttribute(openingTag, "id"),
    fubonHtmlAttribute(openingTag, "name"),
  ].filter(Boolean);
}

function isFubonDepositCurrentPageField(name: string): boolean {
  return /(?:^|:|_)dataGridCurrentPage$/iu.test(name);
}

function isFubonDepositPageSizeField(name: string): boolean {
  return /(?:^|:|_)(?:dataGridCurrentPageSize|currentPageSize|pageSize)$/iu.test(
    name,
  );
}

function fubonDepositCurrentPageFieldBelongsToResult(
  name: string,
  tableId: string,
  providerResultTable: boolean,
): boolean {
  if (!isFubonDepositCurrentPageField(name)) return false;
  const normalizedName = name.toLowerCase();
  const normalizedTableId = tableId.toLowerCase();
  const fieldPrefix = normalizedName.replace(
    /(?:^|:|_)datagridcurrentpage$/iu,
    "",
  );
  const tablePrefixes = [
    normalizedTableId,
    normalizedTableId.replace(/_datagrid_datagridbody$/iu, "_datagrid"),
    normalizedTableId.replace(/_datagridbody$/iu, "_datagrid"),
  ].filter(Boolean);
  if (tablePrefixes.some((prefix) => fieldPrefix === prefix)) return true;
  if (
    providerResultTable &&
    /(?:^|[:_-])resultgrid(?:$|[:_-])/iu.test(name)
  ) {
    return true;
  }
  return false;
}

function fubonDepositPageSizeFieldBelongsToResult(
  name: string,
  tableId: string,
  providerResultTable: boolean,
): boolean {
  if (!isFubonDepositPageSizeField(name)) return false;
  const normalizedName = name.toLowerCase();
  const normalizedTableId = tableId.toLowerCase();
  const fieldPrefix = normalizedName.replace(
    /(?:^|:|_)(?:datagridcurrentpagesize|currentpagesize|pagesize)$/iu,
    "",
  );
  const tablePrefixes = [
    normalizedTableId,
    normalizedTableId.replace(/_datagrid_datagridbody$/iu, "_datagrid"),
    normalizedTableId.replace(/_datagridbody$/iu, "_datagrid"),
  ].filter(Boolean);
  if (tablePrefixes.some((prefix) => fieldPrefix === prefix)) return true;
  if (
    providerResultTable &&
    /(?:^|[:_-])resultgrid(?:$|[:_-])/iu.test(name)
  ) {
    return true;
  }
  return false;
}

function fubonPaginationControls(markup: string): Array<{
  tagName: string;
  markup: string;
  ancestorOpenings: string[];
}> {
  return [
    ...markup.matchAll(
      /<((?:a|button|select))\b[^>]*>[\s\S]*?<\/\1>|<(input)\b[^>]*>/giu,
    ),
  ].map((match) => ({
    tagName: (match[1] ?? match[2] ?? "").toLowerCase(),
    markup: match[0],
    ancestorOpenings: fubonHtmlAncestorOpenings(markup, match.index ?? 0),
  }));
}

function fubonPaginationControlOpening(markup: string): string {
  return (
    markup.match(/^<(?:input|select|button|a)\b[^>]*>/iu)?.[0] ?? ""
  );
}

function fubonPaginationControlValue(
  markup: string,
  opening: string,
): string {
  const directValue = fubonHtmlAttribute(opening, "value");
  if (directValue) return directValue;
  const selectedOption = [
    ...markup.matchAll(/<option\b[^>]*>/giu),
  ].find((option) => fubonHasHtmlBooleanAttribute(option[0], "selected"));
  return selectedOption
    ? fubonHtmlAttribute(selectedOption[0], "value")
    : "";
}

function fubonGridMarkerValues(opening: string): string[] {
  return [
    fubonHtmlAttribute(opening, "id"),
    fubonHtmlAttribute(opening, "class"),
  ].filter(Boolean);
}

function fubonHasResultGridNamespace(value: string): boolean {
  return /(?:^|[^a-z0-9])resultgrid(?:[^a-z0-9]|$)/iu.test(value);
}

function fubonHasNonResultGridMarker(opening: string): boolean {
  return fubonGridMarkerValues(opening).some(
    (value) =>
      /(?:grid|table|list|pager)/iu.test(value) &&
      !fubonHasResultGridNamespace(value),
  );
}

function fubonControlBelongsToResultGrid(
  control: FubonDepositPaginationContext["controls"][number],
  currentPageFieldNames: readonly string[] = [],
): boolean {
  const scopeOpenings = [control.opening, ...control.ancestorOpenings];
  const scopeText = [control.onclick, ...scopeOpenings].join(" ");
  if (fubonHasResultGridNamespace(scopeText)) return true;
  const mentionedPaginationFields = [
    ...fubonPaginationFieldNames(control.opening),
    ...[...control.onclick.matchAll(/["']([^"']+)["']/gu)].map(
      (match) => match[1] ?? "",
    ),
  ].filter(
    (name) =>
      isFubonDepositCurrentPageField(name) ||
      isFubonDepositPageSizeField(name),
  );
  if (mentionedPaginationFields.length > 0)
    return mentionedPaginationFields.some(
      (name) =>
        currentPageFieldNames.includes(name) ||
        /(?:^|[:_-])resultgrid(?:$|[:_-])/iu.test(name),
    );
  const onclickWithoutPaginationHelper = control.onclick
    .replace(/setDataGridCurrentPage/giu, "")
    .replace(/dataGridCurrentPage(?:Size)?/giu, "");
  if (
    /\b[a-z0-9_-]*grid[a-z0-9_-]*\b/iu.test(onclickWithoutPaginationHelper)
  )
    return false;
  if (scopeOpenings.some(fubonHasNonResultGridMarker)) return false;
  return true;
}

function fubonPagerBelongsToResultGrid(
  opening: string,
  ancestorOpenings: string[],
): boolean {
  const scopeOpenings = [opening, ...ancestorOpenings];
  if (
    scopeOpenings.some((candidate) =>
      fubonHasResultGridNamespace(
        fubonGridMarkerValues(candidate).join(" "),
      ),
    )
  )
    return true;
  if (scopeOpenings.some(fubonHasNonResultGridMarker)) return false;
  return true;
}

function fubonPositivePageNumber(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function fubonDepositPaginationContext(
  html: string,
): FubonDepositPaginationContext | null {
  const expectedHeaders = depositHeaders.map((header) =>
    header.replace(/\s+/gu, ""),
  );
  for (const match of html.matchAll(/<table\b[^>]*>/giu)) {
    const opening = match[0];
    const table = fubonExtractBalancedHtmlElement(
      html,
      match.index ?? 0,
      opening,
    );
    const rows = [
      ...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu),
    ];
    const headerRowIndex = rows.findIndex((row) => {
      const headers = [
        ...(row[1] ?? "").matchAll(
          /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/giu,
        ),
      ].map((cell) => fubonStripHtml(cell[1] ?? "").replace(/\s+/gu, ""));
      return (
        headers.length >= expectedHeaders.length &&
        expectedHeaders.every((header, index) =>
          (headers[index] ?? "").includes(header),
        )
      );
    });
    if (headerRowIndex < 0) continue;

    const tableId = fubonHtmlAttribute(opening, "id");
    const tableStart = match.index ?? 0;
    const tableEnd = tableStart + table.length;
    let formOpening: string | undefined;
    let formMarkup: string | undefined;
    for (const formMatch of html.matchAll(/<form\b[^>]*>/giu)) {
      const candidateStart = formMatch.index ?? 0;
      if (candidateStart > tableStart) break;
      const candidateOpening = formMatch[0];
      const candidateMarkup = fubonExtractBalancedHtmlElement(
        html,
        candidateStart,
        candidateOpening,
      );
      const candidateEnd = candidateStart + candidateMarkup.length;
      if (tableStart >= candidateStart && tableEnd <= candidateEnd) {
        formOpening = candidateOpening;
        formMarkup = candidateMarkup;
      }
    }
    const markup = formMarkup ?? table;
    const providerResultTable =
      fubonHasHtmlClassToken(opening, "queryResult") ||
      fubonHasHtmlClassOrIdToken(opening, "resultGrid") ||
      /(?:^|[:_-])(?:dataGridBody|resultGrid)(?:$|[:_-])/iu.test(tableId) ||
      fubonHtmlAttribute(formOpening ?? "", "id").toLowerCase() === "form1";
    const controlsInMarkup = fubonPaginationControls(markup);
    const allControls = fubonPaginationControls(html);
    const controlNameSet = new Set(
      controlsInMarkup.flatMap((control) => {
        const opening = fubonPaginationControlOpening(control.markup);
        return fubonPaginationFieldNames(opening);
      }),
    );
    const currentPageFieldEntries = allControls.flatMap((control) => {
      const opening = fubonPaginationControlOpening(control.markup);
      return fubonPaginationFieldNames(opening)
        .filter((name) => {
          if (!isFubonDepositCurrentPageField(name)) return false;
          if (controlNameSet.has(name) && !tableId) return true;
          return fubonDepositCurrentPageFieldBelongsToResult(
            name,
            tableId,
            providerResultTable,
          );
        })
        .map((name) => ({
          name,
          value: fubonPaginationControlValue(control.markup, opening),
        }));
    });
    const currentPageFieldNames = [
      ...new Set(currentPageFieldEntries.map((entry) => entry.name)),
    ];
    const currentPageValues = [
      ...new Set(
        currentPageFieldEntries
          .map((entry) => fubonPositivePageNumber(entry.value))
          .filter((value): value is number => value !== null),
      ),
    ];
    const currentPage = currentPageValues.length === 1
      ? currentPageValues[0]!
      : null;
    const currentPageFieldCount = currentPageFieldNames.length;
    const pageSizeFieldEntries = allControls.flatMap((control) => {
      const controlOpening = fubonPaginationControlOpening(control.markup);
      return fubonPaginationFieldNames(controlOpening)
        .filter((name) =>
          fubonDepositPageSizeFieldBelongsToResult(
            name,
            tableId,
            providerResultTable,
          ),
        )
        .map((name) => ({
          name,
          value: fubonPaginationControlValue(control.markup, controlOpening),
        }));
    });
    const pageSizeValues = [
      ...new Set(
        pageSizeFieldEntries
          .map((entry) => fubonPositivePageNumber(entry.value))
          .filter((value): value is number => value !== null),
      ),
    ];
    const providerPageSize = pageSizeValues.length === 1
      ? pageSizeValues[0]!
      : null;
    const providerPager = [
      ...markup.matchAll(/<([a-z][\w:-]*)\b[^>]*>/giu),
    ].some((candidate) => {
      const tagName = candidate[1]?.toLowerCase();
      return (
        tagName !== undefined &&
        /^(?:div|span|nav|ul|ol)$/u.test(tagName) &&
        (fubonHasHtmlClassOrIdToken(candidate[0], "pager") ||
          fubonHasHtmlClassOrIdToken(candidate[0], "pagination")) &&
        fubonPagerBelongsToResultGrid(
          candidate[0],
          fubonHtmlAncestorOpenings(markup, candidate.index ?? 0),
        )
      );
    });
    const controls = controlsInMarkup.map((control) => {
      const markupValue = control.markup;
      const controlOpening =
        markupValue.match(/^<(?:input|select|button|a)\b[^>]*>/iu)?.[0] ?? "";
      const label = [
        fubonStripHtml(markupValue),
        fubonHtmlAttribute(controlOpening, "value"),
        fubonHtmlAttribute(controlOpening, "aria-label"),
        fubonHtmlAttribute(controlOpening, "title"),
      ]
        .map(cleanText)
        .find(Boolean) ?? "";
      return {
        tagName: control.tagName,
        opening: controlOpening,
        text: label,
        onclick: fubonHtmlAttribute(controlOpening, "onclick"),
        ancestorOpenings: control.ancestorOpenings,
      };
    });
    return {
      markup,
      providerResultTable,
      currentPageFieldCount,
      currentPage,
      currentPageFieldNames,
      providerPageSize,
      pageSizeControlPresent: pageSizeFieldEntries.length > 0,
      providerPager,
      controls,
    };
  }
  return null;
}

type FubonDepositPaginationAction = {
  targetPage: number;
  pageFieldName: string;
};

function fubonParsePaginationAction(
  control: FubonDepositPaginationContext["controls"][number],
): FubonDepositPaginationAction | null {
  if (!/setDataGridCurrentPage/iu.test(control.onclick)) return null;
  const match = control.onclick.match(
    /setDataGridCurrentPage\s*\(\s*[^,]+,\s*(\d+)\s*,\s*["']([^"']+)["']\s*\)/iu,
  );
  const targetPage = fubonPositivePageNumber(match?.[1] ?? "");
  const pageFieldName = cleanText(match?.[2]);
  if (
    targetPage === null ||
    !isFubonDepositCurrentPageField(pageFieldName)
  )
    return null;
  return { targetPage, pageFieldName };
}

function fubonIsInteractivePaginationControl(
  control: FubonDepositPaginationContext["controls"][number],
): boolean {
  return control.tagName === "a" || control.tagName === "button";
}

function fubonIsDisabledPaginationControl(
  control: FubonDepositPaginationContext["controls"][number],
): boolean {
  return (
    fubonHasHtmlBooleanAttribute(control.opening, "disabled") ||
    fubonHtmlAttribute(control.opening, "aria-disabled").toLowerCase() ===
      "true" ||
    fubonHasHtmlClassToken(control.opening, "disabled")
  );
}

function fubonIsPaginationLabel(text: string): boolean {
  return (
    /^(?:下一頁|下頁|上一頁|上頁|第一頁|最後一頁|末頁)$/u.test(text) ||
    /^(?:第\s*)?\d+(?:\s*頁)?$/iu.test(text) ||
    /^page\s*\d+$/iu.test(text)
  );
}

/**
 * Derive a provider pagination signal from the result form. A full terminal
 * page is trusted only for the known Fubon result-table shape with either a
 * current-page proof or an exact page-size proof and no active or ambiguous
 * forward control. Missing controls in an unrecognized result remain
 * ambiguous and fail closed.
 */
export function parseFubonDepositPaginationSignal(
  html: string,
  rowCount: number,
): FubonDepositPaginationSignal {
  const context = fubonDepositPaginationContext(html);
  const ambiguousTerminalSignal = (
    reason: FubonDepositPaginationAmbiguityReason,
    providerPageSize?: number,
  ): FubonDepositPaginationSignal => ({
    nextPage: null,
    pageFieldName: null,
    // `terminal` describes the retained response sequence: no traversable
    // next page was parsed. Provider completeness is a separate claim and is
    // deliberately withheld when the pager is ambiguous.
    terminal: true,
    evidence: null,
    paginationAmbiguous: true,
    paginationAmbiguityReason: reason,
    ...(providerPageSize !== undefined ? { providerPageSize } : {}),
  });
  if (!context) return ambiguousTerminalSignal("result-context-missing");
  const actionBelongsToResult = (action: FubonDepositPaginationAction) =>
    context.currentPageFieldNames.length === 0
      ? /(?:^|[:_-])resultGrid(?:$|[:_-])/iu.test(action.pageFieldName)
      : context.currentPageFieldNames.includes(action.pageFieldName);
  const isResultAttributableControl = (
    control: FubonDepositPaginationContext["controls"][number],
  ): boolean => {
    const action = fubonParsePaginationAction(control);
    if (action !== null) return actionBelongsToResult(action);
    return fubonControlBelongsToResultGrid(control);
  };
  const paginationControls = context.controls.filter(
    (control) =>
      fubonIsInteractivePaginationControl(control) &&
      isResultAttributableControl(control),
  );
  const nextControls = paginationControls.filter((control) =>
    /^(?:下一頁|下頁)$/u.test(control.text),
  );
  const parsedActions = context.controls
    .filter((control) => /setDataGridCurrentPage/iu.test(control.onclick))
    .map((control) => ({
      control,
      action: fubonParsePaginationAction(control),
    }))
    .filter(({ control, action }) =>
      action !== null
        ? actionBelongsToResult(action)
        : fubonControlBelongsToResultGrid(control),
    );
  const malformedActions = parsedActions.some(
    ({ action }) => action === null,
  );
  const recognizedActions = parsedActions.flatMap(({ control, action }) =>
    action !== null &&
    !fubonIsDisabledPaginationControl(control)
      ? [{ control, action }]
      : [],
  );
  const isDisabledNext = fubonIsDisabledPaginationControl;
  const activeNextControls = nextControls.filter(
    (control) => !isDisabledNext(control),
  );
  const activeNextActions = recognizedActions.filter(
    ({ control }) =>
      activeNextControls.includes(control) &&
      /^(?:下一頁|下頁)$/u.test(control.text),
  );
  const hasAmbiguousPaginationControl = paginationControls.some((control) => {
    if (!fubonIsPaginationLabel(control.text)) return false;
    if (fubonIsDisabledPaginationControl(control)) return false;
    const action = fubonParsePaginationAction(control);
    return action === null;
  });
  const currentPage = context.currentPage;
  const nextAction =
    currentPage !== null
      ? recognizedActions.find(
          ({ action }) => action.targetPage === currentPage + 1,
        )
      : activeNextActions[0];
  const hasUntraversableForwardTarget =
    currentPage !== null &&
    recognizedActions.some(({ action }) => action.targetPage > currentPage) &&
    nextAction === undefined;
  if (
    malformedActions ||
    hasAmbiguousPaginationControl ||
    hasUntraversableForwardTarget
  ) {
    const reason: FubonDepositPaginationAmbiguityReason = malformedActions
      ? "malformed-result-action"
      : hasUntraversableForwardTarget
        ? "forward-target-untraversable"
        : "forward-control-unrecognized";
    return ambiguousTerminalSignal(
      reason,
      context.providerPageSize ?? undefined,
    );
  }
  if (nextAction) {
    if (
      currentPage !== null &&
      nextAction.action.targetPage !== currentPage + 1
    )
      return ambiguousTerminalSignal(
        "forward-target-untraversable",
        context.providerPageSize ?? undefined,
      );
    if (
      currentPage === null &&
      (activeNextControls.length !== 1 || activeNextActions.length !== 1)
    )
      return ambiguousTerminalSignal(
        "current-page-unresolved",
        context.providerPageSize ?? undefined,
      );
    return {
      nextPage: String(nextAction.action.targetPage),
      pageFieldName: nextAction.action.pageFieldName,
      terminal: false,
      evidence: "next-page",
      ...(context.providerPageSize !== null
        ? { providerPageSize: context.providerPageSize }
        : {}),
    };
  }
  if (activeNextControls.length > 0) {
    return ambiguousTerminalSignal(
      "forward-control-unrecognized",
      context.providerPageSize ?? undefined,
    );
  }
  if (currentPage === null && recognizedActions.length > 0)
    return ambiguousTerminalSignal(
      "current-page-unresolved",
      context.providerPageSize ?? undefined,
    );
  const hasDisabledNext =
    nextControls.length > 0 && nextControls.every(isDisabledNext);
  const hasOnlyCurrentOrPreviousTargets =
    currentPage !== null &&
    recognizedActions.length > 0 &&
    recognizedActions.every(({ action }) => action.targetPage <= currentPage);
  const explicitNoNext =
    /data-(?:has-)?next(?:-page)?\s*=\s*["']?(?:false|0|none|empty)["']?/iu.test(
      context.markup,
    );
  const exactFullTerminalPage =
    context.providerResultTable &&
    context.pageSizeControlPresent &&
    context.providerPageSize !== null &&
    context.providerPageSize === rowCount &&
    context.currentPageFieldCount === 0 &&
    nextControls.length === 0 &&
    recognizedActions.length === 0 &&
    !context.providerPager;
  const terminalNoNext =
    context.providerResultTable &&
    context.currentPageFieldCount > 0 &&
    currentPage !== null &&
    rowCount > 0 &&
    (hasDisabledNext ||
      explicitNoNext ||
      hasOnlyCurrentOrPreviousTargets ||
      (nextControls.length === 0 && !context.providerPager));
  if (
    !exactFullTerminalPage &&
    (!terminalNoNext ||
      (context.providerPager &&
        !explicitNoNext &&
        !hasDisabledNext &&
        !hasOnlyCurrentOrPreviousTargets))
  )
    return ambiguousTerminalSignal(
      "terminal-proof-missing",
      context.providerPageSize ?? undefined,
    );
  return {
    nextPage: null,
    pageFieldName: null,
    terminal: true,
    evidence: "terminal-no-next",
    ...(context.providerPageSize !== null
      ? { providerPageSize: context.providerPageSize }
      : {}),
  };
}

function nextTimestamp(): string {
  const timestamp = Date.now();
  lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
  return String(lastTimestamp);
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function addMonthsClamped(date: Date, months: number): Date {
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth() + months;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(targetYear, targetMonth, Math.min(date.getDate(), lastDay));
}

function depositDateRangeFields(
  dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
): Record<string, string> {
  const today = new Date();
  const endDate = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const dayOffsets: Partial<
    Record<z.infer<typeof fubonStatementDateRangeSchema>, number>
  > = {
    "1": 0,
    "3": 2,
    "7": 6,
    "14": 13,
    "21": 20,
  };
  const monthOffsets: Partial<
    Record<z.infer<typeof fubonStatementDateRangeSchema>, number>
  > = {
    "30": 1,
    "60": 2,
    "90": 3,
    "180": 6,
  };

  if (dateRange === "180_365") {
    return {
      "form1:rdoGroup3": dateRange,
      "form1:startDate": formatDate(addMonthsClamped(endDate, -12)),
      "form1:endDate": formatDate(addMonthsClamped(endDate, -6)),
      "resultGrid:dataGridCurrentPage": "1",
    };
  }

  const dayOffset = dayOffsets[dateRange];
  const monthOffset = monthOffsets[dateRange];
  const startDate =
    dayOffset !== undefined
      ? addDays(endDate, -dayOffset)
      : addMonthsClamped(endDate, -(monthOffset ?? 0));

  return {
    "form1:rdoGroup3": dateRange,
    "form1:startDate": formatDate(startDate),
    "form1:endDate": formatDate(endDate),
    "resultGrid:dataGridCurrentPage": "1",
  };
}

function branchNameFromAccount(account: string): string {
  return cleanText(account.match(/\(([^()]+)\)\s*$/)?.[1]);
}

function accountIdFor(account: string, fallback: string): string {
  const accountPrefix = account.split(/[（(]/)[0] ?? account;
  const fallbackPrefix = fallback.split(/[（(]/)[0] ?? fallback;
  return (
    digitsOnly(accountPrefix) ||
    digitsOnly(fallbackPrefix) ||
    safeAccountKeyFallback(fallback)
  );
}

async function waitForFrame(
  page: Page,
  name: string,
  timeoutMs = 60_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frame({ name });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for frame "${name}".`);
}

function depositRows(scope: BrowserScope): Locator {
  return scope.locator("tr").filter({
    has: scope.locator("a.btn_sel").filter({ hasText: "交易明細查詢" }),
  });
}

async function countDepositRows(scope: BrowserScope): Promise<number> {
  await scope
    .locator("a.btn_sel")
    .filter({ hasText: "交易明細查詢" })
    .first()
    .waitFor({
      state: "attached",
      timeout: 60_000,
    });
  return await depositRows(scope).count();
}

async function readMaskedAccountLabel(row: Locator): Promise<string> {
  const raw = await row
    .locator("td")
    .first()
    .innerText()
    .catch(async () => await row.innerText());
  return maskAccount(raw);
}

function isFubonDepositAccountPlaceholder(
  account: FubonDepositAccountOption,
): boolean {
  const value = cleanText(account.value).toLowerCase();
  const label = cleanText(account.label).toLowerCase();
  if (!value || !label) return true;
  if (["none", "null", "undefined", "-1"].includes(value)) return true;
  return /^(?:請|请选择)?選擇(?:帳戶|賬戶)?$/.test(label);
}

export async function readFubonDepositAccountOptions(
  page: Page,
): Promise<FubonDepositAccountOption[]> {
  const scope = await findScopeWithSelector(page, depositAccountSelectSelector);
  const options = scope.locator(`${depositAccountSelectSelector} option`);
  const count = await options.count();
  const accounts: FubonDepositAccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = cleanText(await option.getAttribute("value"));
    const label = cleanText(await option.textContent());
    if (value && label) accounts.push({ label, value });
  }

  const validAccounts = accounts.filter(
    (account) => !isFubonDepositAccountPlaceholder(account),
  );
  if (validAccounts.length === 0) {
    throw new StatementComponentAbsentError(
      "No Fubon deposit account is available for this login.",
    );
  }

  return validAccounts;
}

async function selectDepositAccount(
  page: Page,
  account: FubonDepositAccountOption,
): Promise<void> {
  const scope = await findScopeWithSelector(page, depositAccountSelectSelector);
  await selectOptionWithoutPointer(
    scope.locator(depositAccountSelectSelector),
    account.value,
  );
}

async function selectDepositAccountWithUi(
  page: Page,
  account: FubonDepositAccountOption,
): Promise<void> {
  const scope = await findScopeWithSelector(page, depositAccountSelectSelector);
  await scope.locator(depositAccountSelectSelector).selectOption(account.value);
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      (await page
        .locator(selector)
        .count()
        .catch(() => 0)) > 0
    ) {
      return page;
    }

    for (const frame of page.frames()) {
      if (
        (await frame
          .locator(selector)
          .count()
          .catch(() => 0)) > 0
      ) {
        return frame;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for selector ${selector}.`);
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
      if (
        (await locatorFor(scope)
          .count()
          .catch(() => 0)) > 0
      ) {
        return scope;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find ${description} in any frame.`);
}

function depositResultTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "帳務日期" })
    .filter({ hasText: "交易時間" })
    .filter({ hasText: "即時餘額" })
    .first();
}

async function clickFirstLinkByText(
  page: Page,
  text: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const link = scope.locator("a").filter({ hasText: text }).first();
      if ((await link.count().catch(() => 0)) > 0) {
        const href = await link.getAttribute("href");
        if (href && href !== "#" && !href.startsWith("javascript:")) {
          await scope.goto(new URL(href, BANK_ENTRY_URL).toString(), {
            waitUntil: "domcontentloaded",
          });
        } else {
          await activateControlWithoutPointer(link);
        }
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find link with text "${text}".`);
}

async function openMyDepositsPage(page: Page): Promise<BrowserScope> {
  const existing = await findScopeWithSelector(
    page,
    "a.input_sel.fastFunctionLinks",
    15_000,
  ).catch(() => null);
  if (existing) return existing;

  await clickFirstLinkByText(page, "我的存款");
  return await findScopeWithSelector(page, "a.input_sel.fastFunctionLinks");
}

async function openTransactionDetailForAccountIndex(
  page: Page,
  accountIndex: number,
): Promise<string> {
  const scope = await openMyDepositsPage(page);

  const rowCount = await countDepositRows(scope);
  if (accountIndex >= rowCount) {
    throw new Error(
      `Deposit account index ${accountIndex} is out of range; only ${rowCount} account rows are visible.`,
    );
  }

  const accountRow = depositRows(scope).nth(accountIndex);
  const maskedAccount = await readMaskedAccountLabel(accountRow);
  const fastFunctionLink = accountRow.locator("a.input_sel.fastFunctionLinks");
  if ((await fastFunctionLink.count()) > 0) {
    await activateControlWithoutPointer(fastFunctionLink).catch(
      () => undefined,
    );
  }

  const transactionDetails = accountRow
    .locator("a.btn_sel")
    .filter({ hasText: "交易明細查詢" });
  await transactionDetails.waitFor({ state: "attached", timeout: 30_000 });
  await activateControlWithoutPointer(transactionDetails);

  return maskedAccount;
}

async function parseDepositStatementHtml(
  page: Page,
  html: string,
  pageOrdinal = 0,
  responseSequence = pageOrdinal + 1,
): Promise<ParsedDepositStatementPage> {
  const parsed = (await page.evaluate(
    ({ html: sourceHtml, headers }) => {
      const clean = (value: string | null | undefined) =>
        (value ?? "")
          .replace(/[\u00a0\u3000]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const cellsFor = (row: Element) =>
        Array.from(row.querySelectorAll("th,td")).map((cell) =>
          clean(cell.textContent),
        );
      const doc = new DOMParser().parseFromString(sourceHtml, "text/html");
      const tables = Array.from(doc.querySelectorAll("table"));
      const tableRows = tables
        .map((table) =>
          Array.from(table.querySelectorAll("tr")).map((row) => cellsFor(row)),
        )
        .find((rows) =>
          rows.some((row) =>
            headers.every((header, index) =>
              clean(row[index]).includes(header),
            ),
          ),
        );
      if (!tableRows) {
        throw new Error("Deposit query response is missing the result table.");
      }

      const headerRowIndex = tableRows.findIndex((row) =>
        headers.every((header, index) => clean(row[index]).includes(header)),
      );
      const rows = tableRows
        .slice(headerRowIndex + 1)
        .map((row) => headers.map((_, index) => clean(row[index])))
        .filter((row) => /^\d{4}\/\d{2}\/\d{2}$/.test(row[0]));
      const startDate = clean(
        (doc.getElementById("form1:startDate") as HTMLInputElement | null)
          ?.value,
      );
      const endDate = clean(
        (doc.getElementById("form1:endDate") as HTMLInputElement | null)?.value,
      );
      const nextLink = Array.from(doc.querySelectorAll("a")).find(
        (link) =>
          clean(link.textContent) === "下一頁" &&
          /setDataGridCurrentPage/.test(link.getAttribute("onclick") ?? ""),
      );
      const nextMatch = (nextLink?.getAttribute("onclick") ?? "").match(
        /setDataGridCurrentPage\([^,]+,\s*(\d+),\s*['"]([^'"]+)['"]/,
      );
      const selectedAccountValue =
        Array.from(
          sourceHtml.matchAll(
            /setupComboBox\("form1:comboAccount",\s*"[^"]*",\s*"([^"]+)"/g,
          ),
        )
          .map((match) => clean(match[1]))
          .filter(Boolean)
          .at(-1) ?? "";
      const accountItems = Array.from(
        sourceHtml.matchAll(
          /comboAccountItems\[\d+\]\s*=\s*new Array\("([^"]*)",\s*"([^"]*)"/g,
        ),
      ).map((match) => ({
        label: clean(match[1]),
        value: clean(match[2]),
      }));
      const selectedAccount = accountItems.find(
        (item) => item.value === selectedAccountValue,
      );
      const account = selectedAccount?.label ?? "";
      const accountId = clean(account.split(/[（(]/)[0]);
      const branchName = clean(account.match(/[（(]([^()（）]+)[）)]/)?.[1]);

      return {
        account,
        accountId,
        branchName,
        selectedAccountValue,
        selectedAccountLabel: account,
        nextPage: nextMatch?.[1] ?? null,
        pageFieldName: nextMatch?.[2] ?? null,
        queryPeriod: startDate && endDate ? `${startDate}~${endDate}` : "",
        startDate,
        endDate,
        rows,
      };
    },
    { html, headers: depositHeaders },
  )) as ParsedDepositStatementPage;

  const responseMetadata = inspectFubonDepositResponseMetadata(html);
  const metadataPageSize = responseMetadata.pagination.find((entry) =>
    /(?:pageSize|currentPageSize)/i.test(entry.name),
  )?.value;
  const providerTotalCount = responseMetadata.pagination.find((entry) =>
    isFubonProviderTotalCountFieldName(entry.name),
  )?.value;
  const pagination = parseFubonDepositPaginationSignal(html, parsed.rows.length);
  return {
    ...parsed,
    nextPage: pagination.nextPage,
    pageFieldName: pagination.pageFieldName,
    terminal: pagination.terminal,
    ...(pagination.evidence !== null
      ? { paginationEvidence: pagination.evidence }
      : {}),
    ...(pagination.paginationAmbiguous === true
      ? { paginationAmbiguous: true as const }
      : {}),
    ...(pagination.paginationAmbiguityReason !== undefined
      ? { paginationAmbiguityReason: pagination.paginationAmbiguityReason }
      : {}),
    responseMetadata,
    bodyLength: Buffer.byteLength(html, "utf8"),
    bodySha256: digestTelemetryValue(html),
    pageOrdinal,
    responseSequence,
    evidenceRows: parsed.rows.map((cells, rowOrdinal) => ({
      rowOrdinal,
      cells: [...cells] as unknown as FubonDepositStatementRowEvidence["cells"],
    })),
    ...(metadataPageSize && metadataPageSize > 0
      ? { providerPageSize: metadataPageSize }
      : pagination.providerPageSize !== undefined
        ? { providerPageSize: pagination.providerPageSize }
        : {}),
    ...(providerTotalCount !== null && providerTotalCount !== undefined
      ? { providerTotalCount }
      : {}),
  };
}

/** Public parser seam used by de-identified workflow evidence checks. */
export async function parseFubonDepositStatementHtml(
  page: Page,
  html: string,
  pageOrdinal = 0,
  responseSequence = pageOrdinal + 1,
): Promise<FubonDepositStatementPageEvidence> {
  const parsed = await parseDepositStatementHtml(
    page,
    html,
    pageOrdinal,
    responseSequence,
  );
  return {
    pageOrdinal: parsed.pageOrdinal,
    responseSequence: parsed.responseSequence,
    terminal: parsed.terminal,
    nextPage: parsed.nextPage,
    pageFieldName: parsed.pageFieldName,
    ...(parsed.paginationEvidence !== undefined
      ? { paginationEvidence: parsed.paginationEvidence }
      : {}),
    ...(parsed.paginationAmbiguous === true
      ? { paginationAmbiguous: true as const }
      : {}),
    ...(parsed.paginationAmbiguityReason !== undefined
      ? { paginationAmbiguityReason: parsed.paginationAmbiguityReason }
      : {}),
    queryRange: { startDate: parsed.startDate, endDate: parsed.endDate },
    selectedAccount: {
      value: parsed.selectedAccountValue,
      label: parsed.selectedAccountLabel,
      branchName: parsed.branchName,
    },
    rows: parsed.evidenceRows,
    ...(parsed.providerPageSize !== undefined
      ? { providerPageSize: parsed.providerPageSize }
      : {}),
    ...(parsed.providerTotalCount !== undefined
      ? { providerTotalCount: parsed.providerTotalCount }
      : {}),
    zeroObservation:
      parsed.evidenceRows.length === 0 ? "empty-page" : "non-empty-page",
  };
}

async function fetchDepositStatement(
  page: Page,
  dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
  accountOption: FubonDepositAccountOption,
  sourceText?: SourceTextPort,
): Promise<FubonParsedDepositStatement> {
  const scope = await findScopeWithSelector(
    page,
    'a[id="form1:doValidateAndSubmit"]',
  );
  const dateRangeId = `input[id="form1:rdoDay${dateRange}"]`;
  await activateControlWithoutPointer(scope.locator(dateRangeId));
  await page.waitForTimeout(500);

  const html = await fetchFormPostbackHtml(
    scope.locator("form").first(),
    "form1:doValidateAndSubmit",
    depositDateRangeFields(dateRange),
  );
  sourceText?.assertIntact(html);
  const pages = [await parseDepositStatementHtml(page, html, 0, 1)];
  await replaceDocumentHtml(scope, html);

  let nextPage = pages[0].nextPage;
  let pageFieldName = pages[0].pageFieldName;
  const traversalRequests = new Set<string>();
  while (nextPage && pageFieldName) {
    const traversalKey = `${pageFieldName}\u0000${nextPage}`;
    if (traversalRequests.has(traversalKey))
      throw new Error("Fubon deposit pagination repeated a page request.");
    traversalRequests.add(traversalKey);
    if (pages.length >= 10_000)
      throw new Error("Fubon deposit pagination exceeded the safe page limit.");
    const nextHtml = await fetchFormPostbackHtml(
      scope.locator("form").first(),
      undefined,
      { [pageFieldName]: nextPage },
    );
    sourceText?.assertIntact(nextHtml);
    const nextParsed = await parseDepositStatementHtml(
      page,
      nextHtml,
      pages.length,
      pages.length + 1,
    );
    pages.push(nextParsed);
    await replaceDocumentHtml(scope, nextHtml);
    nextPage = nextParsed.nextPage;
    pageFieldName = nextParsed.pageFieldName;
  }

  await findScopeWithLocator(
    page,
    depositResultTable,
    "deposit statement result table",
  );

  return assembleFubonParsedDepositStatement(pages, accountOption);
}

function assembleFubonParsedDepositStatement(
  pages: ParsedDepositStatementPage[],
  accountOption: FubonDepositAccountOption,
): FubonParsedDepositStatement {
  const firstPage = pages[0];
  if (!firstPage) {
    throw new Error("Fubon deposit query returned no response page.");
  }
  const accountNumber =
    deriveFubonDomesticDepositAccountNumberEvidence(accountOption);
  return {
    account: firstPage.account || accountOption.label,
    accountId:
      firstPage.accountId ||
      accountIdFor(
        firstPage.account || accountOption.label,
        accountOption.label,
      ),
    queryPeriod: firstPage.queryPeriod,
    branchName:
      firstPage.branchName ||
      branchNameFromAccount(firstPage.account || accountOption.label),
    rows: pages.flatMap((statementPage) => statementPage.rows),
    pages: pages.map((statementPage) => ({
      ...statementPage,
      queryRange: {
        startDate: statementPage.startDate,
        endDate: statementPage.endDate,
      },
      selectedAccount: {
        value: statementPage.selectedAccountValue || accountOption.value,
        label: statementPage.selectedAccountLabel || accountOption.label,
        branchName:
          statementPage.branchName ||
          branchNameFromAccount(
            statementPage.selectedAccountLabel || accountOption.label,
          ),
      },
      rows: statementPage.evidenceRows,
      zeroObservation:
        statementPage.evidenceRows.length === 0
          ? "empty-page"
          : "non-empty-page",
    })),
    accountOption: {
      value: accountOption.value,
      label: accountOption.label,
      branchName:
        firstPage.branchName || branchNameFromAccount(accountOption.label),
      ...(accountNumber ? { accountNumber } : {}),
    },
  };
}

function isFubonDepositQueryResponse(response: Response): boolean {
  try {
    const postData = response.request().postData() ?? "";
    return (
      response.request().method().toUpperCase() === "POST" &&
      new URL(response.url()).pathname === depositQueryPath &&
      (postData.includes("doValidateAndSubmit") ||
        postData.includes("dataGridCurrentPage"))
    );
  } catch {
    return false;
  }
}

async function clickFubonDepositQueryAndReadHtml(
  page: Page,
  scope: BrowserScope,
): Promise<string> {
  const submit = scope.locator('a[id="form1:doValidateAndSubmit"]');
  await submit.waitFor({ state: "visible", timeout: 30_000 });
  const [response] = await Promise.all([
    page.waitForResponse(isFubonDepositQueryResponse, { timeout: 60_000 }),
    submit.click({ timeout: 30_000 }),
  ]);
  await response.finished();
  return await response.text();
}

async function findFubonDepositNextPage(
  page: Page,
): Promise<{ scope: BrowserScope; link: Locator } | null> {
  for (const scope of [page, ...page.frames()]) {
    const link = scope.locator("a").filter({ hasText: "下一頁" }).first();
    if ((await link.count().catch(() => 0)) > 0) return { scope, link };
  }
  return null;
}

/**
 * Telemetry-only query path. It submits the visible form through Playwright
 * and reads the matching response transiently for structural metadata. It
 * deliberately does not use fetchFormPostbackHtml or replaceDocumentHtml;
 * the bank owns the resulting document lifecycle.
 */
export type FubonDepositUiQueryDependencies = {
  accountAlreadySelected?: boolean;
  parsePage?: (
    page: Page,
    html: string,
    pageOrdinal: number,
    responseSequence: number,
  ) => Promise<ParsedDepositStatementPage>;
};

export async function fetchFubonDepositStatementViaUi(
  page: Page,
  dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
  accountOption: FubonDepositAccountOption,
  dependencies: FubonDepositUiQueryDependencies = {},
): Promise<FubonParsedDepositStatement> {
  const parsePage = dependencies.parsePage ?? parseDepositStatementHtml;
  let scope = await findScopeWithSelector(
    page,
    'a[id="form1:doValidateAndSubmit"]',
  );
  if (!dependencies.accountAlreadySelected) {
    await selectDepositAccountWithUi(page, accountOption);
  }
  const dateRangeId = `input[id="form1:rdoDay${dateRange}"]`;
  await scope.locator(dateRangeId).click({ timeout: 30_000 });
  await page.waitForTimeout(500);

  const pages: ParsedDepositStatementPage[] = [];
  const visited = new Set<string>();
  let nextLink: Locator | null = null;
  while (true) {
    let html: string;
    if (nextLink) {
      const [response] = await Promise.all([
        page.waitForResponse(isFubonDepositQueryResponse, { timeout: 60_000 }),
        nextLink.click({ timeout: 30_000 }),
      ]);
      await response.finished();
      html = await response.text();
      nextLink = null;
    } else {
      html = await clickFubonDepositQueryAndReadHtml(page, scope);
    }
    const parsed = await parsePage(page, html, pages.length, pages.length + 1);
    pages.push(parsed);

    const next = await findFubonDepositNextPage(page);
    if (!next || !parsed.nextPage || !parsed.pageFieldName) break;
    const traversalKey = `${parsed.pageFieldName}\u0000${parsed.nextPage}`;
    if (visited.has(traversalKey)) {
      throw new Error("Fubon deposit pagination repeated a page request.");
    }
    visited.add(traversalKey);
    if (pages.length >= 10_000) {
      throw new Error("Fubon deposit pagination exceeded the safe page limit.");
    }
    scope = next.scope;
    nextLink = next.link;
  }

  await findScopeWithLocator(
    page,
    depositResultTable,
    "deposit statement result table",
  );
  return assembleFubonParsedDepositStatement(pages, accountOption);
}

function unionStrings(values: readonly string[][]): string[] {
  return [...new Set(values.flat())].sort();
}

function unionFields(
  values: ReadonlyArray<ReadonlyArray<{ name: string; type: string }>>,
): Array<{ name: string; type: string }> {
  const byName = new Map<string, { name: string; type: string }>();
  for (const fields of values) {
    for (const field of fields) byName.set(field.name, field);
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameFields(
  left: ReadonlyArray<{ name: string; type: string }>,
  right: ReadonlyArray<{ name: string; type: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (field, index) =>
        field.name === right[index]?.name && field.type === right[index]?.type,
    )
  );
}

async function readFubonDepositFormMetadata(page: Page): Promise<{
  fieldNames: string[];
  fields: Array<{ name: string; type: string }>;
}> {
  const scope = await findScopeWithSelector(
    page,
    'a[id="form1:doValidateAndSubmit"]',
    5_000,
  ).catch(() => null);
  if (!scope) return { fieldNames: [], fields: [] };
  const controls = scope.locator("input,select,textarea");
  const count = await controls.count().catch(() => 0);
  const fields = new Map<string, { name: string; type: string }>();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const rawName =
      (await control.getAttribute("name").catch(() => null)) ??
      (await control.getAttribute("id").catch(() => null));
    const name = rawName ? safeTelemetryFieldName(rawName) : null;
    if (!name) continue;
    const type =
      (await control.getAttribute("type").catch(() => null)) ?? "control";
    fields.set(name, { name, type: cleanText(type).toLowerCase() });
  }
  return {
    fieldNames: [...fields.keys()].sort(),
    fields: [...fields.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

function buildFubonDepositTelemetryRecord(
  queryId: "A1" | "A2" | "B",
  rangeCode: z.infer<typeof fubonStatementDateRangeSchema>,
  statement: FubonParsedDepositStatement,
  responses: readonly FubonDepositResponseObservation[],
  form: { fieldNames: string[]; fields: Array<{ name: string; type: string }> },
): FubonDepositTelemetryOutput["records"][number] {
  const pages = statement.pages;
  const metadata = pages.map(
    (page) =>
      page.responseMetadata ?? {
        fieldNames: [],
        fields: [],
        candidateProviderKeyNames: [],
        candidateProviderKeyDigests: [],
        statusFieldNames: [],
        correctionFieldNames: [],
        transactionTimeFieldNames: [],
        accountScopeFieldNames: [],
        pagination: [],
      },
  );
  const response = responses.filter((item) => item.method === "POST").at(-1);
  const bodyLengths = pages.map((page) => page.bodyLength ?? 0);
  const bodyHashes = pages.map(
    (page) => page.bodySha256 ?? digestTelemetryValue(""),
  );
  const bodyHash =
    bodyHashes.length === 1
      ? bodyHashes[0]!
      : digestTelemetryValue(bodyHashes.join("\n"));
  const firstPage = pages[0];
  const queryScope = {
    rangeCode,
    startDate: firstPage?.queryRange.startDate ?? "",
    endDate: firstPage?.queryRange.endDate ?? "",
    explicitZeroProbe: queryId === "B",
  };
  const responseMetadata: FubonDepositResponseMetadata = {
    fieldNames: unionStrings(metadata.map((item) => item.fieldNames)),
    fields: unionFields(metadata.map((item) => item.fields)),
    candidateProviderKeyNames: unionStrings(
      metadata.map((item) => item.candidateProviderKeyNames),
    ),
    candidateProviderKeyDigests: unionStrings(
      metadata.map((item) => item.candidateProviderKeyDigests),
    ) as `sha256:${string}`[],
    statusFieldNames: unionStrings(
      metadata.map((item) => item.statusFieldNames),
    ),
    correctionFieldNames: unionStrings(
      metadata.map((item) => item.correctionFieldNames),
    ),
    transactionTimeFieldNames: unionStrings(
      metadata.map((item) => item.transactionTimeFieldNames),
    ),
    accountScopeFieldNames: unionStrings(
      metadata.map((item) => item.accountScopeFieldNames),
    ),
    pagination: [
      ...new Map(
        metadata.flatMap((item) =>
          item.pagination.map((entry) => [entry.name, entry] as const),
        ),
      ).values(),
    ].sort((left, right) => left.name.localeCompare(right.name)),
  };
  const fieldNames = unionStrings([
    form.fieldNames,
    responseMetadata.fieldNames,
  ]);
  const fields = unionFields([form.fields, responseMetadata.fields]);
  return {
    telemetryVersion: FUBON_DEPOSIT_TELEMETRY_VERSION,
    queryId,
    queryScope,
    endpoint: {
      path: response?.path ?? null,
      method: response?.method ?? null,
      status: response?.status ?? null,
      contentType: response?.contentType ?? null,
      bodyLength: bodyLengths.reduce((sum, length) => sum + length, 0),
      bodySha256: bodyHash,
      requestHeaderNames: response?.requestHeaderNames ?? [],
      responseHeaderNames: response?.responseHeaderNames ?? [],
    },
    form: { fieldNames, fields },
    response: responseMetadata,
    observed: {
      pageCount: pages.length,
      rowCount: statement.rows.length,
      zeroResult:
        pages.length > 0 &&
        pages.every((page) => page.zeroObservation === "empty-page"),
      terminalPage: pages.at(-1)?.terminal ?? false,
    },
  };
}

function compareFubonDepositTelemetry(
  first: FubonDepositTelemetryOutput["records"][number] | undefined,
  second: FubonDepositTelemetryOutput["records"][number] | undefined,
): FubonDepositTelemetryOutput["comparison"] {
  if (!first || !second) {
    return {
      repeatStability: "not-observed",
      fieldShapeEqual: false,
      paginationShapeEqual: false,
      candidateKeyNameIntersection: [],
      candidateKeyDigestIntersection: [],
    };
  }
  const candidateKeyNameIntersection =
    first.response.candidateProviderKeyNames.filter((name) =>
      second.response.candidateProviderKeyNames.includes(name),
    );
  const candidateKeyDigestIntersection =
    first.response.candidateProviderKeyDigests.filter((digest) =>
      second.response.candidateProviderKeyDigests.includes(digest),
    );
  const fieldShapeEqual = sameFields(
    first.response.fields,
    second.response.fields,
  );
  const paginationShapeEqual = sameStrings(
    first.response.pagination.map((entry) => entry.name),
    second.response.pagination.map((entry) => entry.name),
  );
  const stable =
    fieldShapeEqual &&
    paginationShapeEqual &&
    sameStrings(
      first.response.candidateProviderKeyNames,
      second.response.candidateProviderKeyNames,
    );
  return {
    repeatStability: stable ? "observed-stable" : "observed-drift",
    fieldShapeEqual,
    paginationShapeEqual,
    candidateKeyNameIntersection,
    candidateKeyDigestIntersection,
  };
}

export type FubonDepositTelemetryRunDependencies = Pick<
  FubonStatementsRunDependencies,
  | "openTransactionDetailForAccountIndex"
  | "readDepositAccountOptions"
  | "selectDepositAccount"
  | "fetchDepositStatement"
>;

/**
 * Runs two identical bounded observations and one explicit zero-range probe.
 * It has no writer or canonical-store dependency by design.
 */
export async function captureFubonDepositTelemetry(
  page: Page,
  input: FubonDepositTelemetryInput,
  overrides: FubonDepositTelemetryRunDependencies = {},
): Promise<FubonDepositTelemetryOutput> {
  const openTransactionDetail =
    overrides.openTransactionDetailForAccountIndex ??
    openTransactionDetailForAccountIndex;
  const readAccounts =
    overrides.readDepositAccountOptions ?? readFubonDepositAccountOptions;
  const selectAccount =
    overrides.selectDepositAccount ?? selectDepositAccountWithUi;
  const fetchStatement =
    overrides.fetchDepositStatement ??
    ((currentPage, range, account) =>
      fetchFubonDepositStatementViaUi(currentPage, range, account, {
        accountAlreadySelected: true,
      }));
  const tracker = new FubonDepositResponseTracker(page);
  try {
    await openTransactionDetail(page, 0);
    const accounts = await readAccounts(page);
    const account = accounts[0];
    if (!account)
      throw new StatementComponentAbsentError(
        "No Fubon deposit account is available for this login.",
      );

    const records: FubonDepositTelemetryOutput["records"] = [];
    const runQuery = async (
      queryId: "A1" | "A2" | "B",
      rangeCode: z.infer<typeof fubonStatementDateRangeSchema>,
    ) => {
      await selectAccount(page, account);
      const formBefore = await readFubonDepositFormMetadata(page);
      const responseSnapshot = tracker.snapshot();
      const statement = await fetchStatement(page, rangeCode, account);
      const formAfter = await readFubonDepositFormMetadata(page);
      const form = formAfter.fields.length > 0 ? formAfter : formBefore;
      records.push(
        buildFubonDepositTelemetryRecord(
          queryId,
          rangeCode,
          statement,
          tracker.since(responseSnapshot),
          form,
        ),
      );
    };

    await runQuery("A1", input.repeatDateRange);
    await runQuery("A2", input.repeatDateRange);
    await runQuery("B", input.zeroDateRange);

    const first = records.find((record) => record.queryId === "A1");
    const second = records.find((record) => record.queryId === "A2");
    const zero = records.find((record) => record.queryId === "B");
    const zeroResultAuthority = zero?.observed.zeroResult
      ? zero.response.statusFieldNames.includes("provider-no-data-message")
        ? "provider-explicit-no-data"
        : "empty-result-table"
      : "non-empty-observation";
    return fubonDepositTelemetryOutputSchema.parse({
      telemetryVersion: FUBON_DEPOSIT_TELEMETRY_VERSION,
      account: {
        valueDigest: digestTelemetryValue(account.value),
        label: maskAccount(account.label),
        branchName: branchNameFromAccount(account.label),
      },
      records,
      comparison: compareFubonDepositTelemetry(first, second),
      zeroResultAuthority,
    });
  } finally {
    tracker.close();
  }
}

export async function runFubonStatements(
  page: Page,
  input: FubonStatementsInput,
  overrides: FubonStatementsRunDependencies,
): Promise<FubonDepositWorkflowCollection> {
  if (input.downloadFormat !== "EXCEL") {
    throw new Error(
      'fubon-statements normalized output currently supports downloadFormat="EXCEL" only.',
    );
  }
  const { sourceConnectionScope, sourceConnectionKey } =
    requireSourceConnectionIdentity("fubon", "Fubon deposit", overrides);

  const openTransactionDetail =
    overrides.openTransactionDetailForAccountIndex ??
    openTransactionDetailForAccountIndex;
  const readAccounts =
    overrides.readDepositAccountOptions ?? readFubonDepositAccountOptions;
  const selectAccount = overrides.selectDepositAccount ?? selectDepositAccount;
  const fetchStatement =
    overrides.fetchDepositStatement ??
    ((currentPage, dateRange, account) =>
      fetchDepositStatement(currentPage, dateRange, account, overrides.sourceText));
  const readCurrent =
    overrides.readCurrentDepositBalances ?? readFubonCurrentDepositBalances;
  const stableSourceConnectionKey = sourceConnectionKey;
  const stableSourceIdentity = {
    sourceConnectionScope,
    sourceConnectionKey: stableSourceConnectionKey,
  } as const;
  const financialCaptures: ExistingFubonFinancialCapture[] = [];
  const financialDepositCaptures: Array<NonNullable<ReturnType<typeof admitFubonDomesticDepositFinancialCapture>["capture"]>> = [];
  const sourceOnlyEntries: Array<{
    capture:
      | FubonDomesticDepositValidatedEvidence
      | FubonDomesticDepositSourceOnlyEvidence;
    captureId: string;
  }> = [];
  const relationInputs: Array<{
    captureId: string;
    sourceCapture: FubonDomesticDepositValidatedEvidence;
    evidence: TransactionCounterpartyAccountEvidenceInput[];
  }> = [];
  let currentBalanceCaptures: Awaited<ReturnType<typeof admitCurrentDepositBalanceCapture>>[] = [];

  {
    await openTransactionDetail(page, 0);
    const accounts = await readAccounts(page);
    let sourceCount = 0;
    let rowCount = 0;

    for (const account of accounts) {
      overrides.signal?.throwIfAborted();
      await selectAccount(page, account);
      const accountStatements: FubonParsedDepositStatement[] = [];

      for (const dateRange of input.dateRanges) {
        overrides.signal?.throwIfAborted();
        const statement = await fetchStatement(page, dateRange, account);
        overrides.sourceText.assertIntact(JSON.stringify(statement));
        accountStatements.push(statement);
      }
      if (accountStatements.length === 0) {
        throw new Error(
          "Fubon deposit evidence admission blocked: no query pages.",
        );
      }
      sourceCount += accountStatements.length;
      rowCount += accountStatements.reduce((count, statement) => count + statement.rows.length, 0);

      const admittedEvidence = buildFubonDepositStatementEvidence(
        accountStatements,
      ).map((capture) => {
        const admission = admitFubonDomesticDepositCaptureEvidence(capture);
        if (admission.status === "admissible" && admission.capture) {
          return admission.capture;
        }
        const sourceOnly = admitFubonDomesticDepositSourceOnlyEvidence(capture);
        if (sourceOnly.status === "source-only" && sourceOnly.capture) {
          return sourceOnly.capture;
        }
        if (admission.status !== "admissible" || !admission.capture) {
          throw new Error(
            `Fubon deposit evidence admission blocked: ${admission.diagnostics.join(", ")}`,
          );
        }
        return admission.capture;
      });
      for (const [index, capture] of admittedEvidence.entries()) {
        const accountDigest = digestEvidenceValue(account.value).slice(7, 19);
        const sourceCaptureId = `fubon-source-${nextTimestamp()}-${accountDigest}-${index}`;
        if (isSourceOnlyFubonDomesticDepositCaptureEvidence(capture)) {
          sourceOnlyEntries.push({ capture, captureId: sourceCaptureId });
          continue;
        }
        let financialInput = {
          capture,
          captureId: `fubon-financial-${nextTimestamp()}-${accountDigest}-${index}`,
          semantics: buildFubonHumanAttestedFinancialSemantics(
            capture,
            stableSourceConnectionKey,
          ),
          humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
          sourceConnectionScope,
          sourceConnectionKey: stableSourceConnectionKey,
        };
        // Run the semantic classifier before the execution boundary. Malformed
        // amount/time/row/balance data must fail visibly rather than being
        // hidden as source-only.
        let financialAdmission =
          admitFubonDomesticDepositFinancialCapture(financialInput);
        // A status marker describes one row, not the completeness of the
        // requested range. Preserve the complete parser capture as source
        // evidence, then admit the clean rows from the same capture so one
        // ambiguous row cannot hide the account's range.
        if (
          financialAdmission.status !== "admitted" &&
          financialAdmission.diagnostics.length > 0 &&
          financialAdmission.diagnostics.every(
            (diagnostic) => diagnostic === "row-status-unresolved",
          )
        ) {
          const partialInput = {
            ...financialInput,
            allowSourceOnlyRows: true,
          };
          const partialAdmission =
            admitFubonDomesticDepositFinancialCapture(partialInput);
          if (
            partialAdmission.status === "admitted" &&
            partialAdmission.capture &&
            partialAdmission.capture.records.length > 0
          ) {
            financialInput = partialInput;
            financialAdmission = partialAdmission;
          }
        }
        if (financialAdmission.status !== "admitted") {
          const disallowed = financialAdmission.diagnostics.filter(
            (diagnostic) => !isFubonSourceOnlyFinancialDiagnostic(diagnostic),
          );
          if (disallowed.length > 0) {
            throw new Error(
              `Fubon deposit financial admission failed: ${disallowed.join(", ")}`,
            );
          }
          sourceOnlyEntries.push({ capture, captureId: sourceCaptureId });
          continue;
        }
        if (!isFubonHumanAttestedV1Active()) {
          sourceOnlyEntries.push({ capture, captureId: sourceCaptureId });
          continue;
        }
        const financialCapture = financialAdmission.capture;
        if (!financialCapture)
          throw new Error(
            "Fubon domestic deposit admission lost its canonical capture.",
          );
        financialCaptures.push(financialCapture);
        financialDepositCaptures.push(financialCapture);
        relationInputs.push({
          captureId: financialInput.captureId,
          sourceCapture: capture,
          evidence: buildFubonLoanPaymentAccountEvidence(
            capture,
            financialCapture,
          ),
        });
      }
    }

    // Read and validate the point-in-time page before opening the financial
    // commit boundary. A failure here must not leave statement captures from
    // this run behind.
    if (financialCaptures.length > 0) {
      const authority = financialCaptures[0]!.identity;
      const currentRows = await readCurrent(page, {
        observedAt: new Date().toISOString(),
        financialAuthority: {
          sourceConnectionKey: authority.sourceConnectionKey,
          identityEpochKey: authority.identityEpochKey,
          authorityClass: "existing-financial-admission",
        },
      });
      overrides.sourceText.assertIntact(JSON.stringify(currentRows));
      const currentObservedAt = new Date().toISOString();
      const existingByAccountNumber = indexFubonCurrentDepositFinancialCaptures(
        financialCaptures,
      );
      currentBalanceCaptures = currentRows.map((unadjustedRow) => {
        const row = { ...unadjustedRow, observedAt: currentObservedAt };
        const matching = existingByAccountNumber.get(row.accountNumber);
        if (!matching)
          throw new Error(
            "Fubon current deposit snapshot contains an account without existing full account-number evidence.",
          );
        return admitCurrentDepositBalanceCapture(
          buildFubonCurrentDepositBalanceCapture(row, matching),
        );
      });
    }

    overrides.signal.throwIfAborted();
    const items: PGliteWorkflowRunItem[] = [];
    for (const entry of sourceOnlyEntries) items.push({
        provider: "fubon", product: "domestic-deposit", itemKey: entry.captureId,
        command: {
          kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
          request: createFubonDomesticDepositSourceEvidence(entry.capture, entry.captureId, stableSourceIdentity),
        },
    });
    for (const capture of financialDepositCaptures) {
        const relation = relationInputs.find((item) => item.captureId === capture.captureId);
        items.push({
          provider: "fubon", product: "domestic-deposit", itemKey: capture.captureId,
          command: { kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND, request: { capture } },
          ...(relation ? {
            relationCommands: () => [{
              kind: PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
              request: {
                sourceConnectionKey: stableSourceConnectionKey,
                integrationNamespace: "fubon",
                observedAt: capture.observedAt,
                counterpartyEvidence: relation.evidence,
              },
            }],
          } : {}),
        });
    }
    for (const capture of currentBalanceCaptures) items.push({
        provider: "fubon", product: "current-balance",
        itemKey: `current-balance:${capture.identity.sourceAccountKey}`,
        command: {
          kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
          request: currentDepositBalanceCommandRequest(capture),
        },
    });

    for (const item of items)
      overrides.sourceText.assertIntact(JSON.stringify(item.command));
    overrides.deferredCommitItems.push(...items);
    return {
      sourceCount,
      rowCount,
      itemCount: items.length,
      financialAdmissionCount: financialDepositCaptures.length + currentBalanceCaptures.length,
    };
  }
}
