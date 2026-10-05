/**
 * Read-time strength of a pending invoice/payment candidate (Spending v2
 * decision 2). Strength is never stored; it is recomputed from the global
 * pending candidate set every time it is shown or acted on.
 */

/**
 * Minimum merchantSimilarity between the invoice seller name and the bank
 * description for a 商家相符 reason and a strong match. The initial value is
 * chosen from fixtures, where a shared merchant token in a two- or
 * three-token description scores 0.5 and unrelated text scores 0. Calibrate it
 * on real data later.
 */
export const MERCHANT_SIMILARITY_STRONG_THRESHOLD = 0.5;

const COMPANY_SUFFIX = /(股份有限公司|有限公司|企業社|分公司|公司|商行)/gu;
const CJK_PAIR = /^[\p{Script=Han}]{2}$/u;

function normalizedMerchant(value: string | null | undefined): string {
  return (value ?? "")
    .toLocaleLowerCase()
    .replace(COMPANY_SUFFIX, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function characterPairs(value: string): string[] {
  const compact = value.replace(/\s+/gu, "");
  return [...compact].slice(0, -1).map((char, index) => char + [...compact][index + 1]);
}

/** Two-character brand prefixes such as 全聯 or 蝦皮 that appear in the other name. */
function sharesLeadingBrand(a: string, b: string): boolean {
  const leading = (value: string) => characterPairs(value)[0] ?? "";
  const lead = (from: string, to: string) => CJK_PAIR.test(leading(from)) && characterPairs(to).includes(leading(from));
  return lead(a, b) || lead(b, a);
}

/**
 * 1 for equal text, 0.75 for containment, 0.6 for a shared Chinese brand
 * prefix, otherwise the larger of the shared-token ratio and the shared
 * character-pair ratio. Company suffixes are ignored.
 */
export function merchantSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizedMerchant(left), b = normalizedMerchant(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.75;
  if (sharesLeadingBrand(a, b)) return 0.6;
  const leftTokens = new Set(a.split(/\s+/u)), rightTokens = new Set(b.split(/\s+/u));
  const sharedTokens = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const leftPairs = new Set(characterPairs(a)), rightPairs = new Set(characterPairs(b));
  const sharedPairs = [...leftPairs].filter((pair) => rightPairs.has(pair)).length;
  return Math.max(
    sharedTokens / Math.max(leftTokens.size, rightTokens.size),
    leftPairs.size && rightPairs.size ? sharedPairs / Math.max(leftPairs.size, rightPairs.size) : 0,
  );
}

export type SpendingCandidateStrength = "strong" | "possible";

/** The reason chips: 金額相同 (always), 同一天 / 相差 N 天, 商家相符. */
export type SpendingCandidateReasons = Readonly<{
  amountEqual: true;
  dayDistance: number;
  merchantMatch: boolean;
}>;

export type SpendingOccurrenceBasis = "purchase-date" | "posting-date-fallback";

/**
 * One member of the global pending candidate set: exact amount and currency,
 * at most seven calendar days apart, neither side linked, and no decision on
 * the pair.
 */
export type PendingCandidateFacts = Readonly<{
  invoiceId: string;
  transactionId: string;
  dayDistance: number;
  invoiceDateBasis: SpendingOccurrenceBasis;
  transactionDateBasis: SpendingOccurrenceBasis;
  sellerName: string | null;
  bankDescription: string | null;
}>;

export type ClassifiedPendingCandidate<T extends PendingCandidateFacts> = T & Readonly<{
  strength: SpendingCandidateStrength;
  reasons: SpendingCandidateReasons;
}>;

function countBy<T>(values: readonly T[], key: (value: T) => string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
}

/**
 * Classify every pair of the complete pending set. A pair is strong when both
 * dates are purchase dates at most one calendar day apart, it is the only
 * pending pair for its invoice and for its payment, and the merchant text
 * passes the threshold. The input must be the whole set, not a page or month.
 */
export function classifyPendingCandidates<T extends PendingCandidateFacts>(
  pending: readonly T[],
): readonly ClassifiedPendingCandidate<T>[] {
  const perInvoice = countBy(pending, (pair) => pair.invoiceId);
  const perTransaction = countBy(pending, (pair) => pair.transactionId);
  return Object.freeze(pending.map((pair) => {
    const merchantMatch = merchantSimilarity(pair.sellerName, pair.bankDescription) >= MERCHANT_SIMILARITY_STRONG_THRESHOLD;
    const strong = pair.invoiceDateBasis === "purchase-date"
      && pair.transactionDateBasis === "purchase-date"
      && pair.dayDistance <= 1
      && perInvoice.get(pair.invoiceId) === 1
      && perTransaction.get(pair.transactionId) === 1
      && merchantMatch;
    return Object.freeze({
      ...pair,
      strength: strong ? "strong" as const : "possible" as const,
      reasons: Object.freeze({ amountEqual: true as const, dayDistance: pair.dayDistance, merchantMatch }),
    });
  }));
}
