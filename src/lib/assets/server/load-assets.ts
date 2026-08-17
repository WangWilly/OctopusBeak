import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import type { AssetsPageDto } from "../types.ts";
import { buildDailyHistory, buildDailyHistoryByAccount } from "../../overview/server/daily-history.ts";
import {
  buildAccountOverview,
  buildPositionsByAccount,
  buildTransactionsByAccount,
} from "../../shared-ledger/server/accounts.ts";
import { createFinancialQuery } from "../../shared-ledger/server/financial-query.ts";

export async function loadAssets(ledgerDir = DEFAULT_LEDGER_DIR): Promise<AssetsPageDto> {
  const { ledger: visibleData, unavailableAccounts } = await createFinancialQuery(ledgerDir)
    .current({ kind: "current", product: "assets" });
  const accounts = [
    ...buildAccountOverview(visibleData),
    ...unavailableAccounts,
  ].filter((account) => account.group !== "liability");

  return {
    accounts,
    positionsByAccount: buildPositionsByAccount(visibleData),
    transactionsByAccount: buildTransactionsByAccount(visibleData),
    dailyHistoryByAccount: buildDailyHistoryByAccount(visibleData),
    dailyHistory: buildDailyHistory(visibleData),
  };
}
