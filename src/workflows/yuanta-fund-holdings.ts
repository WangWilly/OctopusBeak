import { createHash } from "node:crypto";
import { sumInvestmentExactAmounts } from "../ledger/canonical/investment-exact-amount.ts";
import type { YuantaCanonicalInvestmentRow } from "../ledger/canonical/yuanta-investment-adapters.ts";
import { yuantaFundCatalogName } from "./yuanta-fund-catalog.ts";

/** Combine lots only when they describe the same security at the same source basis. */
export function aggregateYuantaFundHoldingLots(rows: readonly YuantaCanonicalInvestmentRow[]): YuantaCanonicalInvestmentRow[] {
  const groups = new Map<string, YuantaCanonicalInvestmentRow[]>();
  for (const row of rows) {
    const group = groups.get(row.producerSecurityId) ?? [];
    group.push(row);
    groups.set(row.producerSecurityId, group);
  }
  return [...groups.values()].map(group => {
    if (group.length === 1) return group[0]!;
    const lots = [...group].sort((a, b) => a.sourceRecordKey.localeCompare(b.sourceRecordKey));
    const first = lots[0]!;
    const keys = new Set<string>();
    for (const lot of lots) {
      if (!lot.quantity || !lot.valuation || !lot.effectiveTimeEvidence || lot.holdingSourceLots ||
        keys.has(lot.sourceRecordKey) || lot.currency !== first.currency || lot.securityCurrency !== first.securityCurrency ||
        lot.valuation.currency !== first.valuation?.currency || lot.effectiveOn !== first.effectiveOn ||
        yuantaFundCatalogName(lot.securityName ?? "") !== yuantaFundCatalogName(first.securityName ?? "") ||
        JSON.stringify(lot.effectiveTimeEvidence) !== JSON.stringify(first.effectiveTimeEvidence)) {
        throw new Error("YuanTa fund holding lots require consistent source valuation evidence.");
      }
      keys.add(lot.sourceRecordKey);
    }
    const sourceRecordKey = `sha256:${createHash("sha256").update(JSON.stringify([
      "yuanta-fund-holding-lot-group-v1", first.producerSecurityId, first.currency,
      first.effectiveOn, lots.map(lot => lot.sourceRecordKey),
    ])).digest("base64url")}`;
    return {
      ...first,
      sourceRecordKey,
      quantity: sumInvestmentExactAmounts(lots.map(lot => lot.quantity!)),
      valuation: { ...sumInvestmentExactAmounts(lots.map(lot => lot.valuation!)), currency: first.valuation!.currency },
      holdingSourceLots: lots,
    };
  });
}
