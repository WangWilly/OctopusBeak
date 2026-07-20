import { DEFAULT_LEDGER_DIR, openLedgerDrizzle } from "../../../ledger/db/client.ts";
import * as schema from "../../../ledger/db/schema.ts";
import type { OverviewPageDto } from "../types.ts";
import {
  buildAccountOverview,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "../../shared-ledger/server/accounts.ts";
import { buildSummaryMetrics } from "../../shared-ledger/server/summary.ts";
import { requiredExchangeRateCurrencies } from "../../../ledger/exchange-rates.ts";
import { buildDailyHistory } from "./daily-history.ts";
import {
  appendUnavailableAccounts,
  applyLedgerVisibility,
  loadActiveImportScopes,
  loadUnavailableAccountIssues,
} from "../../data-issues/server/ledger-visibility.ts";

export async function loadOverview(ledgerDir = DEFAULT_LEDGER_DIR): Promise<OverviewPageDto> {
  const { db, sqlite } = openLedgerDrizzle(ledgerDir);
  try {
    const [
      sourceFiles,
      accountTransactions,
      foreignCurrencyTransactions,
      creditCardStatementLines,
      creditCardCaptures,
      creditCardCaptureEntries,
      creditCardSnapshots,
      loanTransactions,
      fundHoldings,
      brokerageHoldings,
      maicoinAccountSnapshots,
      maicoinStatementRows,
    ] = await Promise.all([
      db.select().from(schema.sourceFiles).all(),
      db.select().from(schema.accountTransactions).all(),
      db.select().from(schema.foreignCurrencyTransactions).all(),
      db.select().from(schema.creditCardStatementLines).all(),
      db.select().from(schema.creditCardCaptures).all(),
      db.select().from(schema.creditCardCaptureEntries).all(),
      db.select().from(schema.creditCardSnapshots).all(),
      db.select().from(schema.loanTransactions).all(),
      db.select().from(schema.fundHoldings).all(),
      db.select().from(schema.brokerageHoldings).all(),
      db.select().from(schema.maicoinAccountSnapshots).all(),
      db.select().from(schema.maicoinStatementRows).all(),
    ]);

    const data: LedgerQueryData = {
      ...emptyLedgerQueryData(),
      sourceFiles,
      accountTransactions,
      foreignCurrencyTransactions,
      creditCardStatementLines,
      creditCardCaptures,
      creditCardCaptureEntries,
      creditCardSnapshots,
      loanTransactions,
      fundHoldings,
      brokerageHoldings,
      maicoinAccountSnapshots,
      maicoinStatementRows,
    };
    const visibleData = applyLedgerVisibility(data, loadActiveImportScopes(sqlite));
    const accounts = appendUnavailableAccounts(
      buildAccountOverview(visibleData),
      loadUnavailableAccountIssues(sqlite),
    );
    const dailyHistory = buildDailyHistory(visibleData);
    const firstDate = dailyHistory[0]?.date;
    const lastDate = dailyHistory.at(-1)?.date;
    const currencies = requiredExchangeRateCurrencies(dailyHistory);
    const placeholders = currencies.map(() => "?").join(", ");
    const exchangeRates: OverviewPageDto["exchangeRates"] =
      !firstDate || !lastDate || currencies.length === 0
        ? []
        : (sqlite.prepare(`
            SELECT
              rate_date AS rateDate,
              currency,
              twd_per_unit AS twdPerUnit
            FROM exchange_rates AS rate
            WHERE currency IN (${placeholders})
              AND rate_date <= ?
              AND (
                rate_date >= ?
                OR rate_date = (
                  SELECT MAX(rate_date)
                  FROM exchange_rates AS prior
                  WHERE prior.currency = rate.currency
                    AND prior.rate_date < ?
                )
              )
            ORDER BY currency, rate_date
          `).all(...currencies, lastDate, firstDate, firstDate) as OverviewPageDto["exchangeRates"])
            .map((rate) => ({ ...rate }));

    return {
      importedAt: latestImportedAt(visibleData),
      summary: buildSummaryMetrics(accounts),
      dailyHistory,
      accounts,
      exchangeRates,
      latestExchangeRateDate: exchangeRates.reduce<string | null>(
        (latest, rate) => !latest || rate.rateDate > latest ? rate.rateDate : latest,
        null,
      ),
    };
  } finally {
    sqlite.close();
  }
}

function latestImportedAt(data: LedgerQueryData) {
  return [
    ...data.sourceFiles.map((source) => source.importedAt),
    ...data.creditCardSnapshots.map((snapshot) => snapshot.capturedAt),
    ...data.maicoinAccountSnapshots.map((snapshot) => snapshot.capturedAt),
  ].sort().at(-1) ?? null;
}
