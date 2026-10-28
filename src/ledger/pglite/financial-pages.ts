import type { AssetsPageDto } from "../../lib/assets/types.ts";
import type { LiabilitiesPageDto } from "../../lib/liabilities/types.ts";
import type { OverviewHoldingPriceDto, OverviewPageDto } from "../../lib/overview/types.ts";
import { isProductAccount, mapCanonicalCreditCard, mapCanonicalProduct } from "../../lib/shared-ledger/server/canonical-product.ts";
import { currentNetPosition, valuationDateFor } from "../../lib/shared-ledger/twd-valuation.ts";
import type { AccountRowDto, CurrencyAmountDto, NetPositionDto, OverviewSummaryDto } from "../../lib/shared-ledger/types.ts";
import { indexExchangeRates } from "../../lib/shared-money/exchange-rates.ts";
import type {
  CanonicalOverviewAmount,
  CanonicalOverviewCurrentQueryResult,
  CanonicalOverviewExpectedSource,
} from "../canonical/canonical-overview-query.ts";
import type { ExchangeRateRecord } from "../exchange-rates.ts";
import { readPGliteDailyHistoryWithAccounts, type PGliteDailyHistory } from "./daily-history.ts";
import { readExchangeRateRows } from "./exchange-rate-rows.ts";
import { readPGliteHoldingPrices, type PGliteHoldingPrice } from "./holding-prices.ts";
import { exactAmountToNumber } from "./overview-amount.ts";
import {
  createPGliteCanonicalOverviewQuery,
  selectPGliteOverviewAssets,
  selectPGliteOverviewLiabilities,
} from "./overview.ts";
import {
  readPreviewCreditAccounts,
  readPreviewCreditBalanceHistory,
  readPreviewPurchases,
  readPreviewStatements,
} from "./preview-credit.ts";
import {
  readPreviewAccounts,
  readPreviewBalanceHistory,
  readPreviewTransactions,
  type PreviewVisibility,
} from "./preview-financial-data.ts";
import {
  countableWithRates,
  previewAccountRow,
  previewBalanceSeries,
  previewCreditAccountRow,
  previewCreditSeries,
  previewSummaryMarkers,
  withPreviewHistory,
  type PreviewBalanceSeries,
} from "./preview-overview.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * The Overview, Assets and Liabilities pages, each composed from one read
 * snapshot. The caller supplies the reader, so it owns the transaction.
 */

type PGliteReader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

export type FinancialPageScope = Readonly<{
  expectedSources: readonly CanonicalOverviewExpectedSource[];
  previewVisibility: PreviewVisibility;
}>;

type Trace = NonNullable<CurrencyAmountDto["traces"]>[number];
type AggregatedAmount = { exact: { coefficient: string; scale: number }; traces: Trace[] };

function exactAmountToDto(amount: CanonicalOverviewAmount): CurrencyAmountDto {
  return {
    currency: amount.currency,
    value: exactAmountToNumber(amount.exact),
    exact: { ...amount.exact },
    traces: amount.traces.map((trace) => ({ ...trace })),
  };
}

/** Keeps the operands' scale: summary amounts show the decimals their sources reported. */
function addExactAmounts(
  left: AggregatedAmount["exact"],
  right: AggregatedAmount["exact"],
): AggregatedAmount["exact"] {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient: (
      BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale)
      + BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale)
    ).toString(),
    scale,
  };
}

function accumulateAmount(
  target: Map<string, AggregatedAmount>,
  currency: string,
  exact: AggregatedAmount["exact"],
  traces: readonly Trace[],
): void {
  const current = target.get(currency);
  if (!current) target.set(currency, { exact: { ...exact }, traces: [...traces] });
  else {
    current.exact = addExactAmounts(current.exact, exact);
    current.traces.push(...traces);
  }
}

function aggregateAmounts(accounts: readonly AccountRowDto[]): Map<string, AggregatedAmount> {
  const result = new Map<string, AggregatedAmount>();
  for (const account of accounts) {
    for (const amount of account.amountLines) {
      if (!amount.exact) continue;
      accumulateAmount(result, amount.currency, amount.exact, amount.traces ?? []);
    }
  }
  return result;
}

function amountLines(amounts: Map<string, AggregatedAmount>): CurrencyAmountDto[] {
  return [...amounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, value]) => ({
    currency,
    value: exactAmountToNumber(value.exact),
    exact: value.exact,
    traces: value.traces,
  }));
}

function addSigned(
  target: Map<string, AggregatedAmount>,
  source: Map<string, AggregatedAmount>,
  sign: 1 | -1,
): void {
  for (const [currency, value] of source) {
    const signed = sign === 1
      ? value.exact
      : { coefficient: (-BigInt(value.exact.coefficient)).toString(), scale: value.exact.scale };
    accumulateAmount(target, currency, signed, value.traces);
  }
}

/**
 * Without history, the renderer valued accounts at today's date; a date past
 * every stored rate picks the same latest rates without a clock.
 */
