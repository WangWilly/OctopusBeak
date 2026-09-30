import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";

export const YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION =
  "yuanta/foreign-settlement/human-attested-v1" as const;
export const YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION =
  "yuanta/foreign-settlement/linkage-v1" as const;
/** v2 adds the live OverseaTrade MarketNo 52/53/54 source-code mapping. */
export const YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION =
  "yuanta/foreign-settlement/market-v2" as const;
export const YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY = "us-equity" as const;
export type YuantaForeignSettlementMarketCode = "52" | "53" | "54";
export const YUANTA_FOREIGN_SETTLEMENT_MARKET_CODEBOOK: Readonly<
  Record<
    YuantaForeignSettlementMarketCode,
    typeof YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY
  >
> = {
  "52": YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
  "53": YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
  "54": YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
};
export function isYuantaForeignSettlementMarketCode(
  value: unknown,
): value is YuantaForeignSettlementMarketCode {
  return (
    typeof value === "string" &&
    Object.hasOwn(YUANTA_FOREIGN_SETTLEMENT_MARKET_CODEBOOK, value)
  );
}
export const YUANTA_FOREIGN_SETTLEMENT_CALENDAR_CONTRACT_VERSION =
  "yuanta/foreign-settlement/calendar-v1" as const;
export const YUANTA_FOREIGN_SETTLEMENT_CALENDAR_START = "2026-01-01" as const;
export const YUANTA_FOREIGN_SETTLEMENT_CALENDAR_END = "2026-12-31" as const;

/**
 * The fixed bank note pair is the provider's cross-product linkage evidence:
 * it identifies a Yuanta foreign-currency row as a securities settlement,
 * without pretending that the bank and brokerage identity epochs are equal.
 * Keep the derivation versioned so a later provider contract cannot silently
 * reinterpret old relation judgments.
 */
export function deriveYuantaForeignSettlementLinkageKey(
  stableLoginIdentity: string,
  currency: string,
): `sha256:${string}` {
  if (!stableLoginIdentity.trim())
    throw new Error("Yuanta settlement linkage requires a stable login identity.");
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency))
    throw new Error("Yuanta settlement linkage requires an ISO currency code.");
  return deriveSourceConnectionIdentityKey(
    "yuanta-foreign-settlement-linkage",
    [
      YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      stableLoginIdentity,
      normalizedCurrency,
      "複委託扣",
      "複委託入",
      "淨額扣",
      "淨額入",
    ],
  );
}
