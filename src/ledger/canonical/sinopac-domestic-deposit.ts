import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";
import { createHash } from "node:crypto";
import {
  admitCanonicalSourceEvidence,
  type CanonicalSourceEvidence,
} from "./canonical-source-evidence.ts";
import {
  commitCanonicalSourceEvidenceBatch,
  commitCanonicalSourceEvidence,
  type CanonicalSourceCommitResult,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
  SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  ensureSinopacHumanAttestationEvents,
  getSinopacHumanAttestedV1Manifest,
  isSinopacHumanAttestationDurablyActive,
  isSinopacHumanAttestedV1Active,
  isSinopacHumanAttestedV1Manifest,
  latestSinopacHumanAttestationEvent,
  recordInitialSinopacHumanAttestationIfMissing,
  sinopacHumanAttestedIdentityEpochKey,
  type SinopacHumanAttestedV1Manifest,
} from "./sinopac-human-attestation.ts";

export const SINOPAC_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "sinopac",
  authority: "sinopac/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "sinopacStatements",
  expectedRowWidth: 9,
  accountingDateIndex: 0,
  transactionDateIndex: 1,
  transactionTimeIndex: 2,
  provenance: {
    evidenceBasis:
      "provider SubInfo/RecordCount fields and explicit FAIL no-data response",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 4,
  inflowIndex: 5,
  completenessEvidence: "response-count",
  explicitNoDataEvidence: {
    kind: "status-message",
    status: "FAIL",
    message: "查無資料",
  },
} as const satisfies AdvertisedDomesticDepositContract;

export const SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-SINOPAC-ACCOUNT",
  scope: { startDate: "20260101", endDate: "20260131" },
  records: [
    {
      values: [
        "2026/01/02",
        "2026/01/02",
        "09:10",
        "SYNTHETIC",
        "100",
        "",
        "900",
        "",
        "",
      ],
    },
  ],
  transport: { reportedCount: 1 },
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightSinopacDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(SINOPAC_DOMESTIC_DEPOSIT_CONTRACT);

/** The provider capture contract remains source evidence. Financial mutation
 * crosses a separate, explicitly confirmed observed-human-attested route and
 * never upgrades foreign-currency captures. */
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
export const SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY =
  SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE;
export const SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION =
  SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION;

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
// Vocabulary aliases keep the workflow's public "foreign statements" name
// while preserving the canonical stream name used in source queries.
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
  account: { value: string; label: string; currency: string };
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

export async function commitSinopacStatementSourceEvidence(
  store: CanonicalSourceStore,
  capture: SinopacStatementValidatedCapture,
  captureId: string,
): Promise<CanonicalSourceCommitResult> {
  return commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(sourceEvidenceForCapture(capture, captureId)),
  );
}

