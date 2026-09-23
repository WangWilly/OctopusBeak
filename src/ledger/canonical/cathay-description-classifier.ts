/**
 * Pure Cathay domestic-deposit description classifier.
 *
 * Keep this module free of persistence imports so worker-owned projections can
 * apply the same provider contract as the canonical enrichment writer.
 */
export type CathayDescriptionClassification = Readonly<{
  candidates: readonly Readonly<{
    value: string;
    confidenceBasisPoints: number;
  }>[];
  tie: boolean;
}>;

export function classifyCathayDescription(
  description: string | null | undefined,
): CathayDescriptionClassification {
  if (!description || description.trim() === "") return { candidates: [], tie: false };
  const text = description.toLowerCase();
  const candidates: Array<{ value: string; confidenceBasisPoints: number }> = [];
  if (/\bdeposit\b/u.test(text))
    candidates.push({ value: "cash.deposit", confidenceBasisPoints: 9_200 });
  if (/\btransfer\b/u.test(text))
    candidates.push({ value: "transfer.internal", confidenceBasisPoints: 8_600 });
  if (/\bcredit(?:\s+card)?\b/u.test(text))
    candidates.push({ value: "payment.credit_card", confidenceBasisPoints: 8_200 });
  if (candidates.length === 0) return { candidates, tie: false };
  const highest = Math.max(...candidates.map((candidate) => candidate.confidenceBasisPoints));
  return {
    candidates,
    tie: candidates.filter((candidate) => candidate.confidenceBasisPoints === highest).length > 1,
  };
}
