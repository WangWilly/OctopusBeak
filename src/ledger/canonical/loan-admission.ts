import { createHash } from "node:crypto";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";
import type {
  CanonicalLoanCaptureBuildInput,
  CanonicalLoanIdentityInput,
  LoanCaptureInput,
  LoanEventKind,
  LoanExactAmount,
  LoanSourceId,
} from "./loan-financial.ts";

export const LOAN_CANONICAL_CONTRACT_VERSION = "loan/canonical/v1" as const;
/**
 * Fubon v1 is retained as historical evidence only. The balance evidence
 * correction changed the compact source payload, so the current contract must
 * use a new route and identity namespace instead of attempting an immutable
 * occurrence overwrite.
 */
export const FUBON_LOAN_LEGACY_CONTRACT_VERSION =
  "loan/canonical/v1.fubon" as const;
export const FUBON_LOAN_CONTRACT_VERSION = "loan/canonical/v2.fubon" as const;
export const YUANTA_LOAN_CONTRACT_VERSION =
  `${LOAN_CANONICAL_CONTRACT_VERSION}.yuanta` as const;
/**
 * Yuanta's loan statement has no provider transaction identifier in the
 * retained result-row contract. This versioned rule therefore identifies a
 * source occurrence from normalized account/date/source-event/payment-item
 * fields, never its rendered row position or mutable amount/balance. The v1
 * rule remains addressable through the old source record tokens already
 * committed to canonical storage.
 */
export const YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION =
  "yuanta/loan-source-occurrence/v2" as const;
export const YUANTA_LOAN_LEGACY_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION =
  "yuanta/loan-source-occurrence/v1" as const;

export const FUBON_LOAN_LEGACY_AUTHORITY_ROUTE =
  "fubon/loan/canonical-v1" as const;
export const FUBON_LOAN_AUTHORITY_ROUTE = "fubon/loan/canonical-v2" as const;
export const YUANTA_LOAN_AUTHORITY_ROUTE = "yuanta/loan/canonical-v1" as const;
export const FUBON_LOAN_COUNTERPART_AUTHORITY_ROUTE =
  "fubon/loan/counterpart-deposit-v1" as const;
export const YUANTA_LOAN_COUNTERPART_AUTHORITY_ROUTE =
  "yuanta/loan/counterpart-deposit-v1" as const;
export const FUBON_LOAN_COUNTERPART_CONTRACT_VERSION =
  "loan/counterpart/v1.fubon" as const;
export const YUANTA_LOAN_COUNTERPART_CONTRACT_VERSION =
  "loan/counterpart/v1.yuanta" as const;

type LoanEventContractMapping = {
  eventKind: LoanEventKind;
  direction: "inflow" | "outflow";
};

/** Source-code mappings make loan direction fail closed. */
export const LOAN_EVENT_CONTRACT_MAPPINGS: Readonly<
  Record<LoanSourceId, Readonly<Record<string, LoanEventContractMapping>>>
> = Object.freeze({
  fubon: Object.freeze({
    "LOAN-DISBURSEMENT": {
      eventKind: "disbursement",
      direction: "outflow",
    } as LoanEventContractMapping,
    "LOAN-PAYMENT": {
      eventKind: "payment",
      direction: "inflow",
    } as LoanEventContractMapping,
    "LOAN-INTEREST": {
      eventKind: "interest",
      direction: "inflow",
    } as LoanEventContractMapping,
    "LOAN-FEE": {
      eventKind: "fee",
      direction: "inflow",
    } as LoanEventContractMapping,
  }),
  yuanta: Object.freeze({
    "LOAN-DISBURSEMENT": {
      eventKind: "disbursement",
      direction: "outflow",
    } as LoanEventContractMapping,
    "LOAN-PAYMENT": {
      eventKind: "payment",
      direction: "inflow",
    } as LoanEventContractMapping,
    "LOAN-INTEREST": {
      eventKind: "interest",
      direction: "inflow",
    } as LoanEventContractMapping,
    "LOAN-FEE": {
      eventKind: "fee",
      direction: "inflow",
    } as LoanEventContractMapping,
  }),
});

