import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationPageModel } from "$lib/automation/types.ts";
import { resolveAutomationBlock } from "./progressive-dashboard-data.ts";

test("a settled automation block provides its own content and falls back to the route model", () => {
  const fallbackAutomation = {
    tasks: [{ id: "fallback-task" }],
  } as unknown as AutomationPageModel;
  const listAutomation = {
    ...fallbackAutomation,
    tasks: [{ id: "list-task" }],
  } as unknown as AutomationPageModel;
  const detailsAutomation = {
    ...fallbackAutomation,
    tasks: [{ id: "details-task" }],
  } as unknown as AutomationPageModel;

  assert.equal(
    resolveAutomationBlock(fallbackAutomation, {
      automation: listAutomation,
      credentialGroups: [],
    }).tasks[0]?.id,
    "list-task",
  );
  assert.equal(
    resolveAutomationBlock(fallbackAutomation, {
      automation: detailsAutomation,
      credentialGroups: [],
    }).tasks[0]?.id,
    "details-task",
  );
  assert.equal(resolveAutomationBlock(fallbackAutomation)?.tasks[0]?.id, "fallback-task");
});
