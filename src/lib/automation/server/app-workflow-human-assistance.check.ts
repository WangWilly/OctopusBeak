import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import {
  completeAppWorkflowHumanAssistance,
  createAppWorkflowHumanAssistancePort,
  type AppWorkflowHumanAssistanceRequest,
} from "./app-workflow-human-assistance.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import { openExecutionForCheck, openTaskRunForCheck } from "./task-run-check-support.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

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

async function withRunningRun(
  taskId: string,
  check: (provider: AutomationPersistenceProvider, taskRunId: string) => Promise<void>,
) {
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId,
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 3,
      startedAt: new Date().toISOString(),
    });
    await check(provider, created.taskRunId);
  } finally {
    await store.close();
  }
}

/** Resolves with each request the route receives; the route itself never settles the stage. */
function capturingRoute() {
  const requests: AppWorkflowHumanAssistanceRequest[] = [];
  let notify: (() => void) | undefined;
  return {
    requests,
    route(request: AppWorkflowHumanAssistanceRequest) {
      requests.push(request);
      notify?.();
    },
    async next(count: number) {
      while (requests.length < count) await new Promise<void>((resolve) => { notify = resolve; });
      return requests[count - 1]!;
    },
  };
}

test("App workflow assistance lets the execution's route resume the same waiting run", () =>
  withRunningRun("sinopac-statements", async (provider, taskRunId) => {
    let releaseRoute!: () => void;
    const routeFinished = new Promise<void>((resolve) => { releaseRoute = resolve; });
    const humanAssistance = createAppWorkflowHumanAssistancePort(
      await openExecutionForCheck(provider.automation, taskRunId, async (request) => {
        assert.equal(request.run.taskRunId, taskRunId);
        assert.equal(request.contract.stageId, "sinopac-login-captcha");
        assert.equal(request.signal.aborted, false);
        assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "waiting_for_human");
        assert.equal(request.run.current().humanAssistanceContract?.stageId, "sinopac-login-captcha");
        await completeAppWorkflowHumanAssistance(request);
        await routeFinished;
      }),
    );
    try {
      assert.equal(await humanAssistance.request(contract, new AbortController().signal), "entered");
      const stored = await provider.automation.taskRunById(taskRunId);
      assert.equal(stored?.status, "running");
      assert.equal(stored?.humanAssistanceContract?.completion.status, "entered");
    } finally {
      releaseRoute();
    }
  }));

test("App workflow assistance rejects a failed host route instead of leaving a dead waiter", () =>
  withRunningRun("sinopac-statements", async (provider, taskRunId) => {
    const { run, execution } = await openExecutionForCheck(provider.automation, taskRunId, async () => {
      throw new Error("route failed");
    });
    await assert.rejects(
      createAppWorkflowHumanAssistancePort({ run, execution }).request(contract, new AbortController().signal),
      /route failed/u,
    );
    assert.equal(execution.pendingAssistance(), null);
  }));

test("solver challenges fail when the execution has no route", async () => {
  const controller = new AbortController();
  await withRunningRun("fubon-all-statements", async (provider, taskRunId) => {
    const { run, execution } = await openExecutionForCheck(provider.automation, taskRunId);
    const assistance = createAppWorkflowHumanAssistancePort({ run, execution });
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
    assert.ok((await provider.automation.taskRunById(taskRunId))?.events.some(
      (event) => event.code === "solver-route-unavailable",
    ));
    assert.deepEqual(
      execution.events().map((event) => event.signal),
      ["solver-route-unavailable"],
      "the host signal is logged on the execution that requested assistance",
    );
    await assert.rejects(
      assistance.request({ ...contract, stageId: "unknown-manual-stage", challengeKind: undefined }, controller.signal),
      /solver route is unavailable/u,
    );
    const failedClosed = await provider.automation.taskRunById(taskRunId);
    assert.equal(failedClosed?.status, "running", "unsupported solver work never enters an unavailable waiting state");
    assert.ok(failedClosed?.events.some((event) => event.code === "solver-challenge-unsupported"));
  }).finally(() => controller.abort());
});

