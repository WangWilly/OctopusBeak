import { DEFAULT_LEDGER_DIR, openLedgerDrizzle } from "../../../ledger/db/client.ts";
import * as schema from "../../../ledger/db/schema.ts";
import type { AssetsPageDto } from "../types.ts";
import { buildDailyHistory, buildDailyHistoryByAccount } from "../../overview/server/daily-history.ts";
import {
  buildAccountOverview,
  buildPositionsByAccount,
  buildTransactionsByAccount,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "../../shared-ledger/server/accounts.ts";
import {
  appendUnavailableAccounts,
  applyLedgerVisibility,
  loadActiveLedgerSupport,
  loadUnavailableAccountIssues,
} from "../../data-issues/server/ledger-visibility.ts";

export async function loadAssets(ledgerDir = DEFAULT_LEDGER_DIR): Promise<AssetsPageDto> {
  const { db, sqlite } = openLedgerDrizzle(ledgerDir);
  try {
    const [
      sourceFiles,
      accountTransactions,
      foreignCurrencyTransactions,
      creditCardCaptures,
      creditCardCaptureEntries,
      fundHoldings,
      fundBuyTransactions,
      fundRedemptionTransactions,
      fundCashDividends,
      fundConversionTransactions,
      brokerageHoldings,
      brokerageTradeTransactions,
      maicoinAccountSnapshots,
      maicoinStatementRows,
    ] = await Promise.all([
      db.select().from(schema.sourceFileImports).all(),
      db.select().from(schema.accountTransactions).all(),
      db.select().from(schema.foreignCurrencyTransactions).all(),
      db.select().from(schema.creditCardCaptures).all(),
      db.select().from(schema.creditCardCaptureEntries).all(),
      db.select().from(schema.fundHoldings).all(),
      db.select().from(schema.fundBuyTransactions).all(),
      db.select().from(schema.fundRedemptionTransactions).all(),
      db.select().from(schema.fundCashDividends).all(),
      db.select().from(schema.fundConversionTransactions).all(),
      db.select().from(schema.brokerageHoldings).all(),
      db.select().from(schema.brokerageTradeTransactions).all(),
      db.select().from(schema.maicoinAccountSnapshots).all(),
      db.select().from(schema.maicoinStatementRows).all(),
    ]);

    const data: LedgerQueryData = {
      ...emptyLedgerQueryData(),
      sourceFiles,
      accountTransactions,
      foreignCurrencyTransactions,
      creditCardCaptures,
      creditCardCaptureEntries,
      fundHoldings,
      fundBuyTransactions,
      fundRedemptionTransactions,
      fundCashDividends,
      fundConversionTransactions,
      brokerageHoldings,
      brokerageTradeTransactions,
      maicoinAccountSnapshots,
      maicoinStatementRows,
    };
    const support = loadActiveLedgerSupport(sqlite);
    const visibleData = applyLedgerVisibility(data, support);
    const accounts = appendUnavailableAccounts(
      buildAccountOverview(visibleData),
      loadUnavailableAccountIssues(sqlite, data, support),
    ).filter((account) => account.group !== "liability");

    return {
      accounts,
      positionsByAccount: buildPositionsByAccount(visibleData),
      transactionsByAccount: buildTransactionsByAccount(visibleData),
      dailyHistoryByAccount: buildDailyHistoryByAccount(visibleData),
      dailyHistory: buildDailyHistory(visibleData),
    };
  } finally {
    sqlite.close();
  }
}
