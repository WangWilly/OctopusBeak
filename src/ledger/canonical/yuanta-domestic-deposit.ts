import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";
import { createHash } from "node:crypto";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  admitCanonicalSourceEvidence,
  commitCanonicalSourceEvidence,
  type CanonicalSourceCommitResult,
  type CanonicalSourceEvidence,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION,
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  ensureYuantaHumanAttestationEvents,
  getYuantaHumanAttestedV2Manifest,
  isYuantaHumanAttestationV2DurablyActive,
  isYuantaHumanAttestedV2Active,
  isYuantaHumanAttestedV2Manifest,
  latestYuantaHumanAttestationEventV2,
  recordInitialYuantaHumanAttestationV2IfMissing,
  restoreYuantaHumanAttestedV2,
  revokeYuantaHumanAttestedV2,
  yuantaHumanAttestedV2IdentityEpochKey,
  yuantaHumanAttestedIdentityEpochKey,
  type YuantaHumanAttestedV2Manifest,
  type YuantaHumanAttestedManifest,
} from "./yuanta-human-attestation.ts";
import {
  requireSourceConnectionIdentity,
  validateSourceConnectionIdentity,
} from "./source-connection-identity.ts";

export const YUANTA_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "yuanta",
  authority: "yuanta/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "yuantaStatements",
  expectedRowWidth: 11,
  accountingDateIndex: 2,
  transactionDateIndex: 3,
  transactionTimeIndex: 4,
  provenance: {
    evidenceBasis: "downloaded CSV headers and normalized rows",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 6,
  inflowIndex: 7,
  completenessEvidence: "none",
  explicitNoDataEvidence: { kind: "none" },
} as const satisfies AdvertisedDomesticDepositContract;

export const YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-YUANTA-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/03/31" },
  records: [
    {
      values: [
        "SYNTHETIC",
        "SYNTHETIC-YUANTA-ACCOUNT",
        "20260102",
        "20260102",
        "09:10:11",
        "SYNTHETIC",
        "100",
        "",
        "900",
        "",
        "",
      ],
    },
  ],
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightYuantaDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(YUANTA_DOMESTIC_DEPOSIT_CONTRACT);

/**
 * Source observation is intentionally a separate contract from the original
 * table-shape preflight.  It records the CSV boundary and parser evidence,
 * but does not claim posting, timing, cancellation, completeness, or a
 * provider-issued occurrence identifier.
 */
export const YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION =
  "capture-evidence-v2" as const;
export const YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION =
  "domestic-deposit-telemetry-v1" as const;

/** The only bounded ranges currently exposed by the Yuanta domestic UI. */
export const YUANTA_DOMESTIC_DEPOSIT_DATE_RANGES = [
  "one_week",
  "one_month",
  "three_months",
] as const;
export type YuantaDomesticDepositDateRange =
  (typeof YUANTA_DOMESTIC_DEPOSIT_DATE_RANGES)[number];

export const YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES = [
  "帳戶名稱",
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
] as const;

export type YuantaDomesticDepositRawRow = {
  rowOrdinal: number;
  /** The normalized eleven-column row observed by the parser. */
  values: readonly string[];
};

export type YuantaDomesticDepositDownloadEvidence = {
  filename: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
  columnNames: readonly string[];
  rows: readonly YuantaDomesticDepositRawRow[];
  /** The CSV is admitted financially only when the UI query is terminal. */
  terminal?: boolean;
};

export type YuantaDomesticDepositCaptureEvidence = {
  evidenceVersion: typeof YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION;
  source: "yuanta";
  observedAt: string;
  account: {
    value: string;
    label: string;
  };
  queryRange: {
    /** The requested UI range, not a claim about provider semantics. */
    dateRange: string;
    startDate: string;
    endDate: string;
  };
  downloads: readonly YuantaDomesticDepositDownloadEvidence[];
  /** Required when every terminal download is empty. */
  zeroResultAuthority?: "provider-explicit-no-data" | "unproven";
  provenance: {
    source: "yuanta-ebank-domestic-deposit-csv";
    encoding: "big5";
    responseBodyRetained: false;
    semantics: "unresolved";
    querySelector: "#acctno";
    submitSelector: "#submitbutton";
    downloadSelector: "a.order_2.m_color_check";
    telemetryVersion: typeof YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION;
  };
};

export type YuantaDomesticDepositCaptureInput =
  YuantaDomesticDepositCaptureEvidence;

export type YuantaDomesticDepositCaptureValidationResult = {
  status: "admissible" | "rejected";
  capture: YuantaDomesticDepositValidatedEvidence | null;
  diagnostics: YuantaDomesticDepositCaptureDiagnostic[];
};

export type YuantaDomesticDepositValidatedEvidence =
  YuantaDomesticDepositCaptureEvidence & {
    readonly __runtimeValidatedYuantaDomesticDepositEvidence: true;
  };

export type YuantaDomesticDepositCaptureDiagnostic =
  | "capture-missing"
  | "evidence-version-invalid"
  | "source-invalid"
  | "observed-at-invalid"
  | "account-invalid"
  | "query-range-invalid"
  | "downloads-missing"
  | "download-shape-invalid"
  | "download-fingerprint-invalid"
  | "download-columns-invalid"
  | "row-shape-invalid"
  | "row-order-invalid"
  | "row-width-invalid"
  | "row-cell-invalid"
  | "row-date-invalid"
  | "row-time-invalid"
  | "row-amount-invalid"
  | "row-amount-conflict"
  | "zero-result-authority-unproven"
  | "terminal-evidence-missing"
  | "provenance-invalid";

export type YuantaDomesticDepositTelemetryRow = {
  rowOrdinal: number;
  rowFingerprint: `sha256:${string}`;
  cellDigests: `sha256:${string}`[];
  cellCount: 11;
  amountShape: "inflow" | "outflow" | "empty" | "invalid" | "conflict";
  /**
   * Privacy-safe direction-column diagnostics.  These categories describe
   * syntax only; they never include the observed amount lexeme.
   */
  amountClasses: {
    outflow: "empty" | "valid-zero" | "valid-nonzero" | "invalid";
    inflow: "empty" | "valid-zero" | "valid-nonzero" | "invalid";
  };
};

