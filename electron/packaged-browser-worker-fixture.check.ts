import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import type { AutomationPersistenceProvider, AutomationTaskRun } from "../src/lib/automation/server/store.ts";
import {
  PACKAGED_BROWSER_FIXTURE_EXPECTED_VERSION_ENV,
  PACKAGED_BROWSER_FIXTURE_MARKER,
  PACKAGED_BROWSER_FIXTURE_TASKS,
  PACKAGED_BROWSER_FIXTURE_URL_ENV,
} from "../src/lib/automation/server/packaged-browser-fixture.ts";
import { runPackagedBrowserWorkerFixture } from "./packaged-browser-worker-fixture.ts";

const chromiumVersion = "151.0.7922.34";
const environment = {
  OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE: "1",
  [PACKAGED_BROWSER_FIXTURE_URL_ENV]: "http://127.0.0.1:43121/",
  [PACKAGED_BROWSER_FIXTURE_EXPECTED_VERSION_ENV]: chromiumVersion,
};

function taskRun(
  taskId: string,
  status: AutomationTaskRun["status"],
  outcome: AutomationTaskRun["appWorkflowOutcome"],
): AutomationTaskRun {
  const browserRuntime = { profileId: "default", profileRevision: 1, chromiumVersion };
  const recordJson = JSON.stringify({ browserRuntime });
  return {
    taskRunId: `${taskId}-run`,
    taskId,
    kind: "crawler",
    status,
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-29T00:00:00.000Z",
    finishedAt: status === "running" ? null : "2026-09-29T00:00:01.000Z",
    exitCode: status === "completed" ? 0 : status === "cancelled" ? null : 1,
    signal: null,
    events: [{
      runId: `${taskId}-run`,
      stage: "collection",
      code: "fixture-page-verified",
      occurredAt: "2026-09-29T00:00:00.100Z",
      completed: 1,
      total: 1,
    }],
    recordJson,
    humanAssistanceContract: null,
    browserRuntime,
    appWorkflowOutcome: outcome,
  };
}

function fakeProvider(runs: Map<string, AutomationTaskRun>): AutomationPersistenceProvider {
  return {
    automation: {
      async taskRunById(taskRunId: string) { return runs.get(taskRunId) ?? null; },
    },
  } as unknown as AutomationPersistenceProvider;
}

function fakePage(version = chromiumVersion, exposeBrowser = true): Page {
  const browser = exposeBrowser ? { version: () => version } : null;
  return {
    context() { return { browser: () => browser }; },
    isClosed() { return true; },
    async evaluate() {
      return `Mozilla/5.0 Chrome/${version} Safari/537.36`;
    },
  } as unknown as Page;
}

test("packaged fixture runs real success and cancel contracts with allow-listed runtime proof", async () => {
  const successTaskId = PACKAGED_BROWSER_FIXTURE_TASKS[0].taskId;
  const cancelTaskId = PACKAGED_BROWSER_FIXTURE_TASKS[1].taskId;
  const runs = new Map<string, AutomationTaskRun>([
    [`${successTaskId}-run`, taskRun(successTaskId, "completed", {
      errorCode: null,
      summary: { status: "completed", counts: {} },
    })],
    [`${cancelTaskId}-run`, taskRun(cancelTaskId, "running", null)],
  ]);
  const provider = fakeProvider(runs);
  const started: string[] = [];
  const cancelled: string[] = [];
  const pageChecks = new Map<string, number>();
  const result = await runPackagedBrowserWorkerFixture(provider, "/tmp/fixture-user-data", environment, {
    async startTask(taskId) {
      started.push(taskId);
      return {
        taskId,
        runId: `${taskId}-run`,
        runtime: { sessionId: "fixture", revision: 1, tasks: [] },
      };
    },
    async cancelTask(taskId) {
      cancelled.push(taskId);
      const run = runs.get(`${taskId}-run`);
      assert.ok(run);
      runs.set(run.taskRunId, {
        ...run,
        status: "cancelled",
        appWorkflowOutcome: { errorCode: "cancelled", summary: null },
      });
      return { cancelled: taskId };
    },
    pageForRun(taskRunId) {
      const count = pageChecks.get(taskRunId) ?? 0;
      pageChecks.set(taskRunId, count + 1);
      return count === 0 ? fakePage() : null;
    },
    pathExists: () => false,
    wait: async () => undefined,
    now: () => 0,
  });

  assert.deepEqual(started, [successTaskId, cancelTaskId]);
  assert.deepEqual(cancelled, [cancelTaskId]);
  assert.deepEqual(result, {
    status: "passed",
    success: {
      status: "completed",
      browserRuntime: { profileId: "default", profileRevision: 1, chromiumVersion },
      actualBrowserVersion: chromiumVersion,
      navigatorChromeVersion: chromiumVersion,
      navigatorChromeMajor: 151,
      browserContextClosed: true,
      hostPageReleased: true,
      runtimeProfileDirectoryRemoved: true,
      recordSanitized: true,
    },
    cancel: {
      status: "cancelled",
      browserRuntime: { profileId: "default", profileRevision: 1, chromiumVersion },
      actualBrowserVersion: chromiumVersion,
      navigatorChromeVersion: chromiumVersion,
      navigatorChromeMajor: 151,
      browserContextClosed: true,
      hostPageReleased: true,
      runtimeProfileDirectoryRemoved: true,
      recordSanitized: true,
    },
  });
  assert.equal(PACKAGED_BROWSER_FIXTURE_MARKER, "local-browser-ok");
});

test("packaged fixture fails closed if it cannot read the live host browser or versions disagree", async () => {
  const taskId = PACKAGED_BROWSER_FIXTURE_TASKS[0].taskId;
  const run = taskRun(taskId, "completed", {
    errorCode: null,
    summary: { status: "completed", counts: {} },
  });
  const provider = fakeProvider(new Map([[run.taskRunId, run]]));
  await assert.rejects(runPackagedBrowserWorkerFixture(provider, "/tmp/fixture-user-data", environment, {
    async startTask(id) {
      return { taskId: id, runId: run.taskRunId, runtime: { sessionId: "fixture", revision: 1, tasks: [] } };
    },
    async cancelTask(id) { return { cancelled: id }; },
    pageForRun: () => fakePage("150.0.1.2"),
    pathExists: () => false,
    wait: async () => undefined,
    now: () => 0,
  }), /versions did not match/u);
  await assert.rejects(runPackagedBrowserWorkerFixture(provider, "/tmp/fixture-user-data", environment, {
    async startTask(id) {
      return { taskId: id, runId: run.taskRunId, runtime: { sessionId: "fixture", revision: 1, tasks: [] } };
    },
    async cancelTask(id) { return { cancelled: id }; },
    pageForRun: () => fakePage(chromiumVersion, false),
    pathExists: () => false,
    wait: async () => undefined,
    now: () => 0,
  }), /no owning browser/u);
});
