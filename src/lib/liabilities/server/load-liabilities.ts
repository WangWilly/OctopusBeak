import { openLedgerDrizzle } from "../../../ledger/db/client.ts";
import * as schema from "../../../ledger/db/schema.ts";
import type { LiabilitiesPageDto } from "../types.ts";
import {
  buildAccountOverview,
  buildTransactionsByAccount,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "$lib/shared-ledger/server/accounts.ts";

export async function loadLiabilities(ledgerDir = "data/ledger"): Promise<LiabilitiesPageDto> {
  const { db, sqlite } = openLedgerDrizzle(ledgerDir);
  try {
    const [creditCardStatementLines, loanTransactions] = await Promise.all([
      db.select().from(schema.creditCardStatementLines).all(),
      db.select().from(schema.loanTransactions).all(),
    ]);

    const data: LedgerQueryData = {
      ...emptyLedgerQueryData(),
      creditCardStatementLines,
      loanTransactions,
    };

    return {
      accounts: buildAccountOverview(data),
      transactionsByAccount: buildTransactionsByAccount(data),
    };
  } finally {
    sqlite.close();
  }
}