export type YuantaDomesticDepositTelemetryManifest = {
  telemetryVersion: typeof YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION;
  evidenceVersion: typeof YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION;
  source: "yuanta";
  observedAt: string;
  account: {
    valueDigest: `sha256:${string}`;
    labelDigest: `sha256:${string}`;
  };
  queryRange: {
    dateRange: string;
    startDate: string;
    endDate: string;
  };
  downloads: {
    filenameDigest: `sha256:${string}`;
    byteLength: number;
    contentDigest: `sha256:${string}`;
    columnNames: string[];
    columnCount: 11;
    rowCount: number;
    rows: YuantaDomesticDepositTelemetryRow[];
  }[];
  /** This boundary records source observation only; it cannot admit finance. */
  canonicalAdmission: "blocked";
  sourceStage: "telemetry-only";
};

const VALIDATED_YUANTA_EVIDENCE = new WeakSet<object>();

function yuantaDigest(
  domain: string,
  ...values: readonly string[]
): `sha256:${string}` {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const value of values) hash.update("\0").update(value);
  return `sha256:${hash.digest("base64url")}`;
}

function normalizedCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+/, "")
    .replace(/'+$/, "");
}

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
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
  const normalized = normalizedCell(value).replace(/[-/]/g, "");
  if (!/^\d{8}$/.test(normalized))
    throw new Error("Yuanta source date is invalid.");
  const formatted = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  if (!validCalendarDate(formatted))
    throw new Error("Yuanta source date is invalid.");
  return normalized;
}

function validObservedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00$/.test(value))
    return false;
  return Number.isFinite(Date.parse(value));
}

function validDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[A-Za-z0-9_-]+$/.test(value);
}

function validSourceTime(value: string): boolean {
  const match = normalizedCell(value).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return false;
  return (
    Number(match[1]) < 24 &&
    Number(match[2]) < 60 &&
    (match[3] === undefined || Number(match[3]) < 60)
  );
}

function validSourceDate(value: string): boolean {
  const normalized = normalizedCell(value).replace(/[-/]/g, "");
  if (!/^\d{8}$/.test(normalized)) return false;
  return validCalendarDate(
    `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`,
  );
}

function validSourceAmount(value: string): boolean {
  const normalized = normalizedCell(value);
  return (
    /^\d+(?:\.\d+)?$/.test(normalized) ||
    /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(normalized)
  );
}

type YuantaDomesticDepositTelemetryAmountClass =
  "empty" | "valid-zero" | "valid-nonzero" | "invalid";

function sourceAmountCellClass(
  value: unknown,
): YuantaDomesticDepositTelemetryAmountClass {
  const normalized = normalizedCell(value);
  if (!normalized) return "empty";
  if (!validSourceAmount(normalized)) return "invalid";
  const coefficient = normalized.replace(/,/g, "").replace(".", "");
  return BigInt(coefficient) === 0n ? "valid-zero" : "valid-nonzero";
}

function sourceAmountShape(
  cells: readonly string[],
): YuantaDomesticDepositTelemetryRow["amountShape"] {
  const outflowClass = sourceAmountCellClass(cells[6]);
  const inflowClass = sourceAmountCellClass(cells[7]);
  if (outflowClass === "invalid" || inflowClass === "invalid") return "invalid";
  const hasOutflow = outflowClass === "valid-nonzero";
  const hasInflow = inflowClass === "valid-nonzero";
  if (hasOutflow && hasInflow) return "conflict";
  if (!hasOutflow && !hasInflow) return "empty";
  return hasOutflow ? "outflow" : "inflow";
}

function diagnostic(
  diagnostics: YuantaDomesticDepositCaptureDiagnostic[],
  code: YuantaDomesticDepositCaptureDiagnostic,
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

/** Convert parser output into an immutable, structurally checked capture. */
export function admitYuantaDomesticDepositCaptureEvidence(
  capture: YuantaDomesticDepositCaptureInput,
): YuantaDomesticDepositCaptureValidationResult {
  const diagnostics: YuantaDomesticDepositCaptureDiagnostic[] = [];
  if (!capture || typeof capture !== "object") {
    diagnostic(diagnostics, "capture-missing");
    return { status: "rejected", capture: null, diagnostics };
  }
  if (capture.evidenceVersion !== YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION)
    diagnostic(diagnostics, "evidence-version-invalid");
  if (capture.source !== "yuanta") diagnostic(diagnostics, "source-invalid");
  if (!validObservedAt(capture.observedAt))
    diagnostic(diagnostics, "observed-at-invalid");
  if (
    !capture.account ||
    typeof capture.account.value !== "string" ||
    !normalizedCell(capture.account.value) ||
    typeof capture.account.label !== "string" ||
    !normalizedCell(capture.account.label)
  )
    diagnostic(diagnostics, "account-invalid");
  if (
    !capture.queryRange ||
    typeof capture.queryRange !== "object" ||
    typeof capture.queryRange.dateRange !== "string" ||
    !YUANTA_DOMESTIC_DEPOSIT_DATE_RANGES.includes(
      capture.queryRange.dateRange as YuantaDomesticDepositDateRange,
    ) ||
    typeof capture.queryRange.startDate !== "string" ||
    typeof capture.queryRange.endDate !== "string" ||
    !normalizedCell(capture.queryRange.dateRange) ||
    !validCalendarDate(capture.queryRange.startDate) ||
    !validCalendarDate(capture.queryRange.endDate) ||
    sourceDate(capture.queryRange.startDate) >
      sourceDate(capture.queryRange.endDate)
  )
    diagnostic(diagnostics, "query-range-invalid");
  if (!Array.isArray(capture.downloads) || capture.downloads.length === 0) {
    diagnostic(diagnostics, "downloads-missing");
  } else {
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
        !validDigest(download.contentDigest)
      )
        diagnostic(diagnostics, "download-fingerprint-invalid");
      if (
        !Array.isArray(download.columnNames) ||
        download.columnNames.length !==
          YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES.length ||
        download.columnNames.some(
          (name: unknown, index: number) =>
            normalizedCell(name) !==
            YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES[index],
        )
      )
        diagnostic(diagnostics, "download-columns-invalid");
      if (!Array.isArray(download.rows)) {
        diagnostic(diagnostics, "row-shape-invalid");
        continue;
      }
      for (const [rowIndex, row] of download.rows.entries()) {
        if (!row || typeof row !== "object") {
          diagnostic(diagnostics, "row-shape-invalid");
          continue;
        }
        if (row.rowOrdinal !== rowIndex)
          diagnostic(diagnostics, "row-order-invalid");
        if (!Array.isArray(row.values)) {
          diagnostic(diagnostics, "row-cell-invalid");
        } else if (
          row.values.length !== YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES.length
        ) {
          diagnostic(diagnostics, "row-width-invalid");
        } else if (
          row.values.some((value: unknown) => typeof value !== "string")
        ) {
          diagnostic(diagnostics, "row-cell-invalid");
        } else {
          const values = row.values;
          if (
            !validSourceDate(values[2] ?? "") ||
            !validSourceDate(values[3] ?? "")
          )
            diagnostic(diagnostics, "row-date-invalid");
          if (!validSourceTime(values[4] ?? ""))
            diagnostic(diagnostics, "row-time-invalid");
          const amountShape = sourceAmountShape(values);
          const outflow = normalizedCell(values[6] ?? "");
          const inflow = normalizedCell(values[7] ?? "");
          if (
            (outflow && !validSourceAmount(outflow)) ||
            (inflow && !validSourceAmount(inflow)) ||
            amountShape === "invalid"
          )
            diagnostic(diagnostics, "row-amount-invalid");
        }
      }
    }
  }
  if (
    !capture.provenance ||
    capture.provenance.source !== "yuanta-ebank-domestic-deposit-csv" ||
    capture.provenance.encoding !== "big5" ||
    capture.provenance.responseBodyRetained !== false ||
    capture.provenance.semantics !== "unresolved" ||
    capture.provenance.querySelector !== "#acctno" ||
    capture.provenance.submitSelector !== "#submitbutton" ||
    capture.provenance.downloadSelector !== "a.order_2.m_color_check" ||
    capture.provenance.telemetryVersion !==
      YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION
  )
    diagnostic(diagnostics, "provenance-invalid");

  if (diagnostics.length > 0)
    return { status: "rejected", capture: null, diagnostics };
  deepFreeze(capture);
  VALIDATED_YUANTA_EVIDENCE.add(capture);
  return {
    status: "admissible",
    capture: capture as YuantaDomesticDepositValidatedEvidence,
    diagnostics,
  };
}

