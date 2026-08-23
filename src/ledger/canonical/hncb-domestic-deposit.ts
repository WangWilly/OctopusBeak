import { createHash } from "node:crypto";
import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";
import {
  admitCanonicalSourceEvidence,
  commitCanonicalSourceEvidence,
  type CanonicalSourceCommitResult,
  type CanonicalSourceEvidence,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
  HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  getHncbHumanAttestedV1Manifest,
  hncbHumanAttestedIdentityEpochKey,
  isHncbHumanAttestedV1Active,
  isHncbHumanAttestationDurablyActive,
  isHncbHumanAttestedV1Manifest,
  ensureHncbHumanAttestationEvents,
  latestHncbHumanAttestationEvent,
  recordInitialHncbHumanAttestationIfMissing,
  recordHncbHumanAttestationEvent,
  restoreHncbHumanAttestedV1,
  revokeHncbHumanAttestedV1,
  type HncbHumanAttestedV1Manifest,
} from "./hncb-human-attestation.ts";

export const HNCB_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "hncb",
  authority: "hncb/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "hncbStatements",
  expectedRowWidth: 11,
  accountingDateIndex: 2,
  transactionDateIndex: 0,
  transactionTimeIndex: 1,
  provenance: {
    evidenceBasis: "downloaded HTML workbook columns and provider no-data text",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 4,
  inflowIndex: 5,
  completenessEvidence: "none",
  explicitNoDataEvidence: {
    kind: "message",
    pattern: /查\s*無\s*資\s*料|無\s*資\s*料|無\s*交\s*易|查\s*無\s*符\s*合/u,
  },
} as const satisfies AdvertisedDomesticDepositContract;

export const HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-HNCB-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/01/31" },
  records: [
    {
      values: [
        "2026/01/02",
        "09:10:11",
        "2026/01/02",
        "TWD",
        "",
        "100",
        "100",
        "SYNTHETIC",
        "",
        "",
        "",
      ],
    },
  ],
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightHncbDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(HNCB_DOMESTIC_DEPOSIT_CONTRACT);

/**
 * HNCB source evidence is deliberately versioned separately from the
 * preflight contract. The provider export establishes an eleven-column
 * workbook shape, but it does not establish a permanent occurrence key,
 * posting status, cancellation semantics, timezone, pagination completeness,
 * or shared-account authority. This adapter therefore remains source-only.
 */
export const HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION =
  "capture-evidence-v1" as const;
export const HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE =
  "hncb/domestic-deposit/capture-evidence-v1" as const;
export const HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND =
  "hncb-domestic-deposit-capture-evidence-v1" as const;
export const HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION =
  "hncb/domestic-deposit/capture-evidence-v1/terminal-export" as const;
export const HNCB_DOMESTIC_DEPOSIT_IDENTITY_EPOCH =
  "hncb/domestic-deposit/capture-evidence-v1" as const;
export const HNCB_DOMESTIC_DEPOSIT_PROVIDER_GUARANTEED = false as const;

export const HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS =
  "canonical-human-attested" as const;
export const HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY =
  HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE;
export const HNCB_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION =
  HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION;
export const HNCB_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY = "TWD" as const;
export const HNCB_DOMESTIC_DEPOSIT_POSTING_ORIGIN = "human-attested" as const;
export const HNCB_DOMESTIC_DEPOSIT_POSTING_BASIS =
  "statement-posted-history" as const;
export const HNCB_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS =
  "transaction-time" as const;
export const HNCB_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei" as const;
export const HNCB_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS =
  "exact-ui-range-terminal-export" as const;
export const HNCB_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY =
  "provider-explicit-no-data" as const;
export const HNCB_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION =
  HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE;

export const HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES = [
  "交易日期",
  "交易時間",
  "帳務日期",
  "幣別",
  "支出金額",
  "存入金額",
  "即時餘額",
  "摘要",
  "存款人代號",
  "備註",
  "補摺日期/票據號碼",
] as const;

export type HncbDomesticDepositRawRow = {
  rowOrdinal: number;
  values: readonly string[];
};

export type HncbDomesticDepositDownloadEvidence = {
  filename: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
  columnNames: readonly string[];
  rows: readonly HncbDomesticDepositRawRow[];
  terminal: boolean;
};

export type HncbDomesticDepositCaptureEvidence = {
  evidenceVersion: typeof HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION;
  source: "hncb";
  product: "domestic-deposit";
  providerGuaranteed: false;
  observedAt: string;
  account: {
    value: string;
    label: string;
  };
  queryRange: {
    startDate: string;
    endDate: string;
  };
  downloads: readonly HncbDomesticDepositDownloadEvidence[];
  /** Required when the provider explicitly reports no matching records. */
  zeroResultAuthority?: "provider-explicit-no-data" | "unproven";
  provenance: {
    source: "hncb-ebank-domestic-deposit-html-workbook";
    encoding: "big5";
    responseBodyRetained: false;
    semantics: "unresolved";
    accountSelector: "select#acct1";
    queryFormSelector: 'form[name="form1"]';
    downloadSelector: 'input[name="excel_download"]';
  };
};

