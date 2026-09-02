import {
  resolveLoanRepaymentRelations,
  type ExplicitLoanTransactionLink,
  type LoanRepaymentRelationResolutionResult,
} from "../ledger/canonical/loan-repayment-relations.ts";

export type LoanRelationResolver = typeof resolveLoanRepaymentRelations;

/**
 * Keep relation admission downstream and fail-soft after a financial capture
 * has committed. Provider workflows supply only their namespace, stable
 * Source Connection key, observation time, and any explicit bank linkage.
 */
export async function resolveLoanRelationsAfterCapture(
  store: Parameters<LoanRelationResolver>[0],
  resolver: LoanRelationResolver,
  input: Readonly<{
    sourceConnectionKey: string;
    integrationNamespace: string;
    observedAt: string;
    failureEvent: string;
    explicitLinks?: readonly ExplicitLoanTransactionLink[];
  }>,
): Promise<LoanRepaymentRelationResolutionResult | null> {
  try {
    return await resolver(store, {
      sourceConnectionKey: input.sourceConnectionKey,
      integrationNamespace: input.integrationNamespace,
      observedAt: input.observedAt,
      requiredCoverage: { complete: true },
      ...(input.explicitLinks && input.explicitLinks.length > 0
        ? { explicitLinks: input.explicitLinks }
        : {}),
    });
  } catch (error) {
    console.warn(input.failureEvent, {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
