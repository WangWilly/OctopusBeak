import { createHash } from "node:crypto";
import type { InvestmentExactAmount } from "../ledger/canonical/investment-financial-admission.ts";
import type { YuantaCanonicalInvestmentRow } from "../ledger/canonical/yuanta-investment-adapters.ts";
import { resolveYuantaFundCatalogName, resolveYuantaFundIdentity, type YuantaFundCatalogEntry } from "./yuanta-fund-catalog.ts";

export type YuantaFundEventDecoder = Readonly<{
  amount: (value: string) => InvestmentExactAmount;
  date: (value: string) => string;
  currency: (value: string) => string;
  cashCurrency?: (value: string) => string;
  allowNameIdentity?: true;
}>;

/** Map confirmed net proceeds and history fields; uncertain cross-currency FX remains closed. */
export function yuantaFundAdditionalEventRows(
  label: string, row: Readonly<Record<string, string>>,
  catalog: readonly YuantaFundCatalogEntry[], scopeKey: string,
  decode: YuantaFundEventDecoder,
): YuantaCanonicalInvestmentRow[] {
  const fingerprint = Object.keys(row).sort().flatMap(key => [key,
    decode.allowNameIdentity && ["基金名稱", "轉出基金", "轉入基金"].includes(key)
      ? resolveYuantaFundIdentity(row[key]!).name : row[key]!]);
  const resolve = (name: string) => decode.allowNameIdentity ? resolveYuantaFundIdentity(name) :
    { ...resolveYuantaFundCatalogName(catalog, name), identityKind: "producer-security-id" as const };
  const record = (name: string, action: YuantaCanonicalInvestmentRow["action"],
    dateField: string, quantity: InvestmentExactAmount, cash: InvestmentExactAmount,
    cashCurrency?: string): YuantaCanonicalInvestmentRow => {
    const security = resolve(name);
    const effectiveOn = decode.date(row[dateField] ?? "");
    const fields = [label, action!, security.fundCode, effectiveOn, ...fingerprint];
    return {
      sourceRecordKey: `sha256:${createHash("sha256").update(JSON.stringify([scopeKey, ...fields])).digest("base64url")}`,
      occurrenceScopeKey: scopeKey, occurrenceFingerprintFields: fields,
      producerSecurityId: security.fundCode, securityName: security.name,
      securityCurrency: security.pricingCurrency,
      ...(security.identityKind === "source-fund-name" ? { securityIdentityKind: "source-fund-name" as const } : {}),
      currency: security.pricingCurrency ?? cashCurrency ?? "XXX", effectiveOn, action, quantity,
      // XXX represents no cash currency for a zero-cash unit distribution.
      cashEffect: { ...cash, currency: cashCurrency ?? security.pricingCurrency ?? "XXX" },
    };
  };
  const zero = { coefficient: "0", scale: 0 };
  switch (label) {
    case "conversion-details": {
      const out = resolve(row["轉出基金"] ?? "");
      const incoming = resolve(row["轉入基金"] ?? "");
      if (out.pricingCurrency && incoming.pricingCurrency && out.pricingCurrency !== incoming.pricingCurrency)
        throw new Error("YuanTa cross-currency conversion requires explicit cash currency and FX evidence.");
      // Confirmed source contract: fees are deducted internally, with no separate
      // bank-account debit. Net redemption proceeds become the new subscription amount.
      const cashSource = row["轉換投資金額"] ?? "";
      const cashCurrency = decode.cashCurrency ? decode.cashCurrency(cashSource) : out.pricingCurrency;
      if (!cashCurrency) throw new Error("YuanTa conversion requires source cash currency.");
      const cash = decode.amount(cashSource);
      return [
        record(row["轉出基金"] ?? "", "sell", "轉出日期", decode.amount(row["轉出單位數"] ?? ""), cash, cashCurrency),
        record(row["轉入基金"] ?? "", "buy", "轉入日期", decode.amount(row["轉入單位數"] ?? ""), cash, cashCurrency),
      ];
    }
    case "cash-dividend-details": {
      const currency = decode.currency(row["計價幣別"] ?? "");
      if (!/^[A-Z]{3}$/u.test(currency)) throw new Error("YuanTa dividend requires source cash currency.");
      return [record(row["基金名稱"] ?? "", "dividend", "入帳日期", zero,
        decode.amount(row["分配金額"] ?? ""), currency)];
    }
    case "unit-dividend-details":
      return [record(row["基金名稱"] ?? "", "corporate_action_in", "分配日期",
        decode.amount(row["分配單位數"] ?? ""), zero)];
    default:
      throw new Error("YuanTa additional event source table is unsupported.");
  }
}