export type HncbDomesticDepositValidatedEvidence =
  HncbDomesticDepositCaptureEvidence & {
    readonly __runtimeValidatedHncbDomesticDepositEvidence: true;
  };

export type HncbDomesticDepositCaptureDiagnostic =
  | "capture-missing"
  | "evidence-version-invalid"
  | "source-invalid"
  | "observed-at-invalid"
  | "account-invalid"
  | "query-range-invalid"
  | "downloads-missing"
  | "download-count-invalid"
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

export type HncbDomesticDepositCaptureValidationResult = {
  status: "admissible" | "rejected";
  capture: HncbDomesticDepositValidatedEvidence | null;
  diagnostics: HncbDomesticDepositCaptureDiagnostic[];
};

const VALIDATED_HNCB_EVIDENCE = new WeakSet<object>();
const SHA256_TOKEN = /^sha256:[A-Za-z0-9_-]+$/;

function hncbDigest(
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
    .trim();
}

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
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
  if (!validCalendarDate(normalized))
    throw new Error("HNCB source date is invalid.");
  return normalized.replaceAll("/", "");
}

function validSourceTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = normalizedCell(value).match(/^(\d{2}):(\d{2}):(\d{2})$/);
  return (
    match !== null &&
    Number(match[1]) < 24 &&
    Number(match[2]) < 60 &&
    Number(match[3]) < 60
  );
}

function validUnsignedAmount(value: unknown): boolean {
  const normalized = normalizedCell(value);
  return (
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) ||
    /^(?:0|[1-9]\d{0,2})(?:,\d{3})+(?:\.\d+)?$/.test(normalized)
  );
}

function validBalance(value: unknown): boolean {
  const normalized = normalizedCell(value);
  return (
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) ||
    /^-?(?:0|[1-9]\d{0,2})(?:,\d{3})+(?:\.\d+)?$/.test(normalized)
  );
}

function isNonZeroAmount(value: string): boolean {
  const digits = value.replace(/,/g, "").replace(".", "");
  return digits.split("").some((digit) => digit !== "0");
}

function amountDirection(
  values: readonly string[],
): "inflow" | "outflow" | "invalid" {
  const outflow = normalizedCell(values[4]);
  const inflow = normalizedCell(values[5]);
  if (
    (outflow && !validUnsignedAmount(outflow)) ||
    (inflow && !validUnsignedAmount(inflow))
  )
    return "invalid";
  const hasOutflow = Boolean(outflow) && isNonZeroAmount(outflow);
  const hasInflow = Boolean(inflow) && isNonZeroAmount(inflow);
  if (hasOutflow === hasInflow) return "invalid";
  if (
    (outflow && !isNonZeroAmount(outflow)) ||
    (inflow && !isNonZeroAmount(inflow))
  )
    return "invalid";
  return hasOutflow ? "outflow" : "inflow";
}

function diagnostic(
  diagnostics: HncbDomesticDepositCaptureDiagnostic[],
  code: HncbDomesticDepositCaptureDiagnostic,
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

export function admitHncbDomesticDepositCaptureEvidence(
  capture: HncbDomesticDepositCaptureEvidence,
): HncbDomesticDepositCaptureValidationResult {
  const diagnostics: HncbDomesticDepositCaptureDiagnostic[] = [];
  if (!capture || typeof capture !== "object") {
    diagnostic(diagnostics, "capture-missing");
    return { status: "rejected", capture: null, diagnostics };
  }
  if (capture.evidenceVersion !== HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION)
    diagnostic(diagnostics, "evidence-version-invalid");
  if (capture.source !== "hncb") diagnostic(diagnostics, "source-invalid");
  if (capture.product !== "domestic-deposit")
    diagnostic(diagnostics, "source-invalid");
  if (capture.providerGuaranteed !== HNCB_DOMESTIC_DEPOSIT_PROVIDER_GUARANTEED)
    diagnostic(diagnostics, "source-invalid");
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
    !normalizedCell(capture.account.label)
  )
    diagnostic(diagnostics, "account-invalid");
  if (
    !capture.queryRange ||
    !validCalendarDate(capture.queryRange.startDate) ||
    !validCalendarDate(capture.queryRange.endDate) ||
    sourceDate(capture.queryRange.startDate) >
      sourceDate(capture.queryRange.endDate)
  )
    diagnostic(diagnostics, "query-range-invalid");
  if (!Array.isArray(capture.downloads) || capture.downloads.length === 0) {
    diagnostic(diagnostics, "downloads-missing");
  } else {
    if (capture.downloads.length !== 1)
      diagnostic(diagnostics, "download-count-invalid");
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
        !SHA256_TOKEN.test(download.contentDigest)
      )
        diagnostic(diagnostics, "download-fingerprint-invalid");
      if (
        !Array.isArray(download.columnNames) ||
        download.columnNames.length !==
          HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES.length ||
        download.columnNames.some(
          (name: unknown, index: number) =>
            normalizedCell(name) !== HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES[index],
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
        if (row.values.length !== HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES.length) {
          diagnostic(diagnostics, "row-width-invalid");
          continue;
        }
        if (row.values.some((value: unknown) => typeof value !== "string")) {
          diagnostic(diagnostics, "row-cell-invalid");
          continue;
        }
        const values = row.values;
        if (!validCalendarDate(values[0]) || !validCalendarDate(values[2]))
          diagnostic(diagnostics, "row-date-invalid");
        if (!validSourceTime(values[1]))
          diagnostic(diagnostics, "row-time-invalid");
        if (normalizedCell(values[3]) !== "TWD")
          diagnostic(diagnostics, "row-currency-invalid");
        const direction = amountDirection(values);
        if (direction === "invalid") {
          const outflow = normalizedCell(values[4]);
          const inflow = normalizedCell(values[5]);
          if (
            (outflow &&
              validUnsignedAmount(outflow) &&
              !isNonZeroAmount(outflow)) ||
            (inflow &&
              validUnsignedAmount(inflow) &&
              !isNonZeroAmount(inflow)) ||
            (outflow &&
              inflow &&
              isNonZeroAmount(outflow) &&
              isNonZeroAmount(inflow))
          )
            diagnostic(diagnostics, "row-amount-conflict");
          else diagnostic(diagnostics, "row-amount-invalid");
        }
        if (!normalizedCell(values[6]) || !validBalance(values[6]))
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
    capture.provenance.source !== "hncb-ebank-domestic-deposit-html-workbook" ||
    capture.provenance.encoding !== "big5" ||
    capture.provenance.responseBodyRetained !== false ||
    capture.provenance.semantics !== "unresolved" ||
    capture.provenance.accountSelector !== "select#acct1" ||
    capture.provenance.queryFormSelector !== 'form[name="form1"]' ||
    capture.provenance.downloadSelector !== 'input[name="excel_download"]'
  )
    diagnostic(diagnostics, "provenance-invalid");

  if (diagnostics.length > 0)
    return { status: "rejected", capture: null, diagnostics };
  deepFreeze(capture);
  VALIDATED_HNCB_EVIDENCE.add(capture);
  return {
    status: "admissible",
    capture: capture as HncbDomesticDepositValidatedEvidence,
    diagnostics,
  };
}

export function isAdmittedHncbDomesticDepositCaptureEvidence(
  value: unknown,
): value is HncbDomesticDepositValidatedEvidence {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_HNCB_EVIDENCE.has(value)
  );
}

