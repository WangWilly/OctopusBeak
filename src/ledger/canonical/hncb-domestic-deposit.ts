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
  commitCanonicalFinancialDepositCaptureBatchInTransaction,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import { commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction } from "./bank-transaction-kind-enrichment.ts";
import {
  admitHncbDomesticDepositFinancialCapture,
  createHncbDomesticDepositBatchSourceEvidence,
  createHncbDomesticDepositSourceEvidence,
  HncbDomesticDepositFinancialAdmissionError,
  type HncbDomesticDepositFinancialAdmissionInput,
  type HncbDomesticDepositValidatedEvidence,
} from "./hncb-domestic-deposit-admission.ts";
import {
  ensureHncbHumanAttestationEvents,
  isHncbHumanAttestedV1Active,
  latestHncbHumanAttestationEvent,
  recordInitialHncbHumanAttestationIfMissing,
} from "./hncb-human-attestation.ts";

export * from "./hncb-domestic-deposit-admission.ts";

export {
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
  getHncbHumanAttestedV1Manifest,
  isHncbHumanAttestedV1Manifest,
  isHncbHumanAttestedV1Active,
  isHncbHumanAttestationDurablyActive,
  latestHncbHumanAttestationEvent,
  recordInitialHncbHumanAttestationIfMissing,
  recordHncbHumanAttestationEvent,
  restoreHncbHumanAttestedV1,
  revokeHncbHumanAttestedV1,
} from "./hncb-human-attestation.ts";

export async function commitHncbDomesticDepositSourceEvidence(
  store: CanonicalSourceStore,
  capture: HncbDomesticDepositValidatedEvidence,
  captureId: string,
): Promise<CanonicalSourceCommitResult> {
  const evidence = createHncbDomesticDepositSourceEvidence(capture, captureId);
  return createCanonicalSourceCaptureAdmission(store)
    .admit(evidence)
    .then((admitted) =>
      canonicalSourceAdmissionCommitResult(admitted, evidence.records.length),
    );
}

export async function commitHncbDomesticDepositSourceEvidenceBatch(
  store: CanonicalSourceStore,
  captures: readonly HncbDomesticDepositValidatedEvidence[],
  captureId: string,
): Promise<CanonicalSourceCommitResult> {
  const evidence = createHncbDomesticDepositBatchSourceEvidence(
    captures,
    captureId,
  );
  return createCanonicalSourceCaptureAdmission(store)
    .admit(evidence)
    .then((admitted) =>
      canonicalSourceAdmissionCommitResult(admitted, evidence.records.length),
    );
}

export async function commitCanonicalHncbDomesticDepositCapture(
  store: CanonicalFinancialDepositWriterStore,
  input: HncbDomesticDepositFinancialAdmissionInput,
): Promise<CanonicalFinancialDepositCommitResult> {
  const [result] = await commitCanonicalHncbDomesticDepositCaptureBatch(
    store,
    [input],
  );
  return result!;
}

function validateHncbFinancialAdmissionInputs(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly HncbDomesticDepositFinancialAdmissionInput[],
) {
  if (inputs.length === 0)
    throw new Error("HNCB domestic deposit financial batch cannot be empty.");
  ensureHncbHumanAttestationEvents(store.db);
  let latest: ReturnType<typeof latestHncbHumanAttestationEvent>;
  try {
    latest = latestHncbHumanAttestationEvent(store.db);
  } catch {
    throw new HncbDomesticDepositFinancialAdmissionError(
      "HNCB human attestation chain is invalid.",
    );
  }
  if (latest?.eventKind === "revoked" || !isHncbHumanAttestedV1Active())
    throw new HncbDomesticDepositFinancialAdmissionError(
      "HNCB human attestation is revoked; future admission is blocked.",
    );
  return inputs.map((input) => {
    const admission = admitHncbDomesticDepositFinancialCapture(input);
    if (admission.status !== "admitted" || !admission.capture)
      throw new HncbDomesticDepositFinancialAdmissionError(
        `HNCB domestic deposit canonical admission blocked: ${admission.diagnostics.join(", ")}`,
      );
    return admission.capture;
  });
}

export function commitCanonicalHncbDomesticDepositCaptureBatchInTransaction(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly HncbDomesticDepositFinancialAdmissionInput[],
  capability: Parameters<
    typeof commitCanonicalFinancialDepositCaptureBatchInTransaction
  >[2],
): CanonicalFinancialDepositCommitResult[] {
  const captures = validateHncbFinancialAdmissionInputs(store, inputs);
  return commitCanonicalFinancialDepositCaptureBatchInTransaction(
    store,
    captures,
    capability,
    (db, results) => {
      recordInitialHncbHumanAttestationIfMissing(
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

export async function commitCanonicalHncbDomesticDepositCaptureBatch(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly HncbDomesticDepositFinancialAdmissionInput[],
): Promise<CanonicalFinancialDepositCommitResult[]> {
  const captures = validateHncbFinancialAdmissionInputs(store, inputs);
  return commitCanonicalFinancialDepositCaptureBatch(
    store,
    captures,
    (db, results) => {
      recordInitialHncbHumanAttestationIfMissing(
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
