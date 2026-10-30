import { exactToNumber } from "$lib/shared-money/exact-money.ts";
import type { Locale } from "$lib/i18n/i18n.ts";
import { formatMoney } from "$lib/shared-money/money.ts";

export type ExactMoney = Readonly<{ currency: string; coefficient: string; scale: number }>;

export function moneyText(amount: ExactMoney, locale: Locale, signed = false) {
  return formatMoney({
    currency: amount.currency,
    value: exactToNumber(amount),
    exact: { coefficient: amount.coefficient, scale: amount.scale },
  }, { locale, signed });
}
