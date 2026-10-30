import { lastOperation } from "../failure-classification.ts";
import type { AutomationTaskRun } from "./store.ts";

type TaskRunFinishedListener = (run: AutomationTaskRun) => void;

const listeners = new Set<TaskRunFinishedListener>();

/** Hears every run the moment its terminal outcome is first persisted, so no runner has to announce it. */
export function onTaskRunFinished(listener: TaskRunFinishedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function announceTaskRunFinished(run: AutomationTaskRun): void {
  for (const listener of listeners) {
    try {
      listener(run);
    } catch {
      // A listener can never change a run's outcome.
    }
  }
}

export type RunFailure = Readonly<{ source: string; code: string; stage: string }>;

/**
 * What a finished run contributes to the failure counts of ADR 0078: one entry for a failed run,
 * one per failed product of a partly completed run, none for a run that completed, was cancelled
 * or was interrupted. A product failure records no stage of its own, so its stage is "unknown".
 */
export function runFailures(run: Pick<AutomationTaskRun, "taskId" | "status" | "events" | "appWorkflowOutcome">): RunFailure[] {
  if (run.status === "failed") {
    const code = run.appWorkflowOutcome?.errorCode ?? "workflow-failed";
    if (code === "cancelled") return [];
    return [{ source: run.taskId, code, stage: lastOperation(run.events)?.stage ?? "unknown" }];
  }
  if (run.status === "partial") {
    return (run.appWorkflowOutcome?.summary?.products ?? [])
      .filter((product) => product.status === "failed")
      .map((product) => ({ source: run.taskId, code: product.errorCode ?? "workflow-failed", stage: "unknown" }));
  }
  return [];
}
