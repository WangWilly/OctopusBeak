import type {
  AutomationDesktopModel,
  AutomationRuntimeSnapshot,
} from "../desktop/api.ts";
import { mergeAutomationRuntime } from "../automation/runtime-sync.ts";
import { isActiveAutomationRuntimeStatus } from "../automation/runtime-status.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import type { OnboardingControllerPort } from "./controller.ts";
import type { OnboardingOverviewReadiness, OnboardingRun } from "./state.ts";

export type OnboardingApplicationDependencies = Pick<
  OnboardingControllerPort,
  "persist" | "now" | "navigate"
> & {
  loadAutomation(): Promise<AutomationDesktopModel>;
  loadOverview(): Promise<OverviewPageDto>;
  runtimeSnapshot(): Promise<AutomationRuntimeSnapshot>;
  cancelTask(taskId: string, expectedRunId?: string): Promise<unknown>;
  forceTerminateTask(taskId: string, expectedRunId?: string): Promise<unknown>;
  wait?(milliseconds: number): Promise<void>;
  cancellationTimeoutMs?: number;
  cancellationPollIntervalMs?: number;
};

function sameTrackedRun(
  task: AutomationDesktopModel["automation"]["tasks"][number] | undefined,
  run: OnboardingRun,
) {
  if (!task || task.id !== run.taskId) return false;
  if (run.runId) return task.runId === run.runId;
  return Boolean(
    run.startedAt
    && task.latestStartedAt
    && Date.parse(task.latestStartedAt) >= Date.parse(run.startedAt),
  );
}

function hasConfirmedWorkflowNoData(task: AutomationDesktopModel["automation"]["tasks"][number]) {
  const outcome = task.appWorkflowOutcome;
  if (outcome?.errorCode !== null || !outcome.summary) return false;
  if (outcome.summary.status === "no-data") return true;
  const products = outcome.summary.products;
  return Boolean(
    products?.length
    && products.every((product) => product.status === "no_data" || product.status === "not_held"),
  );
}

function defaultWait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Adapts renderer services to onboarding operations. The adapter owns the
 * boundary between task identity, canonical runtime state, and a fresh Overview
 * read so the progression controller never has to inspect page components.
 */
export function createOnboardingApplicationPort(
  dependencies: OnboardingApplicationDependencies,
): OnboardingControllerPort {
  const wait = dependencies.wait ?? defaultWait;
  const timeout = dependencies.cancellationTimeoutMs ?? 45_000;
  const pollInterval = dependencies.cancellationPollIntervalMs ?? 200;

  async function readAutomation() {
    const [model, snapshot] = await Promise.all([
      dependencies.loadAutomation(),
      dependencies.runtimeSnapshot(),
    ]);
    return {
      model,
      snapshot,
      automation: mergeAutomationRuntime(model.automation, snapshot),
    };
  }

  async function prepareOverview(run: OnboardingRun) {
    const { automation } = await readAutomation();
    const task = automation.tasks.find((candidate) => candidate.id === run.taskId);
    if (!task || !sameTrackedRun(task, run)) {
      throw new Error("The onboarding workflow is no longer the current run.");
    }
    if (task.isActive || task.status !== "completed") {
      throw new Error("The onboarding workflow has not completed successfully.");
    }

    const overview = await dependencies.loadOverview();
    if (overview.availability === "unavailable") {
      throw new Error("The Overview data is unavailable. Retry the Overview read before continuing.");
    }
    if (overview.accounts.length > 0) return "accounts" satisfies OnboardingOverviewReadiness;
    if (overview.availability === "empty") return "empty" satisfies OnboardingOverviewReadiness;
    if (overview.availability === "awaiting" && hasConfirmedWorkflowNoData(task)) {
      return "workflow-no-data" satisfies OnboardingOverviewReadiness;
    }
    throw new Error("The Overview is still awaiting data and this workflow did not confirm an empty result.");
  }

  async function cancelRun(run: OnboardingRun) {
    const initial = await readAutomation();
    const task = initial.automation.tasks.find((candidate) => candidate.id === run.taskId);
    if (!task) throw new Error("The tracked onboarding workflow could not be verified.");

    if (!sameTrackedRun(task, run)) {
      if (run.runId) return;
      if (task.isActive) {
        throw new Error("The active workflow identity could not be verified; it was not cancelled.");
      }
      return;
    }
    if (!task.isActive) return;

    const expectedRunId = task.runId ?? run.runId;
    await dependencies.cancelTask(run.taskId, expectedRunId ?? undefined);

    const deadline = Date.now() + timeout;
    let forceRequested = false;
    while (Date.now() < deadline) {
      const snapshot = await dependencies.runtimeSnapshot();
      const currentRun = snapshot.tasks.find((candidate) => candidate.taskId === run.taskId);
      // The old run ceased to be current. Never cancel or terminate a newer run
      // that may have started under the same task ID.
      if (expectedRunId && currentRun?.runId !== expectedRunId) return;
      if (currentRun && !isActiveAutomationRuntimeStatus(currentRun.status)) return;

      let currentTask: AutomationDesktopModel["automation"]["tasks"][number] | undefined;
      if (!currentRun || !expectedRunId) {
        const latest = await dependencies.loadAutomation();
        const merged = mergeAutomationRuntime(latest.automation, snapshot);
        currentTask = merged.tasks.find((candidate) => candidate.id === run.taskId);
        if (!currentTask) {
          throw new Error("The tracked onboarding workflow disappeared before cancellation was confirmed.");
        }
        if (!sameTrackedRun(currentTask, run)) {
          if (expectedRunId) return;
          throw new Error("The tracked onboarding workflow identity changed during cancellation.");
        }
        if (!currentTask.isActive) return;
      }
      const forceTerminateAvailable = currentRun?.forceTerminateAvailable === true
        || currentTask?.forceTerminateAvailable === true;

      if (
        !forceRequested
        && currentRun?.status === "cancelling"
        && forceTerminateAvailable
        && (!expectedRunId || currentRun.runId === expectedRunId)
      ) {
        await dependencies.forceTerminateTask(run.taskId, expectedRunId ?? undefined);
        forceRequested = true;
      }
      await wait(pollInterval);
    }
    throw new Error("The tracked onboarding workflow did not stop before the cancellation timeout.");
  }

  return {
    persist: dependencies.persist,
    now: dependencies.now,
    navigate: dependencies.navigate,
    prepareOverview,
    cancelRun,
  };
}