export async function commitSinopacStatementSourceEvidenceBatch(
  store: CanonicalSourceStore,
  captures: readonly SinopacStatementValidatedCapture[],
  captureId: string,
): Promise<CanonicalSourceCommitResult[]> {
  if (captures.length === 0)
    throw new Error("SinoPac source batch cannot be empty.");
  const evidences = captures.map((capture, index) =>
    admitCanonicalSourceEvidence(
      sourceEvidenceForCapture(capture, `${captureId}-${index}`),
    ),
  );
  const captureKeys = new Set<string>();
  const plannedOccurrences = new Map<
    string,
    CanonicalSourceEvidence["records"][number]
  >();
  for (const evidence of evidences) {
    if (captureKeys.has(evidence.captureId))
      throw new Error("SinoPac source batch capture overwrite is forbidden.");
    captureKeys.add(evidence.captureId);
    const route = store.db
      .prepare(
        "SELECT integration_namespace, stream, contract_version FROM source_authority_routes WHERE authority_route = ?",
      )
      .get(evidence.routeKey) as Record<string, unknown> | undefined;
    if (
      route &&
      (String(route.integration_namespace) !== evidence.integrationNamespace ||
        String(route.stream) !== evidence.stream ||
        String(route.contract_version) !== evidence.contractVersion)
    )
      throw new Error("SinoPac authority route contract drifted.");
    if (
      store.db
        .prepare("SELECT 1 FROM source_captures WHERE capture_key = ?")
        .get(evidence.captureId)
    )
      throw new Error("SinoPac source capture overwrite is forbidden.");
    for (const record of evidence.records) {
      const occurrenceIdentity = [
        evidence.integrationNamespace,
        evidence.sourceConnectionKey,
        evidence.identityEpoch,
        evidence.stream,
        evidence.recordKind,
        evidence.subjectDigest,
        record.occurrenceKey,
      ].join("\u0000");
      const planned = plannedOccurrences.get(occurrenceIdentity);
      if (
        planned &&
        (planned.providerKey !== record.providerKey ||
          planned.contentHash !== record.contentHash ||
          stableSourceJson(planned.compact) !==
            stableSourceJson(record.compact))
      )
        throw new Error(
          "SinoPac source occurrence conflict; overwrite is forbidden.",
        );
      plannedOccurrences.set(occurrenceIdentity, record);
      if (record.collisionKey !== undefined) {
        const collisions = store.db
          .prepare(
            `SELECT record.occurrence_key FROM source_records record
             JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
             JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
             JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
             WHERE connection.integration_namespace = ? AND connection.source_connection_key = ?
               AND epoch.epoch_key = ? AND subject.stream = ? AND subject.record_kind = ?
               AND subject.subject_digest = ? AND record.collision_key = ?`,
          )
          .all(
            evidence.integrationNamespace,
            evidence.sourceConnectionKey,
            evidence.identityEpoch,
            evidence.stream,
            evidence.recordKind,
            evidence.subjectDigest,
            record.collisionKey,
          ) as Array<{ occurrence_key?: unknown }>;
        if (
          collisions.some(
            (existing) =>
              String(existing.occurrence_key) !== record.occurrenceKey,
          )
        )
          throw new Error(
            "SinoPac source collision key maps to another occurrence; overwrite is forbidden.",
          );
      }
      const existing = store.db
        .prepare(
          `SELECT record.provider_key, record.content_hash, record.payload_json
           FROM source_records record
           JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
           JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
           JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
           WHERE connection.integration_namespace = ? AND connection.source_connection_key = ?
             AND epoch.epoch_key = ? AND subject.stream = ? AND subject.record_kind = ?
             AND subject.subject_digest = ? AND record.occurrence_key = ?`,
        )
        .all(
          evidence.integrationNamespace,
          evidence.sourceConnectionKey,
          evidence.identityEpoch,
          evidence.stream,
          evidence.recordKind,
          evidence.subjectDigest,
          record.occurrenceKey,
        ) as Array<Record<string, unknown>>;
      if (
        existing.some(
          (row) =>
            String(row.provider_key) !== record.providerKey ||
            String(row.content_hash) !== record.contentHash ||
            String(row.payload_json) !== stableSourceJson(record.compact),
        )
      )
        throw new Error(
          "SinoPac source occurrence conflict; overwrite is forbidden.",
        );
    }
  }
  return commitCanonicalSourceEvidenceBatch(store, evidences);
}

export type SinopacDomesticDepositFinancialAdmissionInput = {
  capture: SinopacStatementValidatedCapture;
  captureId: string;
  humanAttestation?: SinopacHumanAttestedV1Manifest;
  personalAuthority?: SinopacPersonalAuthority;
};

export type SinopacPersonalAuthority = {
  readonly source: "durable-attestation";
};
const SINOPAC_PERSONAL_AUTHORITIES = new WeakSet<object>();
const SINOPAC_PERSONAL_AUTHORITY_SNAPSHOTS = new WeakMap<
  object,
  {
    db: CanonicalFinancialDepositWriterStore["db"];
    sequence: number;
    eventAt: string;
    manifestFingerprint: string;
  }
