import { writeSync } from "node:fs";

export const AUTOMATION_PROGRESS_FD_ENV = "LIBRETTO_AUTOMATION_PROGRESS_FD";

export type AutomationProgressEvent = {
  type: "progress";
  phaseCode: string | null;
  completed: number | null;
  total: number | null;
  percent: number | null;
  attempt?: number;
  params?: Readonly<Record<string, string | number | boolean>>;
};

function finiteNonNegative(value: number | null) {
  return value === null || Number.isFinite(value) ? value : null;
}

/**
 * Workflow-side producer for locale-neutral progress.  The lifecycle runner
 * receives this over a dedicated inherited pipe; it is deliberately separate
 * from stdout/stderr so diagnostic log text can never become UI state.
 */
export function emitAutomationProgress(input: Omit<AutomationProgressEvent, "type">) {
  const completed = finiteNonNegative(input.completed);
  const total = finiteNonNegative(input.total);
  const percent = finiteNonNegative(input.percent);
  const event: AutomationProgressEvent = {
    type: "progress",
    phaseCode: typeof input.phaseCode === "string" ? input.phaseCode : null,
    completed,
    total,
    percent,
    ...(Number.isFinite(input.attempt) ? { attempt: input.attempt } : {}),
    ...(input.params ? { params: input.params } : {}),
  };
  const fd = Number(process.env[AUTOMATION_PROGRESS_FD_ENV]);
  if (Number.isSafeInteger(fd) && fd >= 0) {
    try {
      writeSync(fd, JSON.stringify(event) + "\n");
      return;
    } catch {
      // The runner may be shutting down; progress is best-effort.
    }
  }
  // Direct workflow invocations have no lifecycle sink. Do not put a
  // progress string on stdout/stderr: the runner intentionally never parses
  // diagnostic logs as structured UI state.
}
