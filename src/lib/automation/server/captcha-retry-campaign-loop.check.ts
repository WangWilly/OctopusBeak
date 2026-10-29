import assert from "node:assert/strict";
import test from "node:test";
import { createPgliteOperationalProvider } from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import type { WorkflowRunEvent } from "../run-event.ts";
import {
  MAX_CAPTCHA_RETRY_ROUNDS,
  createCaptchaRetryCampaign,
  decideAfterRound,
  runCaptchaRetryCampaign,
  transitionCaptchaRetryCampaign,
  type CaptchaRetryCampaign,
  type CaptchaRetryCampaignRun,
  type CaptchaRound,
  type CaptchaRoundRequest,
  type CaptchaRoundResult,
} from "./captcha-retry-campaign.ts";
import { captchaRoundExecution } from "./captcha-round-execution.ts";
import type { ActiveTaskRunFields, TaskRunOutcome, TaskRunReport } from "./active-task-run.ts";
import { readAutomationSettings } from "./settings.ts";
import {
  appWorkflowRoutesVerification,
  captchaRetryCooldownMs,
  sourceVerificationRoute,
} from "./verification-routing.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import { openTaskRunForCheck } from "./task-run-check-support.ts";

const SUCCEEDED: TaskRunReport = { summary: null, failure: null };
const WORKFLOW_FAILED: TaskRunReport = { summary: null, failure: { code: "workflow-failed", proven: true } };
const SOLVER_EXHAUSTED = { kind: "retryable", reason: "solver-exhausted" } as const;
const noCooldown = () => undefined;

/** The outcome a real run gives a report when no stop and no Commit attempt applies. */
function assessReport(report: TaskRunReport): TaskRunOutcome {
  const errorCode = report.failure?.code ?? null;
  const status = errorCode === null
    ? report.summary?.status === "partial" ? "partial" : "completed"
    : errorCode === "cancelled" ? "cancelled" : "failed";
  return { status, errorCode, summary: report.summary, forced: false };
}

type TransitionCall = Readonly<{ status: string; fields?: ActiveTaskRunFields }>;

/** A recording Active run whose stop, assessment and admission each check controls. */
function fakeRun(options: Readonly<{
  admit?: boolean;
  assess?: (report: TaskRunReport) => TaskRunOutcome;
}> = {}) {
  const controller = new AbortController();
  const updates: ActiveTaskRunFields[] = [];
  const transitions: TransitionCall[] = [];
  const events: WorkflowRunEvent[] = [];
  const run: CaptchaRetryCampaignRun = {
    taskRunId: "run-1",
    signal: controller.signal,
    assess: options.assess ?? assessReport,
    async update(fields) {
      updates.push(fields);
    },
    async transition(status, fields) {
      transitions.push({ status, fields });
      return options.admit ?? true;
    },
    async appendEvent(event) {
      events.push(event);
    },
  };
  return { run, controller, updates, transitions, events };
}

type FakeRoundStep = Readonly<{
  /** The round captures its challenge before it ends. */
  capture?: boolean;
  result: CaptchaRoundResult;
  /** Runs after the capture, while the round is still executing. */
  during?: () => void;
}>;

/** A round adapter that answers each round with the next canned step. */
function fakeRound(steps: readonly FakeRoundStep[]) {
  const requests: Omit<CaptchaRoundRequest, "onChallengeCaptured">[] = [];
  const executeRound: CaptchaRound = async ({ onChallengeCaptured, ...request }) => {
    requests.push(request);
    const step = steps[requests.length - 1];
    assert.ok(step, `unexpected round ${requests.length}`);
    if (step.capture) await onChallengeCaptured();
    step.during?.();
    return step.result;
  };
  return { executeRound, requests, attempts: () => requests.map((request) => request.attempt) };
}

const exhaustedRound = (report = WORKFLOW_FAILED): FakeRoundStep => ({
  capture: true,
  result: { report, routing: SOLVER_EXHAUSTED },
});