export type HncbDomesticDepositAccountIdentity = {
  sourceConnectionKey: `sha256:${string}`;
  identityEpochKey: `sha256:${string}`;
  subjectDigest: `sha256:${string}`;
};

export function deriveHncbDomesticDepositAccountIdentity(
  account: HncbDomesticDepositCaptureEvidence["account"],
): HncbDomesticDepositAccountIdentity {
  const subjectDigest = hncbDigest(
    "hncb-source-account-v1",
    normalizedCell(account.value),
  );
  return {
    sourceConnectionKey: hncbDigest(
      "hncb-source-connection-v1",
      "account-scope",
    ),
    identityEpochKey: hncbDigest(
      "hncb-source-identity-epoch-v1",
      HNCB_DOMESTIC_DEPOSIT_IDENTITY_EPOCH,
    ),
    subjectDigest,
  };
}

function sourceEvidenceForCapture(
  capture: HncbDomesticDepositValidatedEvidence,
  captureId: string,
): CanonicalSourceEvidence {
  if (!isAdmittedHncbDomesticDepositCaptureEvidence(capture))
    throw new Error("HNCB source evidence requires structural admission.");
  if (!captureId.trim())
    throw new Error("HNCB source evidence capture ID is required.");
  const identity = deriveHncbDomesticDepositAccountIdentity(capture.account);
  const startDate = sourceDate(capture.queryRange.startDate);
  const endDate = sourceDate(capture.queryRange.endDate);
  const pages = capture.downloads.map((download, pageOrdinal) => ({
    download,
    pageOrdinal,
  }));
  return {
    captureId: captureId.trim(),
    integrationNamespace: "hncb",
    sourceConnectionKey: identity.sourceConnectionKey,
    identityEpoch: identity.identityEpochKey,
    stream: "domestic-deposit",
    recordKind: HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND,
    routeKey: HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
    contractVersion: HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    subjectDigest: identity.subjectDigest,
    observedAt: capture.observedAt,
    scope: {
      startDate,
      endDate,
      kind: "bounded-range",
      completeness: "single-page",
      ruleVersion: HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION,
    },
    pages: pages.map(({ download, pageOrdinal }) => ({
      pageOrdinal,
      responseCode: "200",
      rowCount: download.rows.length,
      terminal: download.terminal,
      metadata: {
        filenameDigest: hncbDigest(
          "hncb-source-filename-v1",
          download.filename,
        ),
        contentDigest: download.contentDigest,
        byteLength: download.byteLength,
        columnCount: download.columnNames.length,
        accountValueDigest: hncbDigest(
          "hncb-source-account-value-v1",
          capture.account.value,
        ),
        accountLabelDigest: hncbDigest(
          "hncb-source-account-label-v1",
          capture.account.label,
        ),
        zeroResultAuthority: capture.zeroResultAuthority ?? null,
        completeness: "unproven",
      },
    })),
    records: pages.flatMap(({ download, pageOrdinal }) =>
      download.rows.map((row) => {
        const cells = row.values.map(normalizedCell);
        const rowDigest = hncbDigest(
          "hncb-source-row-v1",
          String(pageOrdinal),
          String(row.rowOrdinal),
          ...cells,
        );
        return {
          occurrenceKey: hncbDigest(
            "hncb-source-occurrence-v1",
            identity.subjectDigest,
            String(pageOrdinal),
            String(row.rowOrdinal),
            rowDigest,
          ),
          collisionKey: hncbDigest(
            "hncb-source-collision-v1",
            identity.subjectDigest,
            rowDigest,
          ),
          providerKey: rowDigest,
          contentHash: hncbDigest("hncb-source-content-v1", rowDigest),
          compact: {
            evidenceVersion: capture.evidenceVersion,
            pageOrdinal,
            rowOrdinal: row.rowOrdinal,
            rowDigest,
            columnCount: cells.length,
            transactionDateShape: "slash-date",
            accountingDateShape: "slash-date",
            transactionTimeShape: "local-second",
            currency: "TWD",
            amountDirection: amountDirection(cells),
            balanceShape: "decimal",
            providerGuaranteed: HNCB_DOMESTIC_DEPOSIT_PROVIDER_GUARANTEED,
            canonicalAdmission: "blocked",
            sourceStage: "source-only",
            semanticStatus: "observed-structural-only",
          },
        };
      }),
    ),
  };
}

