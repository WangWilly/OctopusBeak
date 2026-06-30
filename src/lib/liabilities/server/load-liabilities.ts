import { DEFAULT_LEDGER_DIR, openLedgerDrizzle } from "../../../ledger/db/client.ts";
import * as schema from "../../../ledger/db/schema.ts";
import type { LiabilitiesPageDto } from "../types.ts";
import { buildDailyHistory, buildDailyHistoryByAccount } from "$lib/overview/server/daily-history.ts";
import {
  buildAccountOverview,
  buildTransactionsByAccount,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "$lib/shared-ledger/server/accounts.ts";

export async function loadLiabilities(ledgerDir = DEFAULT_LEDGER_DIR): Promise<LiabilitiesPageDto> {
  const { db, sqlite } = openLedgerDrizzle(ledgerDir);
  try {
    const [sourceFiles, creditCardStatementLines, loanTransactions, maicoinAccountSnapshots] = await Promise.all([
      db.select().from(schema.sourceFiles).all(),
      db.select().from(schema.creditCardStatementLines).all(),
      db.select().from(schema.loanTransactions).all(),
      db.select().from(schema.maicoinAccountSnapshots).all(),
    ]);

    const data: LedgerQueryData = {
      ...emptyLedgerQueryData(),
      sourceFiles,
      creditCardStatementLines,
      loanTransactions,
      maicoinAccountSnapshots,
    };
    const accounts = buildAccountOverview(data).filter((account) => account.group === "liability");

    return {
      accounts,
      transactionsByAccount: buildTransactionsByAccount(data),
      dailyHistoryByAccount: buildDailyHistoryByAccount(data),
      dailyHistory: buildDailyHistory(data),
    };
  } finally {
    sqlite.close();
  }
}
