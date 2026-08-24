import { createHash } from "node:crypto";
import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";
import {
  admitCanonicalSourceEvidence,
  commitCanonicalSourceEvidenceBatch,
  type CanonicalSourceCommitResult,
  type CanonicalSourceEvidence,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  CTBC_HUMAN_ATTESTED_V1_MANIFEST,
  ctbcHumanAttestedIdentityEpochKey,
  ensureCtbcHumanAttestationEvents,
  getCtbcHumanAttestedV1Manifest,
  isCtbcHumanAttestationDurablyActive,
  isCtbcHumanAttestedV1Active,
  isCtbcHumanAttestedV1Manifest,
  latestCtbcHumanAttestationEvent,
  recordInitialCtbcHumanAttestationIfMissing,
  type CtbcHumanAttestedV1Manifest,
} from "./ctbc-human-attestation.ts";

export const CTBC_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "ctbc",
  authority: "ctbc/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "ctbcStatements",
  expectedRowWidth: 8,
  accountingDateIndex: 0,
  transactionDateIndex: 1,
  transactionTimeIndex: 2,
  provenance: {
    evidenceBasis: "provider detailList fields and explicit no-data code 9201",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 4,
  inflowIndex: 5,
  completenessEvidence: "pagination-termination",
  explicitNoDataEvidence: { kind: "code", code: "9201" },
} as const satisfies AdvertisedDomesticDepositContract;

export const CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-CTBC-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/01/31" },
  records: [
    {
      values: [
        "2026/01/02",
        "2026/01/02",
        "09:10:11",
        "SYNTHETIC",
        "0",
        "100",
        "900",
        "",
      ],
    },
  ],
  transport: { pageNumbers: [1], terminalPageObserved: true },
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightCtbcDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(CTBC_DOMESTIC_DEPOSIT_CONTRACT);

export const CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION =
  "capture-evidence-v1" as const;
export const CTBC_DOMESTIC_DEPOSIT_SOURCE_ROUTE =
  "ctbc/domestic-deposit/capture-evidence-v1" as const;
export const CTBC_DOMESTIC_DEPOSIT_SOURCE_RULE_VERSION =
  CTBC_DOMESTIC_DEPOSIT_SOURCE_ROUTE;
export const CTBC_DOMESTIC_DEPOSIT_SOURCE_RECORD_KIND =
  "ctbc-domestic-deposit-row-v1" as const;
export const CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY =
  CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE;
export const CTBC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION =
  CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION;
export const CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS =
  "canonical-human-attested" as const;
export const CTBC_DOMESTIC_DEPOSIT_FINANCIAL_COMPLETENESS_BASIS =
  "all-visible-ranges-terminal-next-key-empty" as const;

export type CtbcDomesticDepositCaptureRow = {
  rowOrdinal: number;
  values: string[];
};
export type CtbcDomesticDepositCaptureResponse = {
  rangeOrdinal: number;
  startDate: string;
  endDate: string;
  code: "0000" | "9201";
  rows: CtbcDomesticDepositCaptureRow[];
  nextKey: string | null;
  terminal: boolean;
};
export type CtbcDomesticDepositCaptureEvidence = {
  evidenceVersion: typeof CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION;
  source: "ctbc";
  product: "domestic-deposit";
  providerGuaranteed: false;
  observedAt: string;
  account: { accountId: string };
  queryRange: { startDate: string; endDate: string };
  responses: CtbcDomesticDepositCaptureResponse[];
  provenance: {
    source: "ctbc-ebmw-qu002-011-natural-response";
    rangeInventorySource: "ctbc-ebmw-qu002-010-dateRanges";
    expectedRangeCount: number;
    responseBodyRetained: false;
    authority: "personal-main";
  };
};
export type CtbcDomesticDepositValidatedEvidence =
  CtbcDomesticDepositCaptureEvidence & {
    readonly __ctbcDomesticDepositValidated: unique symbol;
  };
export type CtbcDomesticDepositCaptureAdmission =
  | {
      status: "admissible";
      capture: CtbcDomesticDepositValidatedEvidence;
      diagnostics: readonly string[];
    }
  | { status: "rejected"; capture: null; diagnostics: readonly string[] };

const VALIDATED = new WeakSet<object>();
const SLASH_DATE = /^\d{4}\/\d{2}\/\d{2}$/;
const LOCAL_SECOND = /^\d{2}:\d{2}:\d{2}$/;

