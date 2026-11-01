import type { Page } from "playwright";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { FubonAttachedPreviewPort } from "./fubon-attached-preview.ts";
import { readFubonCurrentDepositBalances } from "./fubon-current-deposit-balances.ts";
import { fubonEbankSite } from "./fubon-ebank-site.ts";
import {
  fetchDepositStatement,
  openTransactionDetailForAccountIndex,
  readFubonDepositAccountOptions,
  selectDepositAccount,
} from "./fubon-statements.ts";

/**
 * The attached collector's view of the signed-in Fubon page. It reads
 * through the same page steps as the verified deposit product, after every
 * verified product has finished with the page.
 */
export function playwrightFubonAttachedPreviewPort(
  page: Page,
  context: Pick<WorkflowContext, "signal" | "text" | "now">,
): FubonAttachedPreviewPort {
  const site = fubonEbankSite(page, context);
  return {
    async balances() {
      const rows = await readFubonCurrentDepositBalances(site, { observedAt: context.now() });
      context.text.assertIntact(JSON.stringify(rows));
      return rows;
    },
    async accountOptions() {
      await openTransactionDetailForAccountIndex(site, 0);
      return await readFubonDepositAccountOptions(site);
    },
    async statement(option, query) {
      context.signal.throwIfAborted();
      await selectDepositAccount(site, option);
      const statement = await fetchDepositStatement(site, query, option);
      context.text.assertIntact(JSON.stringify(statement));
      return statement;
    },
  };
}
