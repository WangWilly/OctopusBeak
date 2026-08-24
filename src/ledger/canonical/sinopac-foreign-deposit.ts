/**
 * Foreign-currency SinoPac source evidence uses the same structural adapter
 * as domestic deposits, but keeps a distinct product stream, route, and
 * identity epoch so the two provider exports cannot collide.
 */
export {
  SINOPAC_FOREIGN_DEPOSIT_EVIDENCE_VERSION,
  SINOPAC_FOREIGN_DEPOSIT_IDENTITY_EPOCH,
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND,
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION,
  SINOPAC_FOREIGN_STATEMENTS_EVIDENCE_VERSION,
  SINOPAC_FOREIGN_STATEMENTS_IDENTITY_EPOCH,
  SINOPAC_FOREIGN_STATEMENTS_SOURCE_EVIDENCE_RECORD_KIND,
  SINOPAC_FOREIGN_STATEMENTS_SOURCE_EVIDENCE_ROUTE,
  SINOPAC_FOREIGN_STATEMENTS_SOURCE_EVIDENCE_RULE_VERSION,
  createSinopacForeignCurrencySourceEvidence,
} from "./sinopac-domestic-deposit.ts";
export type {
  SinopacStatementCaptureDiagnostic,
  SinopacStatementCaptureEvidence,
  SinopacStatementCaptureValidationResult,
  SinopacStatementDownloadEvidence,
  SinopacStatementValidatedCapture,
  SinopacSourceRow,
} from "./sinopac-domestic-deposit.ts";

import {
  admitSinopacStatementCaptureEvidence,
  isAdmittedSinopacStatementCaptureEvidence,
  type SinopacStatementCaptureEvidence,
  type SinopacStatementCaptureValidationResult,
  type SinopacStatementValidatedCapture,
} from "./sinopac-domestic-deposit.ts";

export function admitSinopacForeignCurrencyCaptureEvidence(
  capture: SinopacStatementCaptureEvidence,
): SinopacStatementCaptureValidationResult {
  if (capture.product !== "foreign-currency") {
    return {
      status: "rejected",
      capture: null,
      diagnostics: ["product-invalid"],
    };
  }
  return admitSinopacStatementCaptureEvidence(capture);
}

export function isAdmittedSinopacForeignCurrencyCaptureEvidence(
  value: unknown,
): value is SinopacStatementValidatedCapture {
  return (
    isAdmittedSinopacStatementCaptureEvidence(value) &&
    value.product === "foreign-currency"
  );
}
