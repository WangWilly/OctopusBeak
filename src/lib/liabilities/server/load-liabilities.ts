import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import type { LiabilitiesPageDto } from "../types.ts";
import { buildDailyHistory, buildDailyHistoryByAccount } from "../../overview/server/daily-history.ts";
import {
  buildAccountOverview,
  buildTransactionsByAccount,
} from "../../shared-ledger/server/accounts.ts";
import { createFinancialQuery } from "../../shared-ledger/server/financial-query.ts";

export async function loadLiabilities(ledgerDir = DEFAULT_LEDGER_DIR): Promise<LiabilitiesPageDto> {
  const { ledger: visibleData, unavailableAccounts } = await createFinancialQuery(ledgerDir)
    .current({ kind: "current", product: "liabilities" });
  const accounts = [...buildAccountOverview(visibleData), ...unavailableAccounts]
    .filter((account) => account.group === "liability");

  return {
    accounts,
    transactionsByAccount: buildTransactionsByAccount(visibleData),
    dailyHistoryByAccount: buildDailyHistoryByAccount(visibleData),
    dailyHistory: buildDailyHistory(visibleData),
  };
}
