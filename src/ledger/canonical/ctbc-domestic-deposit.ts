import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";
import {
  canonicalSourceAdmissionCommitResult,
  createCanonicalSourceCaptureAdmission,
} from "./canonical-source-capture-admission.ts";
import type {
  CanonicalSourceCommitResult,
  CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction,
} from "./bank-transaction-kind-enrichment.ts";
import {
  ensureCtbcHumanAttestationEvents,
  isCtbcHumanAttestationDurablyActive,
  isCtbcHumanAttestedV1Active,
  latestCtbcHumanAttestationEvent,
  recordInitialCtbcHumanAttestationIfMissing,
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

import {
  CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  CTBC_DOMESTIC_DEPOSIT_SOURCE_ROUTE,
  CTBC_DOMESTIC_DEPOSIT_SOURCE_RULE_VERSION,
  CTBC_DOMESTIC_DEPOSIT_SOURCE_RECORD_KIND,
  CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  CTBC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
  CTBC_DOMESTIC_DEPOSIT_FINANCIAL_COMPLETENESS_BASIS,
  CTBC_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  deriveCtbcDomesticDepositAccountNumberEvidence,
  admitCtbcDomesticDepositCaptureEvidence,
  isAdmittedCtbcDomesticDepositCaptureEvidence,
  createCtbcDomesticDepositSourceEvidence,
  CtbcDomesticDepositFinancialAdmissionError,
  admitCtbcDomesticDepositFinancialCapture,
} from "./ctbc-domestic-deposit-admission.ts";
import type {
  CtbcDomesticDepositCaptureRow,
  CtbcDomesticDepositCaptureResponse,
  CtbcDomesticDepositCaptureEvidence,
  CtbcDomesticDepositAccountNumberEvidence,
  CtbcDomesticDepositValidatedEvidence,
  CtbcDomesticDepositCaptureAdmission,
  CtbcDomesticDepositFinancialAdmissionInput,
  CtbcDomesticDepositFinancialAdmissionResult,
} from "./ctbc-domestic-deposit-admission.ts";
export {
  CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  CTBC_DOMESTIC_DEPOSIT_SOURCE_ROUTE,
  CTBC_DOMESTIC_DEPOSIT_SOURCE_RULE_VERSION,
  CTBC_DOMESTIC_DEPOSIT_SOURCE_RECORD_KIND,
  CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  CTBC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
  CTBC_DOMESTIC_DEPOSIT_FINANCIAL_COMPLETENESS_BASIS,
  CTBC_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  deriveCtbcDomesticDepositAccountNumberEvidence,
  admitCtbcDomesticDepositCaptureEvidence,
  isAdmittedCtbcDomesticDepositCaptureEvidence,
  createCtbcDomesticDepositSourceEvidence,
  CtbcDomesticDepositFinancialAdmissionError,
  admitCtbcDomesticDepositFinancialCapture,
} from "./ctbc-domestic-deposit-admission.ts";
export type {
  CtbcDomesticDepositCaptureRow,
  CtbcDomesticDepositCaptureResponse,
  CtbcDomesticDepositCaptureEvidence,
  CtbcDomesticDepositAccountNumberEvidence,
  CtbcDomesticDepositValidatedEvidence,
  CtbcDomesticDepositCaptureAdmission,
  CtbcDomesticDepositFinancialAdmissionInput,
  CtbcDomesticDepositFinancialAdmissionResult,
} from "./ctbc-domestic-deposit-admission.ts";

export async function commitCtbcDomesticDepositSourceEvidenceBatch(
  store: CanonicalSourceStore,
  inputs: readonly {
    capture: CtbcDomesticDepositValidatedEvidence;
    captureId: string;
  }[],
): Promise<CanonicalSourceCommitResult[]> {
  if (!inputs.length)
    throw new Error("CTBC source evidence batch cannot be empty.");
  const evidences = inputs.map(({ capture, captureId }) =>
    createCtbcDomesticDepositSourceEvidence(capture, captureId),
  );
  const admission = createCanonicalSourceCaptureAdmission(store);
  const receipts = await admission.admitBatch(evidences);
  return receipts.map((receipt, index) =>
    canonicalSourceAdmissionCommitResult(
      receipt,
      evidences[index]!.records.length,
    ),
  );
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
    (db, results) =>
      commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
        db,
        results.map((result) => result.captureId),
      ),
  );
}

export function isCtbcHumanAttestationReady(
  store: CanonicalFinancialDepositWriterStore,
): boolean {
  return isCtbcHumanAttestationDurablyActive(store.db);
}
