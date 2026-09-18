const EXCLUDED_CANONICAL_SPENDING_KIND_PREFIXES = [
  "transfer",
  "cash",
  "investment",
  "payment.credit_card",
  "payment.loan",
] as const;

/**
 * Return whether a known canonical transaction kind may contribute to the
 * gross-posted-outflow Spending view and its recognition commands.
 */
export function isCanonicalSpendingTransactionKindIncluded(kind: string): boolean {
  return !EXCLUDED_CANONICAL_SPENDING_KIND_PREFIXES.some(
    (prefix) => kind === prefix || kind.startsWith(`${prefix}.`),
  );
}