export class CanonicalLoanAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalLoanAdmissionError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function token(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("base64url")}`;
}

/** Build an opaque, deterministic identity or source-record token. */
export function canonicalLoanToken(...parts: string[]): `sha256:${string}` {
  return token(...parts);
}

/**
 * Project an account option value into the identity fields required by the
 * canonical loan contract. The provider value stays in memory only; every
 * persisted identity is opaque and scoped to the source connection.
 */
export function canonicalLoanSourceIdentity(
  sourceId: LoanSourceId,
  sourceConnectionScope: string,
  accountValue: string,
): CanonicalLoanIdentityInput {
  const connectionScope = sourceConnectionScope.trim();
  const selectedAccount = accountValue.trim();
  if (!connectionScope || !selectedAccount)
    throw new CanonicalLoanAdmissionError(
      "Loan source connection scope and account option are required.",
    );

  const identityNamespaceVersion = sourceId === "fubon" ? "v2" : "v1";
  const sourceConnectionKey = deriveSourceConnectionIdentityKey(
    sourceId,
    connectionScope,
  );
  const identityEpochKey = token(
    sourceId,
    `loan-identity-epoch-${identityNamespaceVersion}`,
  );
  const accountKey = token(
    sourceId,
    `loan-account-key-${identityNamespaceVersion}`,
    connectionScope,
    selectedAccount,
  );
  return {
    sourceConnectionKey,
    identityEpochKey,
    accountKey,
    subjectDigest: token(
      sourceId,
      `loan-subject-${identityNamespaceVersion}`,
      connectionScope,
      selectedAccount,
    ),
    accountNo: token(
      sourceId,
      `loan-account-number-${identityNamespaceVersion}`,
      selectedAccount,
    ),
  };
}

/** Parse a provider amount without converting through a floating point value. */
export function parseCanonicalLoanAmount(
  value: string,
  label = "Loan amount",
): LoanExactAmount {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\s,]/gu, "")
    .replace(/^(?:NT\$|TWD|NTD)/iu, "");
  const parenthesized = normalized.startsWith("(") && normalized.endsWith(")");
  const unsigned = parenthesized
    ? normalized.slice(1, -1)
    : normalized.replace(/^[+-]/u, "");
  const match = unsigned.match(/^(?:(\d+)(?:\.(\d+))?|\.(\d+))$/u);
  if (!match)
    throw new CanonicalLoanAdmissionError(`${label} is not an exact decimal.`);
  const fraction = match[2] ?? match[3] ?? "";
  const integer = match[1] ?? "0";
  const coefficient = `${integer}${fraction}`.replace(/^0+(?=\d)/u, "");
  return { coefficient, scale: fraction.length };
}

function requireDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value))
    throw new CanonicalLoanAdmissionError(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (date.toISOString().slice(0, 10) !== value)
    throw new CanonicalLoanAdmissionError(
      `${label} must be a valid calendar date.`,
    );
  return value;
}

/** Convert the bank's displayed slash date to the canonical date form. */
export function parseCanonicalLoanDate(
  value: string,
  label = "Loan source date",
): string {
  const normalized = value.normalize("NFKC").trim().replaceAll("/", "-");
  if (!ISO_DATE.test(normalized))
    throw new CanonicalLoanAdmissionError(`${label} must be YYYY/MM/DD.`);
  return requireDate(normalized, label);
}

/** Compare a source-reported date at Asia/Taipei midnight with collection
 * time. Date-only JavaScript parsing is UTC by specification in many runtimes;
 * spelling out +08:00 preserves the provider's local civil date at boundaries
 * such as 00:30 Asia/Taipei. */
export function isCanonicalLoanSourceDateBeforeObservedAt(
  sourceDate: string,
  observedAt: string,
): boolean {
  let canonicalDate: string;
  try {
    canonicalDate = requireDate(sourceDate, "Loan source date");
  } catch {
    return false;
  }
  const sourceEpoch = Date.parse(`${canonicalDate}T00:00:00+08:00`);
  const observedEpoch = Date.parse(observedAt);
  return (
    Number.isFinite(sourceEpoch) &&
    Number.isFinite(observedEpoch) &&
    sourceEpoch < observedEpoch
  );
}

export function expectedContract(sourceId: LoanSourceId): string {
  return sourceId === "fubon"
    ? FUBON_LOAN_CONTRACT_VERSION
    : YUANTA_LOAN_CONTRACT_VERSION;
}

export function expectedAuthority(sourceId: LoanSourceId): string {
  return sourceId === "fubon"
    ? FUBON_LOAN_AUTHORITY_ROUTE
    : YUANTA_LOAN_AUTHORITY_ROUTE;
}

export function expectedRecordKind(sourceId: LoanSourceId): string {
  return `${sourceId}-loan-transaction`;
}

export function expectedCounterpartAuthority(sourceId: LoanSourceId): string {
  return sourceId === "fubon"
    ? FUBON_LOAN_COUNTERPART_AUTHORITY_ROUTE
    : YUANTA_LOAN_COUNTERPART_AUTHORITY_ROUTE;
}

export function expectedCounterpartContract(sourceId: LoanSourceId): string {
  return sourceId === "fubon"
    ? FUBON_LOAN_COUNTERPART_CONTRACT_VERSION
    : YUANTA_LOAN_COUNTERPART_CONTRACT_VERSION;
}

export function expectedCounterpartRecordKind(sourceId: LoanSourceId): string {
  return `${sourceId}-loan-counterpart-deposit`;
}

export function sourceEpoch(localDate: string, localTime: string): number {
  const value = Date.parse(`${localDate}T${localTime}+08:00`);
  if (!Number.isSafeInteger(value))
    throw new CanonicalLoanAdmissionError(
      "Loan source time is not representable.",
    );
  return value;
}

export function dateFromSourceTime(effectiveOn: string, localTime: string): string {
  return `${effectiveOn}T${localTime}`;
}

/** Wrap source-projected rows in the versioned canonical loan capture contract. */
export function createCanonicalLoanCapture(
  input: CanonicalLoanCaptureBuildInput,
): LoanCaptureInput {
  const contractVersion = expectedContract(input.sourceId);
  const records = input.rows.map((row) => ({
    sourceRecordKey: row.sourceRecordKey,
    ...(row.sourceOccurrenceIdentityRuleVersion === undefined
      ? {}
      : {
          sourceOccurrenceIdentityRuleVersion:
            row.sourceOccurrenceIdentityRuleVersion,
        }),
    occurrenceIndex: row.occurrenceIndex,
    effectiveOn: row.effectiveOn,
    sourceTime: row.sourceTime,
    postingStatus: "posted" as const,
    eventKind: row.eventKind,
    eventEvidence: {
      kind: "source-coded-loan-event" as const,
      sourceRecordKey: row.sourceRecordKey,
      sourceCode: row.sourceCode,
      contractVersion,
    },
    direction: row.direction,
    amount: row.amount,
    currency: "TWD" as const,
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.sourceDescription === undefined
      ? {}
      : { sourceDescription: row.sourceDescription }),
    ...(row.balance === undefined
      ? {}
      : {
          balanceSourceEvidence: [
            {
              kind: "source-reported-balance" as const,
              balanceKind: "loan_outstanding" as const,
              balanceField: "balance-after-transaction" as const,
              balance: row.balance.balance,
              effectiveAtField: row.balance.effectiveAtField,
              effectiveAt: row.balance.effectiveAt,
              effectiveAtPrecision: row.balance.effectiveAtPrecision,
              effectiveAtTimeOrigin: row.balance.effectiveAtTimeOrigin,
              storageAnchor: "effective-at-date-only" as const,
              contractVersion,
            },
          ],
        }),
  }));
  const balanceObservations = input.rows.flatMap((row) =>
    row.balance === undefined
      ? []
      : [
          {
            observationKey: row.balance.observationKey,
            sourceRecordKey: row.sourceRecordKey,
            balanceKind: "loan_outstanding" as const,
            balance: row.balance.balance,
            currency: "TWD" as const,
            effectiveAt: row.balance.effectiveAt,
            effectiveAtPrecision: row.balance.effectiveAtPrecision,
            effectiveAtTimeOrigin: row.balance.effectiveAtTimeOrigin,
            effectiveTimeBasis: "source-reported" as const,
            effectiveTimeRuleVersion: contractVersion,
            effectiveTimeEvidence: {
              kind: "source-reported-balance-effective-time" as const,
              sourceRecordKey: row.sourceRecordKey,
              sourceField: "statement-as-of" as const,
              sourceFieldRole: row.balance.effectiveAtField,
              value: row.balance.effectiveAt,
              precision: row.balance.effectiveAtPrecision,
              timeOrigin: row.balance.effectiveAtTimeOrigin,
              storageAnchor: "effective-at-date-only" as const,
              contractVersion,
            },
          },
        ],
  );
  return {
    captureId: input.captureId,
    sourceId: input.sourceId,
    authorityRoute: expectedAuthority(input.sourceId),
    contractVersion,
    identity: {
      ...input.identity,
      accountType: "loan",
      stream: "loan",
      recordKind: expectedRecordKind(input.sourceId),
      currency: "TWD",
    },
    observedAt: input.observedAt,
    scope: input.scope,
    semantics: {
      status: "posted",
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: contractVersion,
      timeZone: "Asia/Taipei",
    },
    pages: input.pages,
    records,
    counterpartTransactions: input.counterpartTransactions,
    balanceObservations,
    relations: input.relations,
    relationCoverage: input.relationCoverage ?? "not-asserted",
  };
}