export function isAdmittedYuantaDomesticDepositCaptureEvidence(
  value: unknown,
): value is YuantaDomesticDepositValidatedEvidence {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_YUANTA_EVIDENCE.has(value)
  );
}

/**
 * Redact one admitted source capture for workflow output. The input may carry
 * account selectors and CSV cells transiently, but this return value contains
 * only opaque digests, fixed column names, row ordinals, and shape metadata.
 * No financial admission or canonical writer is reachable from this seam.
 */
export function createYuantaDomesticDepositTelemetryManifest(
  capture: YuantaDomesticDepositValidatedEvidence,
): YuantaDomesticDepositTelemetryManifest {
  if (!isAdmittedYuantaDomesticDepositCaptureEvidence(capture))
    throw new Error("Yuanta telemetry requires structural source admission.");

  return {
    telemetryVersion: YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
    evidenceVersion: capture.evidenceVersion,
    source: "yuanta",
    observedAt: capture.observedAt,
    account: {
      valueDigest: yuantaDigest(
        "yuanta-telemetry-account-value-v1",
        capture.account.value,
      ),
      labelDigest: yuantaDigest(
        "yuanta-telemetry-account-label-v1",
        capture.account.label,
      ),
    },
    queryRange: { ...capture.queryRange },
    downloads: capture.downloads.map((download) => ({
      filenameDigest: yuantaDigest(
        "yuanta-telemetry-filename-v1",
        download.filename,
      ),
      byteLength: download.byteLength,
      contentDigest: download.contentDigest,
      columnNames: [...YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES],
      columnCount: 11,
      rowCount: download.rows.length,
      rows: download.rows.map((row) => {
        const cells = row.values.map(normalizedCell);
        return {
          rowOrdinal: row.rowOrdinal,
          rowFingerprint: yuantaDigest(
            "yuanta-telemetry-row-v1",
            String(row.rowOrdinal),
            ...cells,
          ),
          cellDigests: cells.map((cell) =>
            yuantaDigest("yuanta-telemetry-cell-v1", cell),
          ),
          cellCount: 11,
          amountShape: sourceAmountShape(cells),
          amountClasses: {
            outflow: sourceAmountCellClass(cells[6]),
            inflow: sourceAmountCellClass(cells[7]),
          },
        };
      }),
    })),
    canonicalAdmission: "blocked",
    sourceStage: "telemetry-only",
  };
}

/**
 * Convert the validated CSV boundary into de-identified durable source
 * evidence. Raw account values, labels, descriptions, notes, amounts and
 * downloaded bytes never enter the source ledger; only scoped digests and
 * structural counts cross this boundary.
 */
