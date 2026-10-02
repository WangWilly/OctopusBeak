import type { InvestmentExactAmount } from "./investment-financial-admission.ts";

function validate(value: InvestmentExactAmount): void {
  if (!/^\d+$/u.test(value.coefficient) || !Number.isSafeInteger(value.scale) ||
    value.scale < 0 || value.scale > 1000) {
    throw new Error("Investment aggregation requires a bounded exact non-negative amount.");
  }
}

export function sumInvestmentExactAmounts(values: readonly InvestmentExactAmount[]): InvestmentExactAmount {
  if (!values.length) throw new Error("Investment aggregation requires source amounts.");
  values.forEach(validate);
  const scale = Math.max(...values.map(value => value.scale));
  const coefficient = values.reduce((sum, value) =>
    sum + BigInt(value.coefficient) * 10n ** BigInt(scale - value.scale), 0n);
  return { coefficient: coefficient.toString(), scale };
}

export function investmentExactAmountsEqual(a: InvestmentExactAmount, b: InvestmentExactAmount): boolean {
  validate(a); validate(b);
  return BigInt(a.coefficient) * 10n ** BigInt(b.scale) ===
    BigInt(b.coefficient) * 10n ** BigInt(a.scale);
}
