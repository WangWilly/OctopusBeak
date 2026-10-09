import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowContext } from "../workflow-executor.ts";
import { appWorkflowCatalogForEnvironment } from "./app-workflow-registry.ts";
import { automationTasksForEnvironment } from "./tasks.ts";
import {
  PACKAGED_BROWSER_FIXTURE_EVENT,
  PACKAGED_BROWSER_FIXTURE_MARKER,
  PACKAGED_BROWSER_FIXTURE_TASKS,
  packagedBrowserFixtureDefinition,
  packagedBrowserFixtureEnabled,
  packagedBrowserFixtureStartUrl,
} from "./packaged-browser-fixture.ts";

test("packaged browser fixture is gated by its exact opt-in flag and loopback URL", () => {
  assert.equal(packagedBrowserFixtureEnabled({}), false);
  assert.equal(packagedBrowserFixtureEnabled({ OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE: "true" }), false);
  const environment = {
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE: "1",
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL: "http://127.0.0.1:43121/",
  };
  assert.equal(packagedBrowserFixtureEnabled(environment), true);
  assert.equal(packagedBrowserFixtureStartUrl(environment), environment.OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL);
  assert.throws(() => packagedBrowserFixtureStartUrl({}), /disabled/u);
  assert.throws(() => packagedBrowserFixtureStartUrl({
    ...environment,
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL: "http://example.com/",
  }), /loopback/u);
  assert.throws(() => packagedBrowserFixtureStartUrl({
    ...environment,
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL: "http://127.0.0.1:43121/redirect?target=external",
  }), /loopback/u);
  assert.throws(() => packagedBrowserFixtureStartUrl({
    ...environment,
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL: "http://user@127.0.0.1:43121/",
  }), /loopback/u);
});

test("fixture tasks and definitions are added only in loopback fixture mode and require no credentials", () => {
  const environment = {
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE: "1",
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL: "http://127.0.0.1:43121/",
  };
  const fixtureTaskIds = PACKAGED_BROWSER_FIXTURE_TASKS.map(({ taskId }) => taskId);
  const fixtureTaskIdSet = new Set<string>(fixtureTaskIds);
  const normalTasks = automationTasksForEnvironment({});
  const fixtureTasks = automationTasksForEnvironment(environment);
  assert.equal(normalTasks.some((task) => fixtureTaskIdSet.has(task.id)), false);
  assert.deepEqual(fixtureTasks.filter((task) => fixtureTaskIdSet.has(task.id)).map((task) => ({
    id: task.id,
    workflowId: task.workflowId,
    credentialKeys: task.credentialKeys,
    credentialGroupId: task.credentialGroupId,
  })), [
    { id: fixtureTaskIds[0], workflowId: fixtureTaskIds[0], credentialKeys: [], credentialGroupId: undefined },
    { id: fixtureTaskIds[1], workflowId: fixtureTaskIds[1], credentialKeys: [], credentialGroupId: undefined },
  ]);
  const normalDefinitions = appWorkflowCatalogForEnvironment({});
  const fixtureDefinitions = appWorkflowCatalogForEnvironment(environment);
  assert.equal(normalDefinitions.some(({ definition }) => fixtureTaskIdSet.has(definition.id)), false);
  assert.deepEqual(fixtureDefinitions.filter(({ definition }) => fixtureTaskIdSet.has(definition.id)).map(({ definition, runtime }) => ({
    id: definition.id,
    requiresFinancialCommit: definition.requiresFinancialCommit,
    runtime,
  })), [
    { id: fixtureTaskIds[0], requiresFinancialCommit: false, runtime: { kind: "browser", startUrl: environment.OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL } },
    { id: fixtureTaskIds[1], requiresFinancialCommit: false, runtime: { kind: "browser", startUrl: environment.OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL } },
  ]);
});

function fixtureContext(marker: string | null, signal = new AbortController().signal) {
  const events: string[] = [];
  const context = {
    signal,
    browser: {
      async withPage(run: (page: never) => Promise<unknown>) {
        return await run({
          locator(selector: string) {
            assert.equal(selector, "#fixture");
            return { async textContent() { return marker; } };
          },
        } as never);
      },
    },
    async event(_stage: string, code: string) { events.push(code); },
  } as unknown as WorkflowContext;
  return { context, events };
}

test("fixture success workflow verifies only the inert page marker and emits a bounded event", async () => {
  const task = PACKAGED_BROWSER_FIXTURE_TASKS.find(({ taskId }) => taskId.endsWith("success"));
  assert.ok(task);
  const { context, events } = fixtureContext(PACKAGED_BROWSER_FIXTURE_MARKER);
  const result = await packagedBrowserFixtureDefinition(task.workflowId).run(context, null);
  assert.deepEqual(result, { status: "completed" });
  assert.deepEqual(events, [PACKAGED_BROWSER_FIXTURE_EVENT]);
});

test("fixture workflow rejects pages that do not contain the fixed local marker", async () => {
  const task = PACKAGED_BROWSER_FIXTURE_TASKS[0];
  const { context, events } = fixtureContext("unexpected content");
  await assert.rejects(packagedBrowserFixtureDefinition(task.workflowId).run(context, null), /page verification failed/u);
  assert.deepEqual(events, []);
});

test("fixture cancellation workflow remains active after page verification until its worker is cancelled", async () => {
  const task = PACKAGED_BROWSER_FIXTURE_TASKS.find(({ taskId }) => taskId.endsWith("cancel"));
  assert.ok(task);
  const controller = new AbortController();
  const { context, events } = fixtureContext(PACKAGED_BROWSER_FIXTURE_MARKER, controller.signal);
  const pending = packagedBrowserFixtureDefinition(task.workflowId).run(context, null);
  while (events.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [PACKAGED_BROWSER_FIXTURE_EVENT]);
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(pending, /fixture cancellation/u);
});
