import {
  LOAN_CONTRACT_FIXTURES,
  YUANTA_LOAN_AUTHORITY_ROUTE,
  YUANTA_LOAN_CONTRACT_VERSION,
  CanonicalLoanAdmissionError,
  LOAN_EVENT_CONTRACT_MAPPINGS,
  YUANTA_LOAN_LEGACY_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  admitCanonicalLoanCapture,
  canonicalLoanSourceIdentity,
  canonicalLoanToken,
  CanonicalLoanConflictError,
  commitCanonicalLoanCapture,
  createCanonicalLoanCapture,
  parseCanonicalLoanAmount,
  parseCanonicalLoanDate,
  isCanonicalLoanSourceDateBeforeObservedAt,
  queryCanonicalLoanCurrent,
  queryCanonicalLoanHistorical,
  queryCanonicalLoanLineage,
  type CanonicalLoanStatementRow,
  type LoanCaptureInput,
  type LoanFinancialStore,
  type LoanHistoricalQuery,
  type LoanLineageQuery,
  type LoanValidatedCapture,
} from "./loan-financial.ts";
import { YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1 } from "./yuanta-loan-live-attestation.fixture.ts";

export {
  YUANTA_LOAN_AUTHORITY_ROUTE,
  YUANTA_LOAN_CONTRACT_VERSION,
  YUANTA_LOAN_LEGACY_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
} from "./loan-financial.ts";
export type {
  LoanCaptureInput as YuantaLoanCaptureInput,
  LoanFinancialStore,
  LoanHistoricalQuery,
  LoanLineageQuery,
  LoanValidatedCapture as YuantaLoanValidatedCapture,
} from "./loan-financial.ts";

export type YuantaLoanStatementRow = {
  transactionDate: string;
  postingDate: string;
  paymentItem: string;
  transactionAmount: string;
  balanceAfterTransaction: string;
};

export type YuantaLoanCaptureBuildInput = {
  accountValue: string;
  sourceConnectionScope: string;
  observedAt: string;
  startDate: string;
  endDate: string;
  scope: LoanCaptureInput["scope"];
  pages: LoanCaptureInput["pages"];
  counterpartTransactions: LoanCaptureInput["counterpartTransactions"];
  relations: LoanCaptureInput["relations"];
  relationCoverage?: LoanCaptureInput["relationCoverage"];
  rows: readonly YuantaLoanStatementRow[];
};

export type YuantaLoanCaptureCommitDependencies = Partial<{
  admit: typeof admitYuantaLoanCapture;
  commit: typeof commitYuantaLoanCapture;
}>;

export const YUANTA_LOAN_CONTRACT = Object.freeze({
  source: "yuanta",
  stream: "loan",
  authority: "yuanta/loan/canonical-v1",
  contractVersion: "loan/canonical/v1.yuanta",
  workflow: "yuantaLoanStatements",
  accountType: "loan",
  amountDirection: "source-coded-loan-boundary",
  optionalFacts: "source-distinguished-only",
  balanceEffectiveTime: "source-reported-only",
  sourceOccurrenceIdentity: YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  legacySourceOccurrenceIdentity:
    YUANTA_LOAN_LEGACY_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  relationRule: "explicit-source-linkage-only",
  completeness: "source-declared-terminal-range",
  readiness: "canonical-synthetic",
} as const);

export const YUANTA_LOAN_FINANCIAL_AUTHORITY =
  YUANTA_LOAN_CONTRACT.authority;
export const YUANTA_LOAN_READINESS = YUANTA_LOAN_CONTRACT.readiness;
export const YUANTA_LOAN_CAPTURE_CONTRACT = YUANTA_LOAN_CONTRACT;

/** Versioned source-code table for the Yuanta loan statement's payment item. */
export const YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION =
  "yuanta/loan-source-event-codebook/v1" as const;