export function createYuantaDomesticDepositSourceEvidence(
  capture: YuantaDomesticDepositValidatedEvidence,
  captureId: string,
  sourceIdentity: Readonly<{
    sourceConnectionScope?: string;
    sourceConnectionKey?: string;
  }>,
): CanonicalSourceEvidence {
  if (!isAdmittedYuantaDomesticDepositCaptureEvidence(capture))
    throw new Error("Yuanta source evidence requires structural admission.");
  if (typeof captureId !== "string" || captureId.trim() === "")
    throw new Error("Yuanta source evidence capture ID is required.");
  if (capture.downloads.some((download) => download.terminal !== true))
    throw new Error(
      "Yuanta source evidence requires a terminal CSV download for the requested range.",
    );
  const stableSourceIdentity = requireSourceConnectionIdentity(
    "yuanta",
    "Yuanta source evidence",
    sourceIdentity,
  );
  const identity = deriveYuantaDomesticDepositAccountIdentity(
    capture.account,
    getYuantaHumanAttestedV2Manifest(),
    stableSourceIdentity.sourceConnectionKey,
  );
  const startDate = sourceDate(capture.queryRange.startDate);
  const endDate = sourceDate(capture.queryRange.endDate);
  const pageRows = capture.downloads.map((download, pageOrdinal) => ({
    download,
    pageOrdinal,
  }));
  return {
    captureId: captureId.trim(),
    integrationNamespace: "yuanta",
    sourceConnectionKey: identity.sourceConnectionKey,
    identityEpoch: identity.identityEpochKey,
    stream: "domestic-deposit",
    recordKind: YUANTA_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND,
    routeKey: YUANTA_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
    contractVersion: YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    subjectDigest: identity.subjectDigest,
    observedAt: capture.observedAt,
    scope: {
      startDate,
      endDate,
      kind: "bounded-range",
      completeness: "complete-range",
      ruleVersion: YUANTA_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION,
    },
    pages: pageRows.map(({ download, pageOrdinal }) => ({
      pageOrdinal,
      responseCode: "200",
      rowCount: download.rows.length,
      terminal: download.terminal === true,
      metadata: {
        filenameDigest: yuantaDigest(
          "yuanta-source-filename-v2",
          download.filename,
        ),
        contentDigest: download.contentDigest,
        byteLength: download.byteLength,
        columnCount: download.columnNames.length,
        accountValueDigest: yuantaDigest(
          "yuanta-source-account-value-v2",
          capture.account.value,
        ),
        accountLabelDigest: yuantaDigest(
          "yuanta-source-account-label-v2",
          capture.account.label,
        ),
        zeroResultAuthority: capture.zeroResultAuthority ?? null,
      },
    })),
    records: pageRows.flatMap(({ download, pageOrdinal }) =>
      download.rows.map((row) => {
        const cells = row.values.map(normalizedCell);
        const identityCells = normalizedYuantaRowForIdentity(row.values);
        const rowDigest = yuantaDigest(
          "yuanta-source-row-v2",
          String(pageOrdinal),
          String(row.rowOrdinal),
          ...identityCells,
        );
        const occurrenceKey = yuantaDigest(
          "yuanta-source-occurrence-v2",
          identity.subjectDigest,
          identity.identityEpochKey,
          String(pageOrdinal),
          String(row.rowOrdinal),
          rowDigest,
        );
        return {
          occurrenceKey,
          collisionKey: yuantaDigest(
            "yuanta-source-collision-v2",
            identity.subjectDigest,
            rowDigest,
          ),
          providerKey: rowDigest,
          contentHash: yuantaDigest("yuanta-source-content-v2", rowDigest),
          compact: {
            evidenceVersion: capture.evidenceVersion,
            pageOrdinal,
            rowOrdinal: row.rowOrdinal,
            rowDigest,
            cellCount: cells.length,
            amountShape: sourceAmountShape(cells),
            semanticStatus: "observed-structural-only",
          },
        };
      }),
    ),
  };
}

export async function commitYuantaDomesticDepositSourceEvidence(
  store: CanonicalSourceStore,
  capture: YuantaDomesticDepositValidatedEvidence,
  captureId: string,
  sourceIdentity: Readonly<{
    sourceConnectionScope?: string;
    sourceConnectionKey?: string;
  }>,
): Promise<CanonicalSourceCommitResult> {
  return commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(
      createYuantaDomesticDepositSourceEvidence(
        capture,
        captureId,
        sourceIdentity,
      ),
    ),
  );
}

export const YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION =
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION;
export const YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY =
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE;
export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS =
  "canonical-human-attested" as const;
export const YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY = "TWD" as const;
export const YUANTA_DOMESTIC_DEPOSIT_POSTING_ORIGIN = "human-attested" as const;
export const YUANTA_DOMESTIC_DEPOSIT_POSTING_BASIS =
  "statement-posted-history" as const;
export const YUANTA_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS =
  "transaction-time" as const;
export const YUANTA_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei" as const;
export const YUANTA_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS =
  "exact-ui-range-terminal-download" as const;
export const YUANTA_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY =
  "provider-explicit-no-data" as const;
export const YUANTA_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION =
  "yuanta/domestic-deposit/human-attested-v2" as const;
export const YUANTA_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE =
  "yuanta/domestic-deposit/capture-evidence-v2" as const;
export const YUANTA_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND =
  "yuanta-domestic-deposit-capture-evidence-v2" as const;
export const YUANTA_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION =
  "yuanta/domestic-deposit/capture-evidence-v2/terminal-download" as const;

/** Legacy v1 identifiers remain available for read-only compatibility tests. */
export const YUANTA_DOMESTIC_DEPOSIT_LEGACY_SOURCE_EVIDENCE_ROUTE =
  "yuanta/domestic-deposit/capture-evidence-v1" as const;
export const YUANTA_DOMESTIC_DEPOSIT_LEGACY_SOURCE_EVIDENCE_RECORD_KIND =
  "yuanta-domestic-deposit-capture-evidence" as const;
export const YUANTA_DOMESTIC_DEPOSIT_LEGACY_SOURCE_EVIDENCE_RULE_VERSION =
  "yuanta/domestic-deposit/capture-evidence-v1/terminal-download" as const;

export type YuantaDomesticDepositAccountIdentity = {
  accountNo: string;
  sourceConnectionKey: `sha256:${string}`;
  identityEpochKey: string;
  subjectDigest: string;
};

function sourceAccountDigest(accountValue: string): string {
  return yuantaDigest("yuanta-account-selector-v1", accountValue);
}

type YuantaSourceConnectionResolution = {
  sourceConnectionKey: `sha256:${string}` | null;
  diagnostics: string[];
};

/**
 * Resolve a stable workflow login identity without mixing in the selected
 * account or human-attestation epoch. Financial admission has no
 * manifest-derived fallback.
 */
function resolveYuantaSourceConnection(
  input: YuantaDomesticDepositFinancialAdmissionInput,
): YuantaSourceConnectionResolution {
  const validated = validateSourceConnectionIdentity("yuanta", input);
  return {
    sourceConnectionKey: validated.sourceConnectionKey,
    diagnostics: [...validated.defects],
  };
}

/**
 * The selector value is reduced to a local domain digest. The display label,
 * dates, filenames, and row content never participate in account identity.
 * Omitting sourceConnectionKey is a non-persistable compatibility calculation:
 * every source or financial admission path supplies the validated workflow key.
 */