const LATEST_RATES = "9999-12-31";

function netPosition(
  accounts: readonly AccountRowDto[],
  net: Map<string, AggregatedAmount>,
  history: PGliteDailyHistory,
  rates: readonly ExchangeRateRecord[],
  markers: ReturnType<typeof previewSummaryMarkers>["net"],
): NetPositionDto {
  const valuationDate = valuationDateFor(history.dailyHistory, accounts, LATEST_RATES);
  const current = currentNetPosition(accounts, indexExchangeRates(rates), valuationDate);
  const incomplete = markers.incomplete === true;
  return current.value === null
    ? { display: "native", amounts: amountLines(net), includesPreview: markers.includesPreview === true, incomplete }
    : {
      display: "converted",
      twd: current.value,
      unconvertedPreviewCurrencies: current.unconvertedPreviewCurrencies,
      includesPreview: current.includesPreview,
      incomplete,
    };
}

function overviewSummary(
  accounts: readonly AccountRowDto[],
  history: PGliteDailyHistory,
  rates: readonly ExchangeRateRecord[],
): OverviewSummaryDto {
  const liabilities = accounts.filter((account) => account.group === "liability");
  const assetTotals = aggregateAmounts(accounts.filter((account) => account.group === "asset"));
  const investmentTotals = aggregateAmounts(accounts.filter((account) => account.group === "investment"));
  const liabilityTotals = aggregateAmounts(liabilities);
  const net = new Map<string, AggregatedAmount>();
  addSigned(net, assetTotals, 1);
  addSigned(net, investmentTotals, 1);
  addSigned(net, liabilityTotals, -1);
  const assetValue = new Map<string, AggregatedAmount>();
  addSigned(assetValue, assetTotals, 1);
  addSigned(assetValue, investmentTotals, 1);
  const preview = previewSummaryMarkers(accounts);
  return {
    net: netPosition(accounts, net, history, rates, preview.net),
    assets: { amounts: amountLines(assetValue), ...preview.assets },
    liabilities: { amounts: amountLines(liabilityTotals), ...preview.liabilities },
  };
}

function mapOverview(
  result: CanonicalOverviewCurrentQueryResult,
  rates: readonly ExchangeRateRecord[],
  history: PGliteDailyHistory,
  prices: readonly PGliteHoldingPrice[],
  previewAccounts: readonly AccountRowDto[],
): OverviewPageDto {
  const projection = result.projection;
  const canonicalAccounts: AccountRowDto[] = projection.accounts.map((account) => ({
    id: account.id,
    canonicalAccountId: account.id,
    label: account.label,
    institution: account.institution,
    institutionKey: account.institutionKey,
    ...(account.viaSource ? { viaSource: account.viaSource } : {}),
    product: account.product,
    group: account.group,
    kind: account.kind,
    typeLabel: account.typeLabel,
    amountLines: account.amounts.map(exactAmountToDto),
    marginAmountLines: account.marginAmounts.map(exactAmountToDto),
    transactionCount: account.transactionCount,
    assetPositionCount: account.positions.length,
    lastUpdated: account.observedAt ? account.observedAt.slice(0, 10) : null,
    valueAvailability: account.availability,
    ...(account.creditCard ? { creditCard: mapCanonicalCreditCard(account.creditCard) } : {}),
  }));
  const accounts = [...canonicalAccounts, ...previewAccounts];
  return {
    availability: projection.availability,
    coverage: projection.availability === "unavailable" ? "unavailable" : projection.sourceGaps.length > 0 || projection.availability !== "available" ? "partial" : "complete",
    historyAvailability: history.dailyHistory.length > 0 ? "available" : "unavailable",
    sourceGaps: projection.sourceGaps.map((gap) => ({ ...gap })),
    importedAt: projection.importedAt,
    summary: overviewSummary(accounts, history, rates),
    dailyHistory: history.dailyHistory.map((row) => ({ ...row })),
    dailyHistoryByAccount: history.dailyHistoryByAccount,
    accounts,
    holdingPrices: holdingPricesForPositions(projection.positions, prices),
    exchangeRates: rates.map(({ rateDate, currency, twdPerUnit }) => ({ rateDate, currency, twdPerUnit })),
  };
}

function holdingPricesForPositions(
  positions: CanonicalOverviewCurrentQueryResult["projection"]["positions"],
  prices: readonly PGliteHoldingPrice[],
): OverviewHoldingPriceDto[] {
  const byPosition = new Map<string, PGliteHoldingPrice[]>();
  for (const price of prices) {
    const key = `${price.accountId}:${price.securityId}`;
    byPosition.set(key, [...(byPosition.get(key) ?? []), price]);
  }
  return positions.map((position) => {
    const observations = byPosition.get(position.id) ?? [];
    return {
      accountId: position.accountId,
      symbol: position.symbol,
      name: position.name,
      kind: position.kind,
      cash: observations.some((observation) => observation.securityType === "cash"),
      currency: observations.at(-1)?.currency ?? position.currency,
      observations: observations.map(({ date, price }) => ({ date, price })),
    };
  });
}


