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

/**
 * Cathay's own passbook labels. A description is one whole label, so each
 * matches exactly, never as a substring: 跨行提款 and 跨行費用 are a
 * withdrawal and a fee, not the transfer their 跨行 prefix suggests. A label
 * with a direction names that direction only; on the other it is unsupported.
 * 網銀轉帳 alone does not say whose account the money went to, so it is a
 * plain transfer.
 */
const LEDGER_LABELS: ReadonlyMap<string, Readonly<{ value: string; direction?: "inflow" | "outflow" }>> = new Map([
  ["自行提款", { value: "cash.withdrawal", direction: "outflow" }],
  ["跨行提款", { value: "cash.withdrawal", direction: "outflow" }],
  ["無卡提款", { value: "cash.withdrawal", direction: "outflow" }],
  ["ATM存", { value: "cash.deposit", direction: "inflow" }],
  ["網銀轉帳", { value: "transfer" }],
  ["跨行轉入", { value: "transfer.external", direction: "inflow" }],
  ["存款息", { value: "interest.earned", direction: "inflow" }],
  ["跨行費用", { value: "fee.bank", direction: "outflow" }],
]);
const LEDGER_LABEL_CONFIDENCE_BASIS_POINTS = 9_500;

export function classifyCathayDescription(
  description: string | null | undefined,
  direction: "inflow" | "outflow",
): CathayDescriptionClassification {
  if (!description || description.trim() === "") return { candidates: [], tie: false };
  const label = LEDGER_LABELS.get(description.normalize("NFKC").replace(/\s+/gu, ""));
  if (label && (label.direction === undefined || label.direction === direction))
    return { candidates: [{ value: label.value, confidenceBasisPoints: LEDGER_LABEL_CONFIDENCE_BASIS_POINTS }], tie: false };
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
