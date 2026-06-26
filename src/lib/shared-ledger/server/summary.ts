import type { AccountRowDto, SummaryMetricDto } from "../types.ts";
import { bucketToAmounts, totalsForAccounts } from "./accounts.ts";

export function buildSummaryMetrics(accounts: AccountRowDto[]): SummaryMetricDto[] {
  const totals = totalsForAccounts(accounts);
  const assets = accounts.filter((account) => account.group === "asset" || account.group === "investment");
  const liabilities = accounts.filter((account) => account.group === "liability");
  const bank = assets.filter((account) => account.kind === "bank").length;
  const foreign = assets.filter((account) => account.kind === "foreign").length;
  const fund = assets.filter((account) => account.kind === "fund").length;
  const brokerage = assets.filter((account) => account.kind === "brokerage").length;
  const cards = liabilities.filter((account) => account.kind === "credit-card").length;
  const loans = liabilities.filter((account) => account.kind === "loan").length;
  const other = liabilities.filter((account) => account.kind === "other").length;

  return [
    {
      label: "Net position",
      amounts: bucketToAmounts(totals.net),
      breakdown: [`${assets.length} asset accounts`, `${liabilities.length} debt accounts`],
    },
    {
      label: "Asset value",
      amounts: bucketToAmounts(addBuckets(totals.assets, totals.investments)),
      breakdown: [
        bank ? `Bank ${bank}` : null,
        fund ? `Fund ${fund}` : null,
        brokerage ? `Brokerage ${brokerage}` : null,
        foreign ? `Foreign ${foreign}` : null,
      ].filter(Boolean) as string[],
    },
    {
      label: "Liabilities",
      amounts: bucketToAmounts(totals.liabilities),
      breakdown: [
        cards ? `Credit card ${cards}` : null,
        loans ? `Loan ${loans}` : null,
        other ? `Other ${other}` : null,
      ].filter(Boolean) as string[],
    },
  ];
}

function addBuckets(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const bucket = { ...left };
  for (const [currency, value] of Object.entries(right)) {
    bucket[currency] = (bucket[currency] ?? 0) + value;
  }
  return bucket;
}
