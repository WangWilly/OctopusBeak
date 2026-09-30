/** Shared, database-independent statement of Spending inclusion semantics. */
export const CANONICAL_SPENDING_INCLUSION_POLICY = Object.freeze({
  id: "gross-posted-outflow",
  version: "v1",
  name: "Gross posted outflow",
  description:
    "Active, normal, posted outflow transactions with supported inclusion semantics; totals remain per currency.",
} as const);
