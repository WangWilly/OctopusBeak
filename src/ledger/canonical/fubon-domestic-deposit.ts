import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";
import { createHash } from "node:crypto";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  canonicalSourceAdmissionCommitResult,
  createCanonicalSourceCaptureAdmission,
} from "./canonical-source-capture-admission.ts";
import type { CanonicalSourceEvidence } from "./canonical-source-evidence.ts";
import {
  type CanonicalSourceCommitResult,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  requireSourceConnectionIdentity,
  validateSourceConnectionIdentity,
} from "./source-connection-identity.ts";
import {
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  ensureFubonHumanAttestationEvents,
  getFubonHumanAttestedV1Manifest,
  isFubonHumanAttestationDurablyActive,
  isFubonHumanAttestedV1Active,
  isFubonHumanAttestedV1Manifest,
  latestFubonHumanAttestationEvent,
  recordInitialFubonHumanAttestationIfMissing,
  recordFubonHumanAttestationEvent,
  type FubonHumanAttestedV1Manifest,
} from "./fubon-human-attestation.ts";
import type { FubonDepositStatementEvidence } from "../../workflows/fubon-statements.ts";

// Keep the contract token duplicated as a literal so canonical checks can run
// without loading Playwright-only workflow dependencies in Node's test runner.
export const FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION =
  "capture-evidence-v2" as const;

export const FUBON_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "fubon",
  authority: "fubon/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "fubonStatements",
  expectedRowWidth: 7,
  accountingDateIndex: 0,
  transactionDateIndex: 0,
  transactionTimeIndex: 1,
  provenance: {
    evidenceBasis: "normalized HTML table columns and next-page traversal",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 3,
  inflowIndex: 4,
  completenessEvidence: "pagination-termination",
  explicitNoDataEvidence: { kind: "none" },
} as const satisfies AdvertisedDomesticDepositContract;

export const FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-FUBON-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/01/31" },
  records: [
    {
      values: [
        "2026/01/02",
        "09:10:11",
        "SYNTHETIC",
        "",
        "100",
        "100",
        "SYNTHETIC",
      ],
    },
  ],
  transport: { pageNumbers: [1, 2], terminalPageObserved: true },
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightFubonDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(FUBON_DOMESTIC_DEPOSIT_CONTRACT);

/**
 * The capture evidence contract is deliberately separate from the original
 * preflight-v1 table-shape contract.  It records exactly what the current
 * form-postback parser saw, without turning column positions into financial
 * semantics or treating row order as a source transaction identifier.
 */
export const FUBON_DOMESTIC_DEPOSIT_CAPTURE_CONTRACT = {
  source: "fubon",
  authority: "fubon/domestic-deposit/capture-evidence-v2",
  contractVersion: FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  readiness: "preflight-only",
  workflow: "fubonStatements",
  rowWidth: 7,
  responseBodyRetained: false,
  semantics: "unresolved",
} as const;

/**
 * The source-only route records parser observations in the shared v8 source
 * store. It is deliberately not a financial authority route: all financial
 * semantics below remain unresolved until separately evidenced.
 */
export const FUBON_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE =
  "fubon/domestic-deposit/capture-evidence-v2" as const;
export const FUBON_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_STREAM =
  "domestic-deposit" as const;
export const FUBON_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND =
  "fubon-domestic-deposit-capture-evidence" as const;
export const FUBON_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION =
  "fubon/domestic-deposit/capture-evidence-v2/pagination-termination" as const;

/** Exact live domestic-deposit route used for the limited TWD attestation. */
export const FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_PATH =
  "/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces" as const;
export const FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_CONTRACT =
  "fubon-domestic-deposit-twd-v1" as const;

/** De-identified fixture for parser/page/zero/readiness checks. */
export const FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2: FubonDomesticDepositCaptureEvidence =
  {
    evidenceVersion: FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "fubon",
    observedAt: "2026-01-31T12:00:00.000Z",
    account: {
      value: "SYNTHETIC-FUBON-ACCOUNT-VALUE",
      label: "SYNTHETIC FUBON ACCOUNT (012)",
      branchName: "012",
    },
    queryRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
    pages: [
      {
        pageOrdinal: 0,
        responseSequence: 1,
        terminal: false,
        nextPage: "2",
        pageFieldName: "resultGrid:dataGridCurrentPage",
        queryRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
        selectedAccount: {
          value: "SYNTHETIC-FUBON-ACCOUNT-VALUE",
          label: "SYNTHETIC FUBON ACCOUNT (012)",
          branchName: "012",
        },
        providerPageSize: 10,
        rows: [
          {
            rowOrdinal: 0,
            cells: [
              "2026/01/02",
              "09:10:11",
              "SYNTHETIC DEPOSIT",
              "",
              "100",
              "100",
              "SYNTHETIC NOTE",
            ],
          },
        ],
        zeroObservation: "non-empty-page",
      },
      {
        pageOrdinal: 1,
        responseSequence: 2,
        terminal: true,
        nextPage: null,
        pageFieldName: null,
        queryRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
        selectedAccount: {
          value: "SYNTHETIC-FUBON-ACCOUNT-VALUE",
          label: "SYNTHETIC FUBON ACCOUNT (012)",
          branchName: "012",
        },
        providerPageSize: 10,
        rows: [],
        zeroObservation: "empty-page",
      },
    ],
    zeroObservation: "non-empty-range",
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
  };

export type FubonDomesticDepositCaptureEvidence = FubonDepositStatementEvidence;

export type FubonDomesticDepositCaptureDiagnostic =
  | "capture-missing"
  | "evidence-version-invalid"
  | "source-invalid"
  | "observed-at-invalid"
  | "account-option-value-missing"
  | "account-option-label-missing"
  | "branch-missing"
  | "query-range-invalid"
  | "query-range-shape-invalid"
  | "page-missing"
  | "pages-invalid"
  | "page-shape-invalid"
  | "page-rows-invalid"
  | "page-metadata-invalid"
  | "page-ordinal-invalid"
  | "page-ordinal-gap"
  | "page-order-invalid"
  | "response-sequence-invalid"
  | "response-sequence-gap"
  | "response-sequence-order-invalid"
  | "terminal-page-missing"
  | "terminal-page-not-last"
  | "page-transition-invalid"
  | "terminal-page-incomplete"
  | "provider-page-size-invalid"
  | "next-page-metadata-incomplete"
  | "query-range-drift"
  | "selected-account-drift"
  | "selected-account-invalid"
  | "row-ordinal-invalid"
  | "row-ordinal-gap"
  | "row-width-invalid"
  | "row-shape-invalid"
  | "row-cell-invalid"
  | "source-occurrence-id-shape-invalid"
  | "source-date-invalid"
  | "source-time-invalid"
  | "row-outside-query-range"
  | "amount-column-conflict"
  | "amount-sign-invalid"
  | "amount-invalid"
  | "balance-invalid"
  | "occurrence-ambiguous"
  | "composite-occurrence-collision"
  | "zero-observation-invalid"
  | "provenance-invalid";

export type FubonDomesticDepositCaptureValidationResult = {
  status: "admissible" | "rejected";
  capture: FubonDomesticDepositValidatedEvidence | null;
  diagnostics: FubonDomesticDepositCaptureDiagnostic[];
};

export type FubonDomesticDepositSourceOnlyValidationResult = {
  status: "source-only";
  capture: FubonDomesticDepositSourceOnlyEvidence;
  diagnostics: FubonDomesticDepositCaptureDiagnostic[];
};

