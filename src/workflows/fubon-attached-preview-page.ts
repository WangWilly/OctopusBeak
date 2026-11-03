import type { Page } from "playwright";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { FubonAttachedPreviewPort } from "./fubon-attached-preview.ts";
import { readCurrentStateSnapshot } from "./current-state-snapshot-capture.ts";
import {
  FUBON_CURRENT_DEPOSIT_RESPONSE,
  parseFubonCurrentDepositBalanceSnapshot,
  readFubonCurrentDepositBalanceTable,
} from "./fubon-current-deposit-balances.ts";
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
      // The preview stages nothing, so it reports no current-balance events.
      return await readCurrentStateSnapshot({
        response: FUBON_CURRENT_DEPOSIT_RESPONSE,
        parse: (decoded, response) => parseFubonCurrentDepositBalanceSnapshot({ rows: decoded.rows, response }),
      }, {
        acquire: () => readFubonCurrentDepositBalanceTable(site),
        now: () => context.now(),
        product: { event: async () => undefined },
        text: context.text,
        signal: context.signal,
      });
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