>();
export function createSinopacPersonalAuthority(
  db: CanonicalFinancialDepositWriterStore["db"],
): SinopacPersonalAuthority {
  if (!isSinopacHumanAttestationDurablyActive(db))
    throw new Error("SinoPac durable personal authority is not active.");
  const latest = latestSinopacHumanAttestationEvent(db);
  if (!latest || latest.eventKind !== "attested")
    throw new Error("SinoPac durable personal authority event is unavailable.");
  const authority = Object.freeze({ source: "durable-attestation" as const });
  SINOPAC_PERSONAL_AUTHORITIES.add(authority);
  SINOPAC_PERSONAL_AUTHORITY_SNAPSHOTS.set(authority, {
    db,
    sequence: latest.sequence,
    eventAt: latest.eventAt,
    manifestFingerprint: latest.manifestFingerprint,
  });
  return authority;
}

function validSinopacPersonalAuthority(
  authority: SinopacPersonalAuthority | undefined,
  expectedDb?: CanonicalFinancialDepositWriterStore["db"],
): boolean {
  if (!authority || !SINOPAC_PERSONAL_AUTHORITIES.has(authority)) return false;
  const snapshot = SINOPAC_PERSONAL_AUTHORITY_SNAPSHOTS.get(authority);
  if (!snapshot || (expectedDb && snapshot.db !== expectedDb)) return false;
  try {
    const latest = latestSinopacHumanAttestationEvent(snapshot.db);
    return (
      latest?.eventKind === "attested" &&
      latest.sequence === snapshot.sequence &&
      latest.eventAt === snapshot.eventAt &&
      latest.manifestFingerprint === snapshot.manifestFingerprint &&
      isSinopacHumanAttestationDurablyActive(snapshot.db)
    );
  } catch {
    return false;
  }
}

export type SinopacDomesticDepositFinancialAdmissionResult = {
  status: "admitted" | "blocked";
  capture: CanonicalFinancialDepositValidatedCapture | null;
  diagnostics: string[];
};

export class SinopacDomesticDepositFinancialAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SinopacDomesticDepositFinancialAdmissionError";
  }
}

function canonicalSinopacDate(value: string): string | null {
  const compact = normalizedCell(value).replaceAll("/", "");
  if (!/^\d{8}$/.test(compact)) return null;
  const formatted = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const parsed = new Date(`${formatted}T00:00:00.000Z`);
  return parsed.toISOString().slice(0, 10) === formatted ? formatted : null;
}

function canonicalSinopacTime(value: string): string | null {
  const match = normalizedCell(value).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (
    !match ||
    Number(match[1]) > 23 ||
    Number(match[2]) > 59 ||
    Number(match[3] ?? 0) > 59
  )
    return null;
  return match[3] === undefined
    ? `${match[1]}:${match[2]}`
    : `${match[1]}:${match[2]}:${match[3]}`;
}

