import {
  sourceEvidenceFromCapture,
  type CurrentDepositBalanceValidatedCapture,
} from "./current-deposit-admission.ts";
import type { PGliteCanonicalBalanceCaptureRequest } from "./balance.ts";

/** Adapt the already validated provider snapshot to a data-only child command. */
export function currentDepositBalanceCommandRequest(
  capture: CurrentDepositBalanceValidatedCapture,
): PGliteCanonicalBalanceCaptureRequest {
  const currency = capture.observations[0]?.currency ?? null;
  if (!currency || (capture.identity.stream === "domestic-deposit"
    && capture.observations.some((observation) => observation.currency !== currency)))
    throw new Error("Current deposit balance capture must contain one account currency.");
  return {
    capture: sourceEvidenceFromCapture(capture),
    account: {
      sourceAccountKey: capture.identity.sourceAccountKey,
      accountType: "depository",
      currency: capture.identity.stream === "foreign-currency-deposit" ? null : currency,
    },
    observations: capture.observations.map((observation) => ({
      observationKey: observation.observationKey,
      balanceKind: observation.balanceKind,
      balance: observation.balance,
      currency: observation.currency,
      effectiveAt: observation.time.effectiveAt,
      effectiveTimeBasis: observation.time.effectiveTimeBasis,
      effectiveTimeRuleVersion: observation.time.effectiveTimeRuleVersion,
      evidenceSourceRecordKey: observation.sourceRecordKey,
      evidenceSourceField: observation.time.sourceField,
      evidenceSourceValue: observation.time.sourceValue,
      evidenceContractVersion: observation.time.contractVersion,
      sourceOccurrenceKey: observation.sourceRecordKey,
      evidenceEndpoint: capture.providerResponse.endpoint,
      evidenceResponseStatus: capture.providerResponse.status,
      evidenceCachePolicy: capture.providerResponse.cacheControl ?? "provider-contract",
    })),
  };
}
