import {
  reconcileSpendingPageActionSummary,
  spendingCanonicalAt,
  type SpendingPageDto,
} from "../src/lib/spending/model.ts";
import type { SpendingLoadInput } from "../src/lib/spending/contracts.ts";
import type { FinancialLiveViewDefinition } from "./pglite-financial-live-views.ts";

export const SPENDING_LIVE_VIEW: FinancialLiveViewDefinition = {
  load: (registry, params) => registry["financial.spending.current"]([params as SpendingLoadInput]),
  dependsOn: [],
  async shouldRecompute(registry, lastValue) {
    if (registry.isSpendingPageActionInFlight?.()) return false;
    // A page action already publishes its exact summary delta. The
    // commit notification may arrive just after that publication;
    // avoid rebuilding the same full summary ahead of a Pairing click.
    // A separate commit still has a newer version and is recomputed.
    const version = await registry["financial.spending.version"]([]);
    const published = (lastValue() as SpendingPageDto | undefined)?.purchaseReport.knowledgeAt ?? -1;
    return version > published;
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

        const currentVersion = await registry["financial.spending.version"]([]);
        const published = lastValue() as SpendingPageDto | undefined;
        const publishedVersion = published?.purchaseReport.knowledgeAt ?? -1;
        const actionVersion = result?.knowledgeAt ?? -1;
        if (currentVersion > publishedVersion || (result && !actionResultPublished && currentVersion >= actionVersion)) {
          recompute();
        }
      })().catch(fail);
    });
  },
};
