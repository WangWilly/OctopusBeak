import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { runCaptchaRetryCampaign } from "./captcha-retry-campaign.ts";
import {
  captchaRoundExecution,
  type CaptchaRoundExecutionDependencies,
} from "./captcha-round-execution.ts";
import { openTaskRunForCheck, requestAssistanceForCheck } from "./task-run-check-support.ts";
import { routeWaitingRunVerification } from "./verification-routing.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import type { AutomationTaskExecutionOptions } from "./task-run-execution.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { openSyntheticPage, pngDataUrl, solidPng } from "./verification-page-check-support.ts";

const noHostedPage = () => null;

/** The campaign as the runner composes it, with the real round adapter. */
function runAppCampaign(dependencies: CaptchaRoundExecutionDependencies) {
  return runCaptchaRetryCampaign({
    taskId: dependencies.taskId,
    run: dependencies.run,
    executeRound: captchaRoundExecution(dependencies),
  });
}

const sinopacContract: HumanAssistanceContractInput = {
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
  expectedAnswerLength: 6,
  challengeImageRegion: {
    id: "captcha-image",
    label: "CAPTCHA image",
    semanticId: "sinopac.login.captcha-image",
    rect: { x: 1, y: 1, width: 10, height: 10 },
  },
  completion: { mode: "inline", targetIds: ["captcha-input"] },
  focus: { targetId: "captcha-input", contextRegionIds: [] },
};

const yuantaTradeImageContract: HumanAssistanceContractInput = {
  stageId: "yuanta-trade-challenge",
  title: "YuanTa Trade image challenge",
  challengeKind: "image-selection",
  targets: [
    {
      id: "challenge-image-1",
      label: "Challenge image 1",
      semanticId: "yuanta-trade.login.challenge-control",
      modes: ["click"],
      rect: { x: 1, y: 1, width: 10, height: 10 },
    },
    {
      id: "challenge-submit",
      label: "Verify challenge",
      semanticId: "yuanta-trade.login.challenge-submit",
      modes: ["click"],
      rect: { x: 1, y: 20, width: 10, height: 10 },
    },
  ],
  contextRegions: [],
  challengeImageRegion: {
    id: "challenge-image-grid",
    label: "Image challenge",
    semanticId: "yuanta-trade.login.challenge-image",
    rect: { x: 1, y: 1, width: 40, height: 40 },
  },
  completion: { mode: "inline", targetIds: ["challenge-submit"] },
  focus: { targetId: "challenge-image-1", contextRegionIds: [] },
};

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

/**
 * One login page every provider adapter below can resolve: SinoPac's #imgCode,
 * Yuanta Bank's GOTP image, and a field SinoPac and Post select by name that
 * also sits under the contract's target rectangle for generic typing.
 */
const CAPTCHA_LOGIN_PAGE = `<body style="margin:0">
  <input id="login_captcha" name="captcha"
    style="position:absolute;left:1px;top:1px;width:10px;height:10px;margin:0;padding:0;border:0;box-sizing:border-box">
  <img id="imgCode" src="${pngDataUrl(120, 40)}" width="120" height="40" style="position:absolute;left:40px;top:40px">
  <img src="/GOTP.png" width="120" height="40" style="position:absolute;left:40px;top:120px">
</body>`;

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for App workflow test state.");
}