export function createHncbDomesticDepositSourceEvidence(
  capture: HncbDomesticDepositValidatedEvidence,
  captureId: string,
): CanonicalSourceEvidence {
  return sourceEvidenceForCapture(capture, captureId);
}

export async function commitHncbDomesticDepositSourceEvidence(
  store: CanonicalSourceStore,
  capture: HncbDomesticDepositValidatedEvidence,
  captureId: string,
): Promise<CanonicalSourceCommitResult> {
  return commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(
      createHncbDomesticDepositSourceEvidence(capture, captureId),
    ),
  );
}

/**
 * A workflow run may inspect several visible accounts, but the generic
 * source writer exposes one atomic source-capture call.  This batch seam
 * keeps the account set and row ownership as opaque digests while retaining
 * one source commit boundary after every account has reached a terminal
 * export/no-data result.
 */
export function createHncbDomesticDepositBatchSourceEvidence(
  captures: readonly HncbDomesticDepositValidatedEvidence[],
  captureId: string,
): CanonicalSourceEvidence {
  if (captures.length === 0)
    throw new Error("HNCB source evidence batch cannot be empty.");
  if (!captureId.trim())
    throw new Error("HNCB source evidence capture ID is required.");
  for (const capture of captures) {
    if (!isAdmittedHncbDomesticDepositCaptureEvidence(capture))
      throw new Error(
        "HNCB source evidence batch requires structural admission.",
      );
    if (capture.downloads.length !== 1)
      throw new Error(
        "HNCB source evidence batch requires one export per account.",
      );
  }
  const first = captures[0]!;
  const firstIdentity = deriveHncbDomesticDepositAccountIdentity(first.account);
  const expectedObservedAt = first.observedAt;
  const expectedStartDate = sourceDate(first.queryRange.startDate);
  const expectedEndDate = sourceDate(first.queryRange.endDate);
  const identities = captures
    .map((capture) => {
      const identity = deriveHncbDomesticDepositAccountIdentity(
        capture.account,
      );
      if (
        capture.observedAt !== expectedObservedAt ||
        sourceDate(capture.queryRange.startDate) !== expectedStartDate ||
        sourceDate(capture.queryRange.endDate) !== expectedEndDate
      )
        throw new Error("HNCB source evidence batch scope is inconsistent.");
      return { capture, identity };
    })
    .sort((left, right) =>
      left.identity.subjectDigest.localeCompare(right.identity.subjectDigest),
    );
  const batchSubjectDigest = hncbDigest(
    "hncb-source-batch-subject-v1",
    ...identities.map(({ identity }) => identity.subjectDigest),
  );
  const pages = identities.flatMap(({ capture, identity }, accountOrdinal) =>
    capture.downloads.map((download) => ({
      accountOrdinal,
      capture,
      download,
      identity,
    })),
  );
  return {
    captureId: captureId.trim(),
    integrationNamespace: "hncb",
    sourceConnectionKey: firstIdentity.sourceConnectionKey,
    identityEpoch: firstIdentity.identityEpochKey,
    stream: "domestic-deposit",
    recordKind: HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND,
    routeKey: HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
    contractVersion: HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    subjectDigest: batchSubjectDigest,
    observedAt: expectedObservedAt,
    scope: {
      startDate: expectedStartDate,
      endDate: expectedEndDate,
      kind: "bounded-range",
      completeness: "single-page",
      ruleVersion: HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION,
    },
    pages: pages.map(({ capture, download, identity }, pageOrdinal) => ({
      pageOrdinal,
      responseCode: "200",
      rowCount: download.rows.length,
      terminal: pageOrdinal === pages.length - 1,
      metadata: {
        filenameDigest: hncbDigest(
          "hncb-source-filename-v1",
          download.filename,
        ),
        contentDigest: download.contentDigest,
        byteLength: download.byteLength,
        columnCount: download.columnNames.length,
        accountSubjectDigest: identity.subjectDigest,
        accountValueDigest: hncbDigest(
          "hncb-source-account-value-v1",
          capture.account.value,
        ),
        accountLabelDigest: hncbDigest(
          "hncb-source-account-label-v1",
          capture.account.label,
        ),
        zeroResultAuthority: capture.zeroResultAuthority ?? null,
        completeness: "unproven",
      },
    })),
    records: pages.flatMap(({ capture, download, identity, accountOrdinal }) =>
      download.rows.map((row) => {
        const cells = row.values.map(normalizedCell);
        const rowDigest = hncbDigest(
          "hncb-source-batch-row-v1",
          identity.subjectDigest,
          String(accountOrdinal),
          String(row.rowOrdinal),
          ...cells,
        );
        return {
          occurrenceKey: hncbDigest(
            "hncb-source-batch-occurrence-v1",
            batchSubjectDigest,
            identity.subjectDigest,
            String(accountOrdinal),
            String(row.rowOrdinal),
            rowDigest,
          ),
          collisionKey: hncbDigest(
            "hncb-source-batch-collision-v1",
            batchSubjectDigest,
            identity.subjectDigest,
            rowDigest,
          ),
          providerKey: rowDigest,
          contentHash: hncbDigest("hncb-source-batch-content-v1", rowDigest),
          compact: {
            evidenceVersion: capture.evidenceVersion,
            accountSubjectDigest: identity.subjectDigest,
            accountOrdinal,
            rowOrdinal: row.rowOrdinal,
            rowDigest,
            columnCount: cells.length,
            transactionDateShape: "slash-date",
            accountingDateShape: "slash-date",
            transactionTimeShape: "local-second",
            currency: "TWD",
            amountDirection: amountDirection(cells),
            balanceShape: "decimal",
            providerGuaranteed: HNCB_DOMESTIC_DEPOSIT_PROVIDER_GUARANTEED,
            canonicalAdmission: "blocked",
            sourceStage: "source-only",
            semanticStatus: "observed-structural-only",
          },
        };
      }),
    ),
  };
}

