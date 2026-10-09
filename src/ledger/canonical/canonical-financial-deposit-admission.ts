import { createHash } from "node:crypto";
import { FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA } from "./foreign-currency-deposit-authorities.ts";
import {
  validateCanonicalSourceAccountNumber,
  type CanonicalSourceAccountNumber,
} from "./canonical-source-evidence.ts";
import {
  assignOccurrenceSlots,
  type CanonicalOccurrenceGroup,
  type CanonicalOccurrenceGroupCoverage,
} from "./occurrence-groups.ts";
import { assertCanonicalOccurrenceGroupEvidence, CanonicalOccurrenceGroupConflictError } from "./occurrence-group-evidence.ts";
import type { InstitutionKey } from "../../lib/institutions/institutions.ts";
import {
  TDCC_SETTLEMENT_DEPOSIT_PROFILE,
  TDCC_SETTLEMENT_DEPOSIT_ROUTE,
} from "./tdcc-settlement-contract.ts";
import {
  CANONICAL_SOURCE_ROUTE_REGISTRY,
  canonicalSourceRuleCombination,
} from "./canonical-source-route-registry.ts";

export type FinancialDepositAmount = {
  coefficient: string;
  scale: number;
};

export type FinancialDepositSourceTime = {
  localDate: string;
  localTime: string;
  timeZone: string;
  epochMilliseconds: number;
  /** The provider's precision is record-level evidence (not an account default). */
  precision?: "date" | "minute" | "second";
  /** Date-only providers are normalized to local midnight with this explicit origin. */
  timeOrigin?: "source_reported" | "defaulted_local_midnight";
};

export type CanonicalFinancialDepositRate = {
  amount: FinancialDepositAmount;
  baseCurrency: string;
  quoteCurrency: string;
  observedOn?: string | null;
};

export type CanonicalFinancialDepositConversionEvidence = {
  originalAmount: FinancialDepositAmount | null;
  originalCurrency: string | null;
  bookedAmount: FinancialDepositAmount;
  bookedCurrency: string;
  sourceReportedRate: CanonicalFinancialDepositRate | null;
  impliedRate: CanonicalFinancialDepositRate | null;
  comparison: "consistent" | "conflicted" | "not-comparable";
  feeAmount?: FinancialDepositAmount | null;
  feeCurrency?: string | null;
  evidenceOrigin: string;
};

export type CanonicalFinancialDepositPage = {
  pageOrdinal: number;
  responseCode: string;
  terminal: boolean;
  rowCount: number;
  responseDigest: string;
  proofKind: string;
  contractFingerprint: string;
  preflightFingerprint: string;
  metadataJson: string;
};

export type CanonicalFinancialDepositRecord = {
  occurrenceKey: string;
  collisionKey: string;
  providerKey: string;
  /** Human-attested occurrence identity; never a provider key or guarantee. */
  humanAttestedOccurrenceKey?: string;
  contentHash: string;
  /** Capture-local ordering retained as lineage; occurrenceKey owns financial identity. */
  sequenceLexeme: string;
  compactJson: string;
  amount: FinancialDepositAmount;
  balanceAfter: FinancialDepositAmount | null;
  currency: string;
  direction: string;
  sourceTime: FinancialDepositSourceTime;
  effectiveOn: string;
  transactionDateTimeLocal: string;
  description?: string | null;
  conversionEvidence?: CanonicalFinancialDepositConversionEvidence | null;
  /** Stable group identity for routes without a reliable source transaction ID. */
  occurrenceGroup?: CanonicalOccurrenceGroup;
  /** Complete source query bucket that contributed this grouped row. */
  occurrenceGroupBucketKey?: string;
};

/** Source evidence that is not a monetary transaction. Holding observations
 * and credit-card statement evidence never enter generic transaction tables. */
export type CanonicalFinancialNonTransactionRecord = {
  recordType: "holding-observation" | "statement-evidence";
  recordKind?: string;
  occurrenceKey: string;
  collisionKey: string;
  providerKey: string;
  contentHash: string;
  sequenceLexeme: string;
  compactJson: string;
  description?: string | null;
};

export function isNonTransactionRecord(
  record:
    | CanonicalFinancialDepositRecord
    | CanonicalFinancialNonTransactionRecord,
): record is CanonicalFinancialNonTransactionRecord {
  return "recordType" in record;
}

export type CanonicalFinancialDepositCapture = {
  captureId: string;
  authorityRoute: string;
  contractVersion: string;
  identity: {
    integrationNamespace: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    stream: string;
    recordKind: string;
    subjectDigest: string;
    accountNo: string;
    /** Explicit alias for the stable source key. */
    sourceAccountKey?: string;
    /** Provider-supported display identifier with source lineage. */
    accountNumber?: CanonicalSourceAccountNumber | null;
    accountType: string;
    /** Nullable for a source-proven multi-currency account. */
    currency: string | null;
    /** The maintaining Institution from contract evidence; an Intermediary source must supply it. */
    institutionKey?: InstitutionKey;
  };
  observedAt: string;
  scope: {
    startDate: string;
    endDate: string;
    scopeKind: "bounded-range";
    completeness: "complete-range";
    completenessBasis: string;
    completenessRuleVersion: string;
    absenceAuthority: string | null;
    contractFingerprint: string;
    preflightFingerprint: string;
    pageCount: number;
    /** Fubon human-attested observations never infer withdrawal from absence. */
    withdrawalPolicy?: "allow-inference" | "never-infer";
  };
  semantics: {
    postingStatus: string;
    postingOrigin: string;
    postingBasis: string;
    postingRuleVersion: string;
    economicStatus: string;
    administrativeState: string;
    semanticRuleVersion: string;
    effectiveTimeBasis: string;
    effectiveTimeRuleVersion: string;
    timeZone: string;
    timePrecision: string;
    timeOrigin: string;
    requireBalance: boolean;
    /** Provider occurrence guarantees are forbidden for observed Yuanta routes. */
    providerGuaranteed?: boolean;
    occurrenceProviderGuaranteed?: boolean;
  };
  pages: readonly CanonicalFinancialDepositPage[];
  records: readonly CanonicalFinancialDepositRecord[];
  nonTransactionRecords?: readonly CanonicalFinancialNonTransactionRecord[];
  /** Complete date coverage for each independently comparable account/product scope. */
  occurrenceGroupCoverage?: readonly CanonicalOccurrenceGroupCoverage[];
};

