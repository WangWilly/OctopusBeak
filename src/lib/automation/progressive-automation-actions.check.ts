import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationPageModel, AutomationTaskRow } from "./types.ts";
import type { DashboardBlockValueMap } from "$lib/shared-shell/dashboard-blocks.ts";
import {
  automationStageTasks,
  dispatchAutomationStageSync,
} from "./progressive-automation-actions.ts";

const task = (id: string) => ({ id } as unknown as AutomationTaskRow);

test("the sync action receives displayed list-block tasks and falls back to the route model", () => {
  const fallbackTask = task("fallback-task");
  const blockTask = task("block-task");
  const fallback = {
    tasks: [fallbackTask],
    parallelRunnableTaskIds: [fallbackTask.id],
  } as unknown as AutomationPageModel;
  const blockAutomation = {
    ...fallback,
    tasks: [blockTask],
    parallelRunnableTaskIds: [blockTask.id],
  } as unknown as AutomationPageModel;
  const listBlock = {
    automation: blockAutomation,
    credentialGroups: [],
  } as unknown as DashboardBlockValueMap["automation"]["list"];

  let received: AutomationTaskRow[] | undefined;
  const blockTasks = automationStageTasks(fallback, listBlock);
  dispatchAutomationStageSync(blockTasks, (tasks) => { received = tasks; });
  assert.strictEqual(received, blockAutomation.tasks);

  received = undefined;
  const fallbackTasks = automationStageTasks(fallback);
  dispatchAutomationStageSync(fallbackTasks, (tasks) => { received = tasks; });
  assert.strictEqual(received, fallback.tasks);
});
