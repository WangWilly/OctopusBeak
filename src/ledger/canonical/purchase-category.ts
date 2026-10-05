import type { CanonicalSpendingCategorization } from "./canonical-spending-contracts.ts";
import type { ExactMoney } from "./spending-recognition-contracts.ts";
import type {
  PurchaseCategory,
  PurchaseCategoryOrigin,
  PurchaseItemCategorization,
} from "../../lib/spending/purchase-category-view.ts";
import { personalCategoryLabels } from "./transaction-taxonomy.ts";

/**
 * The Purchase category (ADR 0038): a query-time reading of one purchase-basis
 * Spending purchase. It is never stored. The record page and the summary share
 * this one function so both read the same precedence.
 *
 * - Bank-only purchase: the transaction's Current Categorization.
 * - Invoice-only purchase: one code when every non-negative item agrees; an
 *   exact split when every item is complete and categorized, the item amounts
 *   sum to the invoice total, and each code's net is non-negative; otherwise
 *   Unclassified.
 * - Linked purchase: user before automatic, then transaction before items. A
 *   single item code applies to the whole counted bank amount; a split applies
 *   only when the items reconcile exactly to the counted bank amount.
 */

export type {
  PurchaseCategory,
  PurchaseCategoryComponent,
  PurchaseCategoryOrigin,
  PurchaseCategorySubject,
  PurchaseItemCategorization,
} from "../../lib/spending/purchase-category-view.ts";

export type PurchaseCategoryItem = Readonly<{
  sequence: number;
  completeness: "complete" | "incomplete";
  amount: ExactMoney | null;
}>;

export type PurchaseCategoryInput = Readonly<{
  basis: "invoice" | "bank-transaction" | "linked" | "refund";
  /** The amount the purchase contributes to Spending totals. */
  countedAmount: ExactMoney | null;
  transaction: Readonly<{ categorization: CanonicalSpendingCategorization }> | null;
  invoice: Readonly<{ total: ExactMoney | null; items: readonly PurchaseCategoryItem[] }> | null;
  itemCategorizations: readonly PurchaseItemCategorization[];
}>;

export const UNCLASSIFIED_PURCHASE_CATEGORY: PurchaseCategory = Object.freeze({ mode: "absent" });

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

function decimal(value: ExactMoney): Decimal {
  return { coefficient: BigInt(value.coefficient), scale: value.scale };
}

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    scale,
    coefficient: left.coefficient * 10n ** BigInt(scale - left.scale) + right.coefficient * 10n ** BigInt(scale - right.scale),
  };
}

function equal(left: Decimal, right: Decimal): boolean {
  const scale = Math.max(left.scale, right.scale);
  return left.coefficient * 10n ** BigInt(scale - left.scale) === right.coefficient * 10n ** BigInt(scale - right.scale);
}

function reduced(value: Decimal): Readonly<{ coefficient: string; scale: number }> {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}

function transactionCategory(categorization: CanonicalSpendingCategorization): PurchaseCategory {
  if (categorization.mode === "single" && categorization.categoryCode && categorization.origin && categorization.taxonomyId && categorization.taxonomyVersion) {
    return {
      mode: "single",
      origin: categorization.origin,
      subject: "transaction",
      categoryCode: categorization.categoryCode,
      labels: personalCategoryLabels(categorization.categoryCode),
      taxonomyId: categorization.taxonomyId,
      taxonomyVersion: categorization.taxonomyVersion,
    };
  }
  if (categorization.mode === "allocated" && categorization.components && categorization.components.length >= 2) {
    return {
      mode: "split",
      origin: "user",
      subject: "transaction",
      components: categorization.components.map((component) => ({
        categoryCode: component.categoryCode,
        labels: personalCategoryLabels(component.categoryCode),
        taxonomyId: component.taxonomyId,
        taxonomyVersion: component.taxonomyVersion,
        amount: { coefficient: component.coefficient, scale: component.scale, currency: component.currency },
      })),
    };
  }
  return UNCLASSIFIED_PURCHASE_CATEGORY;
}

/**
 * Reads the items of one invoice against `target`, the amount a split must
 * reconcile to: the invoice total for an invoice-only purchase, the counted
 * bank amount for a linked purchase. Negative lines never block a single code.
 */
