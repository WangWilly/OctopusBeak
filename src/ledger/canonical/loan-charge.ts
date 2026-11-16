/** The stream of a loan account. */
export const LOAN_ACCOUNT_STREAM = "loan" as const;

/** What a loan charges, which the loan account books as an inflow. */
export const LOAN_CHARGE_KINDS: ReadonlySet<string> = new Set(["interest.charged", "fee.loan"]);

/**
 * A loan's interest or fee on its loan account (ADR 0138, ADR 0141). The
 * account books it as an inflow, yet it is money the person spends, so Cash
 * flow counts it once as an outflow and Spending as a purchase. Principal and
 * disbursement are not charges.
 */
export function isLoanCharge(kind: string | null, direction: string, stream: string | null): boolean {
  return stream === LOAN_ACCOUNT_STREAM && direction === "inflow" && kind !== null && LOAN_CHARGE_KINDS.has(kind);
}
