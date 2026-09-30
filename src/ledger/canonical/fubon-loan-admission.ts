import type {
  CanonicalLoanStatementRow,
  LoanCaptureInput,
} from "./loan-financial.ts";
import {
  CanonicalLoanAdmissionError,
  FUBON_LOAN_CONTRACT_VERSION,
  LOAN_EVENT_CONTRACT_MAPPINGS,
  canonicalLoanSourceIdentity,
  canonicalLoanToken,
  createCanonicalLoanCapture,
  isCanonicalLoanSourceDateBeforeObservedAt,
  parseCanonicalLoanAmount,
  parseCanonicalLoanDate,
} from "./loan-admission.ts";

export const FUBON_LOAN_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "fubon/loan/account-number-v1" as const;

export type FubonLoanStatementRow = {
  transactionDate: string;
  transactionContent: string;
  transactionAmount: string;
  balanceAfterTransaction: string;
};

export type FubonLoanAccountNumberEvidence = Readonly<{
  value: string;
  kind: "loan-account";
  evidenceVersion: typeof FUBON_LOAN_ACCOUNT_NUMBER_EVIDENCE_VERSION;
  sourceField: "form1:loanAccountCombo option.text";
}>;

export type FubonLoanCaptureBuildInput = {
  accountValue: string;
  accountNumber?: FubonLoanAccountNumberEvidence;
  sourceConnectionScope: string;
  observedAt: string;
  startDate: string;
  endDate: string;
  scope: LoanCaptureInput["scope"];
  pages: LoanCaptureInput["pages"];
  counterpartTransactions: LoanCaptureInput["counterpartTransactions"];
  relations: LoanCaptureInput["relations"];
  relationCoverage?: LoanCaptureInput["relationCoverage"];
  rows: readonly FubonLoanStatementRow[];
};

/** Exact provider labels/codes accepted by the Fubon loan adapter. */
export const FUBON_LOAN_SOURCE_EVENT_CODES: Readonly<Record<string, string>> =
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
    利息: "LOAN-INTEREST",
    繳息: "LOAN-INTEREST",
    利息支付: "LOAN-INTEREST",
    手續費: "LOAN-FEE",
    費用: "LOAN-FEE",
    違約金: "LOAN-FEE",
  });

export const FUBON_LOAN_SOURCE_EVENT_CODEBOOK_VERSION =
  "fubon/loan-source-event-codebook/v1" as const;

function normalizedSourceLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sourceCodeFor(label: string): string {
  const sourceCode = FUBON_LOAN_SOURCE_EVENT_CODES[normalizedSourceLabel(label)];
  if (!sourceCode || !LOAN_EVENT_CONTRACT_MAPPINGS.fubon[sourceCode])
    throw new CanonicalLoanAdmissionError(
      "Fubon loan source event code is unsupported.",
    );
  return sourceCode;
}

function optionalAmount(value: string, label: string) {
  const normalized = normalizedSourceLabel(value);
  if (!normalized || ["-", "—", "N/A", "NA"].includes(normalized))
    return undefined;
  return normalizedAmountForIdentity(parseCanonicalLoanAmount(normalized, label));
}

function normalizedAmountForIdentity(value: {
  coefficient: string;
  scale: number;
}): { coefficient: string; scale: number } {
  if (value.coefficient === "0") return { coefficient: "0", scale: 0 };
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient.endsWith("0")) {
    coefficient = coefficient.slice(0, -1);
    scale -= 1;
  }
  return { coefficient, scale };
}