function itemsCategory(
  items: readonly PurchaseCategoryItem[],
  categorizations: readonly PurchaseItemCategorization[],
  target: ExactMoney | null,
): PurchaseCategory {
  if (items.length === 0) return UNCLASSIFIED_PURCHASE_CATEGORY;
  const bySequence = new Map(categorizations.map((row) => [row.sequence, row]));
  const nonNegative = items.filter((item) => item.amount === null || BigInt(item.amount.coefficient) >= 0n);
  if (nonNegative.length === 0) return UNCLASSIFIED_PURCHASE_CATEGORY;
  const anyUser = (rows: readonly (PurchaseItemCategorization | undefined)[]): PurchaseCategoryOrigin =>
    rows.some((row) => row?.origin === "user") ? "user" : "derived";

  const agreed = nonNegative.map((item) => bySequence.get(item.sequence));
  const codes = new Set(agreed.map((row) => row?.categoryCode));
  if (!codes.has(undefined) && codes.size === 1) {
    const first = agreed[0]!;
    return {
      mode: "single",
      origin: anyUser(agreed),
      subject: "items",
      categoryCode: first.categoryCode,
      labels: personalCategoryLabels(first.categoryCode),
      taxonomyId: first.taxonomyId,
      taxonomyVersion: first.taxonomyVersion,
    };
  }

  if (target === null) return UNCLASSIFIED_PURCHASE_CATEGORY;
  const all = items.map((item) => ({ item, categorization: bySequence.get(item.sequence) }));
  if (all.some(({ item, categorization }) => item.completeness !== "complete" || item.amount === null || categorization === undefined || item.amount.currency !== target.currency))
    return UNCLASSIFIED_PURCHASE_CATEGORY;
  let sum: Decimal = { coefficient: 0n, scale: 0 };
  const byCode = new Map<string, { net: Decimal; categorization: PurchaseItemCategorization }>();
  for (const { item, categorization } of all) {
    const amount = decimal(item.amount!);
    sum = add(sum, amount);
    const entry = byCode.get(categorization!.categoryCode);
    if (entry) entry.net = add(entry.net, amount);
    else byCode.set(categorization!.categoryCode, { net: amount, categorization: categorization! });
  }
  if (!equal(sum, decimal(target))) return UNCLASSIFIED_PURCHASE_CATEGORY;
  if (byCode.size < 2) return UNCLASSIFIED_PURCHASE_CATEGORY;
  if ([...byCode.values()].some((entry) => entry.net.coefficient < 0n)) return UNCLASSIFIED_PURCHASE_CATEGORY;
  return {
    mode: "split",
    origin: anyUser(all.map((entry) => entry.categorization)),
    subject: "items",
    components: [...byCode.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([categoryCode, entry]) => ({
        categoryCode,
        labels: personalCategoryLabels(categoryCode),
        taxonomyId: entry.categorization.taxonomyId,
        taxonomyVersion: entry.categorization.taxonomyVersion,
        amount: { ...reduced(entry.net), currency: target.currency },
      })),
  };
}

export function readPurchaseCategory(input: PurchaseCategoryInput): PurchaseCategory {
  switch (input.basis) {
    case "refund":
      return UNCLASSIFIED_PURCHASE_CATEGORY;
    case "bank-transaction":
      return input.transaction ? transactionCategory(input.transaction.categorization) : UNCLASSIFIED_PURCHASE_CATEGORY;
    case "invoice":
      return input.invoice ? itemsCategory(input.invoice.items, input.itemCategorizations, input.invoice.total) : UNCLASSIFIED_PURCHASE_CATEGORY;
    case "linked": {
      const fromTransaction = input.transaction ? transactionCategory(input.transaction.categorization) : UNCLASSIFIED_PURCHASE_CATEGORY;
      if (fromTransaction.mode !== "absent" && fromTransaction.origin === "user") return fromTransaction;
      const fromItems = input.invoice ? itemsCategory(input.invoice.items, input.itemCategorizations, input.countedAmount) : UNCLASSIFIED_PURCHASE_CATEGORY;
      if (fromItems.mode !== "absent" && fromItems.origin === "user") return fromItems;
      if (fromTransaction.mode !== "absent") return fromTransaction;
      return fromItems;
    }
  }
}

/** The codes a purchase category touches; a split touches each component once. */
export function purchaseCategoryCodes(category: PurchaseCategory): readonly string[] {
  if (category.mode === "single") return [category.categoryCode];
  if (category.mode === "split") return category.components.map((component) => component.categoryCode);
  return [];
}
