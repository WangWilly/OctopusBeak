import type { AutomationProgressEvent } from "./progress.ts";
import type { WorkflowDefinition } from "./workflow-executor.ts";

export type ExchangeRateSyncService = (options: {
  scheduledAtUtc?: string;
  emitProgress?: (event: Omit<AutomationProgressEvent, "type">) => void;
}) => Promise<unknown>;

/** A nonbrowser workflow built with the same executor contract as providers. */
export function createExchangeRateWorkflow(
  service: ExchangeRateSyncService,
  options: Readonly<{
    scheduledAtUtc?: string;
    emitProgress: (event: Omit<AutomationProgressEvent, "type">) => void;
  }>,
): WorkflowDefinition {
  return {
    id: "exchange-rates",
    requiresFinancialCommit: false,
    async run(context) {
      let eventQueue = Promise.resolve();
      await service({
        scheduledAtUtc: options.scheduledAtUtc,
        emitProgress: (event) => {
          options.emitProgress(event);
          eventQueue = eventQueue.then(() => context.event("collection", "progress-update"));
        },
      });
      await eventQueue;
    },
  };
}
