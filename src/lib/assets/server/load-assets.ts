import { openLedgerDrizzle } from "../../../ledger/db/client.ts";
import * as schema from "../../../ledger/db/schema.ts";
import type { AssetsPageDto } from "../types.ts";
import {
  buildAccountOverview,
  buildPositionsByAccount,
  buildTransactionsByAccount,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "$lib/shared-ledger/server/accounts.ts";

export async function loadAssets(ledgerDir = "data/ledger"): Promise<AssetsPageDto> {
  const { db, sqlite } = openLedgerDrizzle(ledgerDir);
  try {
    const [
      accountTransactions,
      foreignCurrencyTransactions,
      fundHoldings,
      fundBuyTransactions,
      fundRedemptionTransactions,
      fundCashDividends,
      fundConversionTransactions,
      brokerageHoldings,
      brokerageTradeTransactions,
    ] = await Promise.all([
      db.select().from(schema.accountTransactions).all(),
      db.select().from(schema.foreignCurrencyTransactions).all(),
      db.select().from(schema.fundHoldings).all(),
      db.select().from(schema.fundBuyTransactions).all(),
      db.select().from(schema.fundRedemptionTransactions).all(),
      db.select().from(schema.fundCashDividends).all(),
      db.select().from(schema.fundConversionTransactions).all(),
      db.select().from(schema.brokerageHoldings).all(),
      db.select().from(schema.brokerageTradeTransactions).all(),
    ]);

    const data: LedgerQueryData = {
      ...emptyLedgerQueryData(),
      accountTransactions,
      foreignCurrencyTransactions,
      fundHoldings,
      fundBuyTransactions,
      fundRedemptionTransactions,
      fundCashDividends,
      fundConversionTransactions,
      brokerageHoldings,
      brokerageTradeTransactions,
    };

    return {
      accounts: buildAccountOverview(data),
      positionsByAccount: buildPositionsByAccount(data),
      transactionsByAccount: buildTransactionsByAccount(data),
    };
  } finally {
    sqlite.close();
  }
}
