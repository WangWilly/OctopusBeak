import type { DatabaseSync } from "node:sqlite";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import {
  commitCanonicalFinancialDepositCaptureBatchInTransaction,
  type CanonicalFinancialDepositCommitResult,
} from "./canonical-financial-deposit-writer.ts";
import {
  withCanonicalSourceCaptureAdmissionTransaction,
  type CanonicalSourceCaptureAdmissionTransactionCapability,
} from "./canonical-source-capture-admission.ts";
import { commitCanonicalCreditCardDirectionEnrichmentForCapturesInTransaction } from "./credit-card-direction-enrichment.ts";
import {
  ensureCanonicalCreditCardSchema,
  persistCanonicalCreditCardExtensions,
} from "./canonical-credit-card-persistence.ts";
import {
  isYuantaCreditCardHumanAttestedV2Active,
  isYuantaCreditCardHumanAttestationV2DurablyActive,
  peekYuantaCreditCardHumanAttestationV2Status,
  recordInitialYuantaCreditCardHumanAttestationV2IfMissing,
} from "./yuanta-credit-card-human-attestation.ts";
import {
  YuantaCreditCardAdmissionError,
  isAdmittedYuantaCreditCardCapture,
  yuantaCanonicalSpineCapture,
  yuantaNeutralCreditCardCapture,
  type YuantaCreditCardValidatedCapture,
} from "./yuanta-credit-card-admission.ts";

export * from "./yuanta-credit-card-admission.ts";

export type YuantaCreditCardWriterStore = Pick<
  CanonicalSourceStore,
  "db" | "commitClock" | "withWriter"
> & {
  readonly beforeYuantaCreditExtensionCommit?: (db: DatabaseSync) => void;
};

export type YuantaCreditCardCommitResult = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  captureId: string;
  accountId: string;
  commitSequence: number;
  transactionCount: number;
  statementCount: number;
  relationCount: number;
  provenanceCount: number;
};

function hasValidatedYuantaCreditCardCapture(
  capture: unknown,
): capture is YuantaCreditCardValidatedCapture {
  return isAdmittedYuantaCreditCardCapture(capture);
}

export async function commitYuantaCreditCardCapture(
  store: YuantaCreditCardWriterStore,
  capture: YuantaCreditCardValidatedCapture,
): Promise<YuantaCreditCardCommitResult> {
  return (await commitYuantaCreditCardCaptureBatch(store, [capture]))[0]!;
}

function toYuantaCreditCardCommitResult(
  store: YuantaCreditCardWriterStore,
  capture: YuantaCreditCardValidatedCapture,
  result: CanonicalFinancialDepositCommitResult,
): YuantaCreditCardCommitResult {
  const row = store.db.prepare(
    `SELECT hex(scope.account_id) AS account_id
     FROM source_captures capture
     JOIN capture_scopes scope ON scope.capture_id = capture.capture_id
     WHERE capture.capture_key = ?`,
  ).get(capture.captureId) as { account_id?: string } | undefined;
  if (!row?.account_id)
    throw new Error("Yuanta shared canonical account is missing after commit.");
  return {
    status: "canonical-live",
    canonicalAdmission: "admitted",
    captureId: capture.captureId,
    accountId: row.account_id.toLowerCase(),
    commitSequence: result.commitSequence,
    transactionCount: result.transactionCount,
    statementCount: capture.statements.length,
    relationCount: capture.relations.length,
    provenanceCount: result.provenanceCount,
  };
}

export function commitYuantaCreditCardCaptureBatchInTransaction(
  store: YuantaCreditCardWriterStore,
  captures: readonly YuantaCreditCardValidatedCapture[],
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): YuantaCreditCardCommitResult[] {
  if (captures.length === 0)
    throw new YuantaCreditCardAdmissionError(
      "Yuanta credit-card capture batch cannot be empty.",
    );
  for (const capture of captures) {
    if (!hasValidatedYuantaCreditCardCapture(capture))
      throw new YuantaCreditCardAdmissionError(
        "Yuanta credit-card batch contains an unvalidated capture.",
      );
  }
    if (
    !isYuantaCreditCardHumanAttestedV2Active() ||
    peekYuantaCreditCardHumanAttestationV2Status(store.db) === "revoked"
  )
    throw new YuantaCreditCardAdmissionError(
      "Yuanta credit-card durable human attestation is revoked.",
    );
  const committed = commitCanonicalFinancialDepositCaptureBatchInTransaction(
    store,
    captures.map(yuantaCanonicalSpineCapture),
    capability,
    (db) => {
      ensureCanonicalCreditCardSchema(db);
      if (!isYuantaCreditCardHumanAttestedV2Active())
        throw new YuantaCreditCardAdmissionError(
          "Yuanta credit-card durable human attestation is revoked.",
        );
      recordInitialYuantaCreditCardHumanAttestationV2IfMissing(db);
      if (!isYuantaCreditCardHumanAttestationV2DurablyActive(db))
        throw new YuantaCreditCardAdmissionError(
          "Yuanta credit-card durable human attestation is revoked.",
        );
      store.beforeYuantaCreditExtensionCommit?.(db);
      persistCanonicalCreditCardExtensions(
        db,
        captures.map(yuantaNeutralCreditCardCapture),
      );
      commitCanonicalCreditCardDirectionEnrichmentForCapturesInTransaction(
        db,
        captures.map((capture) => capture.captureId),
      );
    },
  );
  return committed.map((result, index) =>
    toYuantaCreditCardCommitResult(store, captures[index]!, result),
  );
}

/** Commit one Yuanta capture inside an execution-owned transaction. */
export function commitYuantaCreditCardCaptureInTransaction(
  store: YuantaCreditCardWriterStore,
  capture: YuantaCreditCardValidatedCapture,
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): YuantaCreditCardCommitResult {
  return commitYuantaCreditCardCaptureBatchInTransaction(store, [capture], capability)[0]!;
}

export async function commitYuantaCreditCardCaptureBatch(
  store: YuantaCreditCardWriterStore,
  captures: readonly YuantaCreditCardValidatedCapture[],
): Promise<YuantaCreditCardCommitResult[]> {
  return withCanonicalSourceCaptureAdmissionTransaction(
    store as unknown as CanonicalSourceStore,
    (capability) =>
      commitYuantaCreditCardCaptureBatchInTransaction(store, captures, capability),
  );
}