function canonicalRows(
  input: FubonLoanCaptureBuildInput,
): CanonicalLoanStatementRow[] {
  const account = normalizedSourceLabel(input.accountValue);
  if (!account)
    throw new CanonicalLoanAdmissionError(
      "Fubon loan account value is required.",
    );
  const preparedRows = input.rows
    .map((row, inputIndex) => {
      const sourceCode = sourceCodeFor(row.transactionContent);
      const mapping = LOAN_EVENT_CONTRACT_MAPPINGS.fubon[sourceCode]!;
      const effectiveOn = parseCanonicalLoanDate(
        row.transactionDate,
        "Fubon loan transaction date",
      );
      const amount = parseCanonicalLoanAmount(
        row.transactionAmount,
        "Fubon loan transaction amount",
      );
      const identityAmount = normalizedAmountForIdentity(amount);
      return {
        row,
        inputIndex,
        sourceCode,
        mapping,
        effectiveOn,
        amount,
        fingerprint: canonicalLoanToken(
          "fubon",
          "loan-source-record-v2",
          account,
          effectiveOn,
          sourceCode,
          mapping.direction,
          identityAmount.coefficient,
          String(identityAmount.scale),
          "TWD",
        ),
      };
    })
    .sort(
      (left, right) =>
        left.effectiveOn.localeCompare(right.effectiveOn) ||
        left.inputIndex - right.inputIndex,
    );
  const ordinals = new Map<string, number>();
  return preparedRows.map(
    ({ row, sourceCode, mapping, effectiveOn, amount, fingerprint }, index) => {
      const ordinal = (ordinals.get(fingerprint) ?? 0) + 1;
      ordinals.set(fingerprint, ordinal);
      const identityAmount = normalizedAmountForIdentity(amount);
      const sourceRecordKey = canonicalLoanToken(
        "fubon",
        "loan-source-record-v2",
        account,
        effectiveOn,
        sourceCode,
        mapping.direction,
        identityAmount.coefficient,
        String(identityAmount.scale),
        "TWD",
        String(ordinal),
      );
      const balance = optionalAmount(
        row.balanceAfterTransaction,
        "Fubon loan balance",
      );
      const balanceEffectiveAt = effectiveOn;
      const balanceIsHistorical =
        balance !== undefined &&
        isCanonicalLoanSourceDateBeforeObservedAt(
          balanceEffectiveAt,
          input.observedAt,
        );
      return {
        sourceRecordKey,
        // The sequence remains useful source evidence, but never enters the
        // semantic occurrence, collision, or provider identity.
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
        description: sourceCode,
        sourceDescription: row.transactionContent,
        ...(balanceIsHistorical
          ? {
              balance: {
                observationKey: canonicalLoanToken(
                  "fubon",
                  "loan-balance-observation-v2",
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
    },
  );
}

export function buildFubonLoanCapture(
  input: FubonLoanCaptureBuildInput,
): LoanCaptureInput {
  const rows = canonicalRows(input);
  const identity = {
    ...canonicalLoanSourceIdentity(
      "fubon",
      input.sourceConnectionScope,
      input.accountValue,
    ),
    ...(input.accountNumber ? { accountNumber: input.accountNumber } : {}),
  };
  return createCanonicalLoanCapture({
    captureId: canonicalLoanToken(
      "fubon",
      "loan-capture-v2",
      input.sourceConnectionScope,
      input.accountValue,
      input.observedAt,
      input.startDate,
      input.endDate,
      ...rows.map((row) => row.sourceRecordKey),
    ),
    sourceId: "fubon",
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

export function assertFubonLoanCaptureAccountNumberEvidence(
  capture: LoanCaptureInput,
): void {
  if (capture.sourceId !== "fubon")
    throw new Error("Fubon loan admission requires a Fubon capture.");
  const accountNumber = (
    capture.identity as LoanCaptureInput["identity"] & {
      accountNumber?: unknown;
    }
  ).accountNumber;
  if (
    accountNumber !== undefined &&
    (accountNumber === null ||
      typeof accountNumber !== "object" ||
      accountNumber.kind !== "loan-account" ||
      accountNumber.evidenceVersion !==
        FUBON_LOAN_ACCOUNT_NUMBER_EVIDENCE_VERSION ||
      accountNumber.sourceField !== "form1:loanAccountCombo option.text" ||
      typeof accountNumber.value !== "string" ||
      !/^\d{14}$/.test(accountNumber.value))
  )
    throw new CanonicalLoanAdmissionError(
      "Fubon loan account number evidence is invalid.",
    );
}
