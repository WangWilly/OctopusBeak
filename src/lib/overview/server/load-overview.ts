import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import type {
  CanonicalOverviewAmount,
  CanonicalOverviewExpectedSource,
} from "../../../ledger/canonical/canonical-overview-query.ts";
import { exactAmountToNumber } from "../../../ledger/canonical/canonical-overview-query.ts";
import type {
  AccountRowDto,
  CurrencyAmountDto,
  SummaryMetricDto,
} from "../../shared-ledger/types.ts";
import type { OverviewPageDto } from "../types.ts";
import { buildCanonicalOverviewSankeyGraph } from "./overview-sankey.ts";
import { createFinancialQuery } from "../../shared-ledger/server/financial-query.ts";
import { mapCanonicalCreditCard } from "../../shared-ledger/server/canonical-product.ts";

export async function loadOverview(
  ledgerDir = DEFAULT_LEDGER_DIR,
  input: { expectedSources?: readonly CanonicalOverviewExpectedSource[] } = {},
): Promise<OverviewPageDto> {
  const query = createFinancialQuery(ledgerDir);
  const current = await query.current({
    kind: "current",
    product: "overview",
    expectedSources: input.expectedSources,
  });
  const projection = current.projection;
  const accounts = projection.accounts.map((account): AccountRowDto => ({
    id: account.id,
    canonicalAccountId: account.id,
    label: account.label,
    institution: account.institution,
    product: account.product,
    group: account.group,
    kind: account.kind,
    typeLabel: account.typeLabel,
    amountLines: account.amounts.map(amountDto),
    marginAmountLines: account.marginAmounts.map(amountDto),
    transactionCount: account.transactionCount,
    assetPositionCount: account.positions.length,
    lastUpdated: account.observedAt ? account.observedAt.slice(0, 10) : null,
    valueAvailability: account.availability,
    ...(account.creditCard
      ? { creditCard: mapCanonicalCreditCard(account.creditCard) }
      : {}),
  }));

  const currencies = [...new Set(
    projection.positions
      .map((position) => position.currency)
      .filter((currency) => currency !== "TWD"),
  )];
  const sankeyExchangeRates = currencies.length === 0
    ? []
    : (await query.current({
      kind: "current",
      product: "overview",
      selection: "latest",
      currencies,
    })).exchangeRates;
  const sankeyRates = new Map(
    sankeyExchangeRates.map((rate) => [rate.currency, rate]),
  );

  return {
    availability: projection.availability,
    coverage: projection.availability === "unavailable"
      ? "unavailable"
      : projection.sourceGaps.length > 0 || projection.availability !== "available"
        ? "partial"
        : "complete",
    historyAvailability: "unavailable",
    sourceGaps: projection.sourceGaps.map((gap) => ({ ...gap })),
    importedAt: projection.importedAt,
    summary: buildCanonicalSummary(accounts),
    dailyHistory: [],
    accounts,
    sankey: buildCanonicalOverviewSankeyGraph(projection.positions, sankeyRates),
    sankeyExchangeRates,
    sankeyLatestExchangeRateDate: latestRateDate(sankeyExchangeRates),
    exchangeRates: [],
    latestExchangeRateDate: null,
  };
}

function amountDto(amount: CanonicalOverviewAmount): CurrencyAmountDto {
  return {
    currency: amount.currency,
    value: exactAmountToNumber(amount.exact),
    exact: { ...amount.exact },
    traces: amount.traces.map((trace) => ({ ...trace })),
  };
}

