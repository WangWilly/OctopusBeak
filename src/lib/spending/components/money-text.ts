import { exactToNumber } from "$lib/shared-money/exact.ts";
import { formatMoney } from "$lib/shared-money/money.ts";

export type ExactMoney = Readonly<{ currency: string; coefficient: string; scale: number }>;

export function moneyText(amount: ExactMoney, locale: string, signed = false) {
  return formatMoney({
    currency: amount.currency,
    value: exactToNumber(amount),
    exact: { coefficient: amount.coefficient, scale: amount.scale },
  }, { locale, signed });
}
