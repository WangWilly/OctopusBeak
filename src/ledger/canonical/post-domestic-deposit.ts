import {
  admitPostDomesticDepositFinancialCapture,
  createPostDomesticDepositSourceEvidence,
  PostDomesticDepositFinancialAdmissionError,
  type PostDomesticDepositFinancialAdmissionInput,
  type PostDomesticDepositValidatedEvidence,
} from "./post-domestic-deposit-admission.ts";
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
  ensurePostHumanAttestationEvents,
  isPostHumanAttestationDurablyActive,
  isPostHumanAttestedV1Active,
  latestPostHumanAttestationEvent,
  recordInitialPostHumanAttestationIfMissing,
} from "./post-human-attestation.ts";

export * from "./post-domestic-deposit-admission.ts";

export async function commitPostDomesticDepositSourceEvidence(
  store: CanonicalSourceStore,
  capture: PostDomesticDepositValidatedEvidence,
  captureId: string,
): Promise<CanonicalSourceCommitResult> {
  const evidence = createPostDomesticDepositSourceEvidence(capture, captureId);
  return createCanonicalSourceCaptureAdmission(store)
    .admit(evidence)
    .then((admitted) =>
      canonicalSourceAdmissionCommitResult(admitted, evidence.records.length),
    );
}

export async function commitPostDomesticDepositSourceEvidenceBatch(
  store: CanonicalSourceStore,
  captures: readonly {
    capture: PostDomesticDepositValidatedEvidence;
    captureId: string;
  }[],
): Promise<CanonicalSourceCommitResult[]> {
  if (captures.length === 0)
    throw new Error("Post source evidence batch cannot be empty.");
  const evidences = captures.map(({ capture, captureId }) =>
    createPostDomesticDepositSourceEvidence(capture, captureId),
  );
  const receipts = await createCanonicalSourceCaptureAdmission(store).admitBatch(
    evidences,
  );
  return receipts.map((receipt, index) =>
    canonicalSourceAdmissionCommitResult(
      receipt,
      evidences[index]!.records.length,
    ),
  );
}

export async function commitCanonicalPostDomesticDepositCaptureBatch(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly PostDomesticDepositFinancialAdmissionInput[],
): Promise<CanonicalFinancialDepositCommitResult[]> {
  ensurePostHumanAttestationEvents(store.db);
  let latest: ReturnType<typeof latestPostHumanAttestationEvent>;
  try {
    latest = latestPostHumanAttestationEvent(store.db);
  } catch {
    throw new PostDomesticDepositFinancialAdmissionError(
      "Post human attestation chain is invalid.",
    );
  }
  if (latest?.eventKind === "revoked" || !isPostHumanAttestedV1Active())
    throw new PostDomesticDepositFinancialAdmissionError(
      "Post human attestation is revoked; future admission is blocked.",
    );
  const admissions = inputs.map(admitPostDomesticDepositFinancialCapture);
  const blocked = admissions.flatMap((admission) => admission.diagnostics);
  if (blocked.length > 0 || admissions.some((admission) => !admission.capture))
    throw new PostDomesticDepositFinancialAdmissionError(
      `Post domestic deposit canonical admission blocked: ${[
        ...new Set(blocked),
      ].join(", ")}`,
    );
  recordInitialPostHumanAttestationIfMissing(
    store.db,
    inputs[0]?.capture.observedAt,
  );
  return commitCanonicalFinancialDepositCaptureBatch(
    store,
    admissions.map((admission) => admission.capture!),
    (db, results) =>
      commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
        db,
        results.map((result) => result.captureId),
      ),
  );
}

export function isPostHumanAttestationReady(
  store: CanonicalFinancialDepositWriterStore,
): boolean {
  return isPostHumanAttestationDurablyActive(store.db);
}