export function deriveYuantaDomesticDepositAccountIdentity(
  account: YuantaDomesticDepositCaptureEvidence["account"],
  manifest: YuantaHumanAttestedManifest = getYuantaHumanAttestedV2Manifest(),
  sourceConnectionKey?: `sha256:${string}`,
): YuantaDomesticDepositAccountIdentity {
  const v2 =
    manifest.authorityRoute === YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE;
  const subjectDigest = sourceAccountDigest(account.value);
  return {
    accountNo: subjectDigest,
    sourceConnectionKey:
      sourceConnectionKey ??
      yuantaDigest(
        v2 ? "yuanta-source-connection-v2" : "yuanta-source-connection-v1",
        "yuanta",
        manifest.attestationId,
        manifest.evidenceVersion,
      ),
    identityEpochKey: v2
      ? yuantaHumanAttestedV2IdentityEpochKey(
          manifest as YuantaHumanAttestedV2Manifest,
        )
      : yuantaHumanAttestedIdentityEpochKey(manifest),
    subjectDigest,
  };
}

export type YuantaDomesticDepositFinancialSemantics = {
  evidenceVersion: typeof YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION;
  account: {
    accountNo: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountType: "depository";
    currency: typeof YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY;
  };
  authority: {
    route: typeof YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
    scope: "personal-authenticated-session";
    membershipEffectiveDate: null;
  };
  posting: {
    status: "posted";
    origin: typeof YUANTA_DOMESTIC_DEPOSIT_POSTING_ORIGIN;
    basis: typeof YUANTA_DOMESTIC_DEPOSIT_POSTING_BASIS;
    ruleVersion: typeof YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
  };
  direction: {
    outflowCellIndex: 6;
    inflowCellIndex: 7;
    ruleVersion: typeof YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
  };
  effectiveTime: {
    basis: typeof YUANTA_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS;
    timeZone: typeof YUANTA_DOMESTIC_DEPOSIT_TIME_ZONE;
    ruleVersion: typeof YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
  };
  cancellation: {
    rule: "unsupported-reject";
    ruleVersion: typeof YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
  };
  completeness: {
    basis: typeof YUANTA_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS;
    ruleVersion: typeof YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
    absenceAuthority: typeof YUANTA_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY;
  };
  occurrence: {
    ruleVersion: typeof YUANTA_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION;
    providerGuaranteed: false;
  };
};