function cell(value: string): string {
  return value
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function digest(domain: string, ...values: string[]): `sha256:${string}` {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const value of values) {
    hash.update("\0");
    hash.update(value);
  }
  return `sha256:${hash.digest("base64url")}`;
}
function validDate(value: string): boolean {
  if (!SLASH_DATE.test(value)) return false;
  const [y, m, d] = value.split("/").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m! - 1 &&
    date.getUTCDate() === d
  );
}
function validTime(value: string): boolean {
  if (!LOCAL_SECOND.test(value)) return false;
  const [h, m, s] = value.split(":").map(Number);
  return h! < 24 && m! < 60 && s! < 60;
}
function validObservedAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+08:00$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function amountClass(value: string): "zero" | "nonzero" | "invalid" {
  const normalized = cell(value).replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return "invalid";
  return Number(normalized) === 0 ? "zero" : "nonzero";
}
function cancellationMarker(values: readonly string[]): boolean {
  return /(?:沖正|沖銷|取消|更正|撤銷|reversal|reverse|cancel)/iu.test(
    values.join(" "),
  );
}

export function admitCtbcDomesticDepositCaptureEvidence(
  value: unknown,
): CtbcDomesticDepositCaptureAdmission {
  const diagnostics: string[] = [];
  const capture =
    value && typeof value === "object"
      ? (value as Partial<CtbcDomesticDepositCaptureEvidence>)
      : null;
  if (
    capture?.evidenceVersion !== CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION ||
    capture.source !== "ctbc" ||
    capture.product !== "domestic-deposit" ||
    capture.providerGuaranteed !== false
  )
    diagnostics.push("contract-invalid");
  if (
    typeof capture?.observedAt !== "string" ||
    !validObservedAt(capture.observedAt)
  )
    diagnostics.push("observed-at-invalid");
  if (
    typeof capture?.account?.accountId !== "string" ||
    !cell(capture.account.accountId)
  )
    diagnostics.push("account-invalid");
  const start = capture?.queryRange?.startDate;
  const end = capture?.queryRange?.endDate;
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    !validDate(start) ||
    !validDate(end) ||
    start > end
  )
    diagnostics.push("query-range-invalid");
  const responses = capture?.responses;
  if (!Array.isArray(responses) || responses.length === 0)
    diagnostics.push("responses-invalid");
  else
    for (const [rangeOrdinal, response] of responses.entries()) {
      if (!response || typeof response !== "object") {
        diagnostics.push("response-invalid");
        continue;
      }
      if (response.rangeOrdinal !== rangeOrdinal)
        diagnostics.push("range-order-invalid");
      if (
        !validDate(response.startDate) ||
        !validDate(response.endDate) ||
        response.startDate > response.endDate
      )
        diagnostics.push("response-range-invalid");
      if (response.code !== "0000" && response.code !== "9201")
        diagnostics.push("response-code-invalid");
      if (
        typeof response.terminal !== "boolean" ||
        (response.terminal && response.nextKey !== null) ||
        (!response.terminal &&
          (typeof response.nextKey !== "string" || !response.nextKey.trim()))
      )
        diagnostics.push("pagination-state-invalid");
      if (!Array.isArray(response.rows)) {
        diagnostics.push("rows-invalid");
        continue;
      }
      if (
        (response.code === "9201" && response.rows.length !== 0) ||
        (response.code === "0000" && response.rows.length === 0)
      )
        diagnostics.push("response-row-conflict");
      for (const [rowOrdinal, row] of response.rows.entries()) {
        if (row?.rowOrdinal !== rowOrdinal)
          diagnostics.push("row-order-invalid");
        if (
          !Array.isArray(row?.values) ||
          row.values.length !== 8 ||
          row.values.some((item) => typeof item !== "string")
        )
          diagnostics.push("row-shape-invalid");
      }
    }
  if (
    Array.isArray(responses) &&
    responses.length > 0 &&
    typeof start === "string" &&
    typeof end === "string"
  ) {
    const observedStart = [...responses]
      .map((item) => item.startDate)
      .sort()[0];
    const observedEnd = [...responses]
      .map((item) => item.endDate)
      .sort()
      .at(-1);
    if (observedStart !== start || observedEnd !== end)
      diagnostics.push("query-range-coverage-unproven");
  }
  if (
    capture?.provenance?.source !== "ctbc-ebmw-qu002-011-natural-response" ||
    capture?.provenance?.rangeInventorySource !==
      "ctbc-ebmw-qu002-010-dateRanges" ||
    !Number.isInteger(capture?.provenance?.expectedRangeCount) ||
    (capture?.provenance?.expectedRangeCount ?? 0) <= 0 ||
    capture?.provenance?.expectedRangeCount !== responses?.length ||
    capture?.provenance?.responseBodyRetained !== false ||
    capture?.provenance?.authority !== "personal-main"
  )
    diagnostics.push("provenance-invalid");
  const unique = [...new Set(diagnostics)];
  if (unique.length)
    return { status: "rejected", capture: null, diagnostics: unique };
  VALIDATED.add(value as object);
  return {
    status: "admissible",
    capture: value as CtbcDomesticDepositValidatedEvidence,
    diagnostics: [],
  };
}

