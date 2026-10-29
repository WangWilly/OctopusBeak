import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import type { ProductCollectionHandle } from "../lib/automation/product-collection.ts";
import { strictSourceText, type SourceTextPort } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";

/** A workflow context for driving one Yuanta product runner without the orchestrator. */
export function yuantaCollectionContext(
  options: Readonly<{ now?: string | (() => string); signal?: AbortSignal; text?: SourceTextPort }> = {},
): WorkflowContext {
  const now = options.now ?? "2026-09-25T00:00:00.000Z";
  return {
    runId: "yuanta-product-check",
    signal: options.signal ?? new AbortController().signal,
    now: typeof now === "function" ? now : () => now,
    browser: {
      withPage: async () => {
        throw new Error("Product checks pass their page to the runner directly.");
      },
    },
    text: options.text ?? strictSourceText,
    verification: { complete: async () => undefined },
    event: async () => undefined,
    signalEvent: async () => undefined,
  };
}

/** A product handle that records staged items with the provider the run adds. */
export function yuantaStagingHandle(
  staged: PGliteWorkflowRunItem[],
  activities: string[] = [],
): ProductCollectionHandle {
  return {
    stage: (...requests) => {
      staged.push(...requests.map((request) => ({ ...request, provider: "yuanta" })));
    },
    reportActivity: async (activity) => {
      activities.push(activity);
    },
    event: async () => undefined,
    collectionPeriod: () => {
      throw new Error("This check supplies no collection period.");
    },
  };
}