test("a cancelled run cannot enter a verification stage", () =>
  withRunningRun("sinopac-statements", async (provider, taskRunId) => {
    const run = await openTaskRunForCheck(provider.automation, taskRunId);
    let routed = false;
    await run.requestStop("cancelled");
    const execution = run.beginExecution("cancelled-check", { assistanceRoute: () => { routed = true; } });
    await assert.rejects(
      createAppWorkflowHumanAssistancePort({ run, execution }).request(contract, new AbortController().signal),
      /not active for human assistance/u,
    );
    assert.equal(routed, false);
    assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "cancelling");
  }));

test("cancelling the run rejects a request waiting on its route", () =>
  withRunningRun("sinopac-statements", async (provider, taskRunId) => {
    const routes = capturingRoute();
    const { run, execution } = await openExecutionForCheck(provider.automation, taskRunId, routes.route);
    // The worker's request signal follows the run's stop, as the supervisor's does.
    const waiting = createAppWorkflowHumanAssistancePort({ run, execution }).request(contract, run.signal);
    await routes.next(1);
    assert.notEqual(execution.pendingAssistance(), null);
    await run.requestStop("cancelled");
    await assert.rejects(waiting);
    assert.equal(execution.pendingAssistance(), null);
    assert.equal(run.current().status, "cancelling");
  }));

test("ending an execution releases its route and rejects its waiting request", () =>
  withRunningRun("sinopac-statements", async (provider, taskRunId) => {
    const routes = capturingRoute();
    const { run, execution } = await openExecutionForCheck(provider.automation, taskRunId, routes.route);
    assert.equal(execution.assistanceRoute(), routes.route);
    const waiting = createAppWorkflowHumanAssistancePort({ run, execution })
      .request(contract, new AbortController().signal);
    const request = await routes.next(1);
    execution.end();
    await assert.rejects(waiting, /has ended/u);
    assert.equal(execution.assistanceRoute(), null);
    assert.equal(execution.pendingAssistance(), null);
    assert.throws(() => execution.holdAssistance(), /has ended/u);
    await assert.rejects(
      completeAppWorkflowHumanAssistance(request),
      /no longer current/u,
      "a route that outlives its execution finds no waiter to resume",
    );
  }));

test("each execution of a run has its own route and cannot see an earlier execution's waiter", () =>
  withRunningRun("sinopac-statements", async (provider, taskRunId) => {
    const run = await openTaskRunForCheck(provider.automation, taskRunId);
    const firstRoutes = capturingRoute();
    const first = run.beginExecution("round-1", { assistanceRoute: firstRoutes.route });
    const firstWaiting = createAppWorkflowHumanAssistancePort({ run, execution: first })
      .request(contract, new AbortController().signal);
    const firstRequest = await firstRoutes.next(1);
    first.end();
    await assert.rejects(firstWaiting, /has ended/u);
    assert.equal(await run.transition("running"), true);

    const secondRoutes = capturingRoute();
    const second = run.beginExecution("round-2", { assistanceRoute: secondRoutes.route });
    assert.equal(second.assistanceRoute(), secondRoutes.route);
    assert.equal(second.pendingAssistance(), null, "the first execution's waiter is not the second's");
    const secondWaiting = createAppWorkflowHumanAssistancePort({ run, execution: second })
      .request(contract, new AbortController().signal);
    const secondRequest = await secondRoutes.next(1);
    assert.equal(firstRoutes.requests.length, 1, "the first execution's route never sees the second's request");
    await assert.rejects(completeAppWorkflowHumanAssistance(firstRequest), /no longer current/u);
    assert.equal(run.current().status, "waiting_for_human");
    assert.equal(run.current().humanAssistanceContract?.completion.status, "pending");
    await completeAppWorkflowHumanAssistance(secondRequest);
    assert.equal(await secondWaiting, "entered");
    second.end();
  }));