export function isAdmittedCtbcDomesticDepositCaptureEvidence(
  value: unknown,
): value is CtbcDomesticDepositValidatedEvidence {
  return value !== null && typeof value === "object" && VALIDATED.has(value);
}

export function createCtbcDomesticDepositSourceEvidence(
  capture: CtbcDomesticDepositValidatedEvidence,
  captureId: string,
): CanonicalSourceEvidence {
  if (!isAdmittedCtbcDomesticDepositCaptureEvidence(capture))
    throw new Error("CTBC source evidence requires structural admission.");
  if (!captureId.trim())
    throw new Error("CTBC source evidence capture ID is required.");
  const account = cell(capture.account.accountId);
  const subjectDigest = digest("ctbc-source-subject-v1", account);
  const allTerminal = capture.responses.every(
    (page) => page.terminal && page.nextKey === null,
  );
  const allNoData = capture.responses.every((page) => page.code === "9201");
  return {
    captureId: captureId.trim(),
    integrationNamespace: "ctbc",
    sourceConnectionKey: digest("ctbc-source-connection-v1", "personal-main"),
    identityEpoch: digest(
      "ctbc-source-identity-epoch-v1",
      CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    ),
    stream: "domestic-deposit",
    recordKind: CTBC_DOMESTIC_DEPOSIT_SOURCE_RECORD_KIND,
    routeKey: CTBC_DOMESTIC_DEPOSIT_SOURCE_ROUTE,
    contractVersion: CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    subjectDigest,
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.queryRange.startDate.replaceAll("/", ""),
      endDate: capture.queryRange.endDate.replaceAll("/", ""),
      kind: "bounded-range",
      completeness: allTerminal ? "complete-range" : "single-page",
      ruleVersion: CTBC_DOMESTIC_DEPOSIT_SOURCE_RULE_VERSION,
      ...(allTerminal && allNoData
        ? { absenceAuthority: "provider-explicit-no-data" as const }
        : {}),
    },
    pages: capture.responses.map((response, index) => ({
      pageOrdinal: response.rangeOrdinal,
      responseCode: "200",
      rowCount: response.rows.length,
      terminal: index === capture.responses.length - 1,
      metadata: {
        rangeStart: response.startDate,
        rangeEnd: response.endDate,
        nextKeyState: response.nextKey === null ? "empty" : "present",
        providerTerminal: response.terminal,
        providerCode: response.code,
        providerExplicitNoData: response.code === "9201",
      },
    })),
    records: capture.responses.flatMap((response) =>
      response.rows.map((row) => {
        const cells = row.values.map(cell);
        const rowDigest = digest(
          "ctbc-source-row-v1",
          String(response.rangeOrdinal),
          String(row.rowOrdinal),
          ...cells,
        );
        return {
          occurrenceKey: digest(
            "ctbc-source-occurrence-v1",
            subjectDigest,
            String(response.rangeOrdinal),
            String(row.rowOrdinal),
            rowDigest,
          ),
          collisionKey: digest(
            "ctbc-source-collision-v1",
            subjectDigest,
            rowDigest,
          ),
          providerKey: rowDigest,
          contentHash: digest("ctbc-source-content-v1", rowDigest),
          compact: {
            evidenceVersion: capture.evidenceVersion,
            rangeOrdinal: response.rangeOrdinal,
            rowOrdinal: row.rowOrdinal,
            rowDigest,
            columnCount: cells.length,
            accountingDateShape: validDate(cells[0]!) ? "slash-date" : "other",
            transactionDateShape: validDate(cells[1]!) ? "slash-date" : "other",
            transactionTimeShape: validTime(cells[2]!)
              ? "local-second"
              : "other",
            outflowAmountClass: amountClass(cells[4]!),
            inflowAmountClass: amountClass(cells[5]!),
            providerGuaranteed: false,
            canonicalAdmission: "blocked",
            sourceStage: "source-only",
          },
        };
      }),
    ),
  };
}