/** Runtime admission brand for the typed source-evidence seam. */
export type FubonDomesticDepositValidatedEvidence =
  FubonDomesticDepositCaptureEvidence & {
    readonly __runtimeValidatedFubonDomesticDepositEvidence: true;
  };

export type FubonDomesticDepositSourceOnlyEvidence =
  FubonDomesticDepositCaptureEvidence & {
    readonly __runtimeSourceOnlyFubonDomesticDepositEvidence: true;
  };

const VALIDATED_FUBON_EVIDENCE = new WeakSet<object>();
const SOURCE_ONLY_FUBON_EVIDENCE = new WeakSet<object>();

export function isAdmittedFubonDomesticDepositCaptureEvidence(
  value: unknown,
): value is FubonDomesticDepositValidatedEvidence {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_FUBON_EVIDENCE.has(value)
  );
}

export function isSourceOnlyFubonDomesticDepositCaptureEvidence(
  value: unknown,
): value is FubonDomesticDepositSourceOnlyEvidence {
  return (
    value !== null &&
    typeof value === "object" &&
    SOURCE_ONLY_FUBON_EVIDENCE.has(value)
  );
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function validDate(value: string): boolean {
  const match = clean(value).match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/);
  if (!match) return false;
  const parsed = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return (
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() === Number(match[2]) - 1 &&
    parsed.getUTCDate() === Number(match[3])
  );
}

function validObservedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match || !validDate(match[1]!)) return false;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)
    return false;
  return Number.isFinite(Date.parse(value));
}

function validRange(
  value: unknown,
): value is { startDate: string; endDate: string } {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as {
    startDate?: unknown;
    endDate?: unknown;
  };
  if (
    typeof candidate.startDate !== "string" ||
    typeof candidate.endDate !== "string"
  )
    return false;
  return (
    validDate(candidate.startDate) &&
    validDate(candidate.endDate) &&
    clean(candidate.startDate).replace(/\D/g, "") <=
      clean(candidate.endDate).replace(/\D/g, "")
  );
}