export async function commitHncbDomesticDepositSourceEvidenceBatch(
  store: CanonicalSourceStore,
  captures: readonly HncbDomesticDepositValidatedEvidence[],
  captureId: string,
): Promise<CanonicalSourceCommitResult> {
  return commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(
      createHncbDomesticDepositBatchSourceEvidence(captures, captureId),
    ),
  );
}

export type HncbDomesticDepositFinancialSemantics = {
  evidenceVersion: typeof HNCB_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION;
  account: {
    accountNo: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountType: "depository";
    currency: typeof HNCB_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY;
  };
  authority: {
    route: typeof HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
    scope: "personal-authenticated-session";
    membershipEffectiveDate: null;
  };
  posting: {
    status: "posted";
    origin: typeof HNCB_DOMESTIC_DEPOSIT_POSTING_ORIGIN;
    basis: typeof HNCB_DOMESTIC_DEPOSIT_POSTING_BASIS;
    ruleVersion: typeof HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
  };
  direction: {
    outflowCellIndex: 4;
    inflowCellIndex: 5;
    ruleVersion: typeof HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
  };
  effectiveTime: {
    basis: typeof HNCB_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS;
    timeZone: typeof HNCB_DOMESTIC_DEPOSIT_TIME_ZONE;
    ruleVersion: typeof HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
  };
  cancellation: {
    rule: "unsupported-reject";
    ruleVersion: typeof HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
  };
  completeness: {
    basis: typeof HNCB_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS;
    ruleVersion: typeof HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
    absenceAuthority: typeof HNCB_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY;
  };
  occurrence: {
    ruleVersion: typeof HNCB_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION;
    providerGuaranteed: false;
  };
};

