/**
 * Renderer-facing shape of the ADR 0038 Purchase category. The canonical
 * reader in src/ledger/canonical/purchase-category.ts produces it; this module
 * stays free of canonical imports because the canonical core imports
 * purchase-matching.ts.
 */
export type PurchaseCategoryOrigin = "user" | "source" | "derived";
export type PurchaseCategorySubject = "transaction" | "items";
export type PurchaseCategoryLabels = Readonly<{ en: string; zhHant: string }>;

export type PurchaseItemCategorization = Readonly<{
  sequence: number;
  origin: "user" | "derived";
  categoryCode: string;
  taxonomyId: string;
  taxonomyVersion: string;
  assertionId: string;
}>;

export type PurchaseCategoryComponent = Readonly<{
  categoryCode: string;
  labels: PurchaseCategoryLabels | null;
  taxonomyId: string;
  taxonomyVersion: string;
  amount: Readonly<{ coefficient: string; scale: number; currency: string }>;
}>;

export type PurchaseCategory =
  | Readonly<{
      mode: "single";
      origin: PurchaseCategoryOrigin;
      subject: PurchaseCategorySubject;
      categoryCode: string;
      labels: PurchaseCategoryLabels | null;
      taxonomyId: string;
      taxonomyVersion: string;
    }>
  | Readonly<{
      mode: "split";
      origin: PurchaseCategoryOrigin;
      subject: PurchaseCategorySubject;
      components: readonly PurchaseCategoryComponent[];
    }>
  | Readonly<{ mode: "absent" }>;
