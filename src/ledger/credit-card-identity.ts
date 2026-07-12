import { hashBytes, stableStringify } from "./content-hash.ts";

export type CreditCardSemanticIdentity = {
  bank?: string | null;
  cardNumber?: string | null;
  statementType?: string | null;
  consumeDate?: string | null;
  description?: string | null;
  foreignCurrency?: string | null;
  foreignAmount?: number | string | null;
  twdAmount?: number | string | null;
  installmentAction?: string | null;
  paymentStatus?: string | null;
  statementPeriod?: string | null;
  sourceRelativePath?: string | null;
  importedAt?: string | null;
};

const text = (value: string | null | undefined) => value?.trim() ?? "";

export function creditCardSemanticKey(input: CreditCardSemanticIdentity): string {
  // ponytail: rows without a bank transaction sequence can collide; include it when the source exposes one.
  const keyMaterial = {
    bank: text(input.bank),
    card: text(input.cardNumber).replace(/\D/g, "").slice(-4),
    statementType: text(input.statementType),
    consumeDate: text(input.consumeDate),
    description: text(input.description),
    foreignCurrency: text(input.foreignCurrency),
    foreignAmount: input.foreignAmount ?? "",
    twdAmount: input.twdAmount ?? "",
    installmentAction: text(input.installmentAction),
    paymentStatus: text(input.paymentStatus),
  };
  return hashBytes(stableStringify(keyMaterial));
}