function buildCanonicalSummary(accounts: readonly AccountRowDto[]): SummaryMetricDto[] {
  const assets = accounts.filter((account) => account.group === "asset" || account.group === "investment");
  const assetAccounts = accounts.filter((account) => account.group === "asset");
  const liabilities = accounts.filter((account) => account.group === "liability");
  const totals = {
    assets: aggregateAmounts(assetAccounts),
    investments: aggregateAmounts(accounts.filter((account) => account.group === "investment")),
    liabilities: aggregateAmounts(liabilities),
  };
  for (const account of accounts)
    addAggregateMap(totals.liabilities, aggregateAmountsFromLines(account.marginAmountLines ?? []), 1);
  const net = new Map<string, AggregateAmount>();
  addAggregateMap(net, totals.assets, 1);
  addAggregateMap(net, totals.investments, 1);
  addAggregateMap(net, totals.liabilities, -1);
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
      amounts: amountLines(net),
      breakdown: [`${assets.length} asset accounts`, `${liabilities.length} debt accounts`],
    },
    {
      label: "Asset value",
      amounts: amountLines(addAggregateMaps(totals.assets, totals.investments)),
      breakdown: [
        bank ? `Bank ${bank}` : null,
        fund ? `Fund ${fund}` : null,
        brokerage ? `Brokerage ${brokerage}` : null,
        foreign ? `Foreign ${foreign}` : null,
      ].filter(Boolean) as string[],
    },
    {
      label: "Liabilities",
      amounts: amountLines(totals.liabilities),
      breakdown: [
        cards ? `Credit card ${cards}` : null,
        loans ? `Loan ${loans}` : null,
        other ? `Other ${other}` : null,
      ].filter(Boolean) as string[],
    },
  ];
}

type AggregateAmount = {
  exact: { coefficient: string; scale: number };
  traces: NonNullable<CurrencyAmountDto["traces"]>[number][];
};

function aggregateAmounts(accounts: readonly AccountRowDto[]): Map<string, AggregateAmount> {
  const result = new Map<string, AggregateAmount>();
  for (const account of accounts)
    for (const amount of account.amountLines) {
      if (!amount.exact) continue;
      const current = result.get(amount.currency);
      if (!current) {
        result.set(amount.currency, {
          exact: amount.exact!,
          traces: [...(amount.traces ?? [])],
        });
      } else {
        current.exact = addExact(current.exact, amount.exact!);
        current.traces.push(...(amount.traces ?? []));
      }
    }
  return result;
}

function aggregateAmountsFromLines(lines: readonly CurrencyAmountDto[]): Map<string, AggregateAmount> {
  const result = new Map<string, AggregateAmount>();
  for (const amount of lines) {
    const current = result.get(amount.currency);
    if (!amount.exact) continue;
    if (!current) result.set(amount.currency, { exact: amount.exact, traces: [...(amount.traces ?? [])] });
    else {
      current.exact = addExact(current.exact, amount.exact);
      current.traces.push(...(amount.traces ?? []));
    }
  }
  return result;
}

function addAggregateMap(
  target: Map<string, AggregateAmount>,
  source: Map<string, AggregateAmount>,
  sign: 1 | -1,
): void {
  for (const [currency, amount] of source) {
    const signed = sign === 1
      ? amount.exact
      : { coefficient: (-BigInt(amount.exact.coefficient)).toString(), scale: amount.exact.scale };
    const current = target.get(currency);
    if (!current) {
      target.set(currency, { exact: normalize(signed), traces: [...amount.traces] });
    } else {
      current.exact = addExact(current.exact, signed);
      current.traces.push(...amount.traces);
    }
  }
}

function addAggregateMaps(left: Map<string, AggregateAmount>, right: Map<string, AggregateAmount>) {
  const result = new Map<string, AggregateAmount>();
  addAggregateMap(result, left, 1);
  addAggregateMap(result, right, 1);
  return result;
}

function amountLines(amounts: Map<string, AggregateAmount>): CurrencyAmountDto[] {
  return [...amounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({
      currency,
      value: exactAmountToNumber(amount.exact),
      exact: amount.exact,
      traces: amount.traces,
    }));
}

function normalize(value: { coefficient: string; scale: number }) {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  if (coefficient === 0n) return { coefficient: "0", scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}

function addExact(left: { coefficient: string; scale: number }, right: { coefficient: string; scale: number }) {
  const scale = Math.max(left.scale, right.scale);
  const coefficient = BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale) + BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale);
  return normalize({ coefficient: coefficient.toString(), scale });
}

function latestRateDate(rates: readonly { rateDate: string }[]): string | null {
  return rates.reduce<string | null>((latest, rate) => !latest || rate.rateDate > latest ? rate.rateDate : latest, null);
}
