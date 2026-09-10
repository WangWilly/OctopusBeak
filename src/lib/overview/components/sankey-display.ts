import type { ExchangeRateDto } from "../../shared-ledger/types.ts";
import type { OverviewSankeyGraphDto, OverviewSankeyLinkDto } from "../types.ts";
import {
  decimalToExact,
  divideExact,
  exactToNumber,
  multiplyExact,
  type ExactAmount,
} from "../../shared-money/exact.ts";

export function displayOverviewSankeyGraph(
  graph: OverviewSankeyGraphDto,
  targetCurrency: string,
  rates: readonly ExchangeRateDto[],
): OverviewSankeyGraphDto {
  const rateMap = new Map(rates.map((rate) => [rate.currency, rate]));
  return {
    nodes: graph.nodes,
    links: graph.links.map((link) => displayLink(link, targetCurrency, rateMap)),
  };
}

function displayLink(
  link: OverviewSankeyLinkDto,
  targetCurrency: string,
  rates: ReadonlyMap<string, ExchangeRateDto>,
): OverviewSankeyLinkDto {
  const exact = exactValueForTarget(link, targetCurrency, rates);
  if (!exact) return fallbackLink(link, targetCurrency, rates);
  const value = exactToNumber(exact);
  if (!Number.isFinite(value)) return fallbackLink(link, targetCurrency, rates, exact);
  const sourceCurrency = link.currency ?? "TWD";
  const sourceRate = quoteFor(sourceCurrency, rates);
  const targetRate = quoteFor(targetCurrency, rates);
  const converted = sourceCurrency !== targetCurrency && sourceRate && targetRate
    ? {
      fromCurrency: sourceCurrency,
      toCurrency: targetCurrency,
      rateDate: sourceRate.rateDate,
      twdPerUnit: sourceRate.twdPerUnit,
      ...(targetCurrency === "TWD" ? {} : {
        targetRateDate: targetRate.rateDate,
        targetTwdPerUnit: targetRate.twdPerUnit,
      }),
      convertedExact: exact,
    }
    : undefined;
  const { conversion: _sourceConversion, ...linkWithoutConversion } = link;
  return {
    ...linkWithoutConversion,
    value,
    currency: targetCurrency,
    exact,
    ...(converted ? { conversion: converted } : {}),
  };
}

function exactValueForTarget(
  link: OverviewSankeyLinkDto,
  targetCurrency: string,
  rates: ReadonlyMap<string, ExchangeRateDto>,
): ExactAmount | null {
  const sourceCurrency = link.currency;
  if (targetCurrency === "TWD") return link.convertedExact ?? (sourceCurrency === "TWD" ? link.exact ?? null : null);
  if (sourceCurrency === targetCurrency && link.exact) return link.exact;
  const targetRate = quoteExact(targetCurrency, rates);
  if (!targetRate) return null;
  if (link.exact && sourceCurrency) {
    const sourceRate = quoteExact(sourceCurrency, rates);
    if (!sourceRate) return null;
    return divideExact(multiplyExact(link.exact, sourceRate), targetRate);
  }
  if (link.convertedExact) return divideExact(link.convertedExact, targetRate);
  return null;
}

function fallbackLink(
  link: OverviewSankeyLinkDto,
  targetCurrency: string,
  rates: ReadonlyMap<string, ExchangeRateDto>,
  exact?: ExactAmount,
): OverviewSankeyLinkDto {
  const targetRate = quoteFor(targetCurrency, rates)?.twdPerUnit ?? 1;
  const value = targetCurrency === "TWD" ? link.value : link.value / targetRate;
  return {
    ...link,
    value,
    ...(exact ? { currency: targetCurrency, exact } : {}),
  };
}

function quoteFor(currency: string, rates: ReadonlyMap<string, ExchangeRateDto>) {
  return currency === "TWD"
    ? { currency: "TWD", rateDate: "", twdPerUnit: 1 }
    : rates.get(currency);
}

function quoteExact(currency: string, rates: ReadonlyMap<string, ExchangeRateDto>): ExactAmount | null {
  const quote = quoteFor(currency, rates);
  return quote ? decimalToExact(quote.twdPerUnit) : null;
}