/** Exact provider labels/codes accepted by the Yuanta loan adapter. */
export const YUANTA_LOAN_SOURCE_EVENT_CODES: Readonly<Record<string, string>> =
  Object.freeze({
    "LOAN-DISBURSEMENT": "LOAN-DISBURSEMENT",
    "LOAN-PAYMENT": "LOAN-PAYMENT",
    "LOAN-INTEREST": "LOAN-INTEREST",
    "LOAN-FEE": "LOAN-FEE",
    撥款: "LOAN-DISBURSEMENT",
    放款: "LOAN-DISBURSEMENT",
    貸款撥款: "LOAN-DISBURSEMENT",
    還款: "LOAN-PAYMENT",
    繳款: "LOAN-PAYMENT",
    繳本: "LOAN-PAYMENT",
    本金: "LOAN-PAYMENT",
    本金還款: "LOAN-PAYMENT",
    本金攤還: "LOAN-PAYMENT",
    本息: "LOAN-PAYMENT",
    暫收款: "LOAN-PAYMENT",
    利息: "LOAN-INTEREST",
    繳息: "LOAN-INTEREST",
    利息支付: "LOAN-INTEREST",
    手續費: "LOAN-FEE",
    費用: "LOAN-FEE",
    違約金: "LOAN-FEE",
  });

/**
 * Bounded, sanitized diagnostics emitted when the current semantic anchor is
 * not enough to distinguish two source rows.  This is observation telemetry,
 * not an admission path: the adapter must still fail closed until a provider
 * identifier is observed and versioned into the source contract.
 */
export const YUANTA_LOAN_SOURCE_OCCURRENCE_AMBIGUITY_DIAGNOSTIC_VERSION =
  "yuanta/loan-source-occurrence-ambiguity/v2" as const;

const YUANTA_LOAN_SOURCE_OCCURRENCE_DIAGNOSTIC_MAX_GROUPS = 32;
const YUANTA_LOAN_SOURCE_OCCURRENCE_DIAGNOSTIC_MAX_MEMBERS = 16;
const YUANTA_LOAN_SOURCE_OCCURRENCE_DIAGNOSTIC_POSITION_BUCKET_SIZE = 10;

/** Header alias IDs describe the retained six-cell parser contract only. */
const YUANTA_LOAN_SOURCE_HEADER_ALIAS_PRESENCE = Object.freeze([
  { aliasId: "transaction-date-pair", present: true },
  { aliasId: "payment-item", present: true },
  { aliasId: "interest-date-pair", present: true },
  { aliasId: "transaction-amount", present: true },
  { aliasId: "balance-after-transaction", present: true },
  { aliasId: "overpayment", present: true },
  // The retained page/parser contract has no provider transaction identifier.
  { aliasId: "provider-transaction-id", present: false },
  { aliasId: "provider-reference-id", present: false },
  { aliasId: "provider-payment-id", present: false },
] as const);

const YUANTA_LOAN_SOURCE_ROW_FIELD_IDS = [
  "transaction-date",
  "posting-date",
  "payment-item",
  "transaction-amount",
  "balance-after-transaction",
] as const;

type YuantaLoanSourceRowFieldId =
  (typeof YUANTA_LOAN_SOURCE_ROW_FIELD_IDS)[number];

export type YuantaLoanSourceOccurrenceAmbiguityDiagnostic = Readonly<{
  diagnosticVersion: typeof YUANTA_LOAN_SOURCE_OCCURRENCE_AMBIGUITY_DIAGNOSTIC_VERSION;
  identityRuleVersion: typeof YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION;
  duplicateGroupCount: number;
  reportedGroupCount: number;
  groupsTruncated: boolean;
  sourceHeaderAliasPresence: readonly {
    aliasId: string;
    present: boolean;
  }[];
  groups: readonly {
    multiplicity: number;
    rowOrdinalPositions: readonly number[];
    rowOrdinalPositionBuckets: readonly string[];
    omittedMemberCount: number;
    stableAnchorHashes: Readonly<{
      account: `sha256:${string}`;
      transactionDate: `sha256:${string}`;
      postingDate: `sha256:${string}`;
      sourceEventCode: `sha256:${string}`;
      paymentItem: `sha256:${string}`;
    }>;
    changedFieldKinds: readonly YuantaLoanSourceRowFieldId[];
    sourceRowFieldPresence: readonly {
      rowOrdinal: number;
      fields: Readonly<Record<YuantaLoanSourceRowFieldId, boolean>>;
    }[];
  }[];
}>;

export const YUANTA_LOAN_SYNTHETIC_FIXTURE_V1 = LOAN_CONTRACT_FIXTURES.yuanta;

/**
 * Sanitized evidence contract for the solver-assisted live run.  It records
 * only source-contract facts and safe projection assertions; no account,
 * amount, description, response, or authentication value belongs here.
 */
