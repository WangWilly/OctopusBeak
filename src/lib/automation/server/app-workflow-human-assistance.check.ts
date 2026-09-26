import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import {
  createAppWorkflowHumanAssistancePort,
  registerAppWorkflowHumanAssistanceRequestHandler,
  resumeAppWorkflowHumanAssistance,
} from "./app-workflow-human-assistance.ts";

const contract: HumanAssistanceContractInput = {
  stageId: "sinopac-login-captcha",
  title: "Enter the SinoPac CAPTCHA",
  targets: [{
    id: "captcha-input",
    label: "CAPTCHA input",
    semanticId: "sinopac.login.captcha-input",
    modes: ["click", "type"],
    rect: { x: 1, y: 1, width: 10, height: 10 },
  }],
  contextRegions: [],
  challengeKind: "text-captcha",
  charset: "digits",
  challengeImageRegion: {
    id: "captcha-image",
    label: "CAPTCHA image",
    semanticId: "sinopac.login.captcha-image",
    rect: { x: 1, y: 1, width: 10, height: 10 },
  },
  completion: { mode: "inline", targetIds: ["captcha-input"] },
  focus: { targetId: "captcha-input", contextRegionIds: [] },
};

test("App workflow assistance lets the host route and resume the same waiting run", async () => {
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "sinopac-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 3,
      startedAt: new Date().toISOString(),
    });
    let releaseRoute!: () => void;
    let notifyRouteStarted!: () => void;
    const routeStarted = new Promise<void>((resolve) => { notifyRouteStarted = resolve; });
    const routeFinished = new Promise<void>((resolve) => { releaseRoute = resolve; });
    const humanAssistance = createAppWorkflowHumanAssistancePort({
      taskRunId: created.taskRunId,
      persistence: provider.automation,
      onRequest: async (_requestedContract, _signal) => {
        const waiting = await provider.automation.taskRunById(created.taskRunId);
        assert.equal(waiting?.status, "waiting_for_human");
        notifyRouteStarted();
        await provider.automation.updateHumanAssistanceCompletion(created.taskRunId, "entered");
        assert.equal(
          await resumeAppWorkflowHumanAssistance(created.taskRunId, "entered"),
          true,
        );
        await routeFinished;
      },
    });
    const controller = new AbortController();
    const request = humanAssistance.request(contract, controller.signal);
    await routeStarted;
    assert.equal(await request, "entered");
    assert.equal((await provider.automation.taskRunById(created.taskRunId))?.status, "running");
    releaseRoute();
  } finally {
    await store.close();
  }
});

test("App workflow assistance rejects a failed host route instead of leaving a dead waiter", async () => {
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "sinopac-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 3,
      startedAt: new Date().toISOString(),
    });
    const humanAssistance = createAppWorkflowHumanAssistancePort({
      taskRunId: created.taskRunId,
      persistence: provider.automation,
      onRequest: async () => { throw new Error("route failed"); },
    });
    const controller = new AbortController();
    await assert.rejects(
      humanAssistance.request(contract, controller.signal),
      /route failed/u,
    );
  } finally {
    await store.close();
  }
});

test("solver challenges fail when the App has no registered route", async () => {
  const store = new PGliteStore(await PGlite.create());
  const controller = new AbortController();
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "fubon-all-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const assistance = createAppWorkflowHumanAssistancePort({
      taskRunId: created.taskRunId,
      persistence: provider.automation,
      requireSolverRoute: true,
    });
    await assert.rejects(
      Promise.race([
        assistance.request(contract, controller.signal),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("Unrouted solver challenge did not fail")),
          1_000,
        )),
      ]),
      /solver route is unavailable/u,
    );
  } finally {
    controller.abort();
    await store.close();
  }
});

test("App workflow assistance dispatches the registered route by task and live run ID", async () => {
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "sinopac-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 3,
      startedAt: new Date().toISOString(),
    });
    let releaseRoute!: () => void;
    const routeFinished = new Promise<void>((resolve) => { releaseRoute = resolve; });
    const unregister = registerAppWorkflowHumanAssistanceRequestHandler(
      "sinopac-statements",
      async (request) => {
        assert.equal(request.taskRunId, created.taskRunId);
        assert.equal(request.contract.stageId, "sinopac-login-captcha");
        assert.equal(request.signal.aborted, false);
        await provider.automation.updateHumanAssistanceCompletion(created.taskRunId, "entered");
        assert.equal(
          await resumeAppWorkflowHumanAssistance(created.taskRunId, "entered"),
          true,
        );
        await routeFinished;
      },
    );
    try {
      const controller = new AbortController();
      const request = createAppWorkflowHumanAssistancePort({
        taskRunId: created.taskRunId,
        persistence: provider.automation,
      }).request(contract, controller.signal);
      assert.equal(await request, "entered");
    } finally {
      releaseRoute();
      unregister();
    }
  } finally {
    await store.close();
  }
});
