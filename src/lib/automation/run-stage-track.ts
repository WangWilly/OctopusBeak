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

export type ProductFailures = Readonly<{
  typeIds: readonly string[];
  /** Products the run tried; skipped ones were never collected. */
  attempted: number;
}>;

/** A product that collected and validated but whose commit was rejected or left unknown. */
const COMMIT_FAILURE_CODES: ReadonlySet<string> = new Set(["canonical-commit-failed", "commit-outcome-unknown"]);

/** Which products failed in this stage, out of those the run tried. Only collection and commit fail a product. */
export function productFailures(outcome: TypedWorkflowOutcome | null, stage: WorkflowStage): ProductFailures | null {
  if (stage !== "collection" && stage !== "commit") return null;
  const products = outcome?.summary?.products ?? [];
  const typeIds = products
    .filter((product) => product.status === "failed"
      && COMMIT_FAILURE_CODES.has(product.errorCode ?? "") === (stage === "commit"))
    .map((product) => product.typeId);
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
  const failedIn = (stage: WorkflowStage) => productFailures(outcome, stage) !== null;
  const productFailed = failedIn("collection") || failedIn("commit");
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
      if (failedIn(stage)) return "failed";
      // A failed product already explains the failure on its own node.
      if (stopped && stoppedStage === stage && !productFailed) return "failed";
      if (stage === "commit" && incomplete) return "warning";
      return "done";
    }
  });
}