for (const providerId of ["sinopac", "post", "einvoice", "yuanta-bank"] as const) {
  const taskId = providerId === "einvoice" ? "einvoice-personal-invoices"
    : providerId === "yuanta-bank" ? "yuanta-all-statements" : `${providerId}-statements`;
  const answer = providerId === "post" ? "1234" : providerId === "einvoice" ? "12345" : "123456";
  const providerContract = {
    ...sinopacContract,
    stageId: providerId === "post" ? "ipost-login-captcha" : `${providerId}-login-captcha`,
    expectedAnswerLength: answer.length,
    targets: sinopacContract.targets.map(target => ({ ...target, semanticId: `${providerId}.login.captcha-input` })),
    challengeImageRegion: { ...sinopacContract.challengeImageRegion!, semanticId: `${providerId}.login.captcha-image` },
  };
  test(`App ${providerId} retries typed rejection after execution cleanup aborts assistance and without retained events`, async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), `${providerId}-app-captcha-`));
    const originalCwd = process.cwd();
    const store = new PGliteStore(await createTestPGlite("operational"));
    const page = await openSyntheticPage(browser, CAPTCHA_LOGIN_PAGE, [
      { path: "/GOTP.png", contentType: "image/png", body: solidPng(120, 40) },
    ]);
    try {
      const provider = createPgliteOperationalProvider(store);
      const created = await provider.automation.createTaskRun({
        taskId,
        kind: "crawler",
        status: "running",
        attempt: 1,
        maxAttempts: 1,
        startedAt: new Date().toISOString(),
      });
      const run = await openTaskRunForCheck(provider.automation, created.taskRunId);
      const settings: AutomationSettingsFile = {
        VERIFICATION_TEXT_CAPTCHA_CONFIDENCE_THRESHOLD: "0.9",
      };
      process.chdir(artifactRoot);
      const pageLookups: string[] = [];
      const injectedAnswers: string[] = [];

      const executeAttempts: number[] = [];
      let solverCalls = 0;

      const campaign = runAppCampaign({
        taskId,
        appWorkflow: true,
        pageForRun: noHostedPage,
        launchVerificationSettings: settings,
        run,
        routeWaitingRunVerification: (input) => routeWaitingRunVerification({
          ...input,
          pageForRun: (session) => {
            pageLookups.push(session);
            return session === created.taskRunId ? page : null;
          },
          solver: {
            async solve() {
              solverCalls += 1;
              return {
                answer,
                confidence: solverCalls <= 3 ? 0.1 : 0.99,
              };
            },
          },
        }),
        async execute(options: AutomationTaskExecutionOptions) {
          const attempt = options.attempt ?? 1;
          executeAttempts.push(attempt);
          const controller = new AbortController();
          try {
            await requestAssistanceForCheck(run, options, providerContract, controller.signal);
          } catch {
            assert.equal(attempt, 1, "only solver exhaustion rejects the pending stage");
            return { summary: null, failure: { code: "workflow-failed" as const, proven: true } };
          }
          injectedAnswers.push(await page.inputValue("#login_captcha"));
          await page.fill("#login_captcha", "");
          const rejected = attempt === 2;
          // Worker cleanup aborts the request before the host joins execution.
          // Progress events are deliberately absent: they must not drive retries.
          controller.abort(new Error("Worker finished"));
          return { summary: null, failure: rejected ? { code: "captcha-provider-rejected" as const, proven: true } : null };
        },
      });

      assert.equal((await run.finish(await campaign)).status, "completed");
      assert.deepEqual(executeAttempts, [1, 2, 3]);
      assert.equal(solverCalls, 5, "three unaccepted challenges in round one, one per later round");
      assert.ok(pageLookups.length > 0);
      assert.ok(pageLookups.every((session) => session === created.taskRunId));
      assert.deepEqual(injectedAnswers, [answer, answer]);
      const finalRun = await provider.automation.taskRunById(created.taskRunId);
      assert.equal(finalRun?.status, "completed");
      assert.equal(finalRun?.attempt, 3);
      assert.equal(Object.hasOwn(finalRun ?? {}, "logPath"), false);
      assert.equal(Object.hasOwn(finalRun ?? {}, "logTail"), false);
      assert.equal(finalRun?.events.some((event) => event.code === "captcha-rejected"), false);
      assert.deepEqual(await readdir(artifactRoot), [], "typed retry writes no CLI log, assistance JSONL, source, or output files");
    } finally {
      process.chdir(originalCwd);
      await page.close();
      await store.close();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
}

test("App SinoPac CAPTCHA assistance aborts its route when the live run is cancelled", async () => {
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "sinopac-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const run = await openTaskRunForCheck(provider.automation, created.taskRunId);
    const controller = new AbortController();
    const campaign = runAppCampaign({
      taskId: "sinopac-statements",
      appWorkflow: true,
      pageForRun: noHostedPage,
      launchVerificationSettings: {},
      // A route still solving when the App closes.
      routeWaitingRunVerification: () => new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      }),
      run,
      async execute(options) {
        try {
          await requestAssistanceForCheck(run, options, sinopacContract, controller.signal);
          throw new Error("Cancellation did not interrupt verification assistance.");
        } catch {
          return { summary: null, failure: { code: "cancelled" as const, proven: true } };
        }
      },
    });

    await waitFor(async () => (await provider.automation.taskRunById(created.taskRunId))?.status === "waiting_for_human");
    void run.requestStop("cancelled");
    controller.abort(new Error("App closed"));
    const report = await campaign;
    assert.equal(run.assess(report).errorCode, "cancelled");
    await run.finish(report);
    const finalRun = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(finalRun?.status, "cancelled");
    assert.equal(Object.hasOwn(finalRun ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(finalRun ?? {}, "logTail"), false);
  } finally {
    await store.close();
  }
});

test("the CAPTCHA campaign routes Yuanta Trade stages through the route its source declares", async () => {
  const store = new PGliteStore(await createTestPGlite("operational"));
  const controller = new AbortController();
  try {
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "yuanta-trade-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const run = await openTaskRunForCheck(provider.automation, created.taskRunId);
    let genericRouteCalls = 0;
    const campaign = runAppCampaign({
      taskId: "yuanta-trade-statements",
      appWorkflow: true,
      pageForRun: noHostedPage,
      launchVerificationSettings: {},
      run,
      routeWaitingRunVerification: async () => {
        genericRouteCalls += 1;
        return { kind: "failed" };
      },
      async execute(options) {
        await assert.rejects(
          requestAssistanceForCheck(run, options, yuantaTradeImageContract, controller.signal),
          /image challenge has no supported local solver/u,
        );
        return { failure: { code: "verification-failed" as const, proven: true }, summary: null };
      },
    });
    assert.equal((await run.finish(await campaign)).status, "failed");
    assert.equal(genericRouteCalls, 0, "the source route refuses the stage before any solver runs");
    const saved = await provider.automation.taskRunById(created.taskRunId);
    assert.ok(saved?.events.some((event) => event.code === "solver-challenge-unsupported"));
  } finally {
    controller.abort();
    await store.close();
  }
});
