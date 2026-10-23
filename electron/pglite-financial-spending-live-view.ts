import { applySpendingSummaryDelta, type SpendingPageDto } from "../src/lib/spending/model.ts";
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
    const published = (lastValue as SpendingPageDto | undefined)?.purchaseReport.knowledgeAt ?? -1;
    return version > published;
  },
  watch({ registry, lastValue, publish, recompute, fail }) {
    if (!registry.onSpendingPageActionSettled) return () => {};
    return registry.onSpendingPageActionSettled((result) => {
      void (async () => {
        let actionResultPublished = false;
        if (result) {
          const previous = lastValue() as SpendingPageDto | undefined;
          const previousVersion = previous?.purchaseReport.knowledgeAt;
          if (previous?.purchaseReport.summary && previousVersion === result.baseKnowledgeAt) {
            try {
              const summary = applySpendingSummaryDelta(
                previous.purchaseReport.summary,
                result.baseKnowledgeAt,
                result.knowledgeAt,
                result.summaryDelta,
              );
              const purchaseReport = Object.freeze({
                ...previous.purchaseReport,
                knowledgeAt: result.knowledgeAt,
                totalsByCurrency: summary.totalsByCurrency,
                summary,
              });
              publish(Object.freeze({
                ...previous,
                canonical: Object.freeze({
                  ...previous.canonical,
                  availability: summary.recordCount > 0 ? "available" : "empty",
                  knowledgePoint: result.knowledgeAt,
                  totalsByCurrency: summary.totalsByCurrency.map((amount) => ({
                    currency: amount.currency,
                    value: Number(amount.coefficient) / 10 ** amount.scale,
                    exact: { coefficient: amount.coefficient, scale: amount.scale },
                  })),
                  totalStatus: "complete",
                }),
                purchaseReport,
              }) satisfies SpendingPageDto);
              actionResultPublished = true;
            } catch {
              // The version check below schedules an authoritative refresh if this delta no longer applies.
            }
          } else if (previousVersion === result.knowledgeAt) {
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
