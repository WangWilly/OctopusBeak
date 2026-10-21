import type { AutomationTaskStatus, TypedWorkflowOutcome } from "./types.ts";
import type { WorkflowRunEvent, WorkflowStage } from "./workflow-executor.ts";

export const WORKFLOW_STAGES = [
  "preparation",
  "authentication",
  "collection",
  "decoding",
  "validation",
  "commit",
  "finalization",
] as const satisfies readonly WorkflowStage[];

export type RunStageState = "done" | "warning" | "failed" | "active" | "pending";

export type RunStage = Readonly<{
  stage: WorkflowStage;
  state: RunStageState;
  lastEvent: WorkflowRunEvent | null;
}>;

const FAILURE_CODE = /-(failed|rejected|exhausted|unavailable|unsupported|interrupted)$/;
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
  const running = ACTIVE_STATUSES.includes(status);
  const incomplete = status === "failed" || status === "partial" || status === "interrupted" || status === "cancelled";
  const productFailed = collectionFailures(outcome) !== null;
  return WORKFLOW_STAGES.map((stage) => {
    const stageEvents = events.filter((event) => event.stage === stage);
    const lastEvent = stageEvents.at(-1) ?? null;
    return { stage, lastEvent, state: stageState() };

    function stageState(): RunStageState {
      if (!lastEvent) return "pending";
      if (running && latest?.stage === stage) return "active";
      if (stageEvents.some((event) => FAILURE_CODE.test(event.code))) return "failed";
      if (stage === "collection" && productFailed) return "failed";
      if (stage === "finalization") {
        if (status === "failed" || status === "interrupted") return "failed";
        if (status === "partial" || status === "cancelled") return "warning";
      }
      if (incomplete && latest?.stage === stage) return "failed";
      if (stage === "commit" && incomplete) return "warning";
      return "done";
    }
  });
}