function readHeldCurrencyRates(
  reader: PGliteReader,
  result: CanonicalOverviewCurrentQueryResult,
  history: PGliteDailyHistory,
  preview: PreviewOverview,
): Promise<ExchangeRateRecord[]> {
  const currencies = [...new Set([
    ...result.projection.positions.map((position) => position.currency),
    ...result.projection.accounts.flatMap((account) => account.amounts.map((amount) => amount.currency)),
    ...history.dailyHistory.flatMap((row) => [
      ...row.netAssets,
      ...row.assets,
      ...row.liabilities,
    ].map((amount) => amount.currency)),
    ...preview.accounts.flatMap((account) => account.amountLines.map((amount) => amount.currency)),
    ...preview.series.flatMap((series) => series.points.map((point) => point.currency)),
  ].filter((currency) => currency !== "TWD" && currency !== "UNKNOWN"))];
  return readExchangeRateRows(reader, currencies);
}

type PreviewOverview = Readonly<{ accounts: readonly AccountRowDto[]; series: readonly PreviewBalanceSeries[] }>;

const NO_PREVIEW: PreviewOverview = { accounts: [], series: [] };

async function readPreviewOverview(reader: PGliteReader, visibility: PreviewVisibility): Promise<PreviewOverview> {
  const views = await readPreviewAccounts(reader, visibility);
  const creditViews = await readPreviewCreditAccounts(reader, visibility);
  if (views.length === 0 && creditViews.length === 0) return NO_PREVIEW;
  const accounts: AccountRowDto[] = [];
  for (const view of views)
    accounts.push(previewAccountRow(view, await readPreviewTransactions(reader, visibility, view.previewAccountId)));
  for (const view of creditViews)
    accounts.push(previewCreditAccountRow(
      view,
      await readPreviewPurchases(reader, visibility, view.previewAccountId),
      await readPreviewStatements(reader, visibility, view.previewAccountId),
    ));
  return {
    accounts,
    series: [
      ...previewBalanceSeries(await readPreviewBalanceHistory(reader, visibility)),
      ...previewCreditSeries(await readPreviewCreditBalanceHistory(reader, visibility)),
    ],
  };
}

async function readHistoryWithPreview(
  reader: PGliteReader,
  result: CanonicalOverviewCurrentQueryResult,
  visibility: PreviewVisibility,
) {
  const canonical = await readPGliteDailyHistoryWithAccounts(
    reader,
    result.projection.knowledgePoint,
    result.projection.accounts,
  );
  const preview = await readPreviewOverview(reader, visibility);
  const rates = await readHeldCurrencyRates(reader, result, canonical, preview);
  const history = withPreviewHistory(canonical, preview.series, countableWithRates(rates));
  return { canonical, history, preview, rates };
}

export async function readOverviewPage(reader: PGliteReader, scope: FinancialPageScope): Promise<OverviewPageDto> {
  const result = await createPGliteCanonicalOverviewQuery(reader, { expectedSources: scope.expectedSources }).current();
  const { history, preview, rates } = await readHistoryWithPreview(reader, result, scope.previewVisibility);
  const prices = await readPGliteHoldingPrices(reader, result.projection.knowledgePoint);
  return mapOverview(result, rates, history, prices, preview.accounts);
}

async function readProductPage(
  reader: PGliteReader,
  scope: FinancialPageScope,
  product: "assets" | "liabilities",
) {
  const result = await createPGliteCanonicalOverviewQuery(reader, { expectedSources: scope.expectedSources }).current();
  const { canonical, history, preview, rates } = await readHistoryWithPreview(reader, result, scope.previewVisibility);
  const projection = product === "assets"
    ? selectPGliteOverviewAssets(result.projection)
    : selectPGliteOverviewLiabilities(result.projection);
  const productDto = mapCanonicalProduct(projection, product, canonical);
  const previewAccounts = preview.accounts.filter((account) => isProductAccount(product, account));
  return {
    ...productDto,
    accounts: [...productDto.accounts, ...previewAccounts],
    dailyHistory: history.dailyHistory.map((row) => ({ ...row })),
    dailyHistoryByAccount: {
      ...productDto.dailyHistoryByAccount,
      ...Object.fromEntries(previewAccounts.map((account) => [account.id, history.dailyHistoryByAccount[account.id] ?? []])),
    },
    exchangeRates: rates.map(({ rateDate, currency, twdPerUnit }) => ({ rateDate, currency, twdPerUnit })),
  };
}

export function readAssetsPage(reader: PGliteReader, scope: FinancialPageScope): Promise<AssetsPageDto> {
  return readProductPage(reader, scope, "assets");
}

export function readLiabilitiesPage(reader: PGliteReader, scope: FinancialPageScope): Promise<LiabilitiesPageDto> {
  return readProductPage(reader, scope, "liabilities");
}