export async function commitCtbcDomesticDepositSourceEvidenceBatch(
  store: CanonicalSourceStore,
  inputs: readonly {
    capture: CtbcDomesticDepositValidatedEvidence;
    captureId: string;
  }[],
): Promise<CanonicalSourceCommitResult[]> {
  if (!inputs.length)
    throw new Error("CTBC source evidence batch cannot be empty.");
  return commitCanonicalSourceEvidenceBatch(
    store,
    inputs.map(({ capture, captureId }) =>
      admitCanonicalSourceEvidence(
        createCtbcDomesticDepositSourceEvidence(capture, captureId),
      ),
    ),
  );
}

export type CtbcDomesticDepositFinancialAdmissionInput = {
  capture: CtbcDomesticDepositValidatedEvidence;
  captureId: string;
  humanAttestation?: CtbcHumanAttestedV1Manifest;
};
export type CtbcDomesticDepositFinancialAdmissionResult = {
  status: "admitted" | "blocked";
  capture: CanonicalFinancialDepositValidatedCapture | null;
  diagnostics: string[];
};
export class CtbcDomesticDepositFinancialAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtbcDomesticDepositFinancialAdmissionError";
  }
}

function financialAmount(
  value: string,
  allowZero = false,
): { coefficient: string; scale: number } | null {
  const normalized = cell(value).replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole = "", fraction = ""] = normalized.split(".");
  const coefficient = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  if (!allowZero && BigInt(coefficient) === 0n) return null;
  return { coefficient, scale: fraction.length };
}
function isoDate(value: string): string | null {
  return validDate(cell(value)) ? cell(value).replaceAll("/", "-") : null;
}
function financialRecord(
  subjectDigest: string,
  response: CtbcDomesticDepositCaptureResponse,
  row: CtbcDomesticDepositCaptureRow,
): { record: CanonicalFinancialDepositRecord | null; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const cells = row.values.map(cell);
  const accountingDate = isoDate(cells[0] ?? "");
  const transactionDate = isoDate(cells[1] ?? "");
  const transactionTime = cells[2] ?? "";
  if (!accountingDate) diagnostics.push("accounting-date-invalid");
  if (!transactionDate) diagnostics.push("transaction-date-invalid");
  if (!validTime(transactionTime)) diagnostics.push("transaction-time-invalid");
  const outflowClass = amountClass(cells[4] ?? "");
  const inflowClass = amountClass(cells[5] ?? "");
  const direction =
    outflowClass === "nonzero" && inflowClass === "zero"
      ? "outflow"
      : outflowClass === "zero" && inflowClass === "nonzero"
        ? "inflow"
        : null;
  if (!direction) diagnostics.push("amount-direction-invalid");
  if (cancellationMarker([cells[3] ?? "", cells[7] ?? ""]))
    diagnostics.push("cancellation-unsupported");
  const amount = direction
    ? financialAmount(cells[direction === "outflow" ? 4 : 5] ?? "")
    : null;
  const balanceAfter = financialAmount(cells[6] ?? "", true);
  if (!balanceAfter) diagnostics.push("balance-invalid");
  if (
    !accountingDate ||
    !transactionDate ||
    !validTime(transactionTime) ||
    !direction ||
    !amount ||
    !balanceAfter ||
    diagnostics.includes("cancellation-unsupported")
  )
    return { record: null, diagnostics };
  const epochMilliseconds = Date.parse(
    `${transactionDate}T${transactionTime}+08:00`,
  );
  if (!Number.isSafeInteger(epochMilliseconds))
    return {
      record: null,
      diagnostics: [...diagnostics, "effective-time-invalid"],
    };
  const description = cells[3] ?? "";
  const note = cells[7] ?? "";
  const core = digest(
    "ctbc-observed-composite-fence-v1",
    subjectDigest,
    accountingDate,
    transactionDate,
    transactionTime,
    direction,
    amount.coefficient,
    String(amount.scale),
    balanceAfter.coefficient,
    String(balanceAfter.scale),
  );
  return {
    diagnostics,
    record: {
      occurrenceKey: digest(
        "ctbc-observed-composite-occurrence-v1",
        core,
        description,
        note,
      ),
      collisionKey: core,
      providerKey: core,
      contentHash: digest("ctbc-observed-content-v1", ...cells),
      sequenceLexeme: `${response.rangeOrdinal}:${row.rowOrdinal}`,
      compactJson: JSON.stringify({
        evidenceVersion: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
        subjectDigest,
        rangeOrdinal: response.rangeOrdinal,
        rowOrdinal: row.rowOrdinal,
        accountingDate,
        transactionDate,
        transactionTime,
        direction,
        amount,
        balanceAfter,
        descriptionDigest: digest("ctbc-description-v1", description),
        noteDigest: digest("ctbc-note-v1", note),
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

export function admitCtbcDomesticDepositFinancialCapture(
  input: CtbcDomesticDepositFinancialAdmissionInput,
): CtbcDomesticDepositFinancialAdmissionResult {
  const diagnostics: string[] = [];
  if (!input || typeof input !== "object")
    return {
      status: "blocked",
      capture: null,
      diagnostics: ["capture-missing"],
    };
  if (!isAdmittedCtbcDomesticDepositCaptureEvidence(input.capture))
    diagnostics.push("runtime-evidence-brand-missing");
  if (!input.captureId?.trim()) diagnostics.push("scope-invalid");
  if (!input.humanAttestation) diagnostics.push("human-attestation-missing");
  else if (!isCtbcHumanAttestedV1Manifest(input.humanAttestation))
    diagnostics.push("human-attestation-mismatch");
  if (!isCtbcHumanAttestedV1Active())
    diagnostics.push("human-attestation-revoked");
  if (!isAdmittedCtbcDomesticDepositCaptureEvidence(input.capture))
    return {
      status: "blocked",
      capture: null,
      diagnostics: [...new Set(diagnostics)],
    };
  const complete = input.capture.responses.every(
    (response) => response.terminal && response.nextKey === null,
  );
  if (!complete) diagnostics.push("terminal-completeness-unproven");
  const allNoData = input.capture.responses.every(
    (response) => response.code === "9201" && response.rows.length === 0,
  );
  const anyNoData = input.capture.responses.some(
    (response) => response.code === "9201",
  );
  if (
    anyNoData &&
    !allNoData &&
    input.capture.responses.every((response) => response.rows.length === 0)
  )
    diagnostics.push("absence-authority-mixed");
  const subjectDigest = digest(
    "ctbc-source-subject-v1",
    cell(input.capture.account.accountId),
  );
  const records: CanonicalFinancialDepositRecord[] = [];
  const seen = new Map<string, string>();
  for (const response of input.capture.responses)
    for (const row of response.rows) {
      const result = financialRecord(subjectDigest, response, row);
      diagnostics.push(...result.diagnostics);
      if (!result.record) continue;
      const previous = seen.get(result.record.collisionKey);
      if (previous) {
        diagnostics.push("occurrence-ambiguous");
        if (previous !== result.record.occurrenceKey)
          diagnostics.push("composite-occurrence-collision");
        continue;
      }
      seen.set(result.record.collisionKey, result.record.occurrenceKey);
      records.push(result.record);
    }
  if (!allNoData && records.length === 0)
    diagnostics.push("nonempty-financial-record-required");
  const unique = [...new Set(diagnostics)];
  if (unique.length)
    return { status: "blocked", capture: null, diagnostics: unique };
  const startDate = input.capture.queryRange.startDate.replaceAll("/", "-");
  const endDate = input.capture.queryRange.endDate.replaceAll("/", "-");
  const contractFingerprint = digest(
    "ctbc-contract-v1",
    CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    CTBC_HUMAN_ATTESTED_V1_MANIFEST.provenance.attestationContractFingerprint,
  );
  return {
    status: "admitted",
    diagnostics: [],
    capture: admitCanonicalFinancialDepositCapture({
      captureId: input.captureId.trim(),
      authorityRoute: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      contractVersion: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
      identity: {
        integrationNamespace: "ctbc",
        sourceConnectionKey: digest(
          "ctbc-source-connection-v1",
          "personal-main",
        ),
        identityEpochKey: ctbcHumanAttestedIdentityEpochKey(
          input.humanAttestation ?? getCtbcHumanAttestedV1Manifest(),
        ),
        stream: "domestic-deposit",
        recordKind: "ctbc-domestic-deposit",
        subjectDigest,
        accountNo: input.capture.account.accountId,
        accountType: "depository",
        currency: "TWD",
      },
      observedAt: input.capture.observedAt,
      scope: {
        startDate,
        endDate,
        scopeKind: "bounded-range",
        completeness: "complete-range",
        completenessBasis: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_COMPLETENESS_BASIS,
        completenessRuleVersion: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
        absenceAuthority: allNoData ? "provider-explicit-no-data" : null,
        contractFingerprint,
        preflightFingerprint: digest(
          "ctbc-preflight-v1",
          subjectDigest,
          startDate,
          endDate,
        ),
        pageCount: input.capture.responses.length,
        withdrawalPolicy: "never-infer",
      },
      semantics: {
        postingStatus: "posted",
        postingOrigin: "human-attested",
        postingBasis: "statement-posted-history",
        postingRuleVersion: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
        economicStatus: "normal",
        administrativeState: "active",
        semanticRuleVersion: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
        effectiveTimeBasis: "accounting",
        effectiveTimeRuleVersion: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
        timeZone: "Asia/Taipei",
        timePrecision: "second",
        timeOrigin: "source_reported",
        requireBalance: true,
        providerGuaranteed: false,
        occurrenceProviderGuaranteed: false,
      },
      pages: input.capture.responses.map((response, index) => ({
        pageOrdinal: response.rangeOrdinal,
        responseCode: "200",
        terminal: index === input.capture.responses.length - 1,
        rowCount: response.rows.length,
        responseDigest: digest(
          "ctbc-response-v1",
          String(response.rangeOrdinal),
          response.code,
          ...response.rows.flatMap((row) => row.values.map(cell)),
        ),
        proofKind: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_COMPLETENESS_BASIS,
        contractFingerprint,
        preflightFingerprint: digest(
          "ctbc-preflight-v1",
          subjectDigest,
          startDate,
          endDate,
        ),
        metadataJson: JSON.stringify({
          rangeStart: response.startDate,
          rangeEnd: response.endDate,
          nextKeyState: response.nextKey === null ? "empty" : "present",
          providerCode: response.code,
          providerTerminal: response.terminal,
          providerExplicitNoData: response.code === "9201",
        }),
      })),
      records,
    }),
  };
}

export async function commitCanonicalCtbcDomesticDepositCaptureBatch(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly CtbcDomesticDepositFinancialAdmissionInput[],
): Promise<CanonicalFinancialDepositCommitResult[]> {
  if (!inputs.length)
    throw new CtbcDomesticDepositFinancialAdmissionError(
      "CTBC financial batch cannot be empty.",
    );
  ensureCtbcHumanAttestationEvents(store.db);
  let latest: ReturnType<typeof latestCtbcHumanAttestationEvent>;
  try {
    latest = latestCtbcHumanAttestationEvent(store.db);
  } catch {
    throw new CtbcDomesticDepositFinancialAdmissionError(
      "CTBC human attestation chain is invalid.",
    );
  }
  if (latest?.eventKind === "revoked" || !isCtbcHumanAttestedV1Active())
    throw new CtbcDomesticDepositFinancialAdmissionError(
      "CTBC human attestation is revoked; future admission is blocked.",
    );
  const admissions = inputs.map(admitCtbcDomesticDepositFinancialCapture);
  const blocked = admissions.flatMap((item) => item.diagnostics);
  if (blocked.length || admissions.some((item) => !item.capture))
    throw new CtbcDomesticDepositFinancialAdmissionError(
      `CTBC domestic deposit canonical admission blocked: ${[...new Set(blocked)].join(", ")}`,
    );
  recordInitialCtbcHumanAttestationIfMissing(
    store.db,
    inputs[0]?.capture.observedAt,
  );
  return commitCanonicalFinancialDepositCaptureBatch(
    store,
    admissions.map((item) => item.capture!),
  );
}

export function isCtbcHumanAttestationReady(
  store: CanonicalFinancialDepositWriterStore,
): boolean {
  return isCtbcHumanAttestationDurablyActive(store.db);
}
