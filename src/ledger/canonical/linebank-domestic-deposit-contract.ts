import type { LineBankHumanAttestedV13Capture } from "./linebank-domestic-deposit.ts";
import type { DomesticDepositSourceTime } from "./domestic-deposit-contract.ts";

export type { DomesticDepositSourceTime };

const LINEBANK_FINANCIAL_VALIDATED_CAPTURE = Symbol(
  "linebank-human-attested-v13-runtime-validated-capture",
);

export type LineBankHumanAttestedV13ValidatedCapture =
  LineBankHumanAttestedV13Capture & {
    readonly __runtimeValidatedLineBankFinancialCapture: "human-attested-v13";
  };

/**
 * Brand the validated capture and freeze its nested evidence before a caller
 * can pass it across the old writer boundary. This module has no persistence
 * dependency and is shared by the PGlite admission path.
 */
export function admitLineBankHumanAttestedV13Capture(
  capture: LineBankHumanAttestedV13Capture,
): LineBankHumanAttestedV13ValidatedCapture {
  Object.defineProperty(capture, LINEBANK_FINANCIAL_VALIDATED_CAPTURE, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  for (const page of capture.pages) Object.freeze(page);
  for (const record of capture.records) {
    Object.freeze(record.sourceTime);
    Object.freeze(record.amount);
    if (record.balanceAfter) Object.freeze(record.balanceAfter);
    Object.freeze(record.cancellationFlags);
    Object.freeze(record);
  }
  Object.freeze(capture.pages);
  Object.freeze(capture.records);
  Object.freeze(capture.scope);
  Object.freeze(capture.authority);
  Object.freeze(capture.humanAttestation.directionCodes);
  Object.freeze(capture.humanAttestation);
  Object.freeze(capture.sourceScopeEvidence);
  Object.freeze(capture.financialAdmissionBlockers);
  Object.freeze(capture);
  return capture as LineBankHumanAttestedV13ValidatedCapture;
}

export function isLineBankHumanAttestedV13CaptureValidated(
  capture: unknown,
): capture is LineBankHumanAttestedV13ValidatedCapture {
  return (
    capture !== null &&
    typeof capture === "object" &&
    (
      capture as LineBankHumanAttestedV13Capture & {
        [LINEBANK_FINANCIAL_VALIDATED_CAPTURE]?: true;
      }
    )[LINEBANK_FINANCIAL_VALIDATED_CAPTURE] === true
  );
}
