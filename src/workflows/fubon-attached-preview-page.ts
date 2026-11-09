import type { Page } from "playwright";
import type { ProductCollectionHandle } from "../lib/automation/product-collection.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { PreviewProductHandle } from "../lib/preview-sources/product-collection.ts";
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
  context: Pick<WorkflowContext, "text">,
  product: PreviewProductHandle,
): FubonAttachedPreviewPort {
  const site = fubonEbankSite(page, product);
  // The preview stages nothing and names no Failure code, so its checks report no validation events.
  const validate: ProductCollectionHandle["validate"] = async (check) => await check();
  return {
    async balances() {
      return await readCurrentStateSnapshot({
        response: FUBON_CURRENT_DEPOSIT_RESPONSE,
        parse: (decoded, response) => parseFubonCurrentDepositBalanceSnapshot({ rows: decoded.rows, response }),
      }, {
        acquire: () => readFubonCurrentDepositBalanceTable(site, product.reader),
        product: { event: async () => undefined, validate, reader: product.reader, signal: product.signal },
      });
    },
    async accountOptions() {
      await openTransactionDetailForAccountIndex(site, 0);
      return await readFubonDepositAccountOptions(site);
    },
    async statement(option, query) {
      product.signal.throwIfAborted();
      await selectDepositAccount(site, option);
      const statement = await fetchDepositStatement(site, query, option, product.reader);
      context.text.assertIntact(JSON.stringify(statement));
      return statement;
    },
  };
}