export function buildHncbHumanAttestedFinancialSemantics(
  capture: HncbDomesticDepositCaptureEvidence,
  manifest: HncbHumanAttestedV1Manifest = getHncbHumanAttestedV1Manifest(),
): HncbDomesticDepositFinancialSemantics {
  const identity = deriveHncbDomesticDepositAccountIdentity(capture.account);
  return {
    evidenceVersion: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    account: {
      accountNo: capture.account.value,
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: hncbHumanAttestedIdentityEpochKey(manifest),
      subjectDigest: identity.subjectDigest,
      accountType: "depository",
      currency: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
    },
    authority: {
      route: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      scope: "personal-authenticated-session",
      membershipEffectiveDate: null,
    },
    posting: {
      status: "posted",
      origin: HNCB_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
      basis: HNCB_DOMESTIC_DEPOSIT_POSTING_BASIS,
      ruleVersion: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    direction: {
      outflowCellIndex: 4,
      inflowCellIndex: 5,
      ruleVersion: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    effectiveTime: {
      basis: HNCB_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
      timeZone: HNCB_DOMESTIC_DEPOSIT_TIME_ZONE,
      ruleVersion: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    cancellation: {
      rule: "unsupported-reject",
      ruleVersion: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    },
    completeness: {
      basis: HNCB_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
      ruleVersion: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      absenceAuthority: HNCB_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
    },
    occurrence: {
      ruleVersion: HNCB_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
      providerGuaranteed: false,
    },
  };
}

export type HncbDomesticDepositFinancialAdmissionInput = {
  capture: HncbDomesticDepositValidatedEvidence;
  captureId: string;
  humanAttestation?: HncbHumanAttestedV1Manifest;
  semantics?: HncbDomesticDepositFinancialSemantics;
};

export type HncbDomesticDepositFinancialAdmissionResult = {
  status: "admitted" | "blocked";
  capture: CanonicalFinancialDepositValidatedCapture | null;
  diagnostics: string[];
};

export class HncbDomesticDepositFinancialAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HncbDomesticDepositFinancialAdmissionError";
  }
}

function normalizedFinancialCell(value: unknown): string {
  return normalizedCell(value).replace(/,/g, "");
}

function parseHncbFinancialAmount(
  value: unknown,
  allowZero = false,
): { coefficient: string; scale: number } | null {
  const normalized = normalizedFinancialCell(value);
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parts = normalized.split(".");
  const coefficient = (parts[0] ?? "") + (parts[1] ?? "");
  const trimmed = coefficient.replace(/^0+(?=\d)/, "") || "0";
  if (!allowZero && BigInt(trimmed) === 0n) return null;
  return { coefficient: trimmed, scale: (parts[1] ?? "").length };
}

function canonicalHncbDate(value: string): string | null {
  const normalized = normalizedCell(value).replace(/[/-]/g, "");
  if (!/^\d{8}$/.test(normalized)) return null;
  const formatted = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  const date = new Date(`${formatted}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === formatted ? formatted : null;
}

function canonicalHncbTime(value: string): string | null {
  const match = normalizedCell(value).match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (
    !match ||
    Number(match[1]) > 23 ||
    Number(match[2]) > 59 ||
    Number(match[3]) > 59
  )
    return null;
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}:${match[3]}`;
}

function hncbFinancialOpaque(
  domain: string,
  ...parts: string[]
): `sha256:${string}` {
  return hncbDigest(domain, ...parts);
}

function unsupportedHncbAuthority(label: string): boolean {
  return /共同|共有|聯名|联名|聯合|联合|代理|代管|joint|shared|co[- ]?owner|authorized/i.test(
    label,
  );
}

function unsupportedHncbCancellation(values: readonly string[]): boolean {
  return /撤銷|撤销|沖正|冲正|更正|取消|退回|回沖|回冲|退款|reversal|reversed|correction|cancel/i.test(
    values.map(normalizedCell).join(" "),
  );
}

function hncbFinancialRecord(
  identity: HncbDomesticDepositAccountIdentity,
  row: HncbDomesticDepositRawRow,
  pageOrdinal: number,
  semantics: HncbDomesticDepositFinancialSemantics,
): { record: CanonicalFinancialDepositRecord | null; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const values = row.values;
  const transactionDate = canonicalHncbDate(values[0] ?? "");
  const accountingDate = canonicalHncbDate(values[2] ?? "");
  const transactionTime = canonicalHncbTime(values[1] ?? "");
  if (!transactionDate) diagnostics.push("transaction-date-invalid");
  if (!accountingDate) diagnostics.push("accounting-date-invalid");
  if (!transactionTime) diagnostics.push("transaction-time-invalid");
  if (!transactionDate || !accountingDate || !transactionTime)
    return { record: null, diagnostics };
  const epochMilliseconds = Date.parse(
    `${transactionDate}T${transactionTime}+08:00`,
  );
  if (!Number.isSafeInteger(epochMilliseconds)) {
    diagnostics.push("effective-time-invalid");
    return { record: null, diagnostics };
  }
  const outflowText = normalizedCell(
    values[semantics.direction.outflowCellIndex],
  );
  const inflowText = normalizedCell(
    values[semantics.direction.inflowCellIndex],
  );
  const outflow = parseHncbFinancialAmount(outflowText);
  const inflow = parseHncbFinancialAmount(inflowText);
  const outflowPresent = Boolean(outflowText);
  const inflowPresent = Boolean(inflowText);
  if ((outflowPresent && inflowPresent) || (!outflow && !inflow))
    diagnostics.push("amount-column-conflict");
  if ((outflowText && !outflow) || (inflowText && !inflow))
    diagnostics.push("amount-invalid");
  const amount = outflow ?? inflow;
  const direction = outflow ? "outflow" : inflow ? "inflow" : null;
  const balanceAfter = parseHncbFinancialAmount(values[6], true);
  if (!balanceAfter) diagnostics.push("balance-invalid");
  if (unsupportedHncbCancellation(values))
    diagnostics.push("cancellation-marker-unsupported");
  if (!amount || !direction || !balanceAfter)
    return { record: null, diagnostics };
  const description = normalizedCell(values[7]);
  const depositor = normalizedCell(values[8]);
  const note = normalizedCell(values[9]);
  const reference = normalizedCell(values[10]);
  const contentHash = hncbFinancialOpaque(
    "hncb-observed-content-v1",
    ...values.map(normalizedCell),
  );
  const collisionKey = hncbFinancialOpaque(
    "hncb-observed-composite-fence-v1",
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
  const occurrenceKey = hncbFinancialOpaque(
    "hncb-observed-composite-occurrence-v1",
    collisionKey,
    description,
    depositor,
    note,
    reference,
  );
  return {
    record: {
      occurrenceKey,
      collisionKey,
      providerKey: collisionKey,
      contentHash,
      sequenceLexeme: `${pageOrdinal}:${row.rowOrdinal}`,
      compactJson: JSON.stringify({
        evidenceVersion: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
        accountDigest: identity.subjectDigest,
        pageOrdinal,
        rowOrdinal: row.rowOrdinal,
        accountingDate,
        transactionDate,
        transactionTime,
        direction,
        amount,
        balanceAfter,
        descriptionDigest: hncbFinancialOpaque(
          "hncb-description-v1",
          description,
        ),
        depositorDigest: hncbFinancialOpaque("hncb-depositor-v1", depositor),
        noteDigest: hncbFinancialOpaque("hncb-note-v1", note),
        referenceDigest: hncbFinancialOpaque("hncb-reference-v1", reference),
        providerGuaranteed: false,
      }),
      amount,
      balanceAfter,
      currency: semantics.account.currency,
      direction,
      sourceTime: {
        localDate: transactionDate,
        localTime: transactionTime,
        timeZone: HNCB_DOMESTIC_DEPOSIT_TIME_ZONE,
        epochMilliseconds,
      },
      effectiveOn: transactionDate,
      transactionDateTimeLocal: `${transactionDate}T${transactionTime}`,
    },
    diagnostics,
  };
}

function hncbRangeDate(value: string): string {
  return normalizedCell(value).replaceAll("/", "-");
}

function hncbFinancialDiagnosticsFor(
  input: HncbDomesticDepositFinancialAdmissionInput,
): {
  diagnostics: string[];
  semantics: HncbDomesticDepositFinancialSemantics | null;
  capture?: CanonicalFinancialDepositValidatedCapture;
} {
  const diagnostics: string[] = [];
  if (!input || typeof input !== "object")
    return { diagnostics: ["capture-missing"], semantics: null };
  if (!isAdmittedHncbDomesticDepositCaptureEvidence(input.capture))
    diagnostics.push("runtime-evidence-brand-missing");
  if (!input.captureId?.trim()) diagnostics.push("scope-invalid");
  const manifest = input.humanAttestation;
  if (!manifest) diagnostics.push("human-attestation-missing");
  else if (!isHncbHumanAttestedV1Manifest(manifest))
    diagnostics.push("human-attestation-mismatch");
  if (!isHncbHumanAttestedV1Active())
    diagnostics.push("human-attestation-revoked");
  if (!isAdmittedHncbDomesticDepositCaptureEvidence(input.capture))
    return { diagnostics: [...new Set(diagnostics)], semantics: null };
  const current = manifest ?? getHncbHumanAttestedV1Manifest();
  const semantics =
    input.semantics ??
    buildHncbHumanAttestedFinancialSemantics(input.capture, current);
  const identity = deriveHncbDomesticDepositAccountIdentity(
    input.capture.account,
  );
  const expectedEpoch = hncbHumanAttestedIdentityEpochKey(current);
  if (
    semantics.account.accountNo !== input.capture.account.value ||
    semantics.account.sourceConnectionKey !== identity.sourceConnectionKey ||
    semantics.account.identityEpochKey !== expectedEpoch ||
    semantics.account.subjectDigest !== identity.subjectDigest
  )
    diagnostics.push("account-identity-mismatch");
  if (
    semantics.account.currency !== "TWD" ||
    input.capture.downloads.some((download) =>
      download.rows.some((row) => normalizedCell(row.values[3]) !== "TWD"),
    )
  )
    diagnostics.push("unsupported-currency");
  if (unsupportedHncbAuthority(input.capture.account.label))
    diagnostics.push("authority-shared-account");
  if (
    semantics.account.accountType !== "depository" ||
    semantics.authority.route !== HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY ||
    semantics.authority.scope !== "personal-authenticated-session" ||
    semantics.authority.membershipEffectiveDate !== null
  )
    diagnostics.push("authority-semantics-unproven");
  if (
    semantics.posting.status !== "posted" ||
    semantics.posting.origin !== HNCB_DOMESTIC_DEPOSIT_POSTING_ORIGIN ||
    semantics.posting.basis !== HNCB_DOMESTIC_DEPOSIT_POSTING_BASIS ||
    semantics.posting.ruleVersion !== HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("posting-semantics-unproven");
  if (
    semantics.direction.outflowCellIndex !== 4 ||
    semantics.direction.inflowCellIndex !== 5 ||
    semantics.direction.ruleVersion !==
      HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("direction-semantics-unproven");
  if (
    semantics.effectiveTime.basis !==
      HNCB_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS ||
    semantics.effectiveTime.timeZone !== HNCB_DOMESTIC_DEPOSIT_TIME_ZONE ||
    semantics.effectiveTime.ruleVersion !==
      HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("effective-time-semantics-unproven");
  if (
    semantics.cancellation.rule !== "unsupported-reject" ||
    semantics.cancellation.ruleVersion !==
      HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("cancellation-semantics-unproven");
  if (
    semantics.completeness.basis !== HNCB_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS ||
    semantics.completeness.absenceAuthority !==
      HNCB_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY ||
    semantics.completeness.ruleVersion !==
      HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY
  )
    diagnostics.push("completeness-semantics-unproven");
  if (
    semantics.occurrence.ruleVersion !==
      HNCB_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION ||
    semantics.occurrence.providerGuaranteed !== false
  )
    diagnostics.push("occurrence-identity-unproven");
  const downloads = input.capture.downloads;
  const hasRows = downloads.some((download) => download.rows.length > 0);
  if (
    downloads.length === 0 ||
    downloads.some((download) => download.terminal !== true)
  )
    diagnostics.push("terminal-evidence-missing");
  if (
    !hasRows &&
    input.capture.zeroResultAuthority !== "provider-explicit-no-data"
  )
    diagnostics.push("zero-result-authority-unproven");
  const queryStart = hncbRangeDate(input.capture.queryRange.startDate);
  const queryEnd = hncbRangeDate(input.capture.queryRange.endDate);
  const seen = new Map<string, string>();
  const records: CanonicalFinancialDepositRecord[] = [];
  for (const [pageOrdinal, download] of downloads.entries()) {
    for (const row of download.rows) {
      const transactionDate = canonicalHncbDate(row.values[0] ?? "");
      if (
        transactionDate &&
        (transactionDate < queryStart || transactionDate > queryEnd)
      )
        diagnostics.push("row-outside-query-range");
      const result = hncbFinancialRecord(identity, row, pageOrdinal, semantics);
      diagnostics.push(...result.diagnostics);
      if (!result.record) continue;
      const prior = seen.get(result.record.collisionKey);
      if (prior !== undefined) {
        diagnostics.push("occurrence-ambiguous");
        if (prior !== result.record.occurrenceKey)
          diagnostics.push("composite-occurrence-collision");
        continue;
      }
      seen.set(result.record.collisionKey, result.record.occurrenceKey);
      records.push(result.record);
    }
  }
  if (diagnostics.length > 0)
    return { diagnostics: [...new Set(diagnostics)], semantics };
  const contractFingerprint = hncbFinancialOpaque(
    "hncb-contract-v1",
    HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    HNCB_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  );
  const preflightFingerprint = hncbFinancialOpaque(
    "hncb-preflight-v1",
    identity.subjectDigest,
    input.capture.queryRange.startDate,
    input.capture.queryRange.endDate,
  );
  const capture = admitCanonicalFinancialDepositCapture({
    captureId: input.captureId.trim(),
    authorityRoute: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    contractVersion: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    identity: {
      integrationNamespace: "hncb",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: expectedEpoch,
      stream: "domestic-deposit",
      recordKind: "hncb-domestic-deposit",
      subjectDigest: identity.subjectDigest,
      accountNo: input.capture.account.value,
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
      semanticRuleVersion: HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
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
        filenameDigest: hncbFinancialOpaque(
          "hncb-filename-v1",
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

export function admitHncbDomesticDepositFinancialCapture(
  input: HncbDomesticDepositFinancialAdmissionInput,
): HncbDomesticDepositFinancialAdmissionResult {
  const result = hncbFinancialDiagnosticsFor(input);
  if (result.diagnostics.length > 0 || !result.capture)
    return {
      status: "blocked",
      capture: null,
      diagnostics: result.diagnostics,
    };
  return { status: "admitted", capture: result.capture, diagnostics: [] };
}

export async function commitCanonicalHncbDomesticDepositCapture(
  store: CanonicalFinancialDepositWriterStore,
  input: HncbDomesticDepositFinancialAdmissionInput,
): Promise<CanonicalFinancialDepositCommitResult> {
  ensureHncbHumanAttestationEvents(store.db);
  let latest: ReturnType<typeof latestHncbHumanAttestationEvent>;
  try {
    latest = latestHncbHumanAttestationEvent(store.db);
  } catch {
    throw new HncbDomesticDepositFinancialAdmissionError(
      "HNCB human attestation chain is invalid.",
    );
  }
  if (latest?.eventKind === "revoked" || !isHncbHumanAttestedV1Active())
    throw new HncbDomesticDepositFinancialAdmissionError(
      "HNCB human attestation is revoked; future admission is blocked.",
    );
  const admission = admitHncbDomesticDepositFinancialCapture(input);
  if (admission.status !== "admitted" || !admission.capture)
    throw new HncbDomesticDepositFinancialAdmissionError(
      `HNCB domestic deposit canonical admission blocked: ${admission.diagnostics.join(", ")}`,
    );
  recordInitialHncbHumanAttestationIfMissing(
    store.db,
    input.capture.observedAt,
  );
  return commitCanonicalFinancialDepositCapture(store, admission.capture);
}

export function isHncbSourceOnlyFinancialDiagnostic(
  diagnostic: string,
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
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
  getHncbHumanAttestedV1Manifest,
  isHncbHumanAttestedV1Manifest,
  isHncbHumanAttestedV1Active,
  isHncbHumanAttestationDurablyActive,
  latestHncbHumanAttestationEvent,
  recordInitialHncbHumanAttestationIfMissing,
  recordHncbHumanAttestationEvent,
  restoreHncbHumanAttestedV1,
  revokeHncbHumanAttestedV1,
};