export const YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1 = Object.freeze({
  schemaVersion: "loan-live-validation-attestation/v1",
  sourceId: "yuanta",
  workflow: "yuantaLoanStatements",
  authorityRoute: YUANTA_LOAN_AUTHORITY_ROUTE,
  captureContractVersion: YUANTA_LOAN_CONTRACT_VERSION,
  sourceEventCodebookVersion: YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
  validationMethod: "solver-assisted-electron-cdp",
  status: "verified-live-run",
  verifiedOn: "2026-09-01",
  runEvidenceSchemaVersion: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.schemaVersion,
  fieldEvidenceVersion: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceVersion,
  fieldEvidenceId: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceId,
  runEvidenceId: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.evidenceId,
  runEvidenceArtifact: YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.artifact,
  financialValuesRetained: false,
  authenticationSecretsRetained: false,
  rawSourcePayloadRetained: false,
  safeAssertions: Object.freeze([
    "identity:source-connection-and-loan-account-boundary-observed",
    "money:source-amount-and-loan-boundary-direction-observed",
    "time:source-transaction-and-balance-effective-time-observed",
    "status:source-event-codebook-observed",
    "completeness:provider-terminal-complete-range-observed",
    "queries:current-historical-lineage-reopen-observed",
  ]),
} as const);

function hasExactYuantaLoanSafeAssertions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.safeAssertions.length &&
    value.every(
      (assertion, index) =>
        assertion === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.safeAssertions[index],
    )
  );
}

function hasCompleteYuantaLoanFieldEvidence(): boolean {
  const evidence = YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1;
  return (
    evidence.observationProvenance.mode === "human-assisted-solver-live-run" &&
    evidence.observationProvenance.valuePolicy ===
      "field-shape-and-semantics-only" &&
    evidence.fieldObservations.identity.providerFields.length > 0 &&
    evidence.fieldObservations.identity.canonicalBindings.length > 0 &&
    evidence.fieldObservations.money.providerFields.length > 0 &&
    evidence.fieldObservations.money.directionBasis.length > 0 &&
    evidence.fieldObservations.time.providerFields.length > 0 &&
    evidence.fieldObservations.time.balanceEffectiveTimeBasis.length > 0 &&
    evidence.fieldObservations.status.providerFields.length > 0 &&
    evidence.fieldObservations.status.interpretation.length > 0 &&
    evidence.fieldObservations.completeness.providerSignals.length > 0 &&
    evidence.fieldObservations.completeness.terminalRule ===
      "yuanta-loan-terminal-v2" &&
    evidence.fieldObservations.queries.verifiedSurfaces.length > 0
  );
}

/** Readiness accepts only the exact sanitized live-evidence contract. */
export function isYuantaLoanLiveValidationAttestationValid(
  value: unknown,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const attestation = value as Record<string, unknown>;
  return (
    attestation.schemaVersion ===
      YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1.schemaVersion &&
    attestation.sourceId === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.sourceId &&
    attestation.workflow === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.workflow &&
    attestation.authorityRoute === YUANTA_LOAN_AUTHORITY_ROUTE &&
    attestation.captureContractVersion === YUANTA_LOAN_CONTRACT_VERSION &&
    attestation.sourceEventCodebookVersion ===
      YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION &&
    attestation.validationMethod === "solver-assisted-electron-cdp" &&
    attestation.status === "verified-live-run" &&
    attestation.verifiedOn === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.verifiedOn &&
    attestation.runEvidenceSchemaVersion ===
      YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.schemaVersion &&
    attestation.fieldEvidenceVersion ===
      YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceVersion &&
    attestation.fieldEvidenceId ===
      YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceId &&
    attestation.runEvidenceId === YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.evidenceId &&
    attestation.runEvidenceArtifact ===
      YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.artifact &&
    attestation.financialValuesRetained === false &&
    attestation.authenticationSecretsRetained === false &&
    attestation.rawSourcePayloadRetained === false &&
    hasExactYuantaLoanSafeAssertions(attestation.safeAssertions) &&
    hasCompleteYuantaLoanFieldEvidence()
  );
}

export function validateYuantaLoanFixture(
  capture: LoanCaptureInput = YUANTA_LOAN_SYNTHETIC_FIXTURE_V1,
) {
  return admitYuantaLoanCapture(capture);
}

export function admitYuantaLoanCapture(
  capture: LoanCaptureInput,
): LoanValidatedCapture {
  if (capture.sourceId !== "yuanta")
    throw new Error("Yuanta loan admission requires a Yuanta capture.");
  return admitCanonicalLoanCapture(capture);
}

