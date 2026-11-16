import { isLoanCharge } from "./loan-charge.ts";

/** The stream of a credit-card account. */
export const CREDIT_CARD_ACCOUNT_STREAM = "credit-card" as const;

/** What a card issuer charges: interest, or a fee for the card. */
export const CARD_CHARGE_KINDS: ReadonlySet<string> = new Set(["interest.charged", "fee.card"]);

/** A card's interest or fee, an outflow the issuer's own label names (ADR 0142). */
export function isCardCharge(kind: string | null, direction: string, stream: string | null): boolean {
  return stream === CREDIT_CARD_ACCOUNT_STREAM && direction === "outflow" && kind !== null && CARD_CHARGE_KINDS.has(kind);
}

/**
 * What a lender or card issuer charges, which no invoice names (ADR 0141,
 * ADR 0142). It is never a pairing candidate and cannot be newly paired; a
 * link the person confirmed earlier still stands.
 */
export function isInvoicelessCharge(kind: string | null, direction: string, stream: string | null): boolean {
  return isLoanCharge(kind, direction, stream) || isCardCharge(kind, direction, stream);
}