export function buildYuantaHumanAttestedFinancialSemantics(
  capture: YuantaDomesticDepositCaptureEvidence,
  manifest: YuantaHumanAttestedV2Manifest = getYuantaHumanAttestedV2Manifest(),
  sourceConnectionKey?: `sha256:${string}`,
): YuantaDomesticDepositFinancialSemantics {
  const identity = deriveYuantaDomesticDepositAccountIdentity(
    capture.account,
    manifest,
    sourceConnectionKey,
  );
  return {
    evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    account: {
      ...identity,
      accountType: "depository",
      currency: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
    },
    authority: {
      route: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      scope: "personal-authenticated-session",
      membershipEffectiveDate: null,
    },
    posting: {
      status: "posted",
      origin: YUANTA_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
      basis: YUANTA_DOMESTIC_DEPOSIT_POSTING_BASIS,
      ruleVersion: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    direction: {
      outflowCellIndex: 6,
      inflowCellIndex: 7,
      ruleVersion: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    effectiveTime: {
      basis: YUANTA_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
      timeZone: YUANTA_DOMESTIC_DEPOSIT_TIME_ZONE,
      ruleVersion: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    cancellation: {
      rule: "unsupported-reject",
      ruleVersion: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    completeness: {
      basis: YUANTA_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
      ruleVersion: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      absenceAuthority: YUANTA_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
    },
    occurrence: {
      ruleVersion: YUANTA_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
      providerGuaranteed: false,
    },
  };
}

export type YuantaDomesticDepositFinancialAdmissionDiagnostic = string;
export type YuantaDomesticDepositFinancialAdmissionInput = {
  capture: YuantaDomesticDepositValidatedEvidence;
  captureId: string;
  humanAttestation?: YuantaHumanAttestedV2Manifest;
  semantics?: YuantaDomesticDepositFinancialSemantics;
  /**
   * Stable login identity supplied by the workflow. It is independent of
   * account attestation and its identity epoch. Both fields are mandatory for
   * financial admission; manifest identity remains provenance only.
   */
  sourceConnectionScope?: string;
  sourceConnectionKey?: string;
};
export type YuantaDomesticDepositFinancialAdmissionResult = {
  status: "admitted" | "blocked";
  capture: CanonicalFinancialDepositValidatedCapture | null;
  diagnostics: YuantaDomesticDepositFinancialAdmissionDiagnostic[];
};

export class YuantaDomesticDepositFinancialAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YuantaDomesticDepositFinancialAdmissionError";
  }
}

function normalizedFinancialCell(value: unknown): string {
  return normalizedCell(value).replace(/,/g, "");
}

function normalizeFinancialAmountParts(
  coefficient: string,
  scale: number,
): { coefficient: string; scale: number } {
  let normalizedCoefficient = coefficient.replace(/^0+(?=\d)/, "") || "0";
  let normalizedScale = scale;
  while (normalizedScale > 0 && normalizedCoefficient.endsWith("0")) {
    normalizedCoefficient = normalizedCoefficient.slice(0, -1) || "0";
    normalizedScale -= 1;
  }
  return { coefficient: normalizedCoefficient, scale: normalizedScale };
}

function parseFinancialAmount(
  value: unknown,
  allowZero = false,
): { coefficient: string; scale: number } | null {
  const normalized = normalizedFinancialCell(value);
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parts = normalized.split(".");
  const coefficient = (parts[0] ?? "") + (parts[1] ?? "");
  const trimmed = coefficient.replace(/^0+(?=\d)/, "") || "0";
  if (!allowZero && BigInt(trimmed) === 0n) return null;
  return normalizeFinancialAmountParts(trimmed, (parts[1] ?? "").length);
}

/**
 * Source exports have used both fixed-width zero-padded amounts and ordinary
 * decimal lexemes. Remove insignificant scale so equivalent numeric values
 * share one content/occurrence representation. Invalid cells remain untouched
 * so structural admission still rejects them instead of guessing.
 */
function normalizedFinancialIdentityCell(value: unknown): string {
  const parsed = parseFinancialAmount(value, true);
  return parsed
    ? `${parsed.coefficient}:${String(parsed.scale)}`
    : normalizedCell(value);
}

function normalizedYuantaRowForIdentity(values: readonly string[]): string[] {
  return values.map((value, index) =>
    index === 6 || index === 7 || index === 8
      ? normalizedFinancialIdentityCell(value)
      : normalizedCell(value),
  );
}

function canonicalDate(value: string): string | null {
  const normalized = normalizedCell(value).replace(/[-/]/g, "");
  if (!/^\d{8}$/.test(normalized)) return null;
  const formatted =
    normalized.slice(0, 4) +
    "-" +
    normalized.slice(4, 6) +
    "-" +
    normalized.slice(6, 8);
  return validCalendarDate(formatted) ? formatted : null;
}

function canonicalTime(value: string): string | null {
  const match = normalizedCell(value).match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  if (Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 59)
    return null;
  return (
    String(Number(match[1])).padStart(2, "0") + ":" + match[2] + ":" + match[3]
  );
}

function sourceTransactionTime(values: readonly string[]): {
  accountingDate: string;
  localDate: string;
  localTime: string;
  epochMilliseconds: number;
} | null {
  const accountingDate = canonicalDate(values[2] ?? "");
  const localDate = canonicalDate(values[3] ?? "");
  const localTime = canonicalTime(values[4] ?? "");
  if (!accountingDate || !localDate || !localTime) return null;
  const epochMilliseconds = Date.parse(localDate + "T" + localTime + "+08:00");
  if (!Number.isSafeInteger(epochMilliseconds)) return null;
  return { accountingDate, localDate, localTime, epochMilliseconds };
}

function unsupportedAuthorityLabel(label: string): boolean {
  return /共同|共有|聯名|联名|聯合|联合|代理|代管|joint|shared|co[- ]?owner|authorized/i.test(
    label,
  );
}

function unsupportedCurrencyLabel(label: string): boolean {
  return /(?:\bUSD\b|\bEUR\b|\bJPY\b|\bCNY\b|\bHKD\b|\bGBP\b|外幣|外汇|外匯)/i.test(
    label,
  );
}

function unsupportedCancellation(values: readonly string[]): boolean {
  return /撤銷|撤销|沖正|冲正|更正|取消|退回|回沖|回冲|退款|reversal|reversed|correction|cancel/i.test(
    values.map(normalizedCell).join(" "),
  );
}

function financialOpaque(domain: string, ...parts: string[]): string {
  return yuantaDigest(domain, ...parts);
}

function rangeDate(value: string): string {
  return normalizedCell(value).replace(/\//g, "-");
}

function financialRecord(
  identity: YuantaDomesticDepositAccountIdentity,
  row: YuantaDomesticDepositRawRow,
  pageOrdinal: number,
  semantics: YuantaDomesticDepositFinancialSemantics,
): { record: CanonicalFinancialDepositRecord | null; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const values = row.values;
  const time = sourceTransactionTime(values);
  if (!time) {
    diagnostics.push("source-date-invalid", "source-time-invalid");
    return { record: null, diagnostics };
  }
  const outflowText = normalizedCell(
    values[semantics.direction.outflowCellIndex],
  );
  const inflowText = normalizedCell(
    values[semantics.direction.inflowCellIndex],
  );
  const outflowClass = sourceAmountCellClass(outflowText);
  const inflowClass = sourceAmountCellClass(inflowText);
  const outflow =
    outflowClass === "valid-nonzero" ? parseFinancialAmount(outflowText) : null;
  const inflow =
    inflowClass === "valid-nonzero" ? parseFinancialAmount(inflowText) : null;
  const hasOutflow = outflowClass === "valid-nonzero";
  const hasInflow = inflowClass === "valid-nonzero";
  const outflowPresent =
    outflowClass === "valid-nonzero" || outflowClass === "invalid";
  const inflowPresent =
    inflowClass === "valid-nonzero" || inflowClass === "invalid";
  if ((outflowPresent && inflowPresent) || (!hasOutflow && !hasInflow))
    diagnostics.push("amount-column-conflict");
  if (outflowClass === "invalid" || inflowClass === "invalid")
    diagnostics.push("amount-invalid");
  const amount = outflow ?? inflow;
  const direction = outflow ? "outflow" : inflow ? "inflow" : null;
  const balanceAfter = parseFinancialAmount(values[8], true);
  if (!amount) diagnostics.push("amount-invalid");
  if (!balanceAfter) diagnostics.push("balance-invalid");
  if (unsupportedCancellation(values))
    diagnostics.push("cancellation-marker-unsupported");
  if (!amount || !balanceAfter || !direction)
    return { record: null, diagnostics };

  const description = normalizedCell(values[5]);
  const checkNumber = normalizedCell(values[9]);
  const note = normalizedCell(values[10]);
  const contentHash = financialOpaque(
    "yuanta-observed-content-v2",
    ...normalizedYuantaRowForIdentity(values),
  );
  const collisionKey = financialOpaque(
    "yuanta-observed-composite-fence-v2",
    identity.subjectDigest,
    time.accountingDate,
    time.localDate,
    time.localTime,
    direction,
    amount.coefficient,
    String(amount.scale),
    balanceAfter.coefficient,
    String(balanceAfter.scale),
  );
  const occurrenceKey = financialOpaque(
    "yuanta-observed-composite-occurrence-v2",
    collisionKey,
    description,
    note,
    checkNumber,
  );
  return {
    record: {
      occurrenceKey,
      collisionKey,
      providerKey: collisionKey,
      contentHash,
      sequenceLexeme: String(pageOrdinal) + ":" + String(row.rowOrdinal),
      compactJson: JSON.stringify({
        evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
        accountDigest: identity.subjectDigest,
        pageOrdinal,
        rowOrdinal: row.rowOrdinal,
        accountingDate: time.accountingDate,
        transactionDate: time.localDate,
        transactionTime: time.localTime,
        direction,
        amount,
        balanceAfter,
        descriptionDigest: financialOpaque(
          "yuanta-description-v1",
          description,
        ),
        checkNumberDigest: financialOpaque(
          "yuanta-check-number-v1",
          checkNumber,
        ),
        noteDigest: financialOpaque("yuanta-note-v1", note),
        providerGuaranteed: false,
      }),
      amount,
      balanceAfter,
      currency: semantics.account.currency,
      direction,
      sourceTime: {
        localDate: time.localDate,
        localTime: time.localTime,
        timeZone: YUANTA_DOMESTIC_DEPOSIT_TIME_ZONE,
        epochMilliseconds: time.epochMilliseconds,
      },
      // The canonical effective date follows the transaction-time basis;
      // accountingDate remains compact source evidence only.
      effectiveOn: time.localDate,
      transactionDateTimeLocal: time.localDate + "T" + time.localTime,
    },
    diagnostics,
  };
}

function expectedSemantics(
  capture: YuantaDomesticDepositValidatedEvidence,
  manifest: YuantaHumanAttestedV2Manifest,
  sourceConnectionKey?: `sha256:${string}`,
): YuantaDomesticDepositFinancialSemantics {
  return buildYuantaHumanAttestedFinancialSemantics(
    capture,
    manifest,
    sourceConnectionKey,
  );
}

function financialDiagnosticsFor(
  input: YuantaDomesticDepositFinancialAdmissionInput,
): {
  diagnostics: string[];
  semantics: YuantaDomesticDepositFinancialSemantics | null;
  capture?: CanonicalFinancialDepositValidatedCapture;
} {
  const diagnostics: string[] = [];
  if (!input || typeof input !== "object") {
    return {
      diagnostics: ["capture-missing", "runtime-evidence-brand-missing"],
      semantics: null,
    };
  }
  if (!isAdmittedYuantaDomesticDepositCaptureEvidence(input.capture))
    diagnostics.push("runtime-evidence-brand-missing");
  if (!input.captureId || !input.captureId.trim())
    diagnostics.push("scope-invalid");
  const manifest = input.humanAttestation;
  if (!manifest) diagnostics.push("human-attestation-missing");
  else if (!isYuantaHumanAttestedV2Manifest(manifest))
    diagnostics.push("human-attestation-mismatch");
  if (!isYuantaHumanAttestedV2Active())
    diagnostics.push("human-attestation-revoked");
  if (!isAdmittedYuantaDomesticDepositCaptureEvidence(input.capture))
    return { diagnostics: [...new Set(diagnostics)], semantics: null };

  const currentManifest = manifest ?? getYuantaHumanAttestedV2Manifest();
  const sourceConnection = resolveYuantaSourceConnection(input);
  diagnostics.push(...sourceConnection.diagnostics);
  if (!sourceConnection.sourceConnectionKey)
    return { diagnostics: [...new Set(diagnostics)], semantics: null };
  const semantics =
    input.semantics ??
    expectedSemantics(
      input.capture,
      currentManifest,
      sourceConnection.sourceConnectionKey,
    );
  const identity = deriveYuantaDomesticDepositAccountIdentity(
    input.capture.account,
    currentManifest,
    sourceConnection.sourceConnectionKey,
  );
  if (
    semantics.account.accountNo !== identity.accountNo ||
    semantics.account.sourceConnectionKey !== identity.sourceConnectionKey ||
    semantics.account.identityEpochKey !== identity.identityEpochKey ||
    semantics.account.subjectDigest !== identity.subjectDigest
  )
    diagnostics.push("account-identity-mismatch");
  if (semantics.account.currency !== YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY)
    diagnostics.push("unsupported-currency");
  if (unsupportedCurrencyLabel(input.capture.account.label))
    diagnostics.push("unsupported-currency");
  if (unsupportedAuthorityLabel(input.capture.account.label))
    diagnostics.push("authority-shared-account");
  if (
    semantics.account.accountType !== "depository" ||
    semantics.authority.route !== YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY ||
    semantics.authority.scope !== "personal-authenticated-session" ||
    semantics.authority.membershipEffectiveDate !== null
  )
    diagnostics.push("authority-semantics-unproven");
  if (
    semantics.posting.status !== "posted" ||
    semantics.posting.origin !== YUANTA_DOMESTIC_DEPOSIT_POSTING_ORIGIN ||
    semantics.posting.basis !== YUANTA_DOMESTIC_DEPOSIT_POSTING_BASIS ||
    semantics.posting.ruleVersion !==
      YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("posting-semantics-unproven");
  if (
    semantics.direction.outflowCellIndex !== 6 ||
    semantics.direction.inflowCellIndex !== 7 ||
    semantics.direction.ruleVersion !==
      YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("direction-semantics-unproven");
  if (
    semantics.effectiveTime.basis !==
      YUANTA_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS ||
    semantics.effectiveTime.timeZone !== YUANTA_DOMESTIC_DEPOSIT_TIME_ZONE ||
    semantics.effectiveTime.ruleVersion !==
      YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("effective-time-semantics-unproven");
  if (
    semantics.cancellation.rule !== "unsupported-reject" ||
    semantics.cancellation.ruleVersion !==
      YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("cancellation-semantics-unproven");
  if (
    semantics.completeness.basis !==
      YUANTA_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS ||
    semantics.completeness.absenceAuthority !==
      YUANTA_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY ||
    semantics.completeness.ruleVersion !==
      YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("completeness-semantics-unproven");
  if (
    semantics.occurrence.ruleVersion !==
      YUANTA_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION ||
    semantics.occurrence.providerGuaranteed !== false
  )
    diagnostics.push("occurrence-identity-unproven");

  const downloads = input.capture.downloads;
  const hasRows = downloads.some((download) => download.rows.length > 0);
  if (
    downloads.some((download) => download.terminal !== true) ||
    downloads.length === 0
  )
    diagnostics.push("terminal-evidence-missing");
  if (
    !hasRows &&
    input.capture.zeroResultAuthority !== "provider-explicit-no-data"
  )
    diagnostics.push("zero-result-authority-unproven");

  const queryStart = rangeDate(input.capture.queryRange.startDate);
  const queryEnd = rangeDate(input.capture.queryRange.endDate);
  const seen = new Map<string, string>();
  const records: CanonicalFinancialDepositRecord[] = [];
  for (const [pageOrdinal, download] of downloads.entries()) {
    for (const row of download.rows) {
      const time = sourceTransactionTime(row.values);
      if (
        time &&
        (time.accountingDate < queryStart || time.accountingDate > queryEnd)
      )
        diagnostics.push("row-outside-query-range");
      const result = financialRecord(identity, row, pageOrdinal, semantics);
      diagnostics.push(...result.diagnostics);
      if (!result.record) continue;
      const previous = seen.get(result.record.collisionKey);
      if (previous !== undefined) {
        diagnostics.push("occurrence-ambiguous");
        if (previous !== result.record.occurrenceKey)
          diagnostics.push("composite-occurrence-collision");
        continue;
      }
      seen.set(result.record.collisionKey, result.record.occurrenceKey);
      records.push(result.record);
    }
  }
  if (diagnostics.length > 0)
    return { diagnostics: [...new Set(diagnostics)], semantics };

  const contractFingerprint = financialOpaque(
    "yuanta-contract-v2",
    YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  );
  const preflightFingerprint = financialOpaque(
    "yuanta-preflight-v2",
    identity.subjectDigest,
    input.capture.queryRange.startDate,
    input.capture.queryRange.endDate,
  );
  const capture = admitCanonicalFinancialDepositCapture({
    captureId: input.captureId.trim(),
    authorityRoute: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    contractVersion: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    identity: {
      integrationNamespace: "yuanta",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
      recordKind: "yuanta-domestic-deposit",
      subjectDigest: identity.subjectDigest,
      accountNo: identity.accountNo,
      accountType: semantics.account.accountType,
      currency: semantics.account.currency,
    },
    observedAt: input.capture.observedAt,
    scope: {
      startDate: queryStart,
      endDate: queryEnd,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: semantics.completeness.basis,
      completenessRuleVersion: semantics.completeness.ruleVersion,
      absenceAuthority: semantics.completeness.absenceAuthority,
      contractFingerprint,
      preflightFingerprint,
      pageCount: downloads.length,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: semantics.posting.status,
      postingOrigin: semantics.posting.origin,
      postingBasis: semantics.posting.basis,
      postingRuleVersion: semantics.posting.ruleVersion,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      effectiveTimeBasis: semantics.effectiveTime.basis,
      effectiveTimeRuleVersion: semantics.effectiveTime.ruleVersion,
      timeZone: semantics.effectiveTime.timeZone,
      timePrecision: "second",
      timeOrigin: "source_reported",
      requireBalance: true,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: downloads.map((download, pageOrdinal) => ({
      pageOrdinal,
      responseCode: "200",
      terminal: download.terminal === true,
      rowCount: download.rows.length,
      responseDigest: download.contentDigest,
      proofKind: semantics.completeness.basis,
      contractFingerprint,
      preflightFingerprint,
      metadataJson: JSON.stringify({
        pageOrdinal,
        filenameDigest: financialOpaque(
          "yuanta-filename-v1",
          download.filename,
        ),
        contentDigest: download.contentDigest,
        rowCount: download.rows.length,
        zeroResultAuthority: input.capture.zeroResultAuthority ?? null,
        providerGuaranteed: false,
      }),
    })),
    records,
  });
  return { diagnostics, semantics, capture };
}

export function admitYuantaDomesticDepositFinancialCapture(
  input: YuantaDomesticDepositFinancialAdmissionInput,
): YuantaDomesticDepositFinancialAdmissionResult {
  const result = financialDiagnosticsFor(input);
  if (result.diagnostics.length > 0 || !result.capture)
    return {
      status: "blocked",
      capture: null,
      diagnostics: result.diagnostics,
    };
  return { status: "admitted", capture: result.capture, diagnostics: [] };
}

/** Commit a validated Yuanta capture only through the explicit financial DB. */
export async function commitCanonicalYuantaDomesticDepositCapture(
  store: CanonicalFinancialDepositWriterStore,
  input: YuantaDomesticDepositFinancialAdmissionInput,
): Promise<CanonicalFinancialDepositCommitResult> {
  ensureYuantaHumanAttestationEvents(store.db);
  const latest = latestYuantaHumanAttestationEventV2(store.db);
  if (latest?.eventKind === "revoked")
    throw new YuantaDomesticDepositFinancialAdmissionError(
      "Yuanta human attestation is durably revoked; future admission is blocked.",
    );
  if (!isYuantaHumanAttestedV2Active())
    throw new YuantaDomesticDepositFinancialAdmissionError(
      "Yuanta human attestation is revoked; future admission is blocked.",
    );
  const admission = admitYuantaDomesticDepositFinancialCapture(input);
  if (admission.status !== "admitted" || !admission.capture)
    throw new YuantaDomesticDepositFinancialAdmissionError(
      `Yuanta domestic deposit canonical admission blocked: ${admission.diagnostics.join(", ")}`,
    );
  // The durable attestation event is intentionally independent of the
  // financial commit, but must exist before readiness can become live.
  recordInitialYuantaHumanAttestationV2IfMissing(
    store.db,
    input.capture.observedAt,
  );
  return commitCanonicalFinancialDepositCapture(store, admission.capture);
}

export function isYuantaSourceOnlyFinancialDiagnostic(
  diagnostic: YuantaDomesticDepositFinancialAdmissionDiagnostic,
): boolean {
  return new Set([
    "human-attestation-missing",
    "human-attestation-mismatch",
    "human-attestation-revoked",
    "unsupported-currency",
    "authority-shared-account",
    "authority-semantics-unproven",
    "completeness-semantics-unproven",
    "zero-result-authority-unproven",
    "terminal-evidence-missing",
  ]).has(diagnostic);
}

export {
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  getYuantaHumanAttestedV2Manifest,
  isYuantaHumanAttestedV2Manifest,
  isYuantaHumanAttestedV2Active,
  isYuantaHumanAttestationV2DurablyActive,
  latestYuantaHumanAttestationEventV2,
  recordInitialYuantaHumanAttestationV2IfMissing,
  restoreYuantaHumanAttestedV2,
  revokeYuantaHumanAttestedV2,
};
