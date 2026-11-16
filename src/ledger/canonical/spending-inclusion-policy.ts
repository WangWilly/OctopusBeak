/** Shared, database-independent statement of Spending inclusion semantics. */
export const CANONICAL_SPENDING_INCLUSION_POLICY = Object.freeze({
  id: "gross-posted-outflow",
  version: "v2",
  name: "Gross posted outflow",
  description:
    "Active, normal, posted outflow transactions with supported inclusion semantics, and a loan's interest and fees, which its loan account books as inflows (ADR 0141); totals remain per currency.",
} as const);
