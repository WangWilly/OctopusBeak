import type { AutomationTaskStatus, TypedWorkflowOutcome } from "./types.ts";
import type { WorkflowStage } from "./workflow-executor.ts";
import type { WorkflowRunEvent } from "./run-event.ts";
import { WORKFLOW_STAGES } from "./task-row.ts";


export type RunStageState = "done" | "warning" | "failed" | "active" | "pending";

export type RunStage = Readonly<{
  stage: WorkflowStage;
  state: RunStageState;
  lastEvent: WorkflowRunEvent | null;
}>;

const ACTIVE_STATUSES: readonly AutomationTaskStatus[] = [
  "queued",
  "preparing",
  "running",
  "waiting_for_human",
  "cancelling",
];

export type CollectionFailures = Readonly<{
  typeIds: readonly string[];
  /** Products the run tried; skipped ones were never collected. */
  attempted: number;
}>;

/** Which products failed collection, out of those the run tried. */
export function collectionFailures(outcome: TypedWorkflowOutcome | null): CollectionFailures | null {
  const products = outcome?.summary?.products ?? [];
  const typeIds = products.filter((product) => product.status === "failed").map((product) => product.typeId);
  if (!typeIds.length) return null;
  return { typeIds, attempted: products.filter((product) => product.status !== "skipped").length };
}

/** A retry starts over at preparation, so the last return to it begins the latest attempt. */
function latestAttempt(events: readonly WorkflowRunEvent[]): readonly WorkflowRunEvent[] {
  const start = events.findLastIndex((event, index) =>
    event.stage === "preparation" && index > 0 && events[index - 1].stage !== "preparation");
  return start === -1 ? events : events.slice(start);
}

/** One node per workflow stage, coloured by where the latest attempt got to and how the run ended. */
export function runStageTrack(
  runEvents: readonly WorkflowRunEvent[],
  status: AutomationTaskStatus,
  outcome: TypedWorkflowOutcome | null,
): RunStage[] {
  const events = latestAttempt(runEvents);
  const latest = events.at(-1) ?? null;
  // The executor closes every failed or cancelled run with a finalization event; the run stopped before it.
  const stoppedStage = events.findLast((event) => event.stage !== "finalization")?.stage;
  // Older events past the retention limit are gone, so stages before the first kept one already finished.
  const firstStageIndex = events.length ? WORKFLOW_STAGES.indexOf(events[0].stage) : 0;
  const running = ACTIVE_STATUSES.includes(status);
  const stopped = status === "failed" || status === "interrupted" || status === "cancelled";
  const incomplete = stopped || status === "partial";
  const productFailed = collectionFailures(outcome) !== null;
  return WORKFLOW_STAGES.map((stage, index) => {
    const stageEvents = events.filter((event) => event.stage === stage);
    const lastEvent = stageEvents.at(-1) ?? null;
    return { stage, lastEvent, state: stageState() };

    function stageState(): RunStageState {
      if (!lastEvent) return index < firstStageIndex ? "done" : "pending";
      if (running && latest?.stage === stage) return "active";
      // The run status, not its closing event, says how the run ended (ADR 0059).
      if (stage === "finalization") {
        if (status === "failed" || status === "interrupted") return "failed";
        if (status === "partial" || status === "cancelled") return "warning";
        return "done";
      }
      if (stageEvents.some((event) => event.outcome === "failed")) return "failed";
      if (stage === "collection" && productFailed) return "failed";
      // A failed product already explains the failure on the collection node.
      if (stopped && stoppedStage === stage && !productFailed) return "failed";
      if (stage === "commit" && incomplete) return "warning";
      return "done";
    }
  });
}