export type CanonicalFinancialDepositGroupRow = Readonly<{
  record: CanonicalFinancialDepositRecord;
  partitionDate: string;
}>;

export type CanonicalFinancialDepositGroupAssignment = Readonly<{
  rows: readonly CanonicalFinancialDepositGroupRow[];
  scopeKey: string;
  startDate: string;
  endDate: string;
  contractVersion: string;
  complete: boolean;
}>;

/**
 * Assign stable slots to transactions whose source contract has no reliable
 * occurrence identifier. The caller supplies rows only after all terminal
 * pages and disjoint date partitions have been combined.
 */
export function assignCanonicalFinancialDepositOccurrenceGroups(
  input: CanonicalFinancialDepositGroupAssignment,
): Readonly<{
  records: readonly CanonicalFinancialDepositRecord[];
  coverage: readonly CanonicalOccurrenceGroupCoverage[];
}> {
  if (!input.complete)
    throw new CanonicalFinancialDepositConflictError(
      "Occurrence groups require complete source coverage.",
    );
  const priorByFingerprint = new Map<
    string,
    Readonly<{ collisionKey: string; contentHash: string }>
  >();
  for (const { record } of input.rows) {
    const prior = priorByFingerprint.get(record.occurrenceKey);
    if (
      prior &&
      (prior.collisionKey !== record.collisionKey ||
        prior.contentHash !== record.contentHash)
    )
      throw new CanonicalFinancialDepositConflictError(
        "A semantic occurrence fingerprint has contradictory source evidence.",
      );
    priorByFingerprint.set(record.occurrenceKey, {
      collisionKey: record.collisionKey,
      contentHash: record.contentHash,
    });
  }

  const assigned = assignOccurrenceSlots({
    rows: input.rows,
    complete: input.complete,
    scopeKey: () => input.scopeKey,
    partitionDate: (row) => row.partitionDate,
    fingerprint: (row) => row.record.occurrenceKey,
    collisionKey: (row, ordinal) => {
      const digest = createHash("sha256")
        .update(
          [
            "canonical-financial-occurrence-collision-v1",
            input.scopeKey,
            row.partitionDate,
            row.record.collisionKey,
            String(ordinal),
          ].join("\u0000"),
        )
        .digest("base64url");
      return `sha256:${digest}`;
    },
  });
  const records = assigned.map(({ row, occurrenceKey, collisionKey, group }) => ({
    ...row.record,
    occurrenceKey,
    collisionKey,
    occurrenceGroup: group,
  }));
  const coverage: readonly CanonicalOccurrenceGroupCoverage[] = [
    {
      scopeKey: input.scopeKey,
      startDate: input.startDate,
      endDate: input.endDate,
      contractVersion: input.contractVersion,
    },
  ];
  return { records, coverage };
}

// Admission is intentionally held out-of-band. A copied object, even one
// carrying every enumerable/non-enumerable key, symbol, and descriptor from
// an admitted capture, cannot acquire this membership.
const VALIDATED_CAPTURES = new WeakSet<object>();

export type CanonicalFinancialDepositValidatedCapture =
  CanonicalFinancialDepositCapture & {
    readonly __runtimeValidatedCanonicalFinancialDeposit: true;
  };


export class CanonicalFinancialDepositConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalFinancialDepositConflictError";
  }
}


