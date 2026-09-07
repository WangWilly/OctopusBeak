import {
  resolveCanonicalInvestmentFundingRelations,
} from "./investment-funding-relations.ts";
import {
  resolveLoanRepaymentRelations,
  type ExplicitLoanTransactionLink,
  type LoanRepaymentRelationResolutionRequest,
  type LoanRepaymentRelationResolutionResult,
} from "./loan-repayment-relations.ts";

export type CanonicalLoanRelationResolver =
  typeof resolveLoanRepaymentRelations;
export type CanonicalInvestmentRelationResolver =
  typeof resolveCanonicalInvestmentFundingRelations;
type InvestmentFundingRelationResolutionResult = Awaited<
  ReturnType<CanonicalInvestmentRelationResolver>
>;

function warnResolutionFailure(failureEvent: string): void {
  // Resolver errors can contain source financial values. Keep the operational
  // event useful without copying provider data into logs.
  console.warn(failureEvent, { code: "relation-resolution-failed" });
}

/**
 * Run loan relation follow-through after the durable capture and any required
 * counterparty evidence commit. Resolution is a separate commit and is
 * deliberately fail-soft so a successful capture remains successful.
 */
export async function runCanonicalLoanRelationFollowThrough(
  store: Parameters<CanonicalLoanRelationResolver>[0],
  resolver: CanonicalLoanRelationResolver,
  input: Readonly<{
    sourceConnectionKey: string;
    integrationNamespace: string;
    observedAt: string;
    failureEvent: string;
    explicitLinks?: readonly ExplicitLoanTransactionLink[];
  }>,
): Promise<LoanRepaymentRelationResolutionResult | null> {
  const request: LoanRepaymentRelationResolutionRequest = {
    sourceConnectionKey: input.sourceConnectionKey,
    integrationNamespace: input.integrationNamespace,
    observedAt: input.observedAt,
    requiredCoverage: { complete: true },
    ...(input.explicitLinks && input.explicitLinks.length > 0
      ? { explicitLinks: input.explicitLinks }
      : {}),
  };
  try {
    return await resolver(store, request);
  } catch {
    warnResolutionFailure(input.failureEvent);
    return null;
  }
}

/**
 * Run investment relation follow-through after the durable investment
 * extension commit. The resolver owns its separate relation-resolution
 * commit, while this boundary keeps resolver failures independent from the
 * successful source capture.
 */
export async function runCanonicalInvestmentRelationFollowThrough(
  store: Parameters<CanonicalInvestmentRelationResolver>[0],
  resolver: CanonicalInvestmentRelationResolver =
    resolveCanonicalInvestmentFundingRelations,
  failureEvent = "canonical-investment-relation-resolution-failed",
): Promise<InvestmentFundingRelationResolutionResult | null> {
  try {
    return await resolver(store);
  } catch {
    warnResolutionFailure(failureEvent);
    return null;
  }
}
