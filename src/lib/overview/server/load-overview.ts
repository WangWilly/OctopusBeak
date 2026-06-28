import { DEFAULT_LEDGER_DIR, openLedgerDrizzle } from "../../../ledger/db/client.ts";
import * as schema from "../../../ledger/db/schema.ts";
import type { OverviewPageDto } from "../types.ts";
import {
  buildAccountOverview,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "$lib/shared-ledger/server/accounts.ts";
import { buildSummaryMetrics } from "$lib/shared-ledger/server/summary.ts";
import { buildDailyHistory } from "./daily-history.ts";

export async function loadOverview(ledgerDir = DEFAULT_LEDGER_DIR): Promise<OverviewPageDto> {
  const { db, sqlite } = openLedgerDrizzle(ledgerDir);
  try {
    const [
      sourceFiles,
      accountTransactions,
      foreignCurrencyTransactions,
      creditCardStatementLines,
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
      loanTransactions,
      fundHoldings,
      brokerageHoldings,
      maicoinAccountSnapshots,
      maicoinStatementRows,
    };
    const accounts = buildAccountOverview(data);

    return {
      importedAt: latestImportedAt(data),
      summary: buildSummaryMetrics(accounts),
      dailyHistory: buildDailyHistory(data),
      accounts,
    };
  } finally {
    sqlite.close();
  }
}

function latestImportedAt(data: LedgerQueryData) {
  return [
    ...data.sourceFiles.map((source) => source.importedAt),
    ...data.maicoinAccountSnapshots.map((snapshot) => snapshot.capturedAt),
  ].sort().at(-1) ?? null;
}
