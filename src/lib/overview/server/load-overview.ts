import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import type { OverviewPageDto } from "../types.ts";
import {
  buildAccountOverview,
  buildRawPositions,
  type LedgerQueryData,
} from "../../shared-ledger/server/accounts.ts";
import { buildSummaryMetrics } from "../../shared-ledger/server/summary.ts";
import { requiredExchangeRateCurrencies } from "../../../ledger/exchange-rates.ts";
import { buildDailyHistory } from "./daily-history.ts";
import { buildOverviewSankeyGraph } from "./overview-sankey.ts";
import {
  createFinancialQuery,
  type ExchangeRateQueryRow,
} from "../../shared-ledger/server/financial-query.ts";

export async function loadOverview(ledgerDir = DEFAULT_LEDGER_DIR): Promise<OverviewPageDto> {
  const { ledger: visibleData, unavailableAccounts, exchangeRates } = await createFinancialQuery(ledgerDir)
    .current({ kind: "current", product: "overview" });
  const accounts = [...buildAccountOverview(visibleData), ...unavailableAccounts];
    const sankeyPositions = buildRawPositions(visibleData);
    const sankeyCurrencies = [...new Set(sankeyPositions.map((position) => position.currency).filter((currency) => currency !== "TWD"))];
    const sankeyExchangeRates = latestExchangeRates(exchangeRates, sankeyCurrencies);
    const sankeyRates = new Map(sankeyExchangeRates.map((rate) => [rate.currency, rate.twdPerUnit]));
    const sankey = buildOverviewSankeyGraph(sankeyPositions, sankeyRates);
    const dailyHistory = buildDailyHistory(visibleData);
    const firstDate = dailyHistory[0]?.date;
    const lastDate = dailyHistory.at(-1)?.date;
    const currencies = requiredExchangeRateCurrencies(dailyHistory);
    const historyExchangeRates = !firstDate || !lastDate || currencies.length === 0
      ? []
      : historicalExchangeRates(exchangeRates, currencies, firstDate, lastDate);

    return {
      importedAt: latestImportedAt(visibleData),
      summary: buildSummaryMetrics(accounts),
      dailyHistory,
      accounts,
      sankey,
      sankeyExchangeRates,
      sankeyLatestExchangeRateDate: sankeyExchangeRates.reduce<string | null>(
        (latest, rate) => !latest || rate.rateDate > latest ? rate.rateDate : latest,
        null,
      ),
      exchangeRates: historyExchangeRates,
      latestExchangeRateDate: historyExchangeRates.reduce<string | null>(
        (latest, rate) => !latest || rate.rateDate > latest ? rate.rateDate : latest,
        null,
      ),
    };
}

function latestImportedAt(data: LedgerQueryData) {
  return [
    ...data.sourceFiles.map((source) => source.importedAt),
    ...data.creditCardSnapshots.map((snapshot) => snapshot.capturedAt),
    ...data.maicoinAccountSnapshots.map((snapshot) => snapshot.capturedAt),
  ].sort().at(-1) ?? null;
}

function latestExchangeRates(
  rows: ExchangeRateQueryRow[],
  currencies: string[],
): OverviewPageDto["sankeyExchangeRates"] {
  const selected = new Set(currencies);
  const latest = new Map<string, ExchangeRateQueryRow>();
  for (const row of rows) {
    if (!selected.has(row.currency)) continue;
    const previous = latest.get(row.currency);
    if (!previous || row.rateDate > previous.rateDate) latest.set(row.currency, row);
  }
  return [...latest.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency))
    .map((row) => ({ ...row }));
}

function historicalExchangeRates(
  rows: ExchangeRateQueryRow[],
  currencies: string[],
  firstDate: string,
  lastDate: string,
): OverviewPageDto["exchangeRates"] {
  const selected = new Set(currencies);
  const byCurrency = new Map<string, ExchangeRateQueryRow[]>();
  for (const row of rows) {
    if (!selected.has(row.currency) || row.rateDate > lastDate) continue;
    const current = byCurrency.get(row.currency) ?? [];
    current.push(row);
    byCurrency.set(row.currency, current);
  }
  return [...byCurrency.entries()]
    .flatMap(([currency, currencyRows]) => {
      const prior = currencyRows
        .filter((row) => row.rateDate < firstDate)
        .sort((left, right) => right.rateDate.localeCompare(left.rateDate))[0];
      return currencyRows.filter((row) => row.rateDate >= firstDate).concat(prior ? [prior] : []);
    })
    .sort((left, right) => left.currency.localeCompare(right.currency) || left.rateDate.localeCompare(right.rateDate))
    .map((row) => ({ ...row }));
}
