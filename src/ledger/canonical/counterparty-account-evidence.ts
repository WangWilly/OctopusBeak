import { createHash } from "node:crypto";

export const COUNTERPARTY_ACCOUNT_EVIDENCE_VERSION =
  "counterparty-account/v1" as const;

/**
 * Live Yuanta domestic-deposit CSV observations show a complete loan account
 * in 備註 as `00` followed by the 14-digit account exposed by the loan
 * statement selector. The contract is deliberately exact: it is not a
 * general leading-zero trimming rule.
 */
export const YUANTA_LOAN_ACCOUNT_NOTE_NORMALIZATION_CONTRACT_VERSION =
  "yuanta/transaction-note-loan-account-leading-00/v1" as const;

export type CounterpartyAccountRole = "originator" | "beneficiary";
export type CounterpartyAccountPurpose = "loan_repayment" | string;
export type CounterpartyAccountScope =
  | "loan_contract"
  | "shared_collection"
  | null;

/**
 * Evidence is generic across transaction records and account-level
 * repayment mandates, so both canonical stores can share the same admission
 * rules without importing either store's runtime.
 */
export type TransactionCounterpartyAccountEvidenceInput = Readonly<{
  captureId: string;
  sourceRecordKey: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  accountValue: string;
  normalizedAccountValue?: string;
  accountDigest?: string;
  role: CounterpartyAccountRole;
  purpose: CounterpartyAccountPurpose;
  scope?: CounterpartyAccountScope;
  evidenceKind?: "transaction-counterparty-account" | "repayment-mandate";
  sourceField?: string;
  contractVersion: string;
  effectiveStartDate?: string | null;
  effectiveEndDate?: string | null;
  /** Required when the source record has no transaction revision (for
   * example, a repayment-setting page). */
  accountKey?: string;
}>;

export type AdmittedCounterpartyAccountEvidence =
  TransactionCounterpartyAccountEvidenceInput & Readonly<{
    sourceValue: string;
    normalizedAccountValue: string;
    accountDigest: `sha256:${string}`;
    evidenceKind:
      | "transaction-counterparty-account"
      | "repayment-mandate";
    sourceField: string;
  }>;

export function counterpartyEvidenceText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value;
}

export function counterpartyEvidenceValidDate(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new Error(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error(`${label} must be a valid calendar date.`);
  return value;
}

function digest(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("base64url")}`;
}

/** Normalize a complete account value. Masked values are a deliberate stop. */
export function normalizeCounterpartyAccountValue(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[\s-]+/gu, "");
  if (!normalized) throw new Error("Counterparty account value is required.");
  if (/[*#•xX]/u.test(normalized))
    throw new Error(
      "Masked counterparty account values cannot be admitted as exact evidence.",
    );
  return normalized;
}

export function counterpartyAccountDigest(
  integrationNamespace: string,
  normalizedValue: string,
): `sha256:${string}` {
  return digest(
    COUNTERPARTY_ACCOUNT_EVIDENCE_VERSION,
    counterpartyEvidenceText(integrationNamespace, "Integration namespace")
      .trim()
      .toLowerCase(),
    normalizedValue,
  );
}

export function admitCounterpartyAccountEvidence(
  input: TransactionCounterpartyAccountEvidenceInput,
  integrationNamespace: string,
): AdmittedCounterpartyAccountEvidence {
  const sourceValue = counterpartyEvidenceText(
    input.accountValue,
    "Counterparty account source value",
  );
  const defaultNormalizedAccountValue =
    normalizeCounterpartyAccountValue(sourceValue);
  const requestedNormalizedAccountValue = input.normalizedAccountValue;
  const namespace = counterpartyEvidenceText(
    integrationNamespace,
    "Counterparty account integration namespace",
  )
    .trim()
    .toLowerCase();
  const isYuantaLoanAccountNoteAlias =
    namespace === "yuanta" &&
    input.contractVersion ===
      YUANTA_LOAN_ACCOUNT_NOTE_NORMALIZATION_CONTRACT_VERSION &&
    input.evidenceKind === "transaction-counterparty-account" &&
    input.role === "beneficiary" &&
    input.purpose === "loan_repayment" &&
    input.sourceField === "備註" &&
    /^00\d{14}$/u.test(defaultNormalizedAccountValue) &&
    requestedNormalizedAccountValue ===
      defaultNormalizedAccountValue.slice(2);
  if (
    requestedNormalizedAccountValue !== undefined &&
    requestedNormalizedAccountValue !== defaultNormalizedAccountValue &&
    !isYuantaLoanAccountNoteAlias
  )
    throw new Error("Counterparty account normalization does not match the source value.");
  const normalizedAccountValue =
    requestedNormalizedAccountValue ?? defaultNormalizedAccountValue;
  const accountDigest = counterpartyAccountDigest(
    namespace,
    normalizedAccountValue,
  );
  if (input.accountDigest !== undefined && input.accountDigest !== accountDigest)
    throw new Error("Counterparty account digest does not match the normalized value.");
  if (input.role !== "originator" && input.role !== "beneficiary")
    throw new Error("Counterparty account role is unsupported.");
  const purpose = counterpartyEvidenceText(
    input.purpose,
    "Counterparty account purpose",
  ).trim();
  const scope = input.scope ?? null;
  if (
    scope !== null &&
    scope !== "loan_contract" &&
    scope !== "shared_collection"
  )
    throw new Error("Counterparty account scope is unsupported.");
  const effectiveStartDate = counterpartyEvidenceValidDate(
    input.effectiveStartDate,
    "Counterparty account effective start date",
  );
  const effectiveEndDate = counterpartyEvidenceValidDate(
    input.effectiveEndDate,
    "Counterparty account effective end date",
  );
  if (
    effectiveStartDate !== null &&
    effectiveEndDate !== null &&
    effectiveStartDate > effectiveEndDate
  )
    throw new Error("Counterparty account effective dates are inverted.");
  return Object.freeze({
    ...input,
    captureId: counterpartyEvidenceText(
      input.captureId,
      "Counterparty account capture ID",
    ).trim(),
    sourceRecordKey: counterpartyEvidenceText(
      input.sourceRecordKey,
      "Counterparty account source record key",
    ).trim(),
    sourceConnectionKey: counterpartyEvidenceText(
      input.sourceConnectionKey,
      "Counterparty account source connection key",
    ).trim(),
    identityEpochKey: counterpartyEvidenceText(
      input.identityEpochKey,
      "Counterparty account identity epoch key",
    ).trim(),
    sourceValue,
    normalizedAccountValue,
    accountDigest,
    purpose,
    scope,
    evidenceKind: input.evidenceKind ?? "transaction-counterparty-account",
    sourceField: counterpartyEvidenceText(
      input.sourceField ?? "counterparty-account",
      "Counterparty account source field",
    ).trim(),
    effectiveStartDate,
    effectiveEndDate,
  });
}