function diagnostic(
  diagnostics: FubonDomesticDepositCaptureDiagnostic[],
  code: FubonDomesticDepositCaptureDiagnostic,
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

/**
 * Validate and brand one parser-produced evidence object.  This is a
 * structural admission only; it intentionally never produces a canonical
 * financial capture.
 */
export function admitFubonDomesticDepositCaptureEvidence(
  capture: FubonDomesticDepositCaptureEvidence,
): FubonDomesticDepositCaptureValidationResult {
  const diagnostics: FubonDomesticDepositCaptureDiagnostic[] = [];
  if (!capture || typeof capture !== "object") {
    diagnostic(diagnostics, "capture-missing");
    return { status: "rejected", capture: null, diagnostics };
  }
  if (capture.evidenceVersion !== FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION)
    diagnostic(diagnostics, "evidence-version-invalid");
  if (capture.source !== "fubon") diagnostic(diagnostics, "source-invalid");
  if (!validObservedAt(capture.observedAt))
    diagnostic(diagnostics, "observed-at-invalid");

  const account = capture.account;
  if (account === null || typeof account !== "object") {
    diagnostic(diagnostics, "account-option-value-missing");
    diagnostic(diagnostics, "account-option-label-missing");
    diagnostic(diagnostics, "branch-missing");
  } else {
    if (typeof account.value !== "string" || !clean(account.value))
      diagnostic(diagnostics, "account-option-value-missing");
    if (typeof account.label !== "string" || !clean(account.label))
      diagnostic(diagnostics, "account-option-label-missing");
    if (typeof account.branchName !== "string" || !clean(account.branchName))
      diagnostic(diagnostics, "branch-missing");
  }
  if (capture.queryRange === null || typeof capture.queryRange !== "object")
    diagnostic(diagnostics, "query-range-shape-invalid");
  if (!validRange(capture.queryRange))
    diagnostic(diagnostics, "query-range-invalid");
  if (
    capture.provenance?.source !==
      "fubon-ebank-domestic-deposit-form-postback" ||
    capture.provenance.responseBodyRetained !== false ||
    capture.provenance.semantics !== "unresolved"
  )
    diagnostic(diagnostics, "provenance-invalid");
  if (!Array.isArray(capture.pages)) {
    diagnostic(diagnostics, "pages-invalid");
  } else if (capture.pages.length === 0) {
    diagnostic(diagnostics, "page-missing");
  }

  const pageOrdinals = new Set<number>();
  const responseSequences = new Set<number>();
  const pages = Array.isArray(capture.pages) ? capture.pages : [];
  for (const [pageIndex, page] of pages.entries()) {
    if (page === null || typeof page !== "object") {
      diagnostic(diagnostics, "page-shape-invalid");
      continue;
    }
    if (!Number.isSafeInteger(page.pageOrdinal) || page.pageOrdinal < 0)
      diagnostic(diagnostics, "page-ordinal-invalid");
    if (page.pageOrdinal !== pageIndex)
      diagnostic(diagnostics, "page-order-invalid");
    if (pageOrdinals.has(page.pageOrdinal))
      diagnostic(diagnostics, "page-ordinal-invalid");
    pageOrdinals.add(page.pageOrdinal);
    if (
      !Number.isSafeInteger(page.responseSequence) ||
      page.responseSequence < 1
    )
      diagnostic(diagnostics, "response-sequence-invalid");
    if (page.responseSequence !== pageIndex + 1)
      diagnostic(diagnostics, "response-sequence-order-invalid");
    if (responseSequences.has(page.responseSequence))
      diagnostic(diagnostics, "response-sequence-invalid");
    responseSequences.add(page.responseSequence);
    if (
      typeof page.terminal !== "boolean" ||
      (page.nextPage !== null && typeof page.nextPage !== "string") ||
      (page.pageFieldName !== null && typeof page.pageFieldName !== "string")
    )
      diagnostic(diagnostics, "page-metadata-invalid");
    if (page.queryRange === null || typeof page.queryRange !== "object") {
      diagnostic(diagnostics, "query-range-shape-invalid");
    } else if (
      !validRange(page.queryRange) ||
      !validRange(capture.queryRange) ||
      page.queryRange.startDate !== capture.queryRange.startDate ||
      page.queryRange.endDate !== capture.queryRange.endDate
    )
      diagnostic(diagnostics, "query-range-drift");
    if (
      page.selectedAccount === null ||
      typeof page.selectedAccount !== "object"
    ) {
      diagnostic(diagnostics, "selected-account-invalid");
    } else if (
      typeof page.selectedAccount.value !== "string" ||
      typeof page.selectedAccount.label !== "string" ||
      typeof page.selectedAccount.branchName !== "string" ||
      account === null ||
      typeof account !== "object" ||
      page.selectedAccount.value !== account.value ||
      page.selectedAccount.label !== account.label ||
      page.selectedAccount.branchName !== account.branchName
    )
      diagnostic(diagnostics, "selected-account-drift");
    if (page.terminal !== (pageIndex === capture.pages.length - 1))
      diagnostic(
        diagnostics,
        page.terminal ? "terminal-page-not-last" : "terminal-page-missing",
      );
    if ((page.nextPage === null) !== page.terminal)
      diagnostic(diagnostics, "next-page-metadata-incomplete");
    if (!page.terminal && !clean(page.nextPage))
      diagnostic(diagnostics, "next-page-metadata-incomplete");
    if (page.nextPage !== null && !clean(page.pageFieldName))
      diagnostic(diagnostics, "next-page-metadata-incomplete");
    if (page.nextPage === null && page.pageFieldName !== null)
      diagnostic(diagnostics, "next-page-metadata-incomplete");
    if (
      page.providerPageSize !== undefined &&
      (!Number.isSafeInteger(page.providerPageSize) ||
        page.providerPageSize <= 0)
    )
      diagnostic(diagnostics, "provider-page-size-invalid");
    if (!page.terminal) {
      if (page.nextPage !== String(pageIndex + 2))
        diagnostic(diagnostics, "page-transition-invalid");
    } else if (Array.isArray(page.rows)) {
      const providerExplicitNoData =
        (
          capture as FubonDomesticDepositCaptureEvidence & {
            zeroResultAuthority?: string;
          }
        ).zeroResultAuthority === "provider-explicit-no-data";
      if (
        !providerExplicitNoData &&
        (page.providerPageSize === undefined ||
          page.rows.length >= page.providerPageSize)
      )
        diagnostic(diagnostics, "terminal-page-incomplete");
    }

    if (!Array.isArray(page.rows)) {
      diagnostic(diagnostics, "page-rows-invalid");
      continue;
    }
    const rowOrdinals = new Set<number>();
    for (const [rowIndex, row] of page.rows.entries()) {
      if (row === null || typeof row !== "object") {
        diagnostic(diagnostics, "row-shape-invalid");
        continue;
      }
      if (!Number.isSafeInteger(row.rowOrdinal) || row.rowOrdinal < 0)
        diagnostic(diagnostics, "row-ordinal-invalid");
      if (rowOrdinals.has(row.rowOrdinal))
        diagnostic(diagnostics, "row-ordinal-invalid");
      rowOrdinals.add(row.rowOrdinal);
      if (!Array.isArray(row.cells)) {
        diagnostic(diagnostics, "row-cell-invalid");
      } else if (
        row.cells.length !== FUBON_DOMESTIC_DEPOSIT_CAPTURE_CONTRACT.rowWidth
      )
        diagnostic(diagnostics, "row-width-invalid");
      else if (row.cells.some((cell: unknown) => typeof cell !== "string"))
        diagnostic(diagnostics, "row-cell-invalid");
      if (
        "sourceOccurrenceId" in row &&
        row.sourceOccurrenceId !== undefined &&
        typeof row.sourceOccurrenceId !== "string"
      )
        diagnostic(diagnostics, "source-occurrence-id-shape-invalid");
      if (row.rowOrdinal !== rowIndex)
        diagnostic(diagnostics, "row-ordinal-gap");
    }
    if (
      page.zeroObservation !==
      (page.rows.length === 0 ? "empty-page" : "non-empty-page")
    )
      diagnostic(diagnostics, "zero-observation-invalid");
  }

  const orderedPageOrdinals = [...pageOrdinals].sort((a, b) => a - b);
  orderedPageOrdinals.forEach((ordinal, index) => {
    if (ordinal !== index) diagnostic(diagnostics, "page-ordinal-gap");
  });
  const orderedResponseSequences = [...responseSequences].sort((a, b) => a - b);
  orderedResponseSequences.forEach((sequence, index) => {
    if (sequence !== index + 1)
      diagnostic(diagnostics, "response-sequence-gap");
  });
  const pageSizes = new Set(
    pages.flatMap((page) =>
      page && typeof page === "object" && page.providerPageSize !== undefined
        ? [page.providerPageSize]
        : [],
    ),
  );
  if (pageSizes.size > 1) diagnostic(diagnostics, "provider-page-size-invalid");
  const allPagesEmpty = pages.every(
    (page) =>
      page !== null &&
      typeof page === "object" &&
      Array.isArray(page.rows) &&
      page.rows.length === 0,
  );
  if (
    capture.zeroObservation !==
    (allPagesEmpty ? "empty-range" : "non-empty-range")
  )
    diagnostic(diagnostics, "zero-observation-invalid");

  if (diagnostics.length > 0)
    return { status: "rejected", capture: null, diagnostics };
  deepFreeze(capture);
  VALIDATED_FUBON_EVIDENCE.add(capture);
  return {
    status: "admissible",
    capture: capture as FubonDomesticDepositValidatedEvidence,
    diagnostics,
  };
}

/**
 * Incomplete pagination may be retained as source-only, but row corruption is
 * never an allowed downgrade.  Run the hard value/invariant checks before
 * branding an incomplete observation so an invalid amount, time, balance, or
 * observed-composite collision still fails the workflow visibly.
 */
function hardSourceOnlyRowDiagnostics(
  capture: FubonDomesticDepositCaptureEvidence,
): FubonDomesticDepositCaptureDiagnostic[] {
  const diagnostics: FubonDomesticDepositCaptureDiagnostic[] = [];
  const startDate = capture.queryRange.startDate.replace(/\//g, "-");
  const endDate = capture.queryRange.endDate.replace(/\//g, "-");
  const identity = deriveFubonDomesticDepositAccountIdentity(capture.account);
  const currency = capture.providerRouteEvidence?.currency ?? "unknown";
  const seenFences = new Map<string, string>();
  for (const page of capture.pages) {
    for (const row of page.rows) {
      const cells = row.cells;
      const rowDate = clean(cells[0]).replace(/\//g, "-");
      if (!validDate(rowDate)) diagnostic(diagnostics, "source-date-invalid");
      else if (rowDate < startDate || rowDate > endDate)
        diagnostic(diagnostics, "row-outside-query-range");
      const outflowLexeme = clean(cells[3]);
      const inflowLexeme = clean(cells[4]);
      const outflow = exactAmount(outflowLexeme);
      const inflow = exactAmount(inflowLexeme);
      if ((outflowLexeme && inflowLexeme) || (!outflowLexeme && !inflowLexeme))
        diagnostic(diagnostics, "amount-column-conflict");
      if ((outflowLexeme && !outflow) || (inflowLexeme && !inflow))
        diagnostic(diagnostics, "amount-sign-invalid");
      const amount = outflow ?? inflow;
      const balanceAfter = exactAmount(cells[5]);
      const time = sourceTime(cells, FUBON_DOMESTIC_DEPOSIT_TIME_ZONE);
      if (!amount) diagnostic(diagnostics, "amount-invalid");
      if (!balanceAfter) diagnostic(diagnostics, "balance-invalid");
      if (!time) diagnostic(diagnostics, "source-time-invalid");
      if (!amount || !balanceAfter || !time) continue;
      const direction = outflow ? "outflow" : inflow ? "inflow" : null;
      if (!direction) continue;
      const contentHash = opaqueToken(
        "fubon-observed-composite-content-v2",
        ...normalizedOccurrenceIdentityCells(cells),
      );
      const fence = opaqueToken(
        "fubon-observed-composite-fence-v2",
        identity.subjectDigest,
        getFubonHumanAttestedV1Manifest().attestationId,
        getFubonHumanAttestedV1Manifest().evidenceVersion,
        currency,
        `${time.localDate}T${time.localTime}`,
        direction,
        amount.coefficient,
        String(amount.scale),
        balanceAfter.coefficient,
        String(balanceAfter.scale),
      );
      const priorContentHash = seenFences.get(fence);
      if (priorContentHash !== undefined) {
        diagnostic(diagnostics, "occurrence-ambiguous");
        if (priorContentHash !== contentHash)
          diagnostic(diagnostics, "composite-occurrence-collision");
      } else {
        seenFences.set(fence, contentHash);
      }
    }
  }
  return diagnostics;
}

const SOURCE_ONLY_CAPTURE_DIAGNOSTICS =
  new Set<FubonDomesticDepositCaptureDiagnostic>([
    "page-transition-invalid",
    "terminal-page-incomplete",
    "provider-page-size-invalid",
    "next-page-metadata-incomplete",
    "terminal-page-missing",
    "terminal-page-not-last",
  ]);

/**
 * Preserve an incomplete pagination observation as source-only evidence. This
 * seam never brands the capture as financial-admissible; it exists so the
 * workflow can report a bounded source-only result instead of silently
 * dropping a provider page that cannot support completeness.
 */
export function admitFubonDomesticDepositSourceOnlyEvidence(
  capture: FubonDomesticDepositCaptureEvidence,
):
  | FubonDomesticDepositCaptureValidationResult
  | FubonDomesticDepositSourceOnlyValidationResult {
  const structural = admitFubonDomesticDepositCaptureEvidence(capture);
  if (structural.status === "admissible") return structural;
  if (
    structural.diagnostics.length === 0 ||
    structural.diagnostics.some(
      (diagnostic) => !SOURCE_ONLY_CAPTURE_DIAGNOSTICS.has(diagnostic),
    )
  )
    return structural;
  const hardDiagnostics = hardSourceOnlyRowDiagnostics(capture);
  if (hardDiagnostics.length > 0)
    return {
      status: "rejected",
      capture: null,
      diagnostics: [...structural.diagnostics, ...hardDiagnostics],
    };
  deepFreeze(capture);
  SOURCE_ONLY_FUBON_EVIDENCE.add(capture);
  return {
    status: "source-only",
    capture: capture as FubonDomesticDepositSourceOnlyEvidence,
    diagnostics: structural.diagnostics,
  };
}

function sourceDate(value: string): string {
  return clean(value).replace(/\D/g, "");
}

function sourceRowDigest(
  pageOrdinal: number,
  rowOrdinal: number,
  cells: readonly string[],
): `sha256:${string}` {
  return opaqueToken(
    "fubon-source-row-v2",
    String(pageOrdinal),
    String(rowOrdinal),
    ...cells,
  );
}

function sourceAccountDigest(
  account: FubonDomesticDepositCaptureEvidence["account"],
): `sha256:${string}` {
  return opaqueToken("fubon-source-account-v2", account.value);
}

function sourcePageMetadata(
  page: FubonDomesticDepositCaptureEvidence["pages"][number],
): Record<string, unknown> {
  const selectedAccountDigest = sourceAccountDigest(page.selectedAccount);
  return {
    responseSequence: page.responseSequence,
    providerPageSize: page.providerPageSize ?? null,
    pageFieldName: page.pageFieldName,
    queryStartDate: sourceDate(page.queryRange.startDate),
    queryEndDate: sourceDate(page.queryRange.endDate),
    selectedAccountDigest,
    selectedLabelDigest: opaqueToken(
      "fubon-source-account-label-v2",
      page.selectedAccount.label,
    ),
    branchDigest: opaqueToken(
      "fubon-source-branch-v2",
      page.selectedAccount.branchName,
    ),
    zeroObservation: page.zeroObservation,
    semanticStatus: "unresolved",
  };
}

/**
 * Convert an admitted parser capture into compact, de-identified source
 * evidence. Raw account values, labels, notes, descriptions, amounts and
 * response bodies never cross this boundary; only structural counts and
 * one-way digests are retained. The page/row key is a storage identity only,
 * not a provider-guaranteed transaction identifier.
 */
export function createFubonDomesticDepositSourceEvidence(
  capture:
    | FubonDomesticDepositValidatedEvidence
    | FubonDomesticDepositSourceOnlyEvidence,
  captureId: string,
  sourceIdentity: Readonly<{
    sourceConnectionScope?: string;
    sourceConnectionKey?: string;
  }>,
): CanonicalSourceEvidence {
  if (
    !isAdmittedFubonDomesticDepositCaptureEvidence(capture) &&
    !isSourceOnlyFubonDomesticDepositCaptureEvidence(capture)
  )
    throw new Error("Fubon source evidence requires structural admission.");
  if (typeof captureId !== "string" || captureId.trim() === "")
    throw new Error("Fubon source evidence capture ID is required.");

  const stableSourceIdentity = requireSourceConnectionIdentity(
    "fubon",
    "Fubon source evidence",
    sourceIdentity,
  );
  const manifest = getFubonHumanAttestedV1Manifest();
  const identity = deriveFubonDomesticDepositAccountIdentity(
    capture.account,
    manifest,
    stableSourceIdentity.sourceConnectionKey,
  );
  const subjectDigest = identity.subjectDigest;
  const sourceConnectionKey = identity.sourceConnectionKey;
  const identityEpoch = identity.identityEpochKey;
  const sourceOnly = isSourceOnlyFubonDomesticDepositCaptureEvidence(capture);
  const observedCurrency = capture.providerRouteEvidence?.currency ?? "unknown";
  return {
    captureId: captureId.trim(),
    integrationNamespace: "fubon",
    sourceConnectionKey,
    identityEpoch,
    stream: FUBON_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_STREAM,
    recordKind: FUBON_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND,
    routeKey: FUBON_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
    contractVersion: FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    subjectDigest,
    observedAt: capture.observedAt,
    scope: {
      startDate: sourceDate(capture.queryRange.startDate),
      endDate: sourceDate(capture.queryRange.endDate),
      kind: "bounded-range",
      // This is a transport shape marker only. Financial completeness and
      // absence authority remain explicitly unresolved in the capture.
      completeness: sourceOnly ? "single-page" : "complete-range",
      ruleVersion: FUBON_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION,
    },
    pages: capture.pages.map((page) => ({
      pageOrdinal: page.pageOrdinal,
      responseCode: "200",
      rowCount: page.rows.length,
      terminal: page.terminal,
      metadata: sourcePageMetadata(page),
    })),
    records: capture.pages.flatMap((page) =>
      page.rows.map((row) => {
        const rowDigest = sourceRowDigest(
          page.pageOrdinal,
          row.rowOrdinal,
          row.cells,
        );
        const occurrenceKey = opaqueToken(
          "fubon-source-structural-occurrence-v2",
          subjectDigest,
          manifest.attestationId,
          manifest.evidenceVersion,
          observedCurrency,
          String(page.pageOrdinal),
          String(row.rowOrdinal),
          rowDigest,
        );
        const sourceOccurrenceId = clean(
          (row as { sourceOccurrenceId?: string }).sourceOccurrenceId,
        );
        return {
          occurrenceKey,
          providerKey: rowDigest,
          contentHash: opaqueToken("fubon-source-content-v2", rowDigest),
          compact: {
            evidenceVersion: FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
            pageOrdinal: page.pageOrdinal,
            rowOrdinal: row.rowOrdinal,
            cellCount: row.cells.length,
            observedCurrency,
            rowDigest,
            sourceOccurrenceObserved: sourceOccurrenceId.length > 0,
            ...(sourceOccurrenceId
              ? {
                  sourceOccurrenceDigest: opaqueToken(
                    "fubon-source-occurrence-v2",
                    sourceOccurrenceId,
                  ),
                }
              : {}),
            identityBasis: "page-row-position-and-content",
            semanticStatus: "unresolved",
          },
        };
      }),
    ),
  };
}

/** Commit only the compact source observation; never financial transactions. */
export async function commitFubonDomesticDepositSourceEvidence(
  store: CanonicalSourceStore,
  capture:
    | FubonDomesticDepositValidatedEvidence
    | FubonDomesticDepositSourceOnlyEvidence,
  captureId: string,
  sourceIdentity: Readonly<{
    sourceConnectionScope?: string;
    sourceConnectionKey?: string;
  }>,
): Promise<CanonicalSourceCommitResult> {
  const evidence = createFubonDomesticDepositSourceEvidence(
    capture,
    captureId,
    sourceIdentity,
  );
  return createCanonicalSourceCaptureAdmission(store)
    .admit(evidence)
    .then((admitted) =>
      canonicalSourceAdmissionCommitResult(admitted, evidence.records.length),
    );
}

export const FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION =
  "human-attested-v1" as const;
export const FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY =
  "fubon/domestic-deposit/human-attested-v1" as const;
export const FUBON_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS =
  "canonical-human-attested" as const;
export {
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  getFubonHumanAttestedV1Manifest,
  isFubonHumanAttestedV1Manifest,
  isFubonHumanAttestedV1Active,
  isFubonHumanAttestationDurablyActive,
  latestFubonHumanAttestationEvent,
  recordFubonHumanAttestationEvent,
  revokeFubonHumanAttestedV1,
} from "./fubon-human-attestation.ts";
export type { FubonHumanAttestedV1Manifest } from "./fubon-human-attestation.ts";
export const FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY = "TWD" as const;
export const FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN = "human-attested" as const;
export const FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS =
  "statement-posted-history" as const;
export const FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS =
  "transaction-time" as const;
export const FUBON_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei" as const;
export const FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION =
  "fubon/domestic-deposit/observed-composite-v2" as const;
export const FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS =
  "human-attested-requested-range-all-pages" as const;
export const FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY =
  "comparable-complete-range" as const;

export type FubonDomesticDepositRowStatusEvidence = {
  status: "posted" | "source-only";
  evidence: "explicit-clean-v1" | "status-marker-v1" | "ambiguous-status-v1";
  marker?: string;
};

/**
 * The current table has no independent status column. Only exact provider
 * status/correction markers in description or note cells are classified;
 * anything marked or ambiguous remains source-only rather than being treated
 * as posted history.
 */
export function classifyFubonDomesticDepositRow(
  cells: readonly string[],
): FubonDomesticDepositRowStatusEvidence {
  const description = clean(cells[2]);
  const note = clean(cells[6]);
  const text = `${description} ${note}`.trim();
  if (!text) return { status: "source-only", evidence: "ambiguous-status-v1" };
  const marker = text.match(
    /待處理|待处理|pending|取消|撤銷|撤销|沖正|冲正|更正|退回|退款|reversal|cancel(?:led)?|correction|refund/i,
  )?.[0];
  if (marker)
    return { status: "source-only", evidence: "status-marker-v1", marker };
  return { status: "posted", evidence: "explicit-clean-v1" };
}

/**
 * The workflow supplies this bundle only after the active runtime-branded
 * human-attestation manifest passes. The parser itself remains observation
 * only; row order/text is never accepted as transaction identity.
 */
export type FubonDomesticDepositFinancialSemantics = {
  evidenceVersion: typeof FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION;
  account: {
    accountNo: string;
    sourceConnectionKey: `sha256:${string}`;
    identityEpochKey: `sha256:${string}`;
    subjectDigest: `sha256:${string}`;
    accountType: "depository";
    currency: string;
  };
  authority: {
    route: string;
    scope: "personal-owned-accounts";
    membershipEffectiveDate: string | null;
  };
  posting: {
    status: "posted";
    origin: string;
    basis: string;
    ruleVersion: string;
  };
  direction: {
    outflowCellIndex: 3;
    inflowCellIndex: 4;
    ruleVersion: string;
  };
  effectiveTime: {
    basis: typeof FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS;
    timeZone: string;
    ruleVersion: string;
  };
  cancellation: {
    rule: "explicit-none-only";
    ruleVersion: string;
  };
  completeness: {
    basis: string;
    ruleVersion: string;
    absenceAuthority: string;
  };
  occurrence: {
    ruleVersion: string;
    providerGuaranteed: false;
  };
};

export type FubonDomesticDepositFinancialAdmissionInput = {
  capture: FubonDomesticDepositValidatedEvidence;
  captureId: string;
  semantics?: FubonDomesticDepositFinancialSemantics;
  humanAttestation?: FubonHumanAttestedV1Manifest;
  /**
   * Stable login identity supplied by the workflow.  It is deliberately
   * separate from the human-attested account/epoch identity: a login can
   * select more than one account, while an attestation can advance its epoch.
   * Both fields are mandatory for financial admission. A legacy manifest
   * identity is provenance only and cannot select a Source Connection.
   */
  sourceConnectionScope?: string;
  sourceConnectionKey?: string;
};

export type FubonDomesticDepositFinancialAdmissionDiagnostic =
  | FubonDomesticDepositCaptureDiagnostic
  | "runtime-evidence-brand-missing"
  | "financial-semantics-missing"
  | "financial-evidence-version-invalid"
  | "financial-contract-literal-invalid"
  | "human-attestation-missing"
  | "human-attestation-revoked"
  | "human-attestation-mismatch"
  | "account-identity-unproven"
  | "account-identity-mismatch"
  | "authority-shared-account"
  | "account-type-invalid"
  | "currency-unproven"
  | "provider-route-evidence-missing"
  | "unsupported-currency"
  | "posting-semantics-unproven"
  | "posting-status-invalid"
  | "direction-semantics-unproven"
  | "direction-layout-invalid"
  | "effective-time-semantics-unproven"
  | "cancellation-semantics-unproven"
  | "cancellation-rule-invalid"
  | "authority-semantics-unproven"
  | "authority-membership-invalid"
  | "member-effective-date-after-query-start"
  | "member-effective-date-after-transaction"
  | "completeness-semantics-unproven"
  | "absence-authority-invalid"
  | "zero-result-authority-unproven"
  | "occurrence-identity-unproven"
  | "source-occurrence-id-missing"
  | "provider-occurrence-guarantee-forbidden"
  | "occurrence-ambiguous"
  | "composite-occurrence-collision"
  | "unsupported-time-zone"
  | "source-date-invalid"
  | "source-time-invalid"
  | "row-outside-query-range"
  | "amount-invalid"
  | "balance-invalid"
  | "amount-column-conflict"
  | "amount-sign-invalid"
  | "scope-invalid"
  | "source-connection-scope-invalid"
  | "source-connection-key-invalid"
  | "source-connection-key-mismatch"
  | "row-status-unresolved";

export type FubonDomesticDepositFinancialAdmissionResult = {
  status: "admitted" | "blocked";
  capture: CanonicalFinancialDepositValidatedCapture | null;
  diagnostics: FubonDomesticDepositFinancialAdmissionDiagnostic[];
};

/** Only these conservative uncertainties may be downgraded to source-only. */
export function isFubonSourceOnlyFinancialDiagnostic(
  diagnostic: FubonDomesticDepositFinancialAdmissionDiagnostic,
): boolean {
  return new Set<FubonDomesticDepositFinancialAdmissionDiagnostic>([
    "unsupported-currency",
    "currency-unproven",
    "provider-route-evidence-missing",
    "authority-shared-account",
    "authority-semantics-unproven",
    "human-attestation-missing",
    "human-attestation-mismatch",
    "human-attestation-revoked",
    "posting-status-invalid",
    "posting-semantics-unproven",
    "completeness-semantics-unproven",
    "absence-authority-invalid",
    "zero-result-authority-unproven",
    "row-status-unresolved",
    "page-transition-invalid",
    "terminal-page-incomplete",
    "provider-page-size-invalid",
    "next-page-metadata-incomplete",
    "terminal-page-missing",
    "terminal-page-not-last",
  ]).has(diagnostic);
}

export class FubonDomesticDepositFinancialAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FubonDomesticDepositFinancialAdmissionError";
  }
}

function opaqueToken(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("base64url")}`;
}

function validOpaque(value: string): value is `sha256:${string}` {
  return /^sha256:[A-Za-z0-9_-]+$/.test(value);
}

type FubonSourceConnectionResolution = {
  sourceConnectionKey: `sha256:${string}` | null;
  diagnostics: FubonDomesticDepositFinancialAdmissionDiagnostic[];
};

/**
 * Resolve the workflow's stable login identity without coupling it to the
 * attested account selector or its identity epoch. Financial admission has no
 * manifest-derived fallback; legacy identity is source/provenance only.
 */
function resolveFubonSourceConnection(
  input: FubonDomesticDepositFinancialAdmissionInput,
): FubonSourceConnectionResolution {
  const validated = validateSourceConnectionIdentity("fubon", input);
  return {
    sourceConnectionKey: validated.sourceConnectionKey,
    diagnostics: [...validated.defects],
  };
}

function exactAmount(
  value: string,
): { coefficient: string; scale: number } | null {
  const normalized = clean(value).replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return {
    coefficient: `${whole}${fraction}`.replace(/^0+(?=\d)/, ""),
    scale: fraction.length,
  };
}

function sourceTime(
  cells: readonly string[],
  timeZone: string,
): {
  localDate: string;
  localTime: string;
  timeZone: string;
  epochMilliseconds: number;
} | null {
  if (timeZone !== "Asia/Taipei") return null;
  const accountingDate = clean(cells[0]).replace(/\//g, "-");
  const observedTime = clean(cells[1]);
  const bareTimeMatch = observedTime.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  const providerDateTimeMatch = observedTime.match(
    /^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!validDate(accountingDate) || (!bareTimeMatch && !providerDateTimeMatch))
    return null;

  // The provider exposes accounting date and transaction time as independent
  // fields. The live transaction-time field may carry its own date, which can
  // legitimately differ from the accounting date across a posting boundary.
  // A legacy bare time has no independent date evidence, so only that shape
  // falls back to the accounting date.
  const transactionDate = providerDateTimeMatch
    ? `${providerDateTimeMatch[1]}-${providerDateTimeMatch[2]}-${providerDateTimeMatch[3]}`
    : accountingDate;
  if (!validDate(transactionDate)) return null;
  const [, hour, minute, second] = bareTimeMatch ?? [
    providerDateTimeMatch![0],
    providerDateTimeMatch![4],
    providerDateTimeMatch![5],
    providerDateTimeMatch![6],
  ];
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)
    return null;
  const time = `${hour}:${minute}:${second}`;
  const epochMilliseconds = Date.parse(`${transactionDate}T${time}+08:00`);
  if (!Number.isSafeInteger(epochMilliseconds)) return null;
  return {
    localDate: transactionDate,
    localTime: time,
    timeZone,
    epochMilliseconds,
  };
}

export type FubonDomesticDepositAccountIdentity = {
  accountNo: `sha256:${string}`;
  sourceConnectionKey: `sha256:${string}`;
  identityEpochKey: `sha256:${string}`;
  subjectDigest: `sha256:${string}`;
};

/**
 * Derive stable, privacy-safe identity keys from one selector option. The
 * selector value is never persisted as an account number; multiple options
 * therefore remain distinct subjects without leaking the raw value. Omitting
 * sourceConnectionKey preserves a legacy compatibility calculation only;
 * source and financial admission always supply a validated workflow key and
 * never persist the compatibility result.
 */
export function deriveFubonDomesticDepositAccountIdentity(
  account: FubonDomesticDepositCaptureEvidence["account"],
  manifest: FubonHumanAttestedV1Manifest = getFubonHumanAttestedV1Manifest(),
  sourceConnectionKey?: `sha256:${string}`,
): FubonDomesticDepositAccountIdentity {
  const subjectDigest = sourceAccountDigest(account);
  return {
    accountNo: subjectDigest,
    sourceConnectionKey:
      sourceConnectionKey ??
      opaqueToken(
        "fubon-source-connection-v2",
        "fubon",
        FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
        manifest.attestationId,
        manifest.evidenceVersion,
      ),
    identityEpochKey: opaqueToken(
      "fubon-source-epoch-v2",
      FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
      manifest.attestationId,
      manifest.evidenceVersion,
      manifest.status,
      FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
    ),
    subjectDigest,
  };
}

function hasPositiveTwdDomesticRouteEvidence(
  capture: FubonDomesticDepositCaptureEvidence,
): boolean {
  const route = capture.providerRouteEvidence;
  return (
    route?.endpointPath === FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_PATH &&
    route.contract === FUBON_DOMESTIC_DEPOSIT_PROVIDER_ROUTE_CONTRACT &&
    route.currency === "TWD"
  );
}

function hasExplicitFxAccountMarker(
  account: FubonDomesticDepositCaptureEvidence["account"],
): boolean {
  return /(?:\bUSD\b|\bEUR\b|\bJPY\b|\bCNY\b|\bHKD\b|\bGBP\b|外幣|外汇|外匯)/i.test(
    clean(account.label),
  );
}

function hasSharedAccountMarker(
  account: FubonDomesticDepositCaptureEvidence["account"],
): boolean {
  return /共同|共有|聯名|联名|聯合|联合|joint|shared|co[- ]?owner|代理|代管/i.test(
    clean(account.label),
  );
}

function normalizedSourceCell(value: string): string {
  return clean(value).replace(/\s+/g, " ");
}

function normalizedOccurrenceIdentityCells(
  cells: readonly string[],
): readonly string[] {
  // The provider's note cell can change when the same transaction is returned
  // through two overlapping query windows. It remains available to structural
  // evidence hashing and workflow relation extraction, but is excluded from
  // occurrence identity. The first six cells are the stable booked tuple:
  // date, time, summary, outflow, inflow, and balance.
  return cells.slice(0, 6).map(normalizedSourceCell);
}

function hasValidatedEvidence(
  value: unknown,
): value is FubonDomesticDepositValidatedEvidence {
  return isAdmittedFubonDomesticDepositCaptureEvidence(value);
}

function normalizeFubonDomesticDepositFinancialCapture(
  input: FubonDomesticDepositFinancialAdmissionInput,
): FubonDomesticDepositFinancialAdmissionResult {
  const diagnostics: FubonDomesticDepositFinancialAdmissionDiagnostic[] = [];
  if (input === null || typeof input !== "object") {
    diagnostics.push("scope-invalid", "runtime-evidence-brand-missing");
    return { status: "blocked", capture: null, diagnostics };
  }
  if (!hasValidatedEvidence(input.capture)) {
    diagnostics.push("runtime-evidence-brand-missing");
    return { status: "blocked", capture: null, diagnostics };
  }
  if (typeof input.captureId !== "string" || !clean(input.captureId))
    diagnostics.push("scope-invalid");

  const attestation = input.humanAttestation;
  if (!attestation || !isFubonHumanAttestedV1Manifest(attestation))
    diagnostics.push(
      attestation ? "human-attestation-mismatch" : "human-attestation-missing",
    );
  if (!isFubonHumanAttestedV1Active())
    diagnostics.push("human-attestation-revoked");

  const semantics = input.semantics;
  if (!semantics) {
    diagnostics.push(
      "financial-semantics-missing",
      "account-identity-unproven",
      "currency-unproven",
      "posting-semantics-unproven",
      "direction-semantics-unproven",
      "effective-time-semantics-unproven",
      "cancellation-semantics-unproven",
      "authority-semantics-unproven",
      "completeness-semantics-unproven",
      "occurrence-identity-unproven",
      "source-occurrence-id-missing",
    );
    return {
      status: "blocked",
      capture: null,
      diagnostics: [...new Set(diagnostics)],
    };
  }
  if (
    semantics.account === null ||
    typeof semantics.account !== "object" ||
    semantics.authority === null ||
    typeof semantics.authority !== "object" ||
    semantics.posting === null ||
    typeof semantics.posting !== "object" ||
    semantics.direction === null ||
    typeof semantics.direction !== "object" ||
    semantics.effectiveTime === null ||
    typeof semantics.effectiveTime !== "object" ||
    semantics.cancellation === null ||
    typeof semantics.cancellation !== "object" ||
    semantics.completeness === null ||
    typeof semantics.completeness !== "object" ||
    semantics.occurrence === null ||
    typeof semantics.occurrence !== "object"
  ) {
    diagnostics.push(
      "financial-contract-literal-invalid",
      "account-identity-unproven",
      "posting-semantics-unproven",
      "direction-semantics-unproven",
      "effective-time-semantics-unproven",
      "cancellation-semantics-unproven",
      "authority-semantics-unproven",
      "completeness-semantics-unproven",
      "occurrence-identity-unproven",
    );
    return {
      status: "blocked",
      capture: null,
      diagnostics: [...new Set(diagnostics)],
    };
  }

  const attestedManifest = isFubonHumanAttestedV1Manifest(attestation)
    ? attestation
    : FUBON_HUMAN_ATTESTED_V1_MANIFEST;
  const sourceConnection = resolveFubonSourceConnection(input);
  diagnostics.push(...sourceConnection.diagnostics);
  if (!sourceConnection.sourceConnectionKey)
    return {
      status: "blocked",
      capture: null,
      diagnostics: [...new Set(diagnostics)],
    };
  const identity = deriveFubonDomesticDepositAccountIdentity(
    input.capture.account,
    attestedManifest,
    sourceConnection.sourceConnectionKey,
  );
  if (
    semantics.account.accountNo !== identity.accountNo ||
    semantics.account.sourceConnectionKey !== identity.sourceConnectionKey ||
    semantics.account.identityEpochKey !== identity.identityEpochKey ||
    semantics.account.subjectDigest !== identity.subjectDigest
  )
    diagnostics.push("account-identity-mismatch");
  if (semantics.account.accountType !== "depository")
    diagnostics.push("account-type-invalid");
  if (
    !validOpaque(semantics.account.sourceConnectionKey) ||
    !validOpaque(semantics.account.identityEpochKey) ||
    !validOpaque(semantics.account.subjectDigest) ||
    !validOpaque(semantics.account.accountNo)
  )
    diagnostics.push("account-identity-unproven");
  if (
    semantics.account.currency !== FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY
  ) {
    diagnostics.push("currency-unproven", "unsupported-currency");
  }
  const routeEvidence = input.capture.providerRouteEvidence;
  if (hasSharedAccountMarker(input.capture.account))
    diagnostics.push("authority-shared-account");
  if (hasExplicitFxAccountMarker(input.capture.account)) {
    diagnostics.push("unsupported-currency");
  } else if (!hasPositiveTwdDomesticRouteEvidence(input.capture)) {
    if (routeEvidence?.currency === "FX")
      diagnostics.push("unsupported-currency");
    else
      diagnostics.push("provider-route-evidence-missing", "currency-unproven");
  }
  if (
    semantics.posting.origin !== FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN ||
    semantics.posting.basis !== FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS
  )
    diagnostics.push("posting-semantics-unproven");
  if (semantics.posting.status !== "posted")
    diagnostics.push("posting-status-invalid", "posting-semantics-unproven");
  if (
    semantics.direction.outflowCellIndex !== 3 ||
    semantics.direction.inflowCellIndex !== 4
  )
    diagnostics.push(
      "direction-layout-invalid",
      "direction-semantics-unproven",
    );
  if (
    semantics.effectiveTime.basis !==
      FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS ||
    semantics.effectiveTime.timeZone !== FUBON_DOMESTIC_DEPOSIT_TIME_ZONE
  )
    diagnostics.push("effective-time-semantics-unproven");
  if (semantics.cancellation.rule !== "explicit-none-only")
    diagnostics.push(
      "cancellation-rule-invalid",
      "cancellation-semantics-unproven",
    );
  if (semantics.authority.route !== FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY)
    diagnostics.push("authority-semantics-unproven");
  if (semantics.authority.scope !== "personal-owned-accounts")
    diagnostics.push(
      "authority-shared-account",
      "authority-semantics-unproven",
    );
  if (semantics.authority.membershipEffectiveDate !== null)
    diagnostics.push("authority-membership-invalid");
  if (
    semantics.evidenceVersion !==
      FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION ||
    semantics.posting.ruleVersion !==
      FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY ||
    semantics.direction.ruleVersion !==
      FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY ||
    semantics.effectiveTime.ruleVersion !==
      FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY ||
    semantics.cancellation.ruleVersion !==
      FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY ||
    semantics.completeness.ruleVersion !==
      FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY ||
    semantics.occurrence.ruleVersion !==
      FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION ||
    semantics.posting.origin !== FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN ||
    semantics.posting.basis !== FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS ||
    semantics.effectiveTime.basis !==
      FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS ||
    semantics.effectiveTime.timeZone !== FUBON_DOMESTIC_DEPOSIT_TIME_ZONE
  )
    diagnostics.push("financial-contract-literal-invalid");
  if (semantics.occurrence.providerGuaranteed !== false)
    diagnostics.push(
      "provider-occurrence-guarantee-forbidden",
      "occurrence-identity-unproven",
    );
  if (
    semantics.completeness.basis !== FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS
  )
    diagnostics.push("completeness-semantics-unproven");
  if (
    semantics.completeness.absenceAuthority !==
    FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY
  )
    diagnostics.push("absence-authority-invalid");

  const zeroAuthority = (
    input.capture as FubonDomesticDepositCaptureEvidence & {
      zeroResultAuthority?: string;
    }
  ).zeroResultAuthority;
  if (
    input.capture.zeroObservation === "empty-range" &&
    zeroAuthority !== "provider-explicit-no-data"
  )
    diagnostics.push("zero-result-authority-unproven");

  const rows = input.capture.pages.flatMap((page) =>
    page.rows.map((row) => ({ page, row })),
  );
  const queryStart = input.capture.queryRange.startDate.replace(/\//g, "-");
  const queryEnd = input.capture.queryRange.endDate.replace(/\//g, "-");
  const seenFences = new Map<string, string>();
  const records: CanonicalFinancialDepositRecord[] = [];
  for (const { page, row } of rows) {
    const cells = row.cells;
    const rowStatus = classifyFubonDomesticDepositRow(cells);
    if (rowStatus.status !== "posted")
      diagnostics.push("row-status-unresolved");
    const rowDate = clean(cells[0]).replace(/\//g, "-");
    if (!validDate(rowDate)) diagnostics.push("source-date-invalid");
    else if (rowDate < queryStart || rowDate > queryEnd)
      diagnostics.push("row-outside-query-range");
    const outflowLexeme = clean(cells[semantics.direction.outflowCellIndex]);
    const inflowLexeme = clean(cells[semantics.direction.inflowCellIndex]);
    const outflow = exactAmount(outflowLexeme);
    const inflow = exactAmount(inflowLexeme);
    if ((outflowLexeme && inflowLexeme) || (!outflowLexeme && !inflowLexeme))
      diagnostics.push("amount-column-conflict");
    if ((outflowLexeme && !outflow) || (inflowLexeme && !inflow))
      diagnostics.push("amount-sign-invalid");
    const amount = outflow ?? inflow;
    const balanceAfter = exactAmount(cells[5]);
    const direction = outflow ? "outflow" : inflow ? "inflow" : null;
    const time = sourceTime(cells, semantics.effectiveTime.timeZone);
    if (!amount) diagnostics.push("amount-invalid");
    if (!balanceAfter) diagnostics.push("balance-invalid");
    if (!time) diagnostics.push("source-time-invalid");
    if (!amount || !balanceAfter || !time || !direction) continue;
    const contentHash = opaqueToken(
      "fubon-observed-composite-content-v2",
      ...normalizedOccurrenceIdentityCells(cells),
    );
    const fence = opaqueToken(
      "fubon-observed-composite-fence-v2",
      identity.subjectDigest,
      FUBON_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
      FUBON_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
      semantics.account.currency,
      `${time.localDate}T${time.localTime}`,
      direction,
      amount.coefficient,
      String(amount.scale),
      balanceAfter.coefficient,
      String(balanceAfter.scale),
    );
    const occurrenceKey = opaqueToken(
      "fubon-observed-composite-occurrence-v2",
      fence,
      contentHash,
    );
    const priorContentHash = seenFences.get(fence);
    if (priorContentHash !== undefined) {
      // Without a provider occurrence identifier, any repeated composite
      // fence in one capture is ambiguous: equal rows may be distinct
      // transactions, while different content is also an atomic collision.
      diagnostics.push("occurrence-ambiguous");
      if (priorContentHash !== contentHash)
        diagnostics.push("composite-occurrence-collision");
      continue;
    }
    seenFences.set(fence, contentHash);
    records.push({
      occurrenceKey,
      collisionKey: fence,
      providerKey: fence,
      contentHash,
      sequenceLexeme: occurrenceKey,
      compactJson: JSON.stringify({
        evidenceVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
        subjectDigest: identity.subjectDigest,
        currency: semantics.account.currency,
        pageOrdinal: page.pageOrdinal,
        rowOrdinal: row.rowOrdinal,
        date: time.localDate,
        time: time.localTime,
        direction,
        amount,
        balanceAfter,
        contentHash,
        rowStatusEvidence: rowStatus.evidence,
      }),
      amount,
      balanceAfter,
      currency: semantics.account.currency,
      direction,
      sourceTime: time,
      effectiveOn: time.localDate,
      transactionDateTimeLocal: `${time.localDate}T${time.localTime}`,
    });
  }
  if (diagnostics.length > 0)
    return {
      status: "blocked",
      capture: null,
      diagnostics: [...new Set(diagnostics)],
    };

  const contractFingerprint = opaqueToken(
    "fubon-contract-v3",
    FUBON_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    semantics.evidenceVersion,
    FUBON_HUMAN_ATTESTED_V1_MANIFEST.provenance.sourceCaptureFingerprint,
  );
  const preflightFingerprint = opaqueToken(
    "fubon-preflight-v3",
    identity.subjectDigest,
    input.capture.queryRange.startDate,
    input.capture.queryRange.endDate,
  );
  const canonicalCapture = admitCanonicalFinancialDepositCapture({
    captureId: input.captureId,
    authorityRoute: semantics.authority.route,
    contractVersion: semantics.evidenceVersion,
    identity: {
      integrationNamespace: "fubon",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
      recordKind: "fubon-domestic-deposit",
      subjectDigest: identity.subjectDigest,
      accountNo: identity.accountNo,
      accountType: semantics.account.accountType,
      currency: semantics.account.currency,
    },
    observedAt: input.capture.observedAt,
    scope: {
      startDate: input.capture.queryRange.startDate.replace(/\//g, "-"),
      endDate: input.capture.queryRange.endDate.replace(/\//g, "-"),
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: semantics.completeness.basis,
      completenessRuleVersion: semantics.completeness.ruleVersion,
      absenceAuthority: semantics.completeness.absenceAuthority,
      contractFingerprint,
      preflightFingerprint,
      pageCount: input.capture.pages.length,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: semantics.posting.status,
      postingOrigin: semantics.posting.origin,
      postingBasis: semantics.posting.basis,
      postingRuleVersion: semantics.posting.ruleVersion,
      economicStatus: "normal",
      administrativeState: "active",
      // The shared assertion spine requires the semantic lineage to equal the
      // authority route; the version remains carried by contractVersion.
      semanticRuleVersion: semantics.authority.route,
      effectiveTimeBasis: semantics.effectiveTime.basis,
      effectiveTimeRuleVersion: semantics.effectiveTime.ruleVersion,
      timeZone: semantics.effectiveTime.timeZone,
      timePrecision: "second",
      timeOrigin: "source_reported",
      requireBalance: true,
    },
    pages: input.capture.pages.map((page) => ({
      pageOrdinal: page.pageOrdinal,
      responseCode: "200",
      terminal: page.terminal,
      rowCount: page.rows.length,
      responseDigest: opaqueToken(
        "fubon-page-v3",
        String(page.pageOrdinal),
        String(page.responseSequence),
        ...page.rows.flatMap((row) => row.cells.map(normalizedSourceCell)),
      ),
      proofKind: semantics.completeness.basis,
      contractFingerprint,
      preflightFingerprint,
      metadataJson: JSON.stringify({
        pageOrdinal: page.pageOrdinal,
        responseSequence: page.responseSequence,
        terminal: page.terminal,
        rowCount: page.rows.length,
        zeroObservation: page.zeroObservation,
        zeroResultAuthority: zeroAuthority ?? null,
        withdrawalPolicy: "never-infer",
        occurrenceRule: FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
        providerGuaranteed: false,
      }),
    })),
    records,
  });
  return { status: "admitted", capture: canonicalCapture, diagnostics: [] };
}

export function admitFubonDomesticDepositFinancialCapture(
  input: FubonDomesticDepositFinancialAdmissionInput,
): FubonDomesticDepositFinancialAdmissionResult {
  return normalizeFubonDomesticDepositFinancialCapture(input);
}

export async function commitCanonicalFubonDomesticDepositCapture(
  store: CanonicalFinancialDepositWriterStore,
  input: FubonDomesticDepositFinancialAdmissionInput,
): Promise<CanonicalFinancialDepositCommitResult> {
  ensureFubonHumanAttestationEvents(store.db);
  const latest = latestFubonHumanAttestationEvent(store.db);
  if (latest?.eventKind === "revoked") {
    throw new FubonDomesticDepositFinancialAdmissionError(
      "Fubon human attestation is durably revoked; future admission is blocked.",
    );
  }
  if (!isFubonHumanAttestedV1Active()) {
    throw new FubonDomesticDepositFinancialAdmissionError(
      "Fubon human attestation is revoked; future admission is blocked.",
    );
  }
  const admission = admitFubonDomesticDepositFinancialCapture(input);
  if (admission.status !== "admitted" || !admission.capture) {
    throw new FubonDomesticDepositFinancialAdmissionError(
      `Fubon domestic deposit canonical admission blocked: ${admission.diagnostics.join(", ")}`,
    );
  }
  const result = await commitCanonicalFinancialDepositCapture(
    store,
    admission.capture,
  );
  recordInitialFubonHumanAttestationIfMissing(
    store.db,
    input.capture.observedAt,
  );
  return result;
}