function validateOpaque(value: string, label: string): void {
  if (!/^sha256:[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${label} must be an opaque sha256 token.`);
}

function validateFinancialAccountNumber(
  identifier: CanonicalSourceAccountNumber,
  accountType: string,
): void {
  const value = identifier.value.trim();
  if (accountType === "depository" || accountType === "loan") {
    if (!/^\d{6,24}$/.test(value))
      throw new Error(
        "Depository and loan account numbers must be complete provider-reported digits.",
      );
  } else if (
    /[*xX•]/u.test(value) ||
    /^sha256:/u.test(value)
  ) {
    throw new Error(
      "Financial account number cannot be masked or an opaque source token.",
    );
  }
}

const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

function validateText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required.`);
}

function validateDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`${label} must be YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error(`${label} must be a valid calendar date.`);
}

function validateAmount(
  value: unknown,
  label: string,
): asserts value is FinancialDepositAmount {
  if (
    value === null ||
    typeof value !== "object" ||
    !("coefficient" in value) ||
    typeof value.coefficient !== "string" ||
    !/^(?:0|[1-9]\d*)$/.test(value.coefficient) ||
    !("scale" in value) ||
    !Number.isSafeInteger(value.scale) ||
    Number(value.scale) < 0
  )
    throw new Error(
      `${label} must be an exact non-negative coefficient/scale amount.`,
    );
}

function validateCurrency(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Z]{3}$/.test(value) ||
    !ISO_CURRENCIES.has(value)
  )
    throw new Error(`${label} must be a valid ISO 4217 currency code.`);
}

function validateSourceTime(
  value: FinancialDepositSourceTime,
  record: CanonicalFinancialDepositRecord,
): void {
  validateDate(value.localDate, "Financial record source date");
  if (!/^\d{2}:\d{2}:\d{2}$/.test(value.localTime))
    throw new Error("Financial record source time must be HH:mm:ss.");
  const [hour, minute, second] = value.localTime.split(":").map(Number);
  if (hour! > 23 || minute! > 59 || second! > 59)
    throw new Error("Financial record source time is invalid.");
  if (value.timeZone !== "Asia/Taipei")
    throw new Error("Financial record time zone must be Asia/Taipei.");
  if (
    value.precision !== "date" &&
    value.precision !== "minute" &&
    value.precision !== "second"
  )
    throw new Error("Financial record time precision is invalid.");
  if (
    value.timeOrigin !== "source_reported" &&
    value.timeOrigin !== "defaulted_local_midnight"
  )
    throw new Error("Financial record time origin is invalid.");
  if (
    value.precision !== "date" &&
    value.timeOrigin === "defaulted_local_midnight"
  )
    throw new Error("Only date precision may default to local midnight.");
  if (
    value.precision === "date" &&
    value.timeOrigin !== "defaulted_local_midnight"
  )
    throw new Error(
      "Date precision must use the defaulted local midnight time origin.",
    );
  const expectedEpoch = Date.parse(
    `${value.localDate}T${value.localTime}+08:00`,
  );
  if (
    !Number.isSafeInteger(value.epochMilliseconds) ||
    value.epochMilliseconds !== expectedEpoch
  )
    throw new Error(
      "Financial record source instant does not match its local time evidence.",
    );
  if (record.effectiveOn !== value.localDate)
    throw new Error(
      "Financial record effective date does not match source time.",
    );
  if (
    record.transactionDateTimeLocal !== `${value.localDate}T${value.localTime}`
  )
    throw new Error(
      "Financial record local timestamp does not match source time.",
    );
}

export function validateCanonicalFinancialDepositCapture(capture: CanonicalFinancialDepositCapture): void {
  const isForeignCurrencyCapture =
    capture.authorityRoute.includes("/foreign-currency/");
  const isFubonCreditCardCapture =
    capture.authorityRoute === "fubon/credit-card/human-attested-v2";
  const isEsunCreditCardCapture =
    capture.authorityRoute === "esun/credit-card/human-attested-v4";
  const isYuantaCreditCardCapture =
    capture.authorityRoute === "yuanta/credit-card/human-attested-v2";
  const isHumanAttestedCreditCardCapture =
    isFubonCreditCardCapture ||
    isEsunCreditCardCapture ||
    isYuantaCreditCardCapture;
  validateText(capture.captureId, "Capture ID");
  validateText(capture.authorityRoute, "Authority route");
  validateText(capture.contractVersion, "Contract version");
  validateText(capture.identity.integrationNamespace, "Integration namespace");
  validateText(capture.identity.stream, "Financial stream");
  validateText(capture.identity.recordKind, "Financial record kind");
  validateText(capture.identity.accountNo, "Financial account number");
  const sourceAccountKey = capture.identity.sourceAccountKey ?? capture.identity.accountNo;
  if (
    capture.identity.sourceAccountKey !== undefined &&
    capture.identity.sourceAccountKey !== capture.identity.accountNo
  )
    throw new Error("Source account key and compatibility accountNo disagree.");
  validateText(sourceAccountKey, "Source account key");
  validateCanonicalSourceAccountNumber(capture.identity.accountNumber);
  const identifier = capture.identity.accountNumber;
  if (identifier) {
    validateFinancialAccountNumber(identifier, capture.identity.accountType);
    const validKinds =
      capture.identity.accountType === "depository"
        ? ["depository-account"]
        : capture.identity.accountType === "loan"
          ? ["loan-account"]
          : capture.identity.accountType === "credit"
            ? ["credit-portfolio-account"]
            : capture.identity.accountType === "investment"
              ? ["brokerage-account", "platform-account"]
              : ["platform-account"];
    if (!(validKinds as readonly string[]).includes(identifier.kind))
      throw new Error(
        `Account number kind ${identifier.kind} is incompatible with ${capture.identity.accountType} financial account.`,
      );
  }
  validateDate(capture.scope.startDate, "Capture start date");
  validateDate(capture.scope.endDate, "Capture end date");
  if (capture.scope.startDate > capture.scope.endDate)
    throw new Error("Capture scope is inverted.");
  if (capture.pages.length !== capture.scope.pageCount)
    throw new Error("Capture page count does not match scope.");
  if (capture.pages.length === 0)
    throw new Error("At least one capture page is required.");
  if (!capture.identity.accountType.trim())
    throw new Error("Financial account type is required.");
  if (capture.identity.currency === "MULTI")
    throw new Error(
      "Financial account currency cannot use the MULTI sentinel.",
    );
  const routeRules: Record<
    string,
    {
      postingOrigin: string;
      postingBasis: string;
      effectiveTimeBasis: string;
      currency?: string;
      postingStatus?: string;
      timeZone?: string;
      timePrecision?: string;
      completeness?: "complete-range" | "single-page";
      completenessBasis?: string;
      completenessRuleVersion?: string;
      absenceAuthority?: string | null;
      withdrawalPolicy?: "allow-inference" | "never-infer";
      integrationNamespace?: string;
      stream?: string;
      recordKind?: string;
      accountType?: string;
      contractVersion?: string;
      requireProviderGuaranteedFalse?: boolean;
      absenceAuthorityOnlyWhenEmpty?: boolean;
    }
  > = {
    "yuanta-fund/investment/canonical-v1": {
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "source-reported",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      completeness: "complete-range",
      completenessBasis: "source-reported-complete-investment-snapshot",
      completenessRuleVersion: "yuanta-fund/investment/canonical-v1",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "yuanta-fund",
      stream: "investment",
      recordKind: "investment-source-record",
      accountType: "investment",
      contractVersion: "yuanta-fund/investment/canonical-v1",
      requireProviderGuaranteedFalse: true,
    },
    "yuanta-trade/investment/canonical-v1": {
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "source-reported",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      completeness: "complete-range",
      completenessBasis: "source-reported-complete-investment-snapshot",
      completenessRuleVersion: "yuanta-trade/investment/canonical-v1",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "yuanta-trade",
      stream: "investment",
      recordKind: "investment-source-record",
      accountType: "investment",
      contractVersion: "yuanta-trade/investment/canonical-v1",
      requireProviderGuaranteedFalse: true,
    },
    "maicoin/investment/canonical-v1": {
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "source-reported",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      completeness: "complete-range",
      completenessBasis: "source-reported-complete-investment-snapshot",
      completenessRuleVersion: "maicoin/investment/canonical-v1",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "maicoin",
      stream: "investment",
      recordKind: "investment-source-record",
      accountType: "investment",
      contractVersion: "maicoin/investment/canonical-v1",
      requireProviderGuaranteedFalse: true,
    },
    "yuanta-fund/investment/margin-credit-canonical-v1": {
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "source-reported",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      completeness: "complete-range",
      completenessBasis: "source-reported-independent-margin-balance",
      completenessRuleVersion:
        "yuanta-fund/investment/margin-credit-canonical-v1",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "yuanta-fund",
      stream: "investment-margin",
      recordKind: "investment-margin-credit",
      accountType: "credit",
      contractVersion: "yuanta-fund/investment/margin-credit-canonical-v1",
      requireProviderGuaranteedFalse: true,
    },
    "yuanta-trade/investment/margin-credit-canonical-v1": {
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "source-reported",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      completeness: "complete-range",
      completenessBasis: "source-reported-independent-margin-balance",
      completenessRuleVersion:
        "yuanta-trade/investment/margin-credit-canonical-v1",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "yuanta-trade",
      stream: "investment-margin",
      recordKind: "investment-margin-credit",
      accountType: "credit",
      contractVersion: "yuanta-trade/investment/margin-credit-canonical-v1",
      requireProviderGuaranteedFalse: true,
    },
    "cathay/domestic-deposit/v1": {
      postingOrigin: "provider_booked_history",
      postingBasis: "query-status-success-with-accounting-date",
      effectiveTimeBasis: "accounting",
    },
    "linebank/domestic-deposit/human-attested-v13": {
      postingOrigin: "human_attested_history",
      postingBasis: "human-attested-formally-posted",
      effectiveTimeBasis: "transaction-time",
    },
    "fubon/domestic-deposit/human-attested-v1": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
    },
    "fubon/loan/canonical-v2": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "source-reported",
      currency: "TWD",
      postingStatus: "posted",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/canonical/v2.fubon",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "fubon",
      stream: "loan",
      recordKind: "fubon-loan-transaction",
      accountType: "loan",
      contractVersion: "loan/canonical/v2.fubon",
      requireProviderGuaranteedFalse: true,
    },
    "fubon/loan/counterpart-deposit-v1": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
      currency: "TWD",
      postingStatus: "posted",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/counterpart/v1.fubon",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "fubon",
      stream: "domestic-deposit",
      recordKind: "fubon-loan-counterpart-deposit",
      accountType: "depository",
      contractVersion: "loan/counterpart/v1.fubon",
      requireProviderGuaranteedFalse: true,
    },
    "fubon/credit-card/human-attested-v2": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
      currency: "TWD",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      completeness: "complete-range",
      completenessBasis: "six-billed-periods-plus-unbilled-terminal-grids",
      completenessRuleVersion: "fubon/credit-card/human-attested-v2",
      withdrawalPolicy: "never-infer",
      integrationNamespace: "fubon",
      stream: "credit-card",
      recordKind: "fubon-credit-card-transaction",
      accountType: "credit",
      contractVersion: "fubon/credit-card/human-attested-v2",
      requireProviderGuaranteedFalse: true,
    },
    "esun/credit-card/human-attested-v4": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
      currency: "TWD",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      completeness: "complete-range",
      completenessBasis:
        "bank-last-year-timeline-current-month-through-twelve-or-thirteen-contiguous-months-terminal-cursor-four-card-counts",
      completenessRuleVersion: "esun/credit-card/human-attested-v4",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "esun",
      stream: "credit-card",
      recordKind: "esun-credit-card-transaction",
      accountType: "credit",
      contractVersion: "esun/credit-card/human-attested-v4",
      requireProviderGuaranteedFalse: true,
    },
    "yuanta/credit-card/human-attested-v2": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
      currency: "TWD",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      completeness: "complete-range",
      completenessBasis:
        "six-billed-months-plus-unbilled-terminal-no-pager-plus-settled-summary-cycles",
      completenessRuleVersion: "yuanta/credit-card/human-attested-v2",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "yuanta",
      stream: "credit-card",
      recordKind: "yuanta-credit-card-transaction",
      accountType: "credit",
      contractVersion: "yuanta/credit-card/human-attested-v2",
      requireProviderGuaranteedFalse: true,
    },
    "yuanta/loan/canonical-v1": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "source-reported",
      currency: "TWD",
      postingStatus: "posted",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/canonical/v1.yuanta",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "yuanta",
      stream: "loan",
      recordKind: "yuanta-loan-transaction",
      accountType: "loan",
      contractVersion: "loan/canonical/v1.yuanta",
      requireProviderGuaranteedFalse: true,
    },
    "yuanta/loan/counterpart-deposit-v1": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
      currency: "TWD",
      postingStatus: "posted",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/counterpart/v1.yuanta",
      absenceAuthority: null,
      withdrawalPolicy: "never-infer",
      integrationNamespace: "yuanta",
      stream: "domestic-deposit",
      recordKind: "yuanta-loan-counterpart-deposit",
      accountType: "depository",
      contractVersion: "loan/counterpart/v1.yuanta",
      requireProviderGuaranteedFalse: true,
    },
    "yuanta/domestic-deposit/human-attested-v2": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
      currency: "TWD",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      completeness: "complete-range",
      completenessBasis: "exact-ui-range-terminal-download",
      absenceAuthority: "provider-explicit-no-data",
      withdrawalPolicy: "never-infer",
      integrationNamespace: "yuanta",
      stream: "domestic-deposit",
      recordKind: "yuanta-domestic-deposit",
      contractVersion: "human-attested-v2",
      requireProviderGuaranteedFalse: true,
    },
    "hncb/domestic-deposit/human-attested-v1": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
      currency: "TWD",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      completeness: "complete-range",
      completenessBasis: "exact-ui-range-terminal-export",
      absenceAuthority: "provider-explicit-no-data",
      withdrawalPolicy: "never-infer",
      integrationNamespace: "hncb",
      stream: "domestic-deposit",
      recordKind: "hncb-domestic-deposit",
      contractVersion: "human-attested-v1",
      requireProviderGuaranteedFalse: true,
    },
    "ctbc/domestic-deposit/human-attested-v1": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "accounting",
      currency: "TWD",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      completeness: "complete-range",
      completenessBasis: "all-visible-ranges-terminal-next-key-empty",
      absenceAuthority: "provider-explicit-no-data",
      withdrawalPolicy: "never-infer",
      integrationNamespace: "ctbc",
      stream: "domestic-deposit",
      recordKind: "ctbc-domestic-deposit",
      contractVersion: "human-attested-v1",
      requireProviderGuaranteedFalse: true,
      absenceAuthorityOnlyWhenEmpty: true,
    },
    "sinopac/domestic-deposit/human-attested-v1": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
      currency: "TWD",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "minute",
      completeness: "complete-range",
      completenessBasis: "bounded-terminal-query",
      absenceAuthority: "provider-explicit-no-data",
      withdrawalPolicy: "never-infer",
      integrationNamespace: "sinopac",
      stream: "domestic-deposit",
      recordKind: "sinopac-domestic-deposit",
      contractVersion: "human-attested-v1",
      requireProviderGuaranteedFalse: true,
      absenceAuthorityOnlyWhenEmpty: true,
    },
    "post/domestic-deposit/human-attested-v1": {
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "accounting",
      currency: "TWD",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      completeness: "complete-range",
      completenessBasis: "accepted-range-terminal-http-200-nonempty-item",
      withdrawalPolicy: "never-infer",
      integrationNamespace: "post",
      stream: "domestic-deposit",
      recordKind: "post-domestic-deposit",
      contractVersion: "human-attested-v1",
      requireProviderGuaranteedFalse: true,
    },
    [TDCC_SETTLEMENT_DEPOSIT_ROUTE]: TDCC_SETTLEMENT_DEPOSIT_PROFILE,
  };
  for (const metadata of Object.values(
    FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA,
  ))
    routeRules[metadata.authorityRoute] = {
      postingOrigin: metadata.postingOrigin,
      postingBasis: "statement-posted-history",
      effectiveTimeBasis: "transaction-time",
      postingStatus: "posted",
      timeZone: "Asia/Taipei",
      completeness: "complete-range",
      completenessBasis: "foreign-currency-terminal-complete-range",
      absenceAuthority: "provider-explicit-no-data",
      withdrawalPolicy: "never-infer",
      integrationNamespace: metadata.integrationNamespace,
      stream: "foreign-currency-deposit",
      recordKind: metadata.recordKind,
      contractVersion: metadata.contractVersion,
      requireProviderGuaranteedFalse: true,
    };
  const routeRule = routeRules[capture.authorityRoute];
  if (!routeRule)
    throw new Error("Unknown canonical financial authority route.");
  if (!canonicalSourceRuleCombination(
    capture.authorityRoute,
    capture.contractVersion,
    capture.semantics.postingRuleVersion,
    capture.semantics.semanticRuleVersion,
    capture.semantics.effectiveTimeRuleVersion,
  ))
    throw new Error("Financial rule combination is not admitted by the source contract.");
  if (
    capture.semantics.postingOrigin !== routeRule.postingOrigin ||
    capture.semantics.postingBasis !== routeRule.postingBasis ||
    capture.semantics.effectiveTimeBasis !== routeRule.effectiveTimeBasis
  )
    throw new Error("Financial semantics do not match the authority route.");
  if (
    routeRule?.requireProviderGuaranteedFalse &&
    (capture.semantics.providerGuaranteed === true ||
      capture.semantics.occurrenceProviderGuaranteed === true ||
      (capture.semantics.providerGuaranteed !== false &&
        capture.semantics.occurrenceProviderGuaranteed !== false))
  )
    throw new Error(
      `${capture.authorityRoute} route requires provider and occurrence guarantees to be explicitly false.`,
    );
  if (routeRule) {
    const mismatches: string[] = [];
    if (
      routeRule.currency !== undefined &&
      capture.identity.currency !== routeRule.currency
    )
      mismatches.push("currency");
    if (
      routeRule.postingStatus !== undefined &&
      capture.semantics.postingStatus !== routeRule.postingStatus
    )
      mismatches.push("posting status");
    if (
      routeRule.timeZone !== undefined &&
      capture.semantics.timeZone !== routeRule.timeZone
    )
      mismatches.push("time zone");
    if (
      routeRule.timePrecision !== undefined &&
      capture.semantics.timePrecision !== routeRule.timePrecision
    )
      mismatches.push("time precision");
    if (
      routeRule.completeness !== undefined &&
      capture.scope.completeness !== routeRule.completeness
    )
      mismatches.push("completeness");
    if (
      routeRule.completenessBasis !== undefined &&
      capture.scope.completenessBasis !== routeRule.completenessBasis
    )
      mismatches.push("completeness basis");
    if (
      routeRule.completenessRuleVersion !== undefined &&
      capture.scope.completenessRuleVersion !==
        routeRule.completenessRuleVersion
    )
      mismatches.push("completeness rule version");
    if (routeRule.absenceAuthority !== undefined) {
      const expectedAbsenceAuthority = routeRule.absenceAuthorityOnlyWhenEmpty
        ? capture.records.length === 0
          ? routeRule.absenceAuthority
          : null
        : routeRule.absenceAuthority;
      if (capture.scope.absenceAuthority !== expectedAbsenceAuthority)
        mismatches.push("absence authority");
    }
    if (
      routeRule.withdrawalPolicy !== undefined &&
      capture.scope.withdrawalPolicy !== routeRule.withdrawalPolicy
    )
      mismatches.push("withdrawal policy");
    if (
      routeRule.integrationNamespace !== undefined &&
      capture.identity.integrationNamespace !== routeRule.integrationNamespace
    )
      mismatches.push("integration namespace");
    if (
      routeRule.stream !== undefined &&
      capture.identity.stream !== routeRule.stream
    )
      mismatches.push("stream");
    if (
      routeRule.recordKind !== undefined &&
      capture.identity.recordKind !== routeRule.recordKind
    )
      mismatches.push("record kind");
    if (
      routeRule.accountType !== undefined &&
      capture.identity.accountType !== routeRule.accountType
    )
      mismatches.push("account type");
    if (
      routeRule.contractVersion !== undefined &&
      capture.contractVersion !== routeRule.contractVersion
    )
      mismatches.push("contract version");
    if (mismatches.length > 0)
      throw new Error(
        `Financial capture does not match the ${capture.authorityRoute} route profile: ${mismatches.join(", ")}.`,
      );
  }
  if (isForeignCurrencyCapture && capture.identity.accountType !== "depository")
    throw new Error(
      "Foreign-currency deposit account type must be depository.",
    );
  if (
    capture.scope.withdrawalPolicy !== undefined &&
    capture.scope.withdrawalPolicy !== "allow-inference" &&
    capture.scope.withdrawalPolicy !== "never-infer"
  )
    throw new Error("Capture withdrawal policy is invalid.");
  validateOpaque(capture.identity.sourceConnectionKey, "Source connection key");
  validateOpaque(capture.identity.identityEpochKey, "Identity epoch key");
  validateOpaque(capture.identity.subjectDigest, "Subject digest");
  let capturedRowCount = 0;
  let terminalPageCount = 0;
  for (const [pageIndex, page] of capture.pages.entries()) {
    if (page.pageOrdinal < 0 || page.pageOrdinal >= capture.scope.pageCount)
      throw new Error("Capture page ordinal is invalid.");
    if (isForeignCurrencyCapture && page.pageOrdinal !== pageIndex)
      throw new Error(
        "Foreign capture page ordinals must be contiguous from zero.",
      );
    if (isHumanAttestedCreditCardCapture && page.pageOrdinal !== pageIndex)
      throw new Error(
        "Human-attested credit-card grid ordinals must be contiguous from zero.",
      );
    if (!Number.isSafeInteger(page.rowCount) || page.rowCount < 0)
      throw new Error("Capture page row count is invalid.");
    capturedRowCount += page.rowCount;
    if (page.terminal) {
      terminalPageCount += 1;
      if (isForeignCurrencyCapture && pageIndex !== capture.pages.length - 1)
        throw new Error(
          "Foreign capture cannot contain pages after its terminal page.",
        );
    }
  }
  if (
    isForeignCurrencyCapture &&
    (terminalPageCount !== 1 || !capture.pages.at(-1)?.terminal)
  )
    throw new Error(
      "Foreign complete-range capture requires exactly one final terminal page.",
    );
  if (isForeignCurrencyCapture && capturedRowCount !== capture.records.length)
    throw new Error(
      "Foreign capture page row count does not match admitted records.",
    );
  if (
    isFubonCreditCardCapture &&
    (capture.pages.length !== 7 ||
      terminalPageCount !== 7 ||
      capturedRowCount !== capture.records.length)
  )
    throw new Error(
      "Fubon credit-card capture requires seven terminal grids with matching row counts.",
    );
  if (
    isEsunCreditCardCapture &&
    (capture.pages.length !== 1 ||
      terminalPageCount !== 1 ||
      capturedRowCount !== capture.records.length)
  )
    throw new Error(
      "E.SUN credit-card capture requires one terminal grid with matching row counts.",
    );
  if (
    isYuantaCreditCardCapture &&
    (capture.pages.length !== 7 ||
      terminalPageCount !== 7 ||
      capturedRowCount !== capture.records.length)
  )
    throw new Error(
      "Yuanta credit-card capture requires seven terminal grids with matching row counts.",
    );
  const nonTransactionRecords = capture.nonTransactionRecords ?? [];
  if (nonTransactionRecords.length > 0) {
    if (
      capture.identity.stream !== "investment" &&
      !nonTransactionRecords.every(
        (record) => record.recordType === "statement-evidence",
      )
    )
      throw new Error(
        "Non-transaction source records are only supported for investment captures.",
      );
    if (capture.scope.withdrawalPolicy !== "never-infer")
      throw new Error(
        "Non-transaction source records require a never-infer capture scope.",
      );
    if (isForeignCurrencyCapture)
      throw new Error(
        "Non-transaction source records are not supported by this financial route.",
      );
  }
  const routeRegistration = CANONICAL_SOURCE_ROUTE_REGISTRY.find(
    (registration) =>
      registration.routeKey === capture.authorityRoute &&
      registration.contractVersions.includes(capture.contractVersion),
  );
  const routeOccurrenceGroupMode = routeRegistration?.occurrenceGroups;
  const routeOccurrenceGroupCoverageMode = routeRegistration?.occurrenceGroupCoverage;
  const requiresOccurrenceGroups = routeOccurrenceGroupMode === "required";
  const permitsOccurrenceGroups = routeOccurrenceGroupMode !== undefined;
  if (
    routeOccurrenceGroupCoverageMode === "queried-buckets" &&
    (capture.scope.scopeKind !== "bounded-range" ||
      capture.scope.completeness !== "complete-range")
  )
    throw new Error("Queried-bucket occurrence proofs require complete bounded financial history.");
  const groupCoverage = capture.occurrenceGroupCoverage ?? [];
  const hasGroupedRecords = capture.records.some(
    (record) => record.occurrenceGroup !== undefined,
  );
  if (
    !permitsOccurrenceGroups &&
    (groupCoverage.length > 0 || hasGroupedRecords)
  )
    throw new Error(
      "Occurrence groups are not registered for this source route.",
    );
  if (requiresOccurrenceGroups && groupCoverage.length === 0)
    throw new Error(
      "Financial capture lacks complete occurrence-group coverage.",
    );
  if (
    (requiresOccurrenceGroups || hasGroupedRecords || groupCoverage.length > 0) &&
    (capture.pages.at(-1)?.terminal !== true ||
      groupCoverage.some(
        (coverage) => coverage.contractVersion !== capture.contractVersion,
      ))
  )
    throw new Error(
      "Occurrence-group coverage does not match the complete financial capture.",
    );
  if (hasGroupedRecords && groupCoverage.length === 0)
    throw new Error("Grouped financial records require complete coverage evidence.");
  try {
    assertCanonicalOccurrenceGroupEvidence({
      records: capture.records, coverage: capture.occurrenceGroupCoverage,
      scopeStart: capture.scope.startDate, scopeEnd: capture.scope.endDate,
      contractVersion: capture.contractVersion,
      coverageMode: routeOccurrenceGroupCoverageMode, requireRecordGroups: requiresOccurrenceGroups,
    });
  } catch (error) {
    if (error instanceof CanonicalOccurrenceGroupConflictError)
      throw new CanonicalFinancialDepositConflictError(error.message);
    throw error;
  }
  const occurrences = new Set<string>();
  const collisions = new Set<string>();
  for (const record of capture.records) {
    validateOpaque(record.occurrenceKey, "Occurrence key");
    validateOpaque(record.collisionKey, "Collision key");
    if (isHumanAttestedCreditCardCapture) {
      if (record.providerKey !== "human-attested:no-provider-key")
        throw new Error(
          "Human-attested credit-card records cannot claim a provider key.",
        );
      validateOpaque(
        record.humanAttestedOccurrenceKey ?? "",
        "Human-attested occurrence key",
      );
      if (record.humanAttestedOccurrenceKey !== record.occurrenceKey)
        throw new Error(
          "Human-attested occurrence key must be the authority identity.",
        );
      if (!/^observed-source-order:\d+$/.test(record.sequenceLexeme))
        throw new Error(
          "Human-attested source order must be an observed ordinal, not a provider sequence.",
        );
    } else {
      validateOpaque(record.providerKey, "Provider key");
      if (record.humanAttestedOccurrenceKey !== undefined)
        throw new Error(
          "Human-attested occurrence identity is only valid for its exact route.",
        );
    }
    validateOpaque(record.contentHash, "Content hash");
    if (occurrences.has(record.occurrenceKey))
      throw new CanonicalFinancialDepositConflictError(
        "Duplicate source occurrence in one capture.",
      );
    if (collisions.has(record.collisionKey))
      throw new CanonicalFinancialDepositConflictError(
        "Duplicate source collision identity in one capture.",
      );
    occurrences.add(record.occurrenceKey);
    collisions.add(record.collisionKey);
    validateText(record.sequenceLexeme, "Financial source sequence");
    validateText(record.compactJson, "Financial compact source payload");
    validateAmount(record.amount, "Financial transaction amount");
    if (record.balanceAfter !== null)
      validateAmount(record.balanceAfter, "Financial balance amount");
    validateCurrency(record.currency, "Financial transaction currency");
    if (record.direction !== "inflow" && record.direction !== "outflow")
      throw new Error(
        "Financial transaction direction must be inflow or outflow.",
      );
    if (isForeignCurrencyCapture) {
      const expectedContentHash = `sha256:${createHash("sha256")
        .update(record.compactJson)
        .digest("base64url")}`;
      if (record.contentHash !== expectedContentHash)
        throw new Error(
          "Foreign financial content hash does not match its compact source payload.",
        );
      let compact: Record<string, unknown>;
      try {
        compact = JSON.parse(record.compactJson) as Record<string, unknown>;
      } catch {
        throw new Error("Foreign compact source payload must be valid JSON.");
      }
      if (
        compact.direction !== record.direction ||
        compact.currency !== record.currency ||
        JSON.stringify(compact.amount) !== JSON.stringify(record.amount) ||
        JSON.stringify(compact.balanceAfter) !==
          JSON.stringify(record.balanceAfter)
      )
        throw new Error(
          "Foreign compact source payload does not match canonical financial facts.",
        );
      validateSourceTime(record.sourceTime, record);
    }
    if (capture.semantics.requireBalance && record.balanceAfter === null)
      throw new Error("Financial record lacks an exact balance.");
    if (record.conversionEvidence) {
      const conversion = record.conversionEvidence;
      validateAmount(conversion.bookedAmount, "Conversion booked amount");
      validateCurrency(conversion.bookedCurrency, "Conversion booked currency");
      if (conversion.originalAmount !== null)
        validateAmount(conversion.originalAmount, "Conversion original amount");
      if (conversion.originalCurrency !== null)
        validateCurrency(
          conversion.originalCurrency,
          "Conversion original currency",
        );
      if (
        (conversion.originalAmount === null) !==
        (conversion.originalCurrency === null)
      )
        throw new Error(
          "Conversion original amount and currency must be present together.",
        );
      if (conversion.feeAmount != null)
        validateAmount(conversion.feeAmount, "Conversion fee amount");
      if (conversion.feeCurrency != null)
        validateCurrency(conversion.feeCurrency, "Conversion fee currency");
      if ((conversion.feeAmount == null) !== (conversion.feeCurrency == null))
        throw new Error(
          "Conversion fee amount and currency must be present together.",
        );
      for (const [label, candidate] of [
        ["source-reported", conversion.sourceReportedRate],
        ["implied", conversion.impliedRate],
      ] as const) {
        if (!candidate) continue;
        validateAmount(candidate.amount, `${label} rate amount`);
        validateCurrency(candidate.baseCurrency, `${label} rate base currency`);
        validateCurrency(
          candidate.quoteCurrency,
          `${label} rate quote currency`,
        );
        if (candidate.observedOn != null)
          validateDate(candidate.observedOn, `${label} rate date`);
      }
      if (
        conversion.comparison !== "consistent" &&
        conversion.comparison !== "conflicted" &&
        conversion.comparison !== "not-comparable"
      )
        throw new Error("Conversion comparison is invalid.");
      if (
        conversion.bookedAmount.coefficient !== record.amount.coefficient ||
        conversion.bookedAmount.scale !== record.amount.scale ||
        conversion.bookedCurrency !== record.currency
      )
        throw new Error(
          "Conversion evidence booked amount must match the canonical transaction.",
      );
    }
  }

  for (const record of nonTransactionRecords) {
    if (
      record.recordType !== "holding-observation" &&
      record.recordType !== "statement-evidence"
    )
      throw new Error("Non-transaction source record kind is unsupported.");
    validateOpaque(record.occurrenceKey, "Occurrence key");
    validateOpaque(record.collisionKey, "Collision key");
    if (record.providerKey !== "human-attested:no-provider-key")
      validateOpaque(record.providerKey, "Provider key");
    validateOpaque(record.contentHash, "Content hash");
    if (occurrences.has(record.occurrenceKey))
      throw new CanonicalFinancialDepositConflictError(
        "Duplicate source occurrence in one capture.",
      );
    if (collisions.has(record.collisionKey))
      throw new CanonicalFinancialDepositConflictError(
        "Duplicate source collision identity in one capture.",
      );
    occurrences.add(record.occurrenceKey);
    collisions.add(record.collisionKey);
    validateText(record.sequenceLexeme, "Financial source sequence");
    validateText(record.compactJson, "Financial compact source payload");
  }
}


export function admitCanonicalFinancialDepositCapture(
  capture: CanonicalFinancialDepositCapture,
): CanonicalFinancialDepositValidatedCapture {
  if (capture === null || typeof capture !== "object")
    throw new Error("A financial deposit capture object is required.");
  validateCanonicalFinancialDepositCapture(capture);
  for (const page of capture.pages) Object.freeze(page);
  for (const record of capture.records) {
    Object.freeze(record.amount);
    if (record.balanceAfter) Object.freeze(record.balanceAfter);
    Object.freeze(record.sourceTime);
    Object.freeze(record);
  }
  for (const record of capture.nonTransactionRecords ?? []) Object.freeze(record);
  Object.freeze(capture.pages);
  Object.freeze(capture.records);
  if (capture.nonTransactionRecords)
    Object.freeze(capture.nonTransactionRecords);
  Object.freeze(capture.identity);
  Object.freeze(capture.scope);
  Object.freeze(capture.semantics);
  Object.freeze(capture);
  VALIDATED_CAPTURES.add(capture);
  return capture as CanonicalFinancialDepositValidatedCapture;
}

export function isAdmittedCanonicalFinancialDepositCapture(
  capture: unknown,
): capture is CanonicalFinancialDepositValidatedCapture {
  return (
    capture !== null &&
    typeof capture === "object" &&
    VALIDATED_CAPTURES.has(capture)
  );
}
