import { translateKnownLabel, type Translation } from "../i18n/i18n.ts";

const breakdownKindKeys = {
  Bank: "bank",
  Fund: "fund",
  Brokerage: "brokerage",
  Crypto: "crypto",
  Foreign: "foreign",
  "Credit card": "creditCard",
  Loan: "loan",
  Other: "other",
} as const satisfies Record<string, keyof Translation["accounts"]>;

type BreakdownKind = (typeof breakdownKindKeys)[keyof typeof breakdownKindKeys];
type BreakdownEntry = { text: string } | { kind: BreakdownKind; count: number };

export function translateSummaryBreakdown(items: string[], dictionary: Translation) {
  const entries: BreakdownEntry[] = [];
  for (const item of items) {
    const kind = (breakdownKindKeys as Partial<Record<string, BreakdownKind>>)[item];
    if (!kind) {
      entries.push({ text: translateCountedAccounts(item, dictionary) });
      continue;
    }
    const counted = entries.find((entry) => "kind" in entry && entry.kind === kind);
    if (counted && "kind" in counted) counted.count += 1;
    else entries.push({ kind, count: 1 });
  }
  return entries.map((entry) =>
    "kind" in entry ? dictionary.common.countLabel(dictionary.accounts[entry.kind], entry.count) : entry.text,
  );
}

function translateCountedAccounts(value: string, dictionary: Translation) {
  const assetMatch = value.match(/^(\d+) asset accounts$/);
  if (assetMatch) return dictionary.common.assetAccountCount(Number(assetMatch[1]));
  const debtMatch = value.match(/^(\d+) debt accounts$/);
  if (debtMatch) return dictionary.common.debtAccountCount(Number(debtMatch[1]));
  return translateKnownLabel(dictionary, value);
}
