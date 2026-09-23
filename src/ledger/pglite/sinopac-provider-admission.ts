import { createHash } from "node:crypto";
import type {
  CanonicalSourceAccountNumber,
  CanonicalSourceEvidence,
} from "../canonical/canonical-source-evidence.ts";
import type {
  CanonicalFinancialDepositCapture,
  CanonicalFinancialDepositRecord,
} from "../canonical/canonical-financial-deposit-writer.ts";

export const SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "sinopac/domestic-deposit/human-attested-v1" as const;
export const SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;
export const SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY =
  SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE;
export const SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION =
  SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION;

export const SINOPAC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION =
  "capture-evidence-v1" as const;

export const SINOPAC_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE =
  "sinopac/domestic-deposit/capture-evidence-v1" as const;

export const SINOPAC_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND =
  "sinopac-domestic-deposit-capture-evidence-v1" as const;

export const SINOPAC_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION =
  "sinopac/domestic-deposit/capture-evidence-v1/terminal-query" as const;

export const SINOPAC_DOMESTIC_DEPOSIT_IDENTITY_EPOCH =
  "sinopac/domestic-deposit/capture-evidence-v1" as const;

export const SINOPAC_DOMESTIC_DEPOSIT_PROVIDER_GUARANTEED = false as const;

export const SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS =
  "canonical-human-attested" as const;

export const SINOPAC_FOREIGN_DEPOSIT_EVIDENCE_VERSION =
  "capture-evidence-v1" as const;

export const SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_ROUTE =
  "sinopac/foreign-currency/capture-evidence-v1" as const;

export const SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND =
  "sinopac-foreign-currency-capture-evidence-v1" as const;

export const SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION =
  "sinopac/foreign-currency/capture-evidence-v1/terminal-query" as const;

export const SINOPAC_FOREIGN_DEPOSIT_IDENTITY_EPOCH =
  "sinopac/foreign-currency/capture-evidence-v1" as const;

export const SINOPAC_FOREIGN_STATEMENTS_EVIDENCE_VERSION =
  SINOPAC_FOREIGN_DEPOSIT_EVIDENCE_VERSION;

export const SINOPAC_FOREIGN_STATEMENTS_SOURCE_EVIDENCE_ROUTE =
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_ROUTE;

export const SINOPAC_FOREIGN_STATEMENTS_SOURCE_EVIDENCE_RECORD_KIND =
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND;

export const SINOPAC_FOREIGN_STATEMENTS_SOURCE_EVIDENCE_RULE_VERSION =
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION;

export const SINOPAC_FOREIGN_STATEMENTS_IDENTITY_EPOCH =
  SINOPAC_FOREIGN_DEPOSIT_IDENTITY_EPOCH;

export const SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES = [
  "帳務日期",
  "交易日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
  "匯率",
] as const;

export type SinopacSourceRow = {
  rowOrdinal: number;
  values: readonly string[];
};

export type SinopacStatementDownloadEvidence = {
  filename: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
  columnNames: readonly string[];
  rows: readonly SinopacSourceRow[];
  queryPeriods?: readonly string[];
  terminal: boolean;
};

export type SinopacStatementCaptureEvidence = {
  evidenceVersion: typeof SINOPAC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION;
  source: "sinopac";
  product: "domestic-deposit" | "foreign-currency";
  providerGuaranteed: false;
  observedAt: string;
  account: {
    value: string;
    label: string;
    currency: string;
    accountNumber?: SinopacStatementAccountNumberEvidence;
  };
  queryRange: { startDate: string; endDate: string };
  downloads: readonly SinopacStatementDownloadEvidence[];
  zeroResultAuthority?: "provider-explicit-no-data" | "unproven";
  provenance: {
    source: "sinopac-mma-json-statement-query";
    responseBodyRetained: false;
    semantics: "unresolved";
    accountEndpoint: "ws_debitacct.ashx";
    transactionEndpoint: "ws_transdetailMerge.ashx";
  };
};

export const SINOPAC_STATEMENT_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "sinopac/statement/account-number-v1" as const;

export type SinopacStatementAccountNumberEvidence = Readonly<{
  value: string;
  kind: "depository-account";
  evidenceVersion: typeof SINOPAC_STATEMENT_ACCOUNT_NUMBER_EVIDENCE_VERSION;
  sourceField: "ws_debitacct.ashx SubInfo.DataValue";
}>;