// The text CAPTCHA tasks the App routes; the campaign treats them alike.
for (const taskId of [
  "fubon-all-statements",
  "yuanta-all-statements",
  "hncb-statements",
  "post-statements",
  "einvoice-personal-invoices",
]) {
  test(`${taskId} retries solver exhaustion in one more round`, async () => {
    assert.equal(appWorkflowRoutesVerification(taskId), true, `${taskId} routes its verification`);
    const { run, updates, transitions } = fakeRun();
    const round = fakeRound([exhaustedRound(), { result: { report: SUCCEEDED } }]);
    const report = await runCaptchaRetryCampaign({
      taskId,
      run,
      executeRound: round.executeRound,
      captchaRetryCooldownMs: noCooldown,
    });
    assert.deepEqual(report, SUCCEEDED);
    assert.deepEqual(round.attempts(), [1, 2]);
    assert.deepEqual(round.requests.map(({ maxAttempts, retrying }) => ({ maxAttempts, retrying })), [
      { maxAttempts: 1, retrying: false },
      { maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS, retrying: true },
    ]);
    assert.notEqual(round.requests[0]?.executionId, round.requests[1]?.executionId);
    assert.deepEqual(updates, [{ attempt: 1, maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS }]);
    assert.deepEqual(transitions, [
      { status: "running", fields: { attempt: 2, maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS } },
    ]);
  });
}

test("Yuanta Trade audio solver exhaustion restarts without a cooldown", async () => {
  assert.ok(sourceVerificationRoute("yuanta-trade-statements"), "Yuanta Trade routes through its own source route");
  assert.equal(captchaRetryCooldownMs("yuanta-trade-statements"), undefined, "Yuanta Trade declares no cooldown");
  const { run } = fakeRun();
  const round = fakeRound([exhaustedRound(), { result: { report: SUCCEEDED } }]);
  const report = await runCaptchaRetryCampaign({
    taskId: "yuanta-trade-statements",
    run,
    executeRound: round.executeRound,
  });
  assert.deepEqual(report, SUCCEEDED);
  assert.deepEqual(round.attempts(), [1, 2]);
});

test("a captured challenge records its round on the run before the round ends", async () => {
  const { run, updates } = fakeRun();
  const seenDuringRounds: ActiveTaskRunFields[][] = [];
  const during = () => seenDuringRounds.push([...updates]);
  const round = fakeRound([
    { ...exhaustedRound(), during },
    { ...exhaustedRound(), during },
    { capture: true, result: { report: SUCCEEDED }, during },
  ]);
  await runCaptchaRetryCampaign({
    taskId: "sinopac-statements",
    run,
    executeRound: round.executeRound,
    captchaRetryCooldownMs: noCooldown,
  });
  assert.deepEqual(seenDuringRounds.map((seen) => seen.at(-1)?.attempt), [1, 2, 3]);
  assert.ok(updates.every((fields) => fields.maxAttempts === MAX_CAPTCHA_RETRY_ROUNDS));
});

test("exhausted solver retries finish with a typed verification failure and a run signal", async () => {
  const { run, events } = fakeRun();
  const summary = { status: "failed", counts: { itemCount: 0, committedCount: 0 }, products: [] } as const;
  const round = fakeRound([
    exhaustedRound(),
    exhaustedRound(),
    exhaustedRound({ summary, failure: { code: "workflow-failed", proven: true } }),
  ]);
  const report = await runCaptchaRetryCampaign({
    taskId: "fubon-all-statements",
    run,
    executeRound: round.executeRound,
    captchaRetryCooldownMs: noCooldown,
  });
  assert.deepEqual(report, { summary, failure: { code: "verification-failed", proven: true } });
  assert.deepEqual(round.attempts(), [1, 2, 3]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.code, "verification-solver-exhausted");
  assert.equal(events[0]?.runId, "run-1");
});

for (const scenario of [
  {
    name: "a failed verification route",
    step: { capture: true, result: { report: WORKFLOW_FAILED, routing: { kind: "failed" } } },
  },
  { name: "a workflow failure before any CAPTCHA", step: { result: { report: WORKFLOW_FAILED } } },
] satisfies readonly { name: string; step: FakeRoundStep }[]) {
  test(`${scenario.name} runs exactly one round and never restarts`, async () => {
    const { run, transitions } = fakeRun();
    const round = fakeRound([scenario.step]);
    const report = await runCaptchaRetryCampaign({
      taskId: "fubon-all-statements",
      run,
      executeRound: round.executeRound,
      captchaRetryCooldownMs: noCooldown,
    });
    assert.deepEqual(report, WORKFLOW_FAILED);
    assert.deepEqual(round.attempts(), [1]);
    assert.deepEqual(transitions, []);
  });
}