export function commitYuantaLoanCapture(
  store: LoanFinancialStore,
  capture: LoanValidatedCapture,
) {
  return commitCanonicalLoanCapture(store, capture);
}

function normalizedSourceLabel(value: string): string {
  return value.normalize("NFKC").replace(/[\u00a0\u3000]/g, " ").replace(/\s+/gu, " ").trim();
}

function sourceCodeFor(label: string): string {
  const sourceCode = YUANTA_LOAN_SOURCE_EVENT_CODES[normalizedSourceLabel(label)];
  if (!sourceCode || !LOAN_EVENT_CONTRACT_MAPPINGS.yuanta[sourceCode])
    throw new CanonicalLoanAdmissionError(
      "Yuanta loan source event code is unsupported.",
    );
  return sourceCode;
}

function optionalAmount(value: string, label: string) {
  const normalized = normalizedSourceLabel(value);
  if (!normalized || ["-", "—", "N/A", "NA"].includes(normalized))
    return undefined;
  return parseCanonicalLoanAmount(normalized, label);
}

type YuantaLoanAmbiguousSourceRow = {
  rowOrdinal: number;
  anchor: {
    account: string;
    transactionDate: string;
    postingDate: string;
    sourceEventCode: string;
    paymentItem: string;
  };
  fields: Readonly<Record<YuantaLoanSourceRowFieldId, string | null>>;
  fieldPresence: Readonly<Record<YuantaLoanSourceRowFieldId, boolean>>;
};

function normalizedAmountKey(
  amount: { coefficient: string; scale: number } | undefined,
): string | null {
  if (amount === undefined) return null;
  let coefficient = amount.coefficient;
  let scale = amount.scale;
  if (coefficient === "0") return "0:0";
  while (scale > 0 && coefficient.endsWith("0")) {
    coefficient = coefficient.slice(0, -1);
    scale -= 1;
  }
  return `${coefficient}:${scale}`;
}

function sourceRowFieldPresence(
  row: YuantaLoanStatementRow,
): Readonly<Record<YuantaLoanSourceRowFieldId, boolean>> {
  return {
    "transaction-date": normalizedSourceLabel(row.transactionDate).length > 0,
    "posting-date": normalizedSourceLabel(row.postingDate).length > 0,
    "payment-item": normalizedSourceLabel(row.paymentItem).length > 0,
    "transaction-amount":
      normalizedSourceLabel(row.transactionAmount).length > 0,
    "balance-after-transaction":
      normalizedSourceLabel(row.balanceAfterTransaction).length > 0,
  };
}

function sourceRowFieldValues(
  row: YuantaLoanStatementRow,
  transactionDate: string,
  postingDate: string,
  amount: { coefficient: string; scale: number },
  balance: { coefficient: string; scale: number } | undefined,
): Readonly<Record<YuantaLoanSourceRowFieldId, string | null>> {
  return {
    "transaction-date": transactionDate,
    "posting-date": postingDate,
    "payment-item": normalizedSourceLabel(row.paymentItem),
    "transaction-amount": normalizedAmountKey(amount),
    "balance-after-transaction": normalizedAmountKey(balance),
  };
}

function ambiguityAnchorHash(
  component: string,
  value: string,
): `sha256:${string}` {
  return canonicalLoanToken(
    YUANTA_LOAN_SOURCE_OCCURRENCE_AMBIGUITY_DIAGNOSTIC_VERSION,
    `anchor:${component}`,
    value,
  );
}

function rowOrdinalBucket(rowOrdinal: number): string {
  const first =
    Math.floor(
      (rowOrdinal - 1) /
        YUANTA_LOAN_SOURCE_OCCURRENCE_DIAGNOSTIC_POSITION_BUCKET_SIZE,
    ) * YUANTA_LOAN_SOURCE_OCCURRENCE_DIAGNOSTIC_POSITION_BUCKET_SIZE +
    1;
  const last =
    first + YUANTA_LOAN_SOURCE_OCCURRENCE_DIAGNOSTIC_POSITION_BUCKET_SIZE - 1;
  return `${first}-${last}`;
}

function changedFieldKinds(
  members: readonly YuantaLoanAmbiguousSourceRow[],
): readonly YuantaLoanSourceRowFieldId[] {
  const first = members[0];
  if (!first) return [];
  return YUANTA_LOAN_SOURCE_ROW_FIELD_IDS.filter((field) =>
    members.some((member) => member.fields[field] !== first.fields[field]),
  );
}