export function deriveSinopacStatementAccountNumberEvidence(
  accountValue: string,
): SinopacStatementAccountNumberEvidence | null {
  const value = accountValue.trim().normalize("NFKC");
  if (!/^\d{6,24}$/.test(value)) return null;
  return {
    value,
    kind: "depository-account",
    evidenceVersion: SINOPAC_STATEMENT_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField: "ws_debitacct.ashx SubInfo.DataValue",
  };
}

export type SinopacStatementValidatedCapture =
  SinopacStatementCaptureEvidence & {
    readonly __runtimeValidatedSinopacStatementEvidence: true;
  };

export type SinopacStatementCaptureDiagnostic =
  | "capture-missing"
  | "evidence-version-invalid"
  | "source-invalid"
  | "product-invalid"
  | "observed-at-invalid"
  | "account-invalid"
  | "query-range-invalid"
  | "downloads-missing"
  | "download-shape-invalid"
  | "download-fingerprint-invalid"
  | "download-columns-invalid"
  | "download-terminal-invalid"
  | "row-shape-invalid"
  | "row-order-invalid"
  | "row-width-invalid"
  | "row-cell-invalid"
  | "row-date-invalid"
  | "row-time-invalid"
  | "row-currency-invalid"
  | "row-amount-invalid"
  | "row-amount-conflict"
  | "row-balance-invalid"
  | "zero-result-authority-unproven"
  | "zero-result-authority-mixed"
  | "provenance-invalid";

export type SinopacStatementCaptureValidationResult = {
  status: "admissible" | "rejected";
  capture: SinopacStatementValidatedCapture | null;
  diagnostics: SinopacStatementCaptureDiagnostic[];
};

const VALIDATED_SINOPAC_CAPTURE = new WeakSet<object>();

const SOURCE_DIGEST = /^sha256:[A-Za-z0-9_-]+$/;

function sinopacDigest(
  domain: string,
  ...values: readonly string[]
): `sha256:${string}` {
  const hash = createHash("sha256").update(domain);
  for (const value of values) hash.update("\0").update(value);
  return `sha256:${hash.digest("base64url")}`;
}

function stableSourceJson(value: Record<string, unknown>): string {
  const canonicalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(canonicalize)
      : entry !== null && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, nested]) => [key, canonicalize(nested)]),
          )
        : entry;
  return JSON.stringify(canonicalize(value));
}

function normalizedCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = normalizedCell(value).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) return false;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

function sourceDate(value: string): string {
  const normalized = normalizedCell(value);
  if (/^\d{8}$/.test(normalized)) return normalized;
  if (!validCalendarDate(normalized))
    throw new Error("SinoPac source date is invalid.");
  return normalized.replaceAll("/", "");
}

function validTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = normalizedCell(value).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  return (
    match !== null &&
    Number(match[1]) < 24 &&
    Number(match[2]) < 60 &&
    (match[3] === undefined || Number(match[3]) < 60)
  );
}

function validAmount(value: unknown): boolean {
  const normalized = normalizedCell(value).replace(/,/g, "");
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized);
}

function nonZeroAmount(value: string): boolean {
  return value
    .replace(/,/g, "")
    .replace(".", "")
    .split("")
    .some((d) => d !== "0");
}

function amountDirection(
  values: readonly string[],
): "inflow" | "outflow" | "invalid" {
  const outflow = normalizedCell(values[4]);
  const inflow = normalizedCell(values[5]);
  if ((outflow && !validAmount(outflow)) || (inflow && !validAmount(inflow)))
    return "invalid";
  const hasOutflow = Boolean(outflow) && nonZeroAmount(outflow);
  const hasInflow = Boolean(inflow) && nonZeroAmount(inflow);
  if (hasOutflow === hasInflow) return "invalid";
  if (
    (outflow && !nonZeroAmount(outflow)) ||
    (inflow && !nonZeroAmount(inflow))
  )
    return "invalid";
  return hasOutflow ? "outflow" : "inflow";
}

function dateShape(value: string): "slash-date" | "invalid" {
  return validCalendarDate(value) ? "slash-date" : "invalid";
}

function timeShape(value: string): "local-minute" | "local-second" | "invalid" {
  const normalized = normalizedCell(value);
  if (!validTime(normalized)) return "invalid";
  return normalized.length === 5 ? "local-minute" : "local-second";
}