function financialAmount(
  value: string,
  allowZero = false,
): { coefficient: string; scale: number } | null {
  const normalized = normalizedCell(value).replaceAll(",", "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole = "", fractional = ""] = normalized.split(".");
  const coefficient = `${whole}${fractional}`.replace(/^0+(?=\d)/, "") || "0";
  if (!allowZero && BigInt(coefficient) === 0n) return null;
  return { coefficient, scale: fractional.length };
}

function unsupportedSinopacMarker(values: readonly string[]): boolean {
  return /撤銷|撤销|沖正|冲正|更正|取消|退回|回沖|回冲|reversal|reversed|correction|cancel/i.test(
    values.map(normalizedCell).join(" "),
  );
}

function unsupportedSinopacAuthority(label: string): boolean {
  return /共同|共有|聯名|联名|代理|代管|joint|shared|co[- ]?owner|authorized/i.test(
    label,
  );
}

function sinopacFinancialRecord(
  capture: SinopacStatementValidatedCapture,
  row: SinopacSourceRow,
  pageOrdinal: number,
): { record: CanonicalFinancialDepositRecord | null; diagnostics: string[] } {
  const values = row.values;
  const diagnostics: string[] = [];
  const accountingDate = canonicalSinopacDate(values[0] ?? "");
  const transactionDate = canonicalSinopacDate(values[1] ?? "");
  const transactionTime = canonicalSinopacTime(values[2] ?? "");
  if (!accountingDate) diagnostics.push("accounting-date-invalid");
  if (!transactionDate) diagnostics.push("transaction-date-invalid");
  if (!transactionTime) diagnostics.push("transaction-time-invalid");
  if (!accountingDate || !transactionDate || !transactionTime)
    return { record: null, diagnostics };
  const epochMilliseconds = Date.parse(
    `${transactionDate}T${transactionTime}+08:00`,
  );
  if (!Number.isSafeInteger(epochMilliseconds)) {
    diagnostics.push("effective-time-invalid");
    return { record: null, diagnostics };
  }
  const outflowText = normalizedCell(values[4]);
  const inflowText = normalizedCell(values[5]);
  const outflow = financialAmount(outflowText);
  const inflow = financialAmount(inflowText);
  if ((Boolean(outflowText) && Boolean(inflowText)) || (!outflow && !inflow))
    diagnostics.push("amount-column-conflict");
  if ((outflowText && !outflow) || (inflowText && !inflow))
    diagnostics.push("amount-invalid");
  const balanceAfter = financialAmount(values[6] ?? "", true);
  if (!balanceAfter) diagnostics.push("balance-invalid");
  if (unsupportedSinopacMarker(values))
    diagnostics.push("cancellation-marker-unsupported");
  const amount = outflow ?? inflow;
  const direction = outflow ? "outflow" : inflow ? "inflow" : null;
  if (!amount || !direction || !balanceAfter || diagnostics.length > 0)
    return { record: null, diagnostics };
  const identity = deriveSinopacIdentity(capture);
  const contentHash = sinopacDigest(
    "sinopac-observed-content-v1",
    ...values.map(normalizedCell),
  );
  const collisionKey = sinopacDigest(
    "sinopac-observed-composite-fence-v1",
    identity.subjectDigest,
    accountingDate,
    transactionDate,
    transactionTime,
    direction,
    amount.coefficient,
    String(amount.scale),
    balanceAfter.coefficient,
    String(balanceAfter.scale),
  );
  const occurrenceKey = sinopacDigest(
    "sinopac-observed-composite-occurrence-v1",
    collisionKey,
    normalizedCell(values[3]),
    normalizedCell(values[7]),
    normalizedCell(values[8]),
  );
  return {
    diagnostics,
    record: {
      occurrenceKey,
      collisionKey,
      providerKey: collisionKey,
      contentHash,
      sequenceLexeme: `${pageOrdinal}:${row.rowOrdinal}`,
      compactJson: stableSourceJson({
        evidenceVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
        accountingDate,
        transactionDate,
        transactionTime,
        direction,
        amount,
        balanceAfter,
        descriptionDigest: sinopacDigest(
          "sinopac-description-v1",
          normalizedCell(values[3]),
        ),
        noteDigest: sinopacDigest("sinopac-note-v1", normalizedCell(values[7])),
        referenceDigest: sinopacDigest(
          "sinopac-reference-v1",
          normalizedCell(values[8]),
        ),
        providerGuaranteed: false,
      }),
      amount,
      balanceAfter,
      currency: "TWD",
      direction,
      sourceTime: {
        localDate: transactionDate,
        localTime: transactionTime,
        timeZone: "Asia/Taipei",
        epochMilliseconds,
      },
      effectiveOn: accountingDate,
      transactionDateTimeLocal: `${transactionDate}T${transactionTime}`,
    },
  };
}

export function admitSinopacDomesticDepositFinancialCapture(
  input: SinopacDomesticDepositFinancialAdmissionInput,
): SinopacDomesticDepositFinancialAdmissionResult {
  const diagnostics: string[] = [];
  if (!isAdmittedSinopacStatementCaptureEvidence(input.capture))
    diagnostics.push("capture-not-runtime-admitted");
  if (!validSinopacPersonalAuthority(input.personalAuthority))
    diagnostics.push("authority-semantics-unproven");
  if (input.capture.product !== "domestic-deposit")
    diagnostics.push("unsupported-product");
  if (input.capture.account.currency !== "TWD")
    diagnostics.push("unsupported-currency");
  const manifest =
    input.humanAttestation ?? getSinopacHumanAttestedV1Manifest();
  if (!isSinopacHumanAttestedV1Manifest(manifest))
    diagnostics.push("human-attestation-mismatch");
  else if (!isSinopacHumanAttestedV1Active())
    diagnostics.push("human-attestation-revoked");
  if (unsupportedSinopacAuthority(input.capture.account.label))
    diagnostics.push("authority-shared-account");
  if (!input.captureId.trim()) diagnostics.push("capture-id-missing");
  if (input.capture.downloads.some((download) => !download.terminal))
    diagnostics.push("terminal-evidence-missing");
  if (
    input.capture.downloads.every((download) => download.rows.length === 0) &&
    input.capture.zeroResultAuthority !== "provider-explicit-no-data"
  )
    diagnostics.push("zero-result-authority-unproven");
  const records: CanonicalFinancialDepositRecord[] = [];
  for (const [pageOrdinal, download] of input.capture.downloads.entries()) {
    for (const row of download.rows) {
      const converted = sinopacFinancialRecord(input.capture, row, pageOrdinal);
      diagnostics.push(...converted.diagnostics);
      if (converted.record) records.push(converted.record);
    }
  }
  if (diagnostics.length > 0)
    return {
      status: "blocked",
      capture: null,
      diagnostics: [...new Set(diagnostics)],
    };
  const identity = deriveSinopacIdentity(input.capture);
  const queryStart = canonicalSinopacDate(input.capture.queryRange.startDate);
  const queryEnd = canonicalSinopacDate(input.capture.queryRange.endDate);
  if (!queryStart || !queryEnd)
    return {
      status: "blocked",
      capture: null,
      diagnostics: ["query-range-invalid"],
    };
  const contractFingerprint = sinopacDigest(
    "sinopac-contract-v1",
    SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  );
  const preflightFingerprint = sinopacDigest(
    "sinopac-preflight-v1",
    identity.subjectDigest,
    queryStart,
    queryEnd,
  );
  const capture = admitCanonicalFinancialDepositCapture({
    captureId: input.captureId.trim(),
    authorityRoute: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    contractVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    identity: {
      integrationNamespace: "sinopac",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: sinopacHumanAttestedIdentityEpochKey(manifest),
      stream: "domestic-deposit",
      recordKind: "sinopac-domestic-deposit",
      subjectDigest: identity.subjectDigest,
      accountNo: input.capture.account.value,
      accountType: "depository",
      currency: "TWD",
    },
    observedAt: input.capture.observedAt,
    scope: {
      startDate: queryStart,
      endDate: queryEnd,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "bounded-terminal-query",
      completenessRuleVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      absenceAuthority:
        records.length === 0 ? "provider-explicit-no-data" : null,
      contractFingerprint,
      preflightFingerprint,
      pageCount: input.capture.downloads.length,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      timeZone: "Asia/Taipei",
      timePrecision: "minute",
      timeOrigin: "source_reported",
      requireBalance: true,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: input.capture.downloads.map((download, pageOrdinal) => ({
      pageOrdinal,
      responseCode: "200",
      terminal: download.terminal,
      rowCount: download.rows.length,
      responseDigest: download.contentDigest,
      proofKind: "bounded-terminal-query",
      contractFingerprint,
      preflightFingerprint,
      metadataJson: stableSourceJson({
        pageOrdinal,
        rowCount: download.rows.length,
        zeroResultAuthority: input.capture.zeroResultAuthority ?? null,
        providerGuaranteed: false,
      }),
    })),
    records,
  });
  return { status: "admitted", capture, diagnostics: [] };
}

export async function commitCanonicalSinopacDomesticDepositCapture(
  store: CanonicalFinancialDepositWriterStore,
  input: SinopacDomesticDepositFinancialAdmissionInput,
): Promise<CanonicalFinancialDepositCommitResult> {
  if (!validSinopacPersonalAuthority(input.personalAuthority, store.db))
    throw new SinopacDomesticDepositFinancialAdmissionError(
      "SinoPac personal authority does not match this durable ledger generation.",
    );
  ensureSinopacHumanAttestationEvents(store.db);
  let latest: ReturnType<typeof latestSinopacHumanAttestationEvent>;
  try {
    latest = latestSinopacHumanAttestationEvent(store.db);
  } catch {
    throw new SinopacDomesticDepositFinancialAdmissionError(
      "SinoPac human attestation chain is invalid.",
    );
  }
  if (latest?.eventKind === "revoked" || !isSinopacHumanAttestedV1Active())
    throw new SinopacDomesticDepositFinancialAdmissionError(
      "SinoPac human attestation is revoked; future admission is blocked.",
    );
  const admission = admitSinopacDomesticDepositFinancialCapture(input);
  if (admission.status !== "admitted" || !admission.capture)
    throw new SinopacDomesticDepositFinancialAdmissionError(
      `SinoPac domestic deposit canonical admission blocked: ${admission.diagnostics.join(", ")}`,
    );
  recordInitialSinopacHumanAttestationIfMissing(
    store.db,
    input.capture.observedAt,
  );
  return commitCanonicalFinancialDepositCapture(store, admission.capture);
}

export async function commitCanonicalSinopacDomesticDepositCaptureBatch(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly SinopacDomesticDepositFinancialAdmissionInput[],
): Promise<CanonicalFinancialDepositCommitResult[]> {
  if (inputs.length === 0)
    throw new SinopacDomesticDepositFinancialAdmissionError(
      "SinoPac financial capture batch cannot be empty.",
    );
  if (
    inputs.some(
      (input) =>
        !validSinopacPersonalAuthority(input.personalAuthority, store.db),
    )
  )
    throw new SinopacDomesticDepositFinancialAdmissionError(
      "SinoPac batch personal authority does not match this durable ledger generation.",
    );
  ensureSinopacHumanAttestationEvents(store.db);
  let latest: ReturnType<typeof latestSinopacHumanAttestationEvent>;
  try {
    latest = latestSinopacHumanAttestationEvent(store.db);
  } catch {
    throw new SinopacDomesticDepositFinancialAdmissionError(
      "SinoPac human attestation chain is invalid.",
    );
  }
  if (latest?.eventKind === "revoked" || !isSinopacHumanAttestedV1Active())
    throw new SinopacDomesticDepositFinancialAdmissionError(
      "SinoPac human attestation is revoked; future admission is blocked.",
    );
  const admissions = inputs.map(admitSinopacDomesticDepositFinancialCapture);
  const blocked = admissions.find(
    (admission) => admission.status !== "admitted",
  );
  if (blocked)
    throw new SinopacDomesticDepositFinancialAdmissionError(
      `SinoPac domestic deposit canonical batch admission blocked: ${blocked.diagnostics.join(", ")}`,
    );
  recordInitialSinopacHumanAttestationIfMissing(
    store.db,
    inputs[0]!.capture.observedAt,
  );
  return commitCanonicalFinancialDepositCaptureBatch(
    store,
    admissions.map((admission) => admission.capture!),
  );
}

export {
  SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
  getSinopacHumanAttestedV1Manifest,
  isSinopacHumanAttestationDurablyActive,
  recordInitialSinopacHumanAttestationIfMissing,
};
