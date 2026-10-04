import type { AccountKind, AccountRowDto } from "$lib/shared-ledger/types.ts";

export type AllocationDonutMode = "asset" | "liability";

export type AllocationDonutItem = {
  key: AccountKind;
  label: string;
  value: number;
  percent: number;
  color: string;
  props: { fill: string };
};

export type AllocationDonutData = {
  currency: string;
  total: number;
  items: AllocationDonutItem[];
};

const EPSILON = 0.000001;
const ASSET_KIND_ORDER: AccountKind[] = ["brokerage", "fund", "bank", "foreign", "crypto", "other"];
const LIABILITY_KIND_ORDER: AccountKind[] = ["loan", "credit-card", "crypto", "other"];
const CURRENCY_ORDER = ["TWD", "USD", "JPY"];

const KIND_COLORS: Record<AccountKind, string> = {
  brokerage: "oklch(52% 0.11 250)",
  fund: "oklch(52% 0.09 170)",
  bank: "oklch(56% 0.1 70)",
  foreign: "oklch(53% 0.08 320)",
  crypto: "oklch(49% 0.06 215)",
  other: "oklch(50% 0.05 285)",
  "credit-card": "oklch(50% 0.07 35)",
  loan: "oklch(46% 0.035 250)",
};

export function getAllocationCurrencies(accounts: AccountRowDto[], mode: AllocationDonutMode) {
  return [...new Set(accounts.filter((account) => isAccountInMode(account, mode)).flatMap((account) => account.amountLines.map((amount) => amount.currency)))]
    .sort((left, right) => currencyRank(left) - currencyRank(right) || left.localeCompare(right));
}

export function buildAllocationDonutData(
  accounts: AccountRowDto[],
  mode: AllocationDonutMode,
  currency = getAllocationCurrencies(accounts, mode)[0] ?? "TWD",
): AllocationDonutData {
  const order = mode === "liability" ? LIABILITY_KIND_ORDER : ASSET_KIND_ORDER;
  const accountsInMode = accounts.filter((account) => isAccountInMode(account, mode));
  const totalsByKind = new Map<AccountKind, number>();

  for (const account of accountsInMode) {
    const value = Math.abs(account.amountLines.find((amount) => amount.currency === currency)?.value ?? 0);
    if (value > EPSILON) totalsByKind.set(account.kind, (totalsByKind.get(account.kind) ?? 0) + value);
  }

  const total = [...totalsByKind.values()].reduce((sum, value) => sum + value, 0);
  const items = order
    .map((kind) => ({ kind, value: totalsByKind.get(kind) ?? 0 }))
    .filter((item) => item.value > EPSILON)
    .map(({ kind, value }) => {
      const color = KIND_COLORS[kind];
      return {
        key: kind,
        label: labelForKind(kind),
        value,
        percent: total > EPSILON ? Math.round((value / total) * 1000) / 10 : 0,
        color,
        props: { fill: color },
      };
    });

  return { currency, total, items };
}

function isAccountInMode(account: AccountRowDto, mode: AllocationDonutMode) {
  return mode === "liability" ? account.group === "liability" : account.group !== "liability";
}

function currencyRank(currency: string) {
  const index = CURRENCY_ORDER.indexOf(currency);
  return index === -1 ? CURRENCY_ORDER.length : index;
}

function labelForKind(kind: AccountKind) {
  return kind
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
