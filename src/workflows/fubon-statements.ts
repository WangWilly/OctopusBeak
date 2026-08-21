import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page, Response } from "playwright";
import { z } from "zod";
import {
  activateControlWithoutPointer,
  selectOptionWithoutPointer,
} from "./browser-interaction.ts";
import { completeFubonHumanLogin, openFubonLoginForm } from "./fubon-auth.ts";
// completeFubonHumanLogin owns emitHumanAssistanceStage with initialZoom: 1.15.
import { fetchFormPostbackHtml, replaceDocumentHtml } from "./form-postback.ts";
import {
  admitFubonDomesticDepositCaptureEvidence,
  admitFubonDomesticDepositSourceOnlyEvidence,
  admitFubonDomesticDepositFinancialCapture,
  commitCanonicalFubonDomesticDepositCapture,
  commitFubonDomesticDepositSourceEvidence,
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
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  isFubonHumanAttestedV1Active,
  isAdmittedFubonDomesticDepositCaptureEvidence,
  isFubonSourceOnlyFinancialDiagnostic,
  isSourceOnlyFubonDomesticDepositCaptureEvidence,
  type FubonDomesticDepositSourceOnlyEvidence,
  type FubonDomesticDepositValidatedEvidence,
} from "../ledger/canonical/fubon-domestic-deposit.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";

const BANK_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";
const depositAccountSelectSelector = 'select[id="form1:comboAccount"]';
const depositQueryPath = "/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces";
export const FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION =
  "capture-evidence-v2" as const;
export const FUBON_DEPOSIT_TELEMETRY_VERSION = "deposit-telemetry-v1" as const;

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

