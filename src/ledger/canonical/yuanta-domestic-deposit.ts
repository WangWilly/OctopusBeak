import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";
import { createHash } from "node:crypto";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCaptureBatch,
  commitCanonicalFinancialDepositCaptureBatchInTransaction,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction,
} from "./bank-transaction-kind-enrichment.ts";
import { combineDomesticDepositDescription } from "./domestic-deposit-store.ts";
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
import { deriveYuantaDomesticDepositAccountKey } from "./yuanta-deposit-account-key.ts";

export { deriveYuantaDomesticDepositAccountKey } from "./yuanta-deposit-account-key.ts";

import {
  admitYuantaDomesticDepositFinancialCapture,
  isAdmittedYuantaDomesticDepositCaptureEvidence,
  isYuantaSourceOnlyFinancialDiagnostic,
  createYuantaDomesticDepositSourceEvidence,
  YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  YuantaDomesticDepositFinancialAdmissionError,
  type YuantaDomesticDepositCaptureEvidence,
  type YuantaDomesticDepositFinancialAdmissionInput,
  type YuantaDomesticDepositFinancialAdmissionResult,
  type YuantaDomesticDepositValidatedEvidence,
  type YuantaDomesticDepositAccountNumberEvidence,
} from "./yuanta-domestic-deposit-admission.ts";
export * from "./yuanta-domestic-deposit-admission.ts";

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
export async function commitYuantaDomesticDepositSourceEvidence(
  store: CanonicalSourceStore,
  capture: YuantaDomesticDepositValidatedEvidence,
  captureId: string,
  sourceIdentity: Readonly<{
    sourceConnectionScope?: string;
    sourceConnectionKey?: string;
  }>,
): Promise<CanonicalSourceCommitResult> {
  const evidence = createYuantaDomesticDepositSourceEvidence(
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

export type YuantaDomesticDepositSourceEvidenceBatchInput = Readonly<{
  capture: YuantaDomesticDepositValidatedEvidence;
  captureId: string;
  sourceIdentity: Readonly<{
    sourceConnectionScope?: string;
    sourceConnectionKey?: string;
  }>;
}>;

/** Commit every source capture from one Yuanta run in one source transaction. */
export async function commitYuantaDomesticDepositSourceEvidenceBatch(
  store: CanonicalSourceStore,
  inputs: readonly YuantaDomesticDepositSourceEvidenceBatchInput[],
): Promise<CanonicalSourceCommitResult[]> {
  if (inputs.length === 0)
    throw new Error("Yuanta source evidence batch cannot be empty.");
  const evidence = inputs.map(({ capture, captureId, sourceIdentity }) =>
    createYuantaDomesticDepositSourceEvidence(capture, captureId, sourceIdentity),
  );
  const receipts = await createCanonicalSourceCaptureAdmission(store).admitBatch(
    evidence,
  );
  return receipts.map((admitted, index) =>
    canonicalSourceAdmissionCommitResult(
      admitted,
      evidence[index]!.records.length,
    ),
  );
}

/** Commit a validated Yuanta capture only through the explicit financial DB. */
export async function commitCanonicalYuantaDomesticDepositCapture(
  store: CanonicalFinancialDepositWriterStore,
  input: YuantaDomesticDepositFinancialAdmissionInput,
): Promise<CanonicalFinancialDepositCommitResult> {
  const [result] = await commitCanonicalYuantaDomesticDepositCaptureBatch(
    store,
    [input],
  );
  return result!;
}

function validateYuantaFinancialAdmissionInputs(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly YuantaDomesticDepositFinancialAdmissionInput[],
): CanonicalFinancialDepositValidatedCapture[] {
  if (inputs.length === 0)
    throw new Error("Yuanta domestic deposit financial batch cannot be empty.");
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
  return inputs.map((input) => {
    const admission = admitYuantaDomesticDepositFinancialCapture(input);
    if (admission.status !== "admitted" || !admission.capture)
      throw new YuantaDomesticDepositFinancialAdmissionError(
        `Yuanta domestic deposit canonical admission blocked: ${admission.diagnostics.join(", ")}`,
      );
    return admission.capture;
  });
}

export function commitCanonicalYuantaDomesticDepositCaptureBatchInTransaction(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly YuantaDomesticDepositFinancialAdmissionInput[],
  capability: Parameters<
    typeof commitCanonicalFinancialDepositCaptureBatchInTransaction
  >[2],
): CanonicalFinancialDepositCommitResult[] {
  const captures = validateYuantaFinancialAdmissionInputs(store, inputs);
  return commitCanonicalFinancialDepositCaptureBatchInTransaction(
    store,
    captures,
    capability,
    (db, results) =>
      {
        recordInitialYuantaHumanAttestationV2IfMissing(
          db,
          inputs[0]!.capture.observedAt,
        );
        commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
          db,
          results.map((result) => result.captureId),
        );
      },
  );
}

export async function commitCanonicalYuantaDomesticDepositCaptureBatch(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly YuantaDomesticDepositFinancialAdmissionInput[],
): Promise<CanonicalFinancialDepositCommitResult[]> {
  const captures = validateYuantaFinancialAdmissionInputs(store, inputs);
  return commitCanonicalFinancialDepositCaptureBatch(
    store,
    captures,
    (db, results) => {
      recordInitialYuantaHumanAttestationV2IfMissing(
        db,
        inputs[0]!.capture.observedAt,
      );
      commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
        db,
        results.map((result) => result.captureId),
      );
    },
  );
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
