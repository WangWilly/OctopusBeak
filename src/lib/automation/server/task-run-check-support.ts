import { openActiveTaskRun, type ActiveAutomationTaskRun } from "./active-task-run.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { AutomationPersistencePort, AutomationTaskRun } from "./store.ts";
import {
  runAutomationTaskExecution,
  type AutomationTaskExecutionOptions,
} from "./task-run-execution.ts";
import type { taskById } from "./tasks.ts";
import type { TypedWorkflowOutcome } from "./typed-workflow-outcome.ts";

/** Own an existing persisted run in a check, publishing to a private runtime snapshot. */
export async function openTaskRunForCheck(
  persistence: AutomationPersistencePort,
  taskRunId: string,
): Promise<ActiveAutomationTaskRun> {
  const row = await persistence.taskRunById(taskRunId);
  if (!row) throw new Error(`Missing automation task run: ${taskRunId}`);
  return openActiveTaskRun({
    run: row,
    persistence,
    runtime: createAutomationRuntimeState(),
  });
}

/** Execute one workflow round over an existing run and finish it, as the runner does. */
export async function executeTaskRunForCheck(
  task: NonNullable<ReturnType<typeof taskById>>,
  persistence: AutomationPersistencePort,
  options: AutomationTaskExecutionOptions & Readonly<{
    taskRunId: string;
    onRunOpened?: (run: ActiveAutomationTaskRun) => void;
  }>,
): Promise<{
  status: AutomationTaskRun["status"];
  taskRunId: string;
  run: AutomationTaskRun;
  outcome: TypedWorkflowOutcome;
}> {
  const { taskRunId, onRunOpened, ...executionOptions } = options;
  const active = await openTaskRunForCheck(persistence, taskRunId);
  onRunOpened?.(active);
  const outcome = await runAutomationTaskExecution(task, active, executionOptions);
  const run = await active.finish(outcome);
  return { status: run.status, taskRunId, run, outcome };
}
