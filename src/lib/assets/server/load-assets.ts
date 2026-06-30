import { DEFAULT_LEDGER_DIR, openLedgerDrizzle } from "../../../ledger/db/client.ts";
import * as schema from "../../../ledger/db/schema.ts";
import type { AssetsPageDto } from "../types.ts";
import { buildDailyHistoryByAccount } from "$lib/overview/server/daily-history.ts";
import {
  buildAccountOverview,
  buildPositionsByAccount,
  buildTransactionsByAccount,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "$lib/shared-ledger/server/accounts.ts";

export async function loadAssets(ledgerDir = DEFAULT_LEDGER_DIR): Promise<AssetsPageDto> {
  const { db, sqlite } = openLedgerDrizzle(ledgerDir);
  try {
    const [
      sourceFiles,
      accountTransactions,
      foreignCurrencyTransactions,
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
      db.select().from(schema.sourceFiles).all(),
      db.select().from(schema.accountTransactions).all(),
      db.select().from(schema.foreignCurrencyTransactions).all(),
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
    const accounts = buildAccountOverview(data).filter((account) => account.group !== "liability");

    return {
      accounts,
      positionsByAccount: buildPositionsByAccount(data),
      transactionsByAccount: buildTransactionsByAccount(data),
      dailyHistoryByAccount: buildDailyHistoryByAccount(data),
    };
  } finally {
    sqlite.close();
  }
}
