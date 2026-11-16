/** Shared, database-independent statement of Spending inclusion semantics. */
export const CANONICAL_SPENDING_INCLUSION_POLICY = Object.freeze({
  id: "gross-posted-outflow",
  version: "v2",
  name: "Gross posted outflow",
  description:
    "Active, normal, posted outflow transactions with supported inclusion semantics, and a loan's interest and fees, which its loan account books as inflows (ADR 0141); totals remain per currency.",
} as const);

/**
 * Kinds Spending never counts: each prefix and every Kind under it. The PGlite
 * SQL eligibility filters are generated from this list.
 */
export const SPENDING_EXCLUDED_KIND_PREFIXES = [
  "transfer",
  "cash",
  "investment",
  "payment.credit_card",
  "payment.loan",
  // A loan's disbursement moves the loan's principal, never spending (ADR 0138).
  "loan",
] as const;

export function isSpendingExcludedKind(kind: string): boolean {
  return SPENDING_EXCLUDED_KIND_PREFIXES.some((prefix) => kind === prefix || kind.startsWith(`${prefix}.`));
}
