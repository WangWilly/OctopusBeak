import type { SpendingLoadInput } from "../src/lib/spending/contracts.ts";
import type { SpendingPageDto } from "../src/lib/spending/model.ts";
import { spendingPageBehind } from "../src/ledger/pglite/spending-page.ts";
import { spendingPageAfterAction, spendingPageNeedsRecompute } from "../src/ledger/pglite/spending-page-actions.ts";
import type { FinancialLiveViewDefinition } from "./pglite-financial-live-views.ts";

export const SPENDING_LIVE_VIEW: FinancialLiveViewDefinition = {
  load: (registry, params) => registry["financial.spending.current"]([params as SpendingLoadInput]),
  dependsOn: ["manual"],
  async shouldRecompute({ registry, pageActions }, lastValue) {
    // A page action publishes its own summary delta once it settles (ADR 0105).
    if (pageActions.inFlight()) return false;
    // Read the version first: a recompute may publish while this read waits.
    const version = await registry["financial.spending.version"]([]);
    return spendingPageBehind(lastValue() as SpendingPageDto | undefined, version);
  },
  watch({ registry, pageActions, lastValue, publish, recompute, fail }) {
    return pageActions.onSettled((result) => {
      void (async () => {
        const after = result ? spendingPageAfterAction(lastValue() as SpendingPageDto | undefined, result) : null;
        if (after?.page) publish(after.page);
        const version = await registry["financial.spending.version"]([]);
        // A commit or manual write that arrived while the action ran was held back by shouldRecompute.
        const settled = result && after ? { result, published: after.published } : null;
        if (spendingPageNeedsRecompute(lastValue() as SpendingPageDto | undefined, version, settled)) recompute();
      })().catch(fail);
    });
  },
};
