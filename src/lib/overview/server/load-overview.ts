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
import { createFinancialQuery } from "../../shared-ledger/server/financial-query.ts";

export async function loadOverview(ledgerDir = DEFAULT_LEDGER_DIR): Promise<OverviewPageDto> {
  const query = createFinancialQuery(ledgerDir);
  const { ledger: visibleData, unavailableAccounts } = await query
    .current({ kind: "current", product: "overview" });
  const accounts = [...buildAccountOverview(visibleData), ...unavailableAccounts];
  const sankeyPositions = buildRawPositions(visibleData);
  const sankeyCurrencies = [...new Set(
    sankeyPositions.map((position) => position.currency).filter((currency) => currency !== "TWD"),
  )];
  const sankeyExchangeRates = await query.overviewExchangeRates({
    kind: "current",
    product: "overview",
    selection: "latest",
    currencies: sankeyCurrencies,
  });
  const sankeyRates = new Map(sankeyExchangeRates.map((rate) => [rate.currency, rate.twdPerUnit]));
  const sankey = buildOverviewSankeyGraph(sankeyPositions, sankeyRates);
  const dailyHistory = buildDailyHistory(visibleData);
  const firstDate = dailyHistory[0]?.date;
  const lastDate = dailyHistory.at(-1)?.date;
  const currencies = requiredExchangeRateCurrencies(dailyHistory);
  const historyExchangeRates = !firstDate || !lastDate || currencies.length === 0
    ? []
    : await query.overviewExchangeRates({
      kind: "current",
      product: "overview",
      selection: "history",
      currencies,
      firstDate,
      lastDate,
    });

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