export const fubonStatementsOutputSchema = z.object({
  dateRanges: z.array(fubonStatementDateRangeSchema),
  downloadFormat: z.enum(["TXT", "EXCEL", "PDF"]),
  count: z.number().int().nonnegative(),
  admissions: z.array(
    z.object({
      accountId: z.string(),
      accountValueDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
      status: z.enum(["financial-admitted", "source-only"]),
      reason: z.string().nullable(),
    }),
  ),
  downloads: z.array(
    z.object({
      accountId: z.string(),
      account: z.string(),
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
  evidence: z.array(
    z.object({
      evidenceVersion: z.literal(FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION),
      source: z.literal("fubon"),
      observedAt: z.string(),
      account: z.object({
        valueDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
        label: z.string(),
        branchName: z.string(),
      }),
      queryRange: z.object({ startDate: z.string(), endDate: z.string() }),
      providerRouteEvidence: z
        .object({
          endpointPath: z.string(),
          contract: z.string(),
          currency: z.enum(["TWD", "FX", "unknown"]),
        })
        .optional(),
      pages: z.array(
        z.object({
          pageOrdinal: z.number().int().nonnegative(),
          responseSequence: z.number().int().positive(),
          terminal: z.boolean(),
          nextPage: z.string().nullable(),
          pageFieldName: z.string().nullable(),
          queryRange: z.object({
            startDate: z.string(),
            endDate: z.string(),
          }),
          selectedAccount: z.object({
            valueDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
            label: z.string(),
            branchName: z.string(),
          }),
          providerPageSize: z.number().int().positive().optional(),
          rows: z.array(
            z.object({
              rowOrdinal: z.number().int().nonnegative(),
              cells: z.array(z.string()).length(7),
            }),
          ),
          zeroObservation: z.enum(["empty-page", "non-empty-page"]),
        }),
      ),
      zeroObservation: z.enum(["empty-range", "non-empty-range"]),
      provenance: z.object({
        source: z.literal("fubon-ebank-domestic-deposit-form-postback"),
        responseBodyRetained: z.literal(false),
        semantics: z.literal("unresolved"),
      }),
    }),
  ),
});

export type FubonCredentials = {
  fubon_user_id?: string;
  fubon_account?: string;
  fubon_password?: string;
};

export type FubonStatementsInput = z.infer<typeof fubonStatementsInputSchema>;
export type FubonStatementsOutput = z.infer<typeof fubonStatementsOutputSchema>;
export type FubonDepositTelemetryInput = z.infer<
  typeof fubonDepositTelemetryInputSchema
>;
export type FubonDepositTelemetryOutput = z.infer<
  typeof fubonDepositTelemetryOutputSchema
>;

type Input = FubonStatementsInput & {
  credentials: FubonCredentials;
};

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

export type FubonStatementsRunDependencies = Partial<{
  openTransactionDetailForAccountIndex: (
    page: Page,
    accountIndex: number,
  ) => Promise<string>;
  readDepositAccountOptions: (
    page: Page,
  ) => Promise<FubonDepositAccountOption[]>;
  selectDepositAccount: (
    page: Page,
    account: FubonDepositAccountOption,
  ) => Promise<void>;
  fetchDepositStatement: (
    page: Page,
    dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
    account: FubonDepositAccountOption,
  ) => Promise<FubonParsedDepositStatement>;
  writeDepositStatementFiles: (
    statements: FubonParsedDepositStatement[],
  ) => Promise<FubonStatementsOutput["downloads"][number]>;
  /** Directory containing the shared canonical.sqlite source store. */
  canonicalLedgerDir: string;
  /** Explicit opt-in path for the limited human-attested financial writer. */
  canonicalFinancialLedgerDir: string;
}>;

export type ParsedDepositStatementPage = {
  account: string;
  accountId: string;
  branchName: string;
  queryPeriod: string;
  rows: string[][];
  nextPage: string | null;
  pageFieldName: string | null;
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
};

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
  queryRange: { startDate: string; endDate: string };
  selectedAccount: FubonDepositAccountOptionEvidence;
  /** Provider page-size evidence used to distinguish a short terminal page from a truncated full page. */
  providerPageSize?: number;
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

export type FubonDepositStatementOutputEvidence = {
  evidenceVersion: typeof FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION;
  source: "fubon";
  observedAt: string;
  account: {
    valueDigest: `sha256:${string}`;
    label: string;
    branchName: string;
  };
  queryRange: { startDate: string; endDate: string };
  providerRouteEvidence?: {
    endpointPath: string;
    contract: string;
    currency: "TWD" | "FX" | "unknown";
  };
  pages: Array<{
    pageOrdinal: number;
    responseSequence: number;
    terminal: boolean;
    nextPage: string | null;
    pageFieldName: string | null;
    queryRange: { startDate: string; endDate: string };
    selectedAccount: {
      valueDigest: `sha256:${string}`;
      label: string;
      branchName: string;
    };
    providerPageSize?: number;
    rows: Array<{
      rowOrdinal: number;
      cells: string[];
    }>;
    zeroObservation: "empty-page" | "non-empty-page";
  }>;
  zeroObservation: "empty-range" | "non-empty-range";
  provenance: {
    source: "fubon-ebank-domestic-deposit-form-postback";
    responseBodyRetained: false;
    semantics: "unresolved";
  };
};

function digestEvidenceValue(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function digestTelemetryValue(value: string): `sha256:${string}` {
  return digestEvidenceValue(value);
}

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
    /(?:total|recordCount|totalCount)\s*[=:]\s*["']?(\d+)/gi,
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

export function redactFubonDepositStatementEvidence(
  evidence:
    | FubonDomesticDepositValidatedEvidence
    | FubonDomesticDepositSourceOnlyEvidence,
): FubonDepositStatementOutputEvidence {
  if (
    !isAdmittedFubonDomesticDepositCaptureEvidence(evidence) &&
    !isSourceOnlyFubonDomesticDepositCaptureEvidence(evidence)
  ) {
    throw new Error(
      "Fubon deposit evidence must cross structural admission before redaction.",
    );
  }
  const redactAccount = (account: FubonDepositAccountOptionEvidence) => ({
    valueDigest: digestEvidenceValue(account.value),
    label: maskAccount(account.label),
    branchName: account.branchName,
  });
  return {
    evidenceVersion: evidence.evidenceVersion,
    source: evidence.source,
    observedAt: evidence.observedAt,
    account: redactAccount(evidence.account),
    queryRange: { ...evidence.queryRange },
    ...(evidence.providerRouteEvidence
      ? { providerRouteEvidence: { ...evidence.providerRouteEvidence } }
      : {}),
    pages: evidence.pages.map((page) => ({
      pageOrdinal: page.pageOrdinal,
      responseSequence: page.responseSequence,
      terminal: page.terminal,
      nextPage: page.nextPage,
      pageFieldName: page.pageFieldName,
      queryRange: { ...page.queryRange },
      selectedAccount: redactAccount(page.selectedAccount),
      rows: page.rows.map((row) => ({
        rowOrdinal: row.rowOrdinal,
        cells: [...row.cells],
      })),
      ...(page.providerPageSize !== undefined
        ? { providerPageSize: page.providerPageSize }
        : {}),
      zeroObservation: page.zeroObservation,
    })),
    zeroObservation: evidence.zeroObservation,
    provenance: { ...evidence.provenance },
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
      queryRange: { ...page.queryRange },
      selectedAccount: { ...page.selectedAccount },
      ...(page.providerPageSize !== undefined
        ? { providerPageSize: page.providerPageSize }
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
) {
  const identity = deriveFubonDomesticDepositAccountIdentity(capture.account);
  return {
    evidenceVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    account: {
      accountNo: identity.accountNo,
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

function requireCredential(
  credentials: FubonCredentials,
  name: keyof FubonCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

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

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
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
    safeFilename(fallback)
  );
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function depositRowSortKey(row: string[]): string {
  return cleanText(row[1]) || cleanText(row[0]);
}

function compareDepositRowsByTransactionTimeDesc(
  left: string[],
  right: string[],
): number {
  return depositRowSortKey(right).localeCompare(depositRowSortKey(left));
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

async function openLoginForm(page: Page) {
  await openFubonLoginForm(page);
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
  const providerPageSize = responseMetadata.pagination.find((entry) =>
    /(?:pageSize|currentPageSize)/i.test(entry.name),
  )?.value;
  return {
    ...parsed,
    responseMetadata,
    bodyLength: Buffer.byteLength(html, "utf8"),
    bodySha256: digestTelemetryValue(html),
    pageOrdinal,
    responseSequence,
    terminal: parsed.nextPage === null,
    evidenceRows: parsed.rows.map((cells, rowOrdinal) => ({
      rowOrdinal,
      cells: [...cells] as unknown as FubonDepositStatementRowEvidence["cells"],
    })),
    ...(providerPageSize && providerPageSize > 0 ? { providerPageSize } : {}),
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
    queryRange: { startDate: parsed.startDate, endDate: parsed.endDate },
    selectedAccount: {
      value: parsed.selectedAccountValue,
      label: parsed.selectedAccountLabel,
      branchName: parsed.branchName,
    },
    rows: parsed.evidenceRows,
    zeroObservation:
      parsed.evidenceRows.length === 0 ? "empty-page" : "non-empty-page",
  };
}

async function fetchDepositStatement(
  page: Page,
  dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
  accountOption: FubonDepositAccountOption,
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

async function writeDepositStatementFiles(
  statements: FubonParsedDepositStatement[],
): Promise<FubonStatementsOutput["downloads"][number]> {
  const first = statements[0];
  if (!first) throw new Error("Cannot write an empty deposit statement file.");

  const downloadsDir = join(process.cwd(), "downloads", "fubon-statements");
  await mkdir(downloadsDir, { recursive: true });

  const account = first.account;
  const accountId = first.accountId;
  const publicAccount = maskAccount(account);
  const publicAccountId = maskAccount(accountId);
  const queryPeriods = uniqueValues(
    statements.map((statement) => statement.queryPeriod),
  );
  const branchName = first.branchName;
  const rows = statements
    .flatMap((statement) => statement.rows)
    .sort(compareDepositRowsByTransactionTimeDesc);
  const baseName = `${safeFilename(publicAccountId)}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);

  await writeFile(csvPath, rowsToCsv([depositHeaders, ...rows]), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: publicAccount,
        查詢期間: queryPeriods,
        分行名稱: branchName,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);

  return {
    accountId: publicAccountId,
    account: publicAccount,
    queryPeriods,
    branchName,
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

export async function signInFubon(
  page: Page,
  session: string,
  credentials: FubonCredentials,
): Promise<void> {
  const values = {
    userId: requireCredential(credentials, "fubon_user_id"),
    account: requireCredential(credentials, "fubon_account"),
    password: requireCredential(credentials, "fubon_password"),
  };
  await openLoginForm(page);
  await completeFubonHumanLogin(page, session, values);
}

export async function runFubonStatements(
  page: Page,
  input: FubonStatementsInput,
  overrides: FubonStatementsRunDependencies = {},
): Promise<FubonStatementsOutput> {
  if (input.downloadFormat !== "EXCEL") {
    throw new Error(
      'fubon-statements normalized output currently supports downloadFormat="EXCEL" only.',
    );
  }

  const openTransactionDetail =
    overrides.openTransactionDetailForAccountIndex ??
    openTransactionDetailForAccountIndex;
  const readAccounts =
    overrides.readDepositAccountOptions ?? readFubonDepositAccountOptions;
  const selectAccount = overrides.selectDepositAccount ?? selectDepositAccount;
  const fetchStatement =
    overrides.fetchDepositStatement ?? fetchDepositStatement;
  const writeStatement =
    overrides.writeDepositStatementFiles ?? writeDepositStatementFiles;
  // Source evidence always has a durable default. Financial projection is a
  // separate opt-in boundary: canonicalLedgerDir alone can never enable it.
  const sourceLedgerDir = overrides.canonicalLedgerDir ?? DEFAULT_LEDGER_DIR;
  const sourceDatabasePath = canonicalSqlitePath(sourceLedgerDir);
  const sourceStore = createCanonicalSourceStore(sourceDatabasePath);
  const financialLedgerDir = overrides.canonicalFinancialLedgerDir;
  const financialDatabasePath = financialLedgerDir
    ? canonicalSqlitePath(financialLedgerDir)
    : null;
  const financialStore = financialDatabasePath
    ? financialDatabasePath === sourceDatabasePath
      ? sourceStore
      : createCanonicalSourceStore(financialDatabasePath)
    : null;
  const financialWriter = financialStore
    ? {
        db: financialStore.db,
        databasePath: financialStore.databasePath,
        commitClock: () => financialStore.commitClock(),
      }
    : null;
  const financialUsesSourceStore = financialStore === sourceStore;

  try {
    await openTransactionDetail(page, 0);
    const accounts = await readAccounts(page);
    const preparedAccounts: Array<{
      statements: FubonParsedDepositStatement[];
      evidence: Array<
        | FubonDomesticDepositValidatedEvidence
        | FubonDomesticDepositSourceOnlyEvidence
      >;
      admission: FubonStatementsOutput["admissions"][number];
    }> = [];

    for (const account of accounts) {
      await selectAccount(page, account);
      const accountStatements: FubonParsedDepositStatement[] = [];

      for (const dateRange of input.dateRanges) {
        accountStatements.push(await fetchStatement(page, dateRange, account));
      }
      if (accountStatements.length === 0) {
        throw new Error(
          "Fubon deposit evidence admission blocked: no query pages.",
        );
      }

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
      const admissionReasons = new Set<string>();
      let admissionStatus: FubonStatementsOutput["admissions"][number]["status"] =
        financialWriter && isFubonHumanAttestedV1Active()
          ? "financial-admitted"
          : "source-only";
      if (!financialWriter)
        admissionReasons.add("financial-ledger-not-configured");
      if (financialWriter && !isFubonHumanAttestedV1Active())
        admissionReasons.add("human-attestation-revoked");
      for (const [index, capture] of admittedEvidence.entries()) {
        if (isSourceOnlyFubonDomesticDepositCaptureEvidence(capture)) {
          admissionStatus = "source-only";
          admissionReasons.add("incomplete-scope");
          await commitFubonDomesticDepositSourceEvidence(
            sourceStore,
            capture,
            `fubon-source-${nextTimestamp()}-${digestEvidenceValue(account.value).slice(7, 19)}-${index}`,
          );
          continue;
        }
        const financialInput = {
          capture,
          captureId: `fubon-financial-${nextTimestamp()}-${digestEvidenceValue(account.value).slice(7, 19)}-${index}`,
          semantics: buildFubonHumanAttestedFinancialSemantics(capture),
          humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
        };
        // Run the semantic classifier even when no financial writer was
        // configured.  The explicit-ledger boundary changes the destination,
        // not the error taxonomy: malformed amount/time/row/balance data must
        // still fail visibly rather than being hidden as source-only.
        const financialAdmission =
          admitFubonDomesticDepositFinancialCapture(financialInput);
        if (financialAdmission.status !== "admitted") {
          const disallowed = financialAdmission.diagnostics.filter(
            (diagnostic) => !isFubonSourceOnlyFinancialDiagnostic(diagnostic),
          );
          if (disallowed.length > 0) {
            await commitFubonDomesticDepositSourceEvidence(
              sourceStore,
              capture,
              `fubon-source-${nextTimestamp()}-${digestEvidenceValue(account.value).slice(7, 19)}-${index}`,
            );
            throw new Error(
              `Fubon deposit financial admission failed: ${disallowed.join(", ")}`,
            );
          }
          admissionStatus = "source-only";
          for (const diagnostic of financialAdmission.diagnostics)
            admissionReasons.add(diagnostic);
          await commitFubonDomesticDepositSourceEvidence(
            sourceStore,
            capture,
            `fubon-source-${nextTimestamp()}-${digestEvidenceValue(account.value).slice(7, 19)}-${index}`,
          );
          continue;
        }
        if (!financialWriter || !isFubonHumanAttestedV1Active()) {
          await commitFubonDomesticDepositSourceEvidence(
            sourceStore,
            capture,
            `fubon-source-${nextTimestamp()}-${digestEvidenceValue(account.value).slice(7, 19)}-${index}`,
          );
          continue;
        }
        try {
          // The financial writer owns the same source-evidence spine, so
          // successful admission must not create a duplicate source row.
          await commitCanonicalFubonDomesticDepositCapture(
            financialWriter,
            financialInput,
          );
          if (!financialUsesSourceStore) {
            await commitFubonDomesticDepositSourceEvidence(
              sourceStore,
              capture,
              `fubon-source-${nextTimestamp()}-${digestEvidenceValue(account.value).slice(7, 19)}-${index}`,
            );
          }
        } catch (error) {
          // Preserve a source-only observation when financial admission
          // fails, then propagate the fail-closed error.
          await commitFubonDomesticDepositSourceEvidence(
            sourceStore,
            capture,
            `fubon-source-${nextTimestamp()}-${digestEvidenceValue(account.value).slice(7, 19)}-${index}`,
          );
          throw error;
        }
      }
      preparedAccounts.push({
        statements: accountStatements,
        evidence: admittedEvidence,
        admission: {
          accountId: maskAccount(account.label),
          accountValueDigest: digestEvidenceValue(account.value),
          status: admissionStatus,
          reason:
            admissionReasons.size > 0 ? [...admissionReasons].join(",") : null,
        },
      });
    }

    const downloads: FubonStatementsOutput["downloads"] = [];
    const evidence: FubonDepositStatementOutputEvidence[] = [];
    const admissions: FubonStatementsOutput["admissions"] = [];
    for (const prepared of preparedAccounts) {
      evidence.push(
        ...prepared.evidence.map(redactFubonDepositStatementEvidence),
      );
      // writeDepositStatementFiles is the one public-artifact redaction
      // boundary. Its return value is already masked; do not mask it again.
      downloads.push(await writeStatement(prepared.statements));
      admissions.push(prepared.admission);
    }

    return {
      dateRanges: input.dateRanges,
      downloadFormat: input.downloadFormat,
      count: downloads.length,
      admissions,
      downloads,
      evidence,
    };
  } finally {
    sourceStore?.close();
    if (financialStore && financialStore !== sourceStore)
      financialStore.close();
  }
}

export default workflow("fubonStatements", {
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: fubonStatementsInputSchema,
  output: fubonStatementsOutputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const { page, session } = ctx;

    await signInFubon(page, session, input.credentials);
    const configuredSourceLedgerDir =
      process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
      process.env.LEDGER_DIR ??
      DEFAULT_LEDGER_DIR;
    const explicitFinancialLedgerDir =
      process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR ??
      process.env.OCTOPUSBEAK_CANONICAL_LEDGER_DIR;
    return await runFubonStatements(page, input, {
      // Source evidence remains durable on the normal local ledger. Financial
      // projection is enabled only when the caller explicitly configures a
      // canonical ledger directory; the default path is source-only.
      canonicalLedgerDir: configuredSourceLedgerDir,
      ...(explicitFinancialLedgerDir
        ? { canonicalFinancialLedgerDir: explicitFinancialLedgerDir }
        : {}),
    });
  },
});