test("a run the store refused until a Canonical Reset is never retried", async () => {
  const { run } = fakeRun({
    assess: (report) => ({ ...assessReport(report), status: "partial", errorCode: "canonical-reset-required" }),
  });
  const report: TaskRunReport = {
    failure: null,
    summary: {
      status: "partial",
      counts: { itemCount: 2, committedCount: 1 },
      products: [
        { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
        { typeId: "credit_card", status: "failed", itemCount: 1, committedCount: 0, errorCode: "canonical-reset-required" },
      ],
    },
  };
  const round = fakeRound([exhaustedRound(report)]);
  const result = await runCaptchaRetryCampaign({
    taskId: "fubon-all-statements",
    run,
    executeRound: round.executeRound,
    captchaRetryCooldownMs: noCooldown,
  });
  assert.equal(result, report);
  assert.deepEqual(round.attempts(), [1]);
});

test("a cancellation during the source's retry cooldown ends the campaign without another round", async () => {
  const { run, controller } = fakeRun();
  const round = fakeRound([{
    ...exhaustedRound(),
    during: () => setTimeout(() => controller.abort("cancelled"), 50),
  }]);
  const started = Date.now();
  const report = await runCaptchaRetryCampaign({
    taskId: "fubon-all-statements",
    run,
    executeRound: round.executeRound,
    captchaRetryCooldownMs: () => 10_000,
  });
  assert.ok(Date.now() - started < 2_000, "the stop ends the cooldown at once");
  assert.deepEqual(round.attempts(), [1], "no round starts after the stop");
  assert.equal(report, WORKFLOW_FAILED);
});

test("Fubon waits out its login cooldown before the next CAPTCHA round", async () => {
  assert.ok((captchaRetryCooldownMs("fubon-all-statements") ?? 0) >= 20_000);
  assert.equal(captchaRetryCooldownMs("sinopac-statements"), undefined);
  const { run } = fakeRun();
  let firstRoundEnded = 0;
  let secondRoundStarted = 0;
  const steps = [exhaustedRound(), { result: { report: SUCCEEDED } }];
  const round = fakeRound(steps);
  const report = await runCaptchaRetryCampaign({
    taskId: "fubon-all-statements",
    run,
    executeRound: async (request) => {
      if (request.attempt === 2) secondRoundStarted = Date.now();
      const result = await round.executeRound(request);
      if (request.attempt === 1) firstRoundEnded = Date.now();
      return result;
    },
    captchaRetryCooldownMs: () => 60,
  });
  assert.deepEqual(report, SUCCEEDED);
  assert.ok(secondRoundStarted - firstRoundEnded >= 55);
});

test("a refused admission ends the campaign: failed while running, as reported once stopped", async () => {
  const running = fakeRun({ admit: false });
  const report = await runCaptchaRetryCampaign({
    taskId: "sinopac-statements",
    run: running.run,
    executeRound: fakeRound([exhaustedRound({ summary: null, failure: null })]).executeRound,
    captchaRetryCooldownMs: noCooldown,
  });
  assert.deepEqual(report, { summary: null, failure: { code: "workflow-failed", proven: false } });

  const stopped = fakeRun({ admit: false });
  const stoppedReport: TaskRunReport = { summary: null, failure: null };
  const result = await runCaptchaRetryCampaign({
    taskId: "sinopac-statements",
    run: {
      ...stopped.run,
      // The stop lands after the round's decision, while admission is refused.
      transition: async (status, fields) => {
        stopped.controller.abort("cancelled");
        return stopped.run.transition(status, fields);
      },
    },
    executeRound: fakeRound([exhaustedRound(stoppedReport)]).executeRound,
    captchaRetryCooldownMs: noCooldown,
  });
  assert.equal(result, stoppedReport);
});

async function withRun(
  taskId: string,
  check: (provider: AutomationPersistenceProvider, taskRunId: string) => Promise<void>,
) {
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    const provider = createPgliteOperationalProvider(store);
    const { taskRunId } = await provider.automation.createTaskRun({
      taskId,
      kind: taskId === "exchange-rates" ? "sync" : "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    await check(provider, taskRunId);
  } finally {
    await store.close();
  }
}

const noHostedPage = () => null;

test("a nonbrowser campaign executes once, routes nothing and leaves finalization to the run", () =>
  withRun("exchange-rates", async (provider, taskRunId) => {
    const run = await openTaskRunForCheck(provider.automation, taskRunId);
    let executions = 0;
    let verificationRoutes = 0;
    const report = await runCaptchaRetryCampaign({
      taskId: "exchange-rates",
      run,
      executeRound: captchaRoundExecution({
        taskId: "exchange-rates",
        appWorkflow: false,
        pageForRun: noHostedPage,
        run,
        launchVerificationSettings: readAutomationSettings(),
        routeWaitingRunVerification: async () => {
          verificationRoutes += 1;
          return { kind: "resumed" };
        },
        async execute(options) {
          executions += 1;
          assert.equal(options.assistanceRoute, undefined);
          return { summary: null, failure: null };
        },
      }),
    });
    assert.deepEqual(report, { summary: null, failure: null });
    assert.equal(executions, 1);
    assert.equal(verificationRoutes, 0);
    assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "running");
    assert.equal((await run.finish(report)).status, "completed");
  }));

test("SinoPac cancellation preserves an ambiguous commit and does not retry", () =>
  withRun("sinopac-statements", async (provider, taskRunId) => {
    const run = await openTaskRunForCheck(provider.automation, taskRunId);
    await run.requestStop("cancelled");
    let executions = 0;
    const report = await runCaptchaRetryCampaign({
      taskId: "sinopac-statements",
      run,
      executeRound: captchaRoundExecution({
        taskId: "sinopac-statements",
        appWorkflow: true,
        pageForRun: noHostedPage,
        run,
        launchVerificationSettings: readAutomationSettings(),
        async execute() {
          executions += 1;
          await run.recordCommitAttempt({ phase: "started", attemptId: "sinopac-attempt", product: null, total: 1 });
          return { summary: null, failure: { code: "workflow-failed", proven: false } };
        },
      }),
    });
    assert.equal(executions, 1);
    const finalRun = await run.finish(report);
    assert.equal(finalRun.status, "failed");
    assert.equal(finalRun.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
  }));

for (const stop of ["cancelled", "forced", "shutdown"] as const) {
  test(`a ${stop} stop ends the CAPTCHA retry cooldown at once`, () =>
    withRun("fubon-all-statements", async (provider, taskRunId) => {
      const run = await openTaskRunForCheck(provider.automation, taskRunId);
      const round = fakeRound([exhaustedRound()]);
      const started = Date.now();
      const stopping = new Promise<void>((resolve) => {
        setTimeout(() => resolve(run.requestStop(stop)), 20);
      });
      const report = await runCaptchaRetryCampaign({
        taskId: "fubon-all-statements",
        run,
        executeRound: round.executeRound,
        captchaRetryCooldownMs: () => 10_000,
      });
      assert.ok(Date.now() - started < 1_000);
      assert.equal(report, WORKFLOW_FAILED);
      assert.deepEqual(round.attempts(), [1]);
      await stopping;
    }));
}

// decideAfterRound: each precedence step, with every later step's trigger present.

function capturedAt(round: number): CaptchaRetryCampaign {
  let campaign: CaptchaRetryCampaign = createCaptchaRetryCampaign();
  for (let next = 1; next <= round; next += 1) {
    if (next > 1) {
      campaign = transitionCaptchaRetryCampaign(campaign, {
        kind: "round-outcome",
        executionId: `execution-${next - 1}`,
        outcome: { kind: "retryable", reason: "solver-exhausted" },
      });
    }
    campaign = transitionCaptchaRetryCampaign(campaign, { kind: "challenge-captured", executionId: `execution-${next}` });
  }
  return campaign;
}

const assessedAs = (status: TaskRunOutcome["status"], errorCode: TaskRunOutcome["errorCode"] = null) => ({
  status,
  errorCode,
});

const summary = { status: "failed", counts: { itemCount: 1, committedCount: 0 }, products: [] } as const;
const ROUND_REPORT: TaskRunReport = { summary, failure: null };

for (const row of [
  {
    name: "an unknown commit outcome outranks a failed route",
    input: { campaign: capturedAt(1), assessed: assessedAs("failed", "commit-outcome-unknown"), routing: { kind: "failed" } as const, aborted: false },
    expected: { kind: "stop", report: ROUND_REPORT, status: "awaiting-outcome", exhausted: false },
  },
  {
    name: "an unknown commit outcome stops with the report, before a stop or a retry",
    input: { campaign: capturedAt(1), assessed: assessedAs("failed", "commit-outcome-unknown"), routing: SOLVER_EXHAUSTED, aborted: true },
    expected: { kind: "stop", report: ROUND_REPORT, status: "awaiting-outcome", exhausted: false },
  },
  {
    name: "a required Canonical Reset stops with the report, before a failed route",
    input: { campaign: capturedAt(1), assessed: assessedAs("partial", "canonical-reset-required"), routing: { kind: "failed" }, aborted: true },
    expected: { kind: "stop", report: ROUND_REPORT, status: "awaiting-outcome", exhausted: false },
  },
  {
    name: "a failed route fails the report, before a stop",
    input: { campaign: capturedAt(1), assessed: assessedAs("cancelled", "cancelled"), routing: { kind: "failed" }, aborted: true },
    expected: {
      kind: "stop",
      report: { summary, failure: { code: "workflow-failed", proven: false } },
      status: "awaiting-outcome",
      exhausted: false,
    },
  },
  {
    name: "a stopped run cancels the campaign, before a retry",
    input: { campaign: capturedAt(1), assessed: assessedAs("failed", "workflow-failed"), routing: SOLVER_EXHAUSTED, aborted: true },
    expected: { kind: "stop", report: ROUND_REPORT, status: "cancelled", exhausted: false },
  },
  {
    name: "a cancelled report cancels the campaign, before a retry",
    input: { campaign: capturedAt(1), assessed: assessedAs("cancelled", "cancelled"), routing: SOLVER_EXHAUSTED, aborted: false },
    expected: { kind: "stop", report: ROUND_REPORT, status: "cancelled", exhausted: false },
  },
  {
    name: "a retryable route without a captured challenge fails the report",
    input: { campaign: createCaptchaRetryCampaign(), assessed: assessedAs("completed"), routing: SOLVER_EXHAUSTED, aborted: false },
    expected: {
      kind: "stop",
      report: { summary, failure: { code: "workflow-failed", proven: false } },
      status: "ready",
      exhausted: false,
    },
  },
  {
    name: "a retryable route with rounds left retries the next round",
    input: { campaign: capturedAt(2), assessed: assessedAs("failed", "workflow-failed"), routing: { kind: "retryable", reason: "provider-rejected" }, aborted: false },
    expected: { kind: "retry", nextRound: 3, status: "ready" },
  },
  {
    name: "a retryable route in the last round exhausts the campaign with a verification failure",
    input: { campaign: capturedAt(MAX_CAPTCHA_RETRY_ROUNDS), assessed: assessedAs("failed", "workflow-failed"), routing: SOLVER_EXHAUSTED, aborted: false },
    expected: {
      kind: "stop",
      report: { summary, failure: { code: "verification-failed", proven: true } },
      status: "exhausted",
      exhausted: true,
    },
  },
  {
    name: "a completed round with a captured challenge completes the campaign",
    input: { campaign: capturedAt(1), assessed: assessedAs("completed"), routing: { kind: "resumed" }, aborted: false },
    expected: { kind: "stop", report: ROUND_REPORT, status: "completed", exhausted: false },
  },
  {
    name: "a failed round with a captured challenge stops with its report and leaves the campaign awaiting",
    input: { campaign: capturedAt(1), assessed: assessedAs("failed", "workflow-failed"), routing: { kind: "resumed" }, aborted: false },
    expected: { kind: "stop", report: ROUND_REPORT, status: "awaiting-outcome", exhausted: false },
  },
  {
    name: "a round that routed nothing stops with its report",
    input: { campaign: createCaptchaRetryCampaign(), assessed: assessedAs("completed"), routing: undefined, aborted: false },
    expected: { kind: "stop", report: ROUND_REPORT, status: "ready", exhausted: false },
  },
] as const) {
  test(`decideAfterRound: ${row.name}`, () => {
    const decision = decideAfterRound({ ...row.input, report: ROUND_REPORT });
    const { expected } = row;
    assert.equal(decision.kind, expected.kind);
    assert.equal(decision.campaign.status, expected.status);
    if (decision.kind === "retry" && expected.kind === "retry") {
      assert.equal(decision.nextRound, expected.nextRound);
    }
    if (decision.kind === "stop" && expected.kind === "stop") {
      assert.deepEqual(decision.report, expected.report);
      assert.equal(decision.exhausted, expected.exhausted);
    }
  });
}
