import {
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  canonicalLoanCaptureSpines,
  persistCanonicalLoanCaptureExtensions,
  validateCanonicalLoanCaptureForAdmission,
  type LoanValidatedCapture,
} from "./loan-financial.ts";
import {
  canonicalInvestmentAdmissionSpines,
  persistCanonicalInvestmentAdmissionExtensions,
  type InvestmentValidatedCapture,
} from "./investment-financial.ts";

/**
 * The only admission requests accepted by the shared financial boundary.
 * Domain callers submit facts in their own validated contract; they do not
 * assemble generic source spines or pass transaction callbacks.
 */
export type CanonicalFinancialAdmissionRequest =
  | {
      readonly kind: "generic";
      readonly captures: readonly CanonicalFinancialDepositValidatedCapture[];
    }
  | {
      readonly kind: "loan";
      readonly capture: LoanValidatedCapture;
    }
  | {
      readonly kind: "investment";
      readonly captures: readonly InvestmentValidatedCapture[];
    };

type PreparedAdmission = Readonly<{
  captures: readonly CanonicalFinancialDepositValidatedCapture[];
  applyExtensions?: (db: CanonicalFinancialDepositWriterStore["db"]) => void;
}>;

function prepareAdmission(
  request: CanonicalFinancialAdmissionRequest,
): PreparedAdmission {
  if (request === null || typeof request !== "object")
    throw new Error("Financial admission request is invalid.");
  switch (request.kind) {
    case "generic": {
      const captures = [...request.captures];
      return { captures };
    }
    case "loan": {
      const capture = request.capture;
      validateCanonicalLoanCaptureForAdmission(capture);
      return {
        captures: canonicalLoanCaptureSpines(capture),
        applyExtensions: (db) =>
          persistCanonicalLoanCaptureExtensions(db, capture),
      };
    }
    case "investment": {
      const captures = [...request.captures];
      return {
        captures: canonicalInvestmentAdmissionSpines(captures),
        applyExtensions: (db) =>
          persistCanonicalInvestmentAdmissionExtensions(db, captures),
      };
    }
    default:
      throw new Error("Financial admission request kind is unsupported.");
  }
}

/**
 * Own the closed domain dispatch and the single durable capture transaction.
 * The low-level writer remains the transaction authority; this module keeps
 * domain-specific spine ordering and extension persistence behind the closed
 * request variants above.
 */
export async function commitCanonicalFinancialAdmission(
  store: CanonicalFinancialDepositWriterStore,
  request: CanonicalFinancialAdmissionRequest,
): Promise<CanonicalFinancialDepositCommitResult[]> {
  const prepared = prepareAdmission(request);
  if (prepared.captures.length === 0)
    throw new Error("Financial admission request cannot be empty.");
  return commitCanonicalFinancialDepositCaptureBatch(
    store,
    prepared.captures,
    prepared.applyExtensions,
  );
}