function createYuantaLoanSourceOccurrenceAmbiguityDiagnostic(
  groups: readonly (readonly YuantaLoanAmbiguousSourceRow[])[],
): YuantaLoanSourceOccurrenceAmbiguityDiagnostic {
  const reportedGroups = groups.slice(
    0,
    YUANTA_LOAN_SOURCE_OCCURRENCE_DIAGNOSTIC_MAX_GROUPS,
  );
  return {
    diagnosticVersion:
      YUANTA_LOAN_SOURCE_OCCURRENCE_AMBIGUITY_DIAGNOSTIC_VERSION,
    identityRuleVersion: YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
    duplicateGroupCount: groups.length,
    reportedGroupCount: reportedGroups.length,
    groupsTruncated: reportedGroups.length < groups.length,
    sourceHeaderAliasPresence: YUANTA_LOAN_SOURCE_HEADER_ALIAS_PRESENCE,
    groups: reportedGroups.map((members) => {
      const first = members[0]!;
      const reportedMembers = members.slice(
        0,
        YUANTA_LOAN_SOURCE_OCCURRENCE_DIAGNOSTIC_MAX_MEMBERS,
      );
      const positions = reportedMembers.map((member) => member.rowOrdinal);
      return {
        multiplicity: members.length,
        rowOrdinalPositions: positions,
        rowOrdinalPositionBuckets: [
          ...new Set(positions.map((position) => rowOrdinalBucket(position))),
        ],
        omittedMemberCount: members.length - reportedMembers.length,
        stableAnchorHashes: {
          account: ambiguityAnchorHash("account", first.anchor.account),
          transactionDate: ambiguityAnchorHash(
            "transaction-date",
            first.anchor.transactionDate,
          ),
          postingDate: ambiguityAnchorHash(
            "posting-date",
            first.anchor.postingDate,
          ),
          sourceEventCode: ambiguityAnchorHash(
            "source-event-code",
            first.anchor.sourceEventCode,
          ),
          paymentItem: ambiguityAnchorHash(
            "payment-item",
            first.anchor.paymentItem,
          ),
        },
        changedFieldKinds: changedFieldKinds(members),
        sourceRowFieldPresence: reportedMembers.map((member) => ({
          rowOrdinal: member.rowOrdinal,
          fields: member.fieldPresence,
        })),
      };
    }),
  };
}

function logYuantaLoanSourceOccurrenceAmbiguity(
  groups: readonly (readonly YuantaLoanAmbiguousSourceRow[])[],
): void {
  console.log(
    JSON.stringify({
      event: "yuanta-loan-source-occurrence-ambiguity",
      diagnostic: createYuantaLoanSourceOccurrenceAmbiguityDiagnostic(groups),
    }),
  );
}

