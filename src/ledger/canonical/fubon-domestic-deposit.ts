import {
  commitCanonicalFinancialDepositCaptureBatch,
  commitCanonicalFinancialDepositCaptureBatchInTransaction,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction,
} from "./bank-transaction-kind-enrichment.ts";
import {
  canonicalSourceAdmissionCommitResult,
  createCanonicalSourceCaptureAdmission,
} from "./canonical-source-capture-admission.ts";
import type { CanonicalSourceCommitResult } from "./canonical-source-store.ts";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import {
  admitFubonDomesticDepositFinancialCapture,
  createFubonDomesticDepositSourceEvidence,
  FubonDomesticDepositFinancialAdmissionError,
  type FubonDomesticDepositFinancialAdmissionInput,
  type FubonDomesticDepositSourceOnlyEvidence,
  type FubonDomesticDepositValidatedEvidence,
} from "./fubon-domestic-deposit-admission.ts";
import type { CanonicalFinancialDepositValidatedCapture } from "./canonical-financial-deposit-admission.ts";
import {
  ensureFubonHumanAttestationEvents,
  isFubonHumanAttestedV1Active,
  latestFubonHumanAttestationEvent,
  recordFubonHumanAttestationEvent,
  recordInitialFubonHumanAttestationIfMissing,
} from "./fubon-human-attestation.ts";

export * from "./fubon-domestic-deposit-admission.ts";
export {
  isFubonHumanAttestationDurablyActive,
  latestFubonHumanAttestationEvent,
  recordFubonHumanAttestationEvent,
  revokeFubonHumanAttestedV1,
} from "./fubon-human-attestation.ts";

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

export type FubonDomesticDepositSourceEvidenceBatchInput = Readonly<{
  capture:
    | FubonDomesticDepositValidatedEvidence
    | FubonDomesticDepositSourceOnlyEvidence;
  captureId: string;
  sourceIdentity: Readonly<{
    sourceConnectionScope?: string;
    sourceConnectionKey?: string;
  }>;
}>;

/** Commit every source capture from one Fubon run in one source transaction. */
export async function commitFubonDomesticDepositSourceEvidenceBatch(
  store: CanonicalSourceStore,
  inputs: readonly FubonDomesticDepositSourceEvidenceBatchInput[],
): Promise<CanonicalSourceCommitResult[]> {
  if (inputs.length === 0)
    throw new Error("Fubon source evidence batch cannot be empty.");
  const evidence = inputs.map(({ capture, captureId, sourceIdentity }) =>
    createFubonDomesticDepositSourceEvidence(capture, captureId, sourceIdentity),
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

export async function commitCanonicalFubonDomesticDepositCapture(
  store: CanonicalFinancialDepositWriterStore,
  input: FubonDomesticDepositFinancialAdmissionInput,
): Promise<CanonicalFinancialDepositCommitResult> {
  const [result] = await commitCanonicalFubonDomesticDepositCaptureBatch(
    store,
    [input],
  );
  return result!;
}

function validateFubonFinancialAdmissionInputs(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly FubonDomesticDepositFinancialAdmissionInput[],
): CanonicalFinancialDepositValidatedCapture[] {
  if (inputs.length === 0)
    throw new Error("Fubon domestic deposit financial batch cannot be empty.");
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
  return inputs.map((input) => {
    const admission = admitFubonDomesticDepositFinancialCapture(input);
    if (admission.status !== "admitted" || !admission.capture) {
      throw new FubonDomesticDepositFinancialAdmissionError(
        `Fubon domestic deposit canonical admission blocked: ${admission.diagnostics.join(", ")}`,
      );
    }
    return admission.capture;
  });
}

export function commitCanonicalFubonDomesticDepositCaptureBatchInTransaction(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly FubonDomesticDepositFinancialAdmissionInput[],
  capability: Parameters<
    typeof commitCanonicalFinancialDepositCaptureBatchInTransaction
  >[2],
): CanonicalFinancialDepositCommitResult[] {
  const captures = validateFubonFinancialAdmissionInputs(store, inputs);
  return commitCanonicalFinancialDepositCaptureBatchInTransaction(
    store,
    captures,
    capability,
    (db, results) =>
      {
        recordInitialFubonHumanAttestationIfMissing(
          db,
          inputs[0]!.capture.observedAt,
        );
        commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
          db,
          results.map((item) => item.captureId),
        );
      },
  );
}

export async function commitCanonicalFubonDomesticDepositCaptureBatch(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly FubonDomesticDepositFinancialAdmissionInput[],
): Promise<CanonicalFinancialDepositCommitResult[]> {
  const captures = validateFubonFinancialAdmissionInputs(store, inputs);
  return commitCanonicalFinancialDepositCaptureBatch(
    store,
    captures,
    (db, results) => {
      recordInitialFubonHumanAttestationIfMissing(
        db,
        inputs[0]!.capture.observedAt,
      );
      commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
        db,
        results.map((item) => item.captureId),
      );
    },
  );
}