function diagnostic(
  diagnostics: SinopacStatementCaptureDiagnostic[],
  code: SinopacStatementCaptureDiagnostic,
): void {
  if (!diagnostics.includes(code)) diagnostics.push(code);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const object = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(object)) {
    const child = object[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

export function admitSinopacStatementCaptureEvidence(
  capture: SinopacStatementCaptureEvidence,
): SinopacStatementCaptureValidationResult {
  const diagnostics: SinopacStatementCaptureDiagnostic[] = [];
  if (!capture || typeof capture !== "object") {
    diagnostic(diagnostics, "capture-missing");
    return { status: "rejected", capture: null, diagnostics };
  }
  if (capture.evidenceVersion !== SINOPAC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION)
    diagnostic(diagnostics, "evidence-version-invalid");
  if (capture.source !== "sinopac") diagnostic(diagnostics, "source-invalid");
  if (
    capture.product !== "domestic-deposit" &&
    capture.product !== "foreign-currency"
  )
    diagnostic(diagnostics, "product-invalid");
  if (
    typeof capture.observedAt !== "string" ||
    !Number.isFinite(Date.parse(capture.observedAt))
  )
    diagnostic(diagnostics, "observed-at-invalid");
  if (
    !capture.account ||
    typeof capture.account.value !== "string" ||
    !normalizedCell(capture.account.value) ||
    typeof capture.account.label !== "string" ||
    !normalizedCell(capture.account.label) ||
    typeof capture.account.currency !== "string" ||
    !/^[A-Z]{3}$/.test(normalizedCell(capture.account.currency).toUpperCase())
  )
    diagnostic(diagnostics, "account-invalid");
  const accountNumber = capture.account?.accountNumber;
  if (
    accountNumber !== undefined &&
    (accountNumber === null ||
      typeof accountNumber !== "object" ||
      accountNumber.kind !== "depository-account" ||
      accountNumber.evidenceVersion !==
        SINOPAC_STATEMENT_ACCOUNT_NUMBER_EVIDENCE_VERSION ||
      accountNumber.sourceField !== "ws_debitacct.ashx SubInfo.DataValue" ||
      typeof accountNumber.value !== "string" ||
      !/^\d{6,24}$/.test(accountNumber.value) ||
      accountNumber.value !== capture.account?.value)
  )
    diagnostic(diagnostics, "account-invalid");
  if (
    !capture.queryRange ||
    !/^\d{8}$/.test(capture.queryRange.startDate) ||
    !/^\d{8}$/.test(capture.queryRange.endDate) ||
    sourceDate(capture.queryRange.startDate) >
      sourceDate(capture.queryRange.endDate)
  )
    diagnostic(diagnostics, "query-range-invalid");
  if (!Array.isArray(capture.downloads) || capture.downloads.length === 0) {
    diagnostic(diagnostics, "downloads-missing");
  } else {
    let totalRows = 0;
    for (const download of capture.downloads) {
      if (!download || typeof download !== "object") {
        diagnostic(diagnostics, "download-shape-invalid");
        continue;
      }
      if (
        typeof download.filename !== "string" ||
        !normalizedCell(download.filename) ||
        !Number.isSafeInteger(download.byteLength) ||
        download.byteLength < 0 ||
        typeof download.contentDigest !== "string" ||
        !SOURCE_DIGEST.test(download.contentDigest)
      )
        diagnostic(diagnostics, "download-fingerprint-invalid");
      if (
        !Array.isArray(download.columnNames) ||
        download.columnNames.length !==
          SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES.length ||
        download.columnNames.some(
          (name: unknown, index: number) =>
            normalizedCell(name) !==
            SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES[index],
        )
      )
        diagnostic(diagnostics, "download-columns-invalid");
      if (download.terminal !== true)
        diagnostic(diagnostics, "download-terminal-invalid");
      if (!Array.isArray(download.rows)) {
        diagnostic(diagnostics, "row-shape-invalid");
        continue;
      }
      totalRows += download.rows.length;
      for (const [rowIndex, row] of download.rows.entries()) {
        if (!row || typeof row !== "object") {
          diagnostic(diagnostics, "row-shape-invalid");
          continue;
        }
        if (row.rowOrdinal !== rowIndex)
          diagnostic(diagnostics, "row-order-invalid");
        if (!Array.isArray(row.values)) {
          diagnostic(diagnostics, "row-cell-invalid");
          continue;
        }
        if (
          row.values.length !== SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES.length
        ) {
          diagnostic(diagnostics, "row-width-invalid");
          continue;
        }
        if (row.values.some((value: unknown) => typeof value !== "string")) {
          diagnostic(diagnostics, "row-cell-invalid");
          continue;
        }
        const values = row.values;
        if (!validCalendarDate(values[0]) || !validCalendarDate(values[1]))
          diagnostic(diagnostics, "row-date-invalid");
        if (!validTime(values[2])) diagnostic(diagnostics, "row-time-invalid");
        const expectedCurrency =
          capture.product === "domestic-deposit"
            ? "TWD"
            : capture.account.currency;
        if (
          (capture.product === "domestic-deposit" &&
            capture.account.currency !== "TWD") ||
          (capture.product === "foreign-currency" &&
            capture.account.currency === "TWD")
        )
          diagnostic(diagnostics, "row-currency-invalid");
        if (!expectedCurrency) diagnostic(diagnostics, "row-currency-invalid");
        const direction = amountDirection(values);
        if (direction === "invalid") {
          const outflow = normalizedCell(values[4]);
          const inflow = normalizedCell(values[5]);
          if (
            (outflow && validAmount(outflow) && !nonZeroAmount(outflow)) ||
            (inflow && validAmount(inflow) && !nonZeroAmount(inflow)) ||
            (outflow &&
              inflow &&
              nonZeroAmount(outflow) &&
              nonZeroAmount(inflow))
          )
            diagnostic(diagnostics, "row-amount-conflict");
          else diagnostic(diagnostics, "row-amount-invalid");
        }
        if (!normalizedCell(values[6]) || !validAmount(values[6]))
          diagnostic(diagnostics, "row-balance-invalid");
      }
    }
    if (totalRows === 0) {
      if (capture.zeroResultAuthority !== "provider-explicit-no-data")
        diagnostic(diagnostics, "zero-result-authority-unproven");
    } else if (capture.zeroResultAuthority !== undefined) {
      diagnostic(diagnostics, "zero-result-authority-mixed");
    }
  }
  if (
    !capture.provenance ||
    capture.provenance.source !== "sinopac-mma-json-statement-query" ||
    capture.provenance.responseBodyRetained !== false ||
    capture.provenance.semantics !== "unresolved" ||
    capture.provenance.accountEndpoint !== "ws_debitacct.ashx" ||
    capture.provenance.transactionEndpoint !== "ws_transdetailMerge.ashx"
  )
    diagnostic(diagnostics, "provenance-invalid");
  if (diagnostics.length > 0)
    return { status: "rejected", capture: null, diagnostics };
  deepFreeze(capture);
  VALIDATED_SINOPAC_CAPTURE.add(capture);
  return {
    status: "admissible",
    capture: capture as SinopacStatementValidatedCapture,
    diagnostics,
  };
}

export function isAdmittedSinopacStatementCaptureEvidence(
  value: unknown,
): value is SinopacStatementValidatedCapture {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_SINOPAC_CAPTURE.has(value)
  );
}

type SinopacIdentity = {
  sourceConnectionKey: `sha256:${string}`;
  identityEpochKey: `sha256:${string}`;
  subjectDigest: `sha256:${string}`;
};

function deriveSinopacIdentity(
  capture: SinopacStatementCaptureEvidence,
): SinopacIdentity {
  const product = capture.product;
  const subjectDigest = sinopacDigest(
    `sinopac-${product}-subject-v1`,
    normalizedCell(capture.account.value),
    normalizedCell(capture.account.currency),
  );
  return {
    sourceConnectionKey: sinopacDigest(
      `sinopac-${product}-connection-v1`,
      product,
    ),
    identityEpochKey: sinopacDigest(
      `sinopac-${product}-identity-epoch-v1`,
      product,
    ),
    subjectDigest,
  };
}

function sourceRoute(capture: SinopacStatementCaptureEvidence): string {
  return capture.product === "domestic-deposit"
    ? SINOPAC_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE
    : SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_ROUTE;
}

function sourceRecordKind(capture: SinopacStatementCaptureEvidence): string {
  return capture.product === "domestic-deposit"
    ? SINOPAC_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND
    : SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND;
}

function sourceRuleVersion(capture: SinopacStatementCaptureEvidence): string {
  return capture.product === "domestic-deposit"
    ? SINOPAC_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION
    : SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION;
}

function sourceEvidenceForCapture(
  capture: SinopacStatementValidatedCapture,
  captureId: string,
): CanonicalSourceEvidence {
  if (!isAdmittedSinopacStatementCaptureEvidence(capture))
    throw new Error("SinoPac source evidence requires structural admission.");
  if (!captureId.trim())
    throw new Error("SinoPac source evidence capture ID is required.");
  const identity = deriveSinopacIdentity(capture);
  const route = sourceRoute(capture);
  const recordKind = sourceRecordKind(capture);
  const ruleVersion = sourceRuleVersion(capture);
  const pages = capture.downloads.map((download, pageOrdinal) => ({
    download,
    pageOrdinal,
  }));
  return {
    captureId: captureId.trim(),
    integrationNamespace: "sinopac",
    sourceConnectionKey: identity.sourceConnectionKey,
    identityEpoch: identity.identityEpochKey,
    stream:
      capture.product === "domestic-deposit"
        ? "domestic-deposit"
        : "foreign-currency",
    recordKind,
    routeKey: route,
    contractVersion: capture.evidenceVersion,
    subjectDigest: identity.subjectDigest,
    observedAt: capture.observedAt,
    accountNumber: capture.account.accountNumber ?? null,
    scope: {
      startDate: sourceDate(capture.queryRange.startDate),
      endDate: sourceDate(capture.queryRange.endDate),
      kind: "bounded-range",
      completeness:
        capture.product === "foreign-currency"
          ? "complete-range"
          : "single-page",
      ruleVersion,
      ...(capture.zeroResultAuthority === "provider-explicit-no-data"
        ? { absenceAuthority: "provider-explicit-no-data" as const }
        : {}),
    },
    pages: pages.map(({ download, pageOrdinal }) => ({
      pageOrdinal,
      responseCode: "200",
      rowCount: download.rows.length,
      terminal: download.terminal,
      metadata: {
        filenameDigest: sinopacDigest(
          "sinopac-source-filename-v1",
          download.filename,
        ),
        contentDigest: download.contentDigest,
        byteLength: download.byteLength,
        columnCount: download.columnNames.length,
        queryPeriodCount: download.queryPeriods?.length ?? 0,
        accountDigest: sinopacDigest(
          "sinopac-source-account-v1",
          capture.account.value,
        ),
        currency: capture.account.currency,
        zeroResultAuthority: capture.zeroResultAuthority ?? null,
        completeness:
          capture.product === "foreign-currency"
            ? "terminal-complete-range"
            : "unproven",
      },
    })),
    records: pages.flatMap(({ download, pageOrdinal }) =>
      download.rows.map((row) => {
        const cells = row.values.map(normalizedCell);
        const rowDigest = sinopacDigest(
          `sinopac-${capture.product}-row-v1`,
          String(pageOrdinal),
          String(row.rowOrdinal),
          ...cells,
        );
        // This digest is retained only to link immutable source evidence and
        // its provenance. SinoPac foreign rows never use it as a Financial
        // Transaction identity because the provider has not established a
        // stable occurrence key contract.
        return {
          occurrenceKey: sinopacDigest(
            `sinopac-${capture.product}-occurrence-v1`,
            identity.subjectDigest,
            String(pageOrdinal),
            String(row.rowOrdinal),
            rowDigest,
          ),
          collisionKey: sinopacDigest(
            `sinopac-${capture.product}-collision-v1`,
            identity.subjectDigest,
            rowDigest,
          ),
          providerKey: rowDigest,
          contentHash: sinopacDigest(
            `sinopac-${capture.product}-content-v1`,
            rowDigest,
          ),
          compact: {
            evidenceVersion: capture.evidenceVersion,
            pageOrdinal,
            rowOrdinal: row.rowOrdinal,
            rowDigest,
            columnCount: cells.length,
            accountingDateShape: dateShape(cells[0] ?? ""),
            transactionDateShape: dateShape(cells[1] ?? ""),
            transactionTimeShape: timeShape(cells[2] ?? ""),
            currency: capture.account.currency,
            amountDirection: amountDirection(cells),
            balanceShape: "decimal",
            providerGuaranteed: false,
            canonicalAdmission: "blocked",
            sourceStage: "source-only",
            semanticStatus: "observed-structural-only",
          },
        };
      }),
    ),
  };
}

export function createSinopacStatementSourceEvidence(
  capture: SinopacStatementValidatedCapture,
  captureId: string,
): CanonicalSourceEvidence {
  return sourceEvidenceForCapture(capture, captureId);
}

export function createSinopacDomesticDepositSourceEvidence(
  capture: SinopacStatementValidatedCapture,
  captureId: string,
): CanonicalSourceEvidence {
  if (capture.product !== "domestic-deposit")
    throw new Error(
      "SinoPac domestic source evidence requires domestic product.",
    );
  return sourceEvidenceForCapture(capture, captureId);
}

export function createSinopacForeignCurrencySourceEvidence(
  capture: SinopacStatementValidatedCapture,
  captureId: string,
): CanonicalSourceEvidence {
  if (capture.product !== "foreign-currency")
    throw new Error(
      "SinoPac foreign source evidence requires foreign product.",
    );
  return sourceEvidenceForCapture(capture, captureId);
}

export const SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1 = Object.freeze({
  authorityRoute: "sinopac/foreign-currency/deposit/human-attested-v1",
  evidenceVersion: "foreign-currency/sinopac/human-attested-v1",
  attestedAt: "2026-08-25",
  attestedBy: "user-confirmed-live-run",
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
  sourceKeyFields: [
    "account",
    "currency",
    "DataText1",
    "DataText4",
    "DataText5",
  ],
  derivedFieldsExcluded: ["DataText9"],
  collisionPolicy: "reject-colliding-tuples",
} as const);

export type SinopacPGliteForeignFinancialCaptureResult = Readonly<{
  status: "admitted" | "blocked";
  capture: CanonicalFinancialDepositCapture | null;
  diagnostics: string[];
}>;

type ExactAmount = Readonly<{ coefficient: string; scale: number }>;

const FOREIGN_CURRENCY_CODES = new Set(
  "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWL".split(
    " ",
  ),
);

function foreignExactAmount(value: string): ExactAmount {
  const normalized = normalizedCell(value).replaceAll(",", "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized))
    throw new Error("SinoPac foreign amount must remain an exact decimal.");
  const [whole, fraction = ""] = normalized.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  let coefficient = digits;
  let scale = fraction.length;
  while (scale > 0 && coefficient.endsWith("0")) {
    coefficient = coefficient.slice(0, -1) || "0";
    scale -= 1;
  }
  return { coefficient, scale };
}

function foreignExactDecimal(value: string): string {
  const exact = foreignExactAmount(value);
  if (exact.scale === 0) return exact.coefficient;
  const digits = exact.coefficient.padStart(exact.scale + 1, "0");
  const splitAt = digits.length - exact.scale;
  return `${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
}

function foreignDate(value: string): string {
  const normalized = normalizedCell(value).replaceAll("/", "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized))
    throw new Error("SinoPac foreign source identity date is invalid.");
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  )
    throw new Error("SinoPac foreign source identity date is invalid.");
  return normalized;
}

function foreignTime(value: string): {
  value: string;
  precision: "minute" | "second";
} {
  const normalized = normalizedCell(value);
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(normalized))
    throw new Error("SinoPac foreign source identity time is invalid.");
  const [hour, minute, second] = normalized.split(":").map(Number);
  if (hour! > 23 || minute! > 59 || (second !== undefined && second > 59))
    throw new Error("SinoPac foreign source identity time is invalid.");
  return normalized.length === 5
    ? { value: `${normalized}:00`, precision: "minute" }
    : { value: normalized, precision: "second" };
}

function foreignToken(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function foreignCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
}

function sinopacForeignRecord(
  capture: SinopacStatementValidatedCapture,
  row: SinopacSourceRow,
): CanonicalFinancialDepositRecord {
  const values = row.values;
  const accountNo = normalizedCell(capture.account.value);
  const currency = normalizedCell(capture.account.currency).toUpperCase();
  const localDate = foreignDate(values[0] ?? "");
  const time = foreignTime(values[2] ?? "");
  const outflowText = normalizedCell(values[4]);
  const inflowText = normalizedCell(values[5]);
  if (Boolean(outflowText) === Boolean(inflowText))
    throw new Error(
      "SinoPac foreign row must prove exactly one amount direction.",
    );
  const direction = outflowText ? "outflow" : "inflow";
  const amountText = foreignExactDecimal(outflowText || inflowText);
  const balanceText = foreignExactDecimal(values[6] ?? "");
  const amount = foreignExactAmount(amountText);
  const balanceAfter = foreignExactAmount(balanceText);
  const sourceTimeText = normalizedCell(values[2]);
  const signedAmount = `${direction === "outflow" ? "-" : "+"}${amountText}`;
  const sourceKey = [
    accountNo,
    currency,
    `${localDate}T${sourceTimeText}`,
    signedAmount,
    balanceText,
  ].join(":");
  const sourceTime = {
    localDate,
    localTime: time.value,
    timeZone: "Asia/Taipei",
    epochMilliseconds: Date.parse(`${localDate}T${time.value}+08:00`),
    precision: time.precision,
    timeOrigin: "source_reported" as const,
  };
  if (!Number.isSafeInteger(sourceTime.epochMilliseconds))
    throw new Error(
      "SinoPac foreign source time is outside the supported instant range.",
    );
  const description = normalizedCell(values[3]) || null;
  const accountingDate = foreignDate(values[1] ?? "");
  const note = normalizedCell(values[7]);
  const reportedRateText = normalizedCell(values[8]);
  const sourceReportedRate = reportedRateText
    ? {
        amount: foreignExactAmount(reportedRateText),
        baseCurrency: currency,
        quoteCurrency: "TWD",
        observedOn: localDate,
      }
    : null;
  const payload = {
    sourceKey,
    sequence: `${localDate}T${sourceTimeText}`,
    amount,
    balanceAfter,
    currency,
    direction,
    currencyEvidence: { kind: "scope", currency },
    sourceTime,
    originalAmount: { amount, currency },
    sourceReportedRate,
    feeAmount: null,
    description,
    sourcePayload: {
      identityAuthority: "human-attested",
      identityContract:
        SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1.evidenceVersion,
      accountingDate,
      note,
      derivedFieldsExcluded:
        SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1.derivedFieldsExcluded,
    },
  };
  const compactJson = foreignCanonicalJson(payload);
  const sourceReportedRateEvidence = sourceReportedRate
    ? {
        amount: sourceReportedRate.amount,
        baseCurrency: sourceReportedRate.baseCurrency,
        quoteCurrency: sourceReportedRate.quoteCurrency,
        observedOn: sourceReportedRate.observedOn,
      }
    : null;
  return {
    occurrenceKey: foreignToken(`sinopac:occurrence:${sourceKey}`),
    collisionKey: foreignToken(`sinopac:collision:${sourceKey}`),
    providerKey: foreignToken(`sinopac:provider:${sourceKey}`),
    contentHash: foreignToken(compactJson),
    sequenceLexeme: payload.sequence,
    compactJson,
    amount,
    balanceAfter,
    currency,
    direction,
    sourceTime,
    effectiveOn: localDate,
    transactionDateTimeLocal: `${localDate}T${time.value}`,
    description,
    conversionEvidence: {
      originalAmount: amount,
      originalCurrency: currency,
      bookedAmount: amount,
      bookedCurrency: currency,
      sourceReportedRate: sourceReportedRateEvidence,
      impliedRate: null,
      comparison: "not-comparable",
      feeAmount: null,
      feeCurrency: null,
      evidenceOrigin: "source-row-conversion-evidence-v1",
    },
  };
}

export function buildSinopacForeignCurrencyFinancialCaptureForPGlite(
  capture: SinopacStatementValidatedCapture,
  captureOccurrenceId: string,
): SinopacPGliteForeignFinancialCaptureResult {
  const diagnostics: string[] = [];
  if (
    !isAdmittedSinopacStatementCaptureEvidence(capture) ||
    capture.product !== "foreign-currency"
  )
    return {
      status: "blocked",
      capture: null,
      diagnostics: ["capture-invalid"],
    };
  if (!captureOccurrenceId.trim())
    return {
      status: "blocked",
      capture: null,
      diagnostics: ["capture-occurrence-id-missing"],
    };
  if (
    capture.downloads.every((download) => download.rows.length === 0) &&
    capture.zeroResultAuthority !== "provider-explicit-no-data"
  )
    return {
      status: "blocked",
      capture: null,
      diagnostics: ["zero-result-authority-unproven"],
    };
  try {
    const accountNo = normalizedCell(capture.account.value);
    const currency = normalizedCell(capture.account.currency).toUpperCase();
    if (!FOREIGN_CURRENCY_CODES.has(currency))
      throw new Error("SinoPac foreign currency is invalid.");
    const startDate = foreignDate(
      capture.queryRange.startDate.replace(
        /^(\d{4})(\d{2})(\d{2})$/,
        "$1-$2-$3",
      ),
    );
    const endDate = foreignDate(
      capture.queryRange.endDate.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
    );
    if (startDate > endDate)
      throw new Error("SinoPac foreign capture scope is inverted.");
    const records = capture.downloads.flatMap((download) =>
      download.rows.map((row) => sinopacForeignRecord(capture, row)),
    );
    if (
      records.some(
        (record) =>
          record.effectiveOn < startDate || record.effectiveOn > endDate,
      )
    )
      throw new Error(
        "SinoPac foreign source row falls outside the complete capture scope.",
      );
    const duplicateSourceKeys = new Set<string>();
    for (const record of records) {
      if (duplicateSourceKeys.has(record.occurrenceKey))
        throw new Error(
          "SinoPac foreign human-attested source identity collision.",
        );
      duplicateSourceKeys.add(record.occurrenceKey);
    }
    const contractVersion =
      SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1.evidenceVersion;
    const authorityRoute =
      SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1.authorityRoute;
    const captureCurrencyScope = { kind: "currency" as const, currency };
    const scopeFingerprint = foreignToken(
      `${contractVersion}:${accountNo}:${startDate}:${endDate}:${foreignCanonicalJson(captureCurrencyScope)}`,
    );
    const responseDigest = foreignToken(
      records.map((record) => record.contentHash).join("|"),
    );
    const connectionKey = "sinopac-foreign-current-login";
    const identityEpochKey =
      SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1.evidenceVersion;
    const captureId = `foreign-sinopac-${foreignToken(`${connectionKey}:${identityEpochKey}:${captureOccurrenceId.trim()}:${accountNo}:${startDate}:${endDate}:${foreignCanonicalJson(captureCurrencyScope)}`).slice("sha256:".length)}`;
    const first = records[0]?.sourceTime ?? {
      localDate: startDate,
      localTime: "00:00:00",
      timeZone: "Asia/Taipei",
      epochMilliseconds: Date.parse(`${startDate}T00:00:00+08:00`),
      precision: "date",
      timeOrigin: "defaulted_local_midnight",
    };
    const preflightFingerprint = foreignToken(`${scopeFingerprint}:preflight`);
    return {
      status: "admitted",
      diagnostics,
      capture: {
        captureId,
        authorityRoute,
        contractVersion,
        identity: {
          integrationNamespace: "sinopac",
          sourceConnectionKey: foreignToken(connectionKey),
          identityEpochKey: foreignToken(identityEpochKey),
          stream: "foreign-currency-deposit",
          recordKind: "sinopac-foreign-currency-deposit",
          subjectDigest: foreignToken(
            `${accountNo}:sinopac-foreign-currency-deposit`,
          ),
          accountNo,
          sourceAccountKey: accountNo,
          accountNumber: capture.account.accountNumber ?? null,
          accountType: "depository",
          currency: null,
        },
        observedAt: capture.observedAt,
        scope: {
          startDate,
          endDate,
          scopeKind: "bounded-range",
          completeness: "complete-range",
          completenessBasis: "foreign-currency-terminal-complete-range",
          completenessRuleVersion: contractVersion,
          absenceAuthority: "provider-explicit-no-data",
          contractFingerprint: scopeFingerprint,
          preflightFingerprint,
          pageCount: 1,
          withdrawalPolicy: "never-infer",
        },
        semantics: {
          postingStatus: "posted",
          postingOrigin: "human-attested",
          postingBasis: "statement-posted-history",
          postingRuleVersion: contractVersion,
          economicStatus: "normal",
          administrativeState: "active",
          semanticRuleVersion: contractVersion,
          effectiveTimeBasis: "transaction-time",
          effectiveTimeRuleVersion: contractVersion,
          timeZone: "Asia/Taipei",
          timePrecision: first.precision ?? "second",
          timeOrigin: first.timeOrigin ?? "source_reported",
          requireBalance: true,
          providerGuaranteed: false,
          occurrenceProviderGuaranteed: false,
        },
        pages: [
          {
            pageOrdinal: 0,
            responseCode: "200",
            terminal: true,
            rowCount: records.length,
            responseDigest,
            proofKind: "foreign-currency-terminal-statement",
            contractFingerprint: scopeFingerprint,
            preflightFingerprint,
            metadataJson: foreignCanonicalJson({
              source: "sinopac",
              accountNo,
              startDate,
              endDate,
              captureCurrencyScope,
              currencyScope: "row-or-typed-scope",
              completeness: "complete-range",
            }),
          },
        ],
        records,
      },
    };
  } catch (error) {
    return {
      status: "blocked",
      capture: null,
      diagnostics: [
        error instanceof Error ? error.message : "foreign-capture-invalid",
      ],
    };
  }
}
