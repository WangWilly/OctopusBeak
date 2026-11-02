import {
  reconcileSpendingPageActionSummary,
  spendingCanonicalAt,
  type SpendingPageDto,
} from "../src/lib/spending/model.ts";
import type { SpendingLoadInput } from "../src/lib/spending/contracts.ts";
import { spendingPageBehind } from "../src/ledger/pglite/spending-page.ts";
import type { FinancialLiveViewDefinition } from "./pglite-financial-live-views.ts";

export const SPENDING_LIVE_VIEW: FinancialLiveViewDefinition = {
  load: (registry, params) => registry["financial.spending.current"]([params as SpendingLoadInput]),
  dependsOn: ["manual"],
  async shouldRecompute(registry, lastValue) {
    if (registry.isSpendingPageActionInFlight?.()) return false;
    // A page action already publishes its exact summary delta. The
    // commit notification may arrive just after that publication;
    // avoid rebuilding the same full summary ahead of a Pairing click.
    // A separate commit still has a newer version and is recomputed.
    // Read the version first: a recompute may publish while this read waits.
    const version = await registry["financial.spending.version"]([]);
    return spendingPageBehind(lastValue() as SpendingPageDto | undefined, version);
  },
  watch({ registry, lastValue, publish, recompute, fail }) {
    if (!registry.onSpendingPageActionSettled) return () => {};
    return registry.onSpendingPageActionSettled((result) => {
      void (async () => {
        let actionResultPublished = false;
        if (result) {
          const previous = lastValue() as SpendingPageDto | undefined;
          if (previous?.purchaseReport.summary) {
            try {
              const reconciliation = reconcileSpendingPageActionSummary(
                previous.purchaseReport.summary,
                previous.purchaseReport.knowledgeAt,
                result,
              );
              if (reconciliation.state === "apply-delta") {
                const { summary } = reconciliation;
                publish(Object.freeze({
                  ...previous,
                  canonical: spendingCanonicalAt(previous.canonical, summary, result.knowledgeAt),
                  purchaseReport: Object.freeze({
                    ...previous.purchaseReport,
                    knowledgeAt: result.knowledgeAt,
                    totalsByCurrency: summary.totalsByCurrency,
                    summary,
                  }),
                }) satisfies SpendingPageDto);
              }
              actionResultPublished = reconciliation.state !== "newer-live-version";
            } catch {
              // The version check below schedules an authoritative refresh if this delta no longer applies.
            }
          } else if (previous?.purchaseReport.knowledgeAt === result.knowledgeAt) {
            actionResultPublished = true;
          }
        }

        const version = await registry["financial.spending.version"]([]);
        const actionVersion = result?.knowledgeAt ?? -1;
        // A canonical commit or a manual write that arrived while the action ran was skipped by shouldRecompute.
        if (spendingPageBehind(lastValue() as SpendingPageDto | undefined, version)
          || (result && !actionResultPublished && version.knowledgeAt >= actionVersion)) {
          recompute();
        }
      })().catch(fail);
    });
  },
};