function canonicalRows(
  input: YuantaLoanCaptureBuildInput,
): CanonicalLoanStatementRow[] {
  const anchors = new Map<string, YuantaLoanAmbiguousSourceRow[]>();
  const account = normalizedSourceLabel(input.accountValue);
  if (!account)
    throw new CanonicalLoanAdmissionError(
      "Yuanta loan account value is required.",
    );
  const rows: CanonicalLoanStatementRow[] = input.rows.map((row, index) => {
    const paymentItem = normalizedSourceLabel(row.paymentItem);
    const sourceCode = sourceCodeFor(paymentItem);
    const mapping = LOAN_EVENT_CONTRACT_MAPPINGS.yuanta[sourceCode]!;
    const transactionDateText = normalizedSourceLabel(row.transactionDate);
    const postingDateText = normalizedSourceLabel(row.postingDate);
    const effectiveDateText = postingDateText || transactionDateText;
    const effectiveOn = parseCanonicalLoanDate(
      effectiveDateText,
      "Yuanta loan effective date",
    );
    const amount = parseCanonicalLoanAmount(
      row.transactionAmount,
      "Yuanta loan transaction amount",
    );
    const balance = optionalAmount(
      row.balanceAfterTransaction,
      "Yuanta loan balance",
    );
    const transactionDate = parseCanonicalLoanDate(
      transactionDateText,
      "Yuanta loan transaction date",
    );
    const postingDate = postingDateText
      ? parseCanonicalLoanDate(postingDateText, "Yuanta loan posting date")
      : "";
    const sourceRecordKey = canonicalLoanToken(
      "yuanta",
      YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
      account,
      transactionDate,
      postingDate,
      sourceCode,
      paymentItem,
    );
    const sourceRow = {
      rowOrdinal: index + 1,
      anchor: {
        account,
        transactionDate,
        postingDate,
        sourceEventCode: sourceCode,
        paymentItem,
      },
      fields: sourceRowFieldValues(
        row,
        transactionDate,
        postingDate,
        amount,
        balance,
      ),
      fieldPresence: sourceRowFieldPresence(row),
    } satisfies YuantaLoanAmbiguousSourceRow;
    const anchorMembers = anchors.get(sourceRecordKey);
    if (anchorMembers) anchorMembers.push(sourceRow);
    else anchors.set(sourceRecordKey, [sourceRow]);
    // Yuanta reports the balance after a transaction. The source only
    // distinguishes the transaction date; retain date precision and do not
    // manufacture an end-of-day timestamp from the posting date.
    const balanceEffectiveAt = parseCanonicalLoanDate(
      transactionDateText,
      "Yuanta loan balance transaction date",
    );
    const balanceIsHistorical =
      balance !== undefined &&
      isCanonicalLoanSourceDateBeforeObservedAt(
        balanceEffectiveAt,
        input.observedAt,
      );
    return {
      sourceRecordKey,
      sourceOccurrenceIdentityRuleVersion:
        YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
      occurrenceIndex: index + 1,
      effectiveOn,
      sourceTime: {
        localTime: "00:00:00",
        precision: "date",
        timeOrigin: "defaulted_local_midnight",
      },
      sourceCode,
      eventKind: mapping.eventKind,
      direction: mapping.direction,
      amount,
      description: paymentItem,
      ...(balanceIsHistorical
        ? {
            balance: {
              observationKey: canonicalLoanToken(
                "yuanta",
                "loan-balance-observation-v1",
                sourceRecordKey,
              ),
              balance,
              effectiveAt: balanceEffectiveAt,
              effectiveAtPrecision: "date",
              effectiveAtTimeOrigin: "source_reported",
              effectiveAtField: "transaction-date",
            },
          }
        : {}),
    };
  });
  const duplicateGroups = [...anchors.values()].filter(
    (members) => members.length > 1,
  );
  if (duplicateGroups.length > 0) {
    logYuantaLoanSourceOccurrenceAmbiguity(duplicateGroups);
    throw new CanonicalLoanConflictError(
      "Yuanta loan source occurrence anchor is ambiguous.",
    );
  }
  return rows;
}

export function buildYuantaLoanCapture(
  input: YuantaLoanCaptureBuildInput,
): LoanCaptureInput {
  const rows = canonicalRows(input);
  const identity = canonicalLoanSourceIdentity(
    "yuanta",
    input.sourceConnectionScope,
    input.accountValue,
  );
  return createCanonicalLoanCapture({
    captureId: canonicalLoanToken(
      "yuanta",
      "loan-capture-v1",
      input.sourceConnectionScope,
      input.accountValue,
      input.observedAt,
      input.startDate,
      input.endDate,
      ...rows.map((row) => row.sourceRecordKey),
    ),
    sourceId: "yuanta",
    identity,
    observedAt: input.observedAt,
    startDate: input.startDate,
    endDate: input.endDate,
    scope: input.scope,
    pages: input.pages,
    counterpartTransactions: input.counterpartTransactions,
    relations: input.relations,
    relationCoverage: input.relationCoverage,
    rows,
  });
}

export async function persistYuantaLoanCapture(
  store: LoanFinancialStore,
  input: YuantaLoanCaptureBuildInput,
  dependencies: YuantaLoanCaptureCommitDependencies = {},
) {
  const admitted = (dependencies.admit ?? admitYuantaLoanCapture)(
    buildYuantaLoanCapture(input),
  );
  return (dependencies.commit ?? commitYuantaLoanCapture)(store, admitted);
}

export function queryYuantaLoanCurrent(store: LoanFinancialStore) {
  return queryCanonicalLoanCurrent(store, { sourceId: "yuanta" });
}

export function queryYuantaLoanHistorical(
  store: LoanFinancialStore,
  request: LoanHistoricalQuery,
) {
  return queryCanonicalLoanHistorical(store, { ...request, sourceId: "yuanta" });
}

export function queryYuantaLoanLineage(
  store: LoanFinancialStore,
  request: LoanLineageQuery,
) {
  return queryCanonicalLoanLineage(store, { ...request, sourceId: "yuanta" });
}
