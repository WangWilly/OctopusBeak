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
import {
  appendUnavailableAccounts,
  applyLedgerVisibility,
  loadActiveImportScopes,
  loadUnavailableAccountIssues,
} from "$lib/data-issues/server/ledger-visibility.ts";

export async function loadLiabilities(ledgerDir = DEFAULT_LEDGER_DIR): Promise<LiabilitiesPageDto> {
  const { db, sqlite } = openLedgerDrizzle(ledgerDir);
  try {
    const [
      sourceFiles,
      creditCardStatementLines,
      creditCardCaptures,
      creditCardCaptureEntries,
      creditCardSnapshots,
      loanTransactions,
      maicoinAccountSnapshots,
    ] = await Promise.all([
      db.select().from(schema.sourceFiles).all(),
      db.select().from(schema.creditCardStatementLines).all(),
      db.select().from(schema.creditCardCaptures).all(),
      db.select().from(schema.creditCardCaptureEntries).all(),
      db.select().from(schema.creditCardSnapshots).all(),
      db.select().from(schema.loanTransactions).all(),
      db.select().from(schema.maicoinAccountSnapshots).all(),
    ]);

    const data: LedgerQueryData = {
      ...emptyLedgerQueryData(),
      sourceFiles,
      creditCardStatementLines,
      creditCardCaptures,
      creditCardCaptureEntries,
      creditCardSnapshots,
      loanTransactions,
      maicoinAccountSnapshots,
    };
    const visibleData = applyLedgerVisibility(data, loadActiveImportScopes(sqlite));
    const accounts = appendUnavailableAccounts(
      buildAccountOverview(visibleData),
      loadUnavailableAccountIssues(sqlite, data),
    ).filter((account) => account.group === "liability");

    return {
      accounts,
      transactionsByAccount: buildTransactionsByAccount(visibleData),
      dailyHistoryByAccount: buildDailyHistoryByAccount(visibleData),
      dailyHistory: buildDailyHistory(visibleData),
    };
  } finally {
    sqlite.close();
  }
}
