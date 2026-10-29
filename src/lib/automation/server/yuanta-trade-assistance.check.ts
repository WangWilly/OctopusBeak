import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  HumanAssistanceContractInput,
} from "../human-assistance.ts";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createAppWorkflowHumanAssistancePort } from "./app-workflow-human-assistance.ts";
import { openExecutionForCheck } from "./task-run-check-support.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import {
  routeYuantaTradeAppAssistanceRequest,
  type YuantaTradeAppAssistanceDependencies,
} from "./yuanta-trade-assistance.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openSyntheticPage, scriptedSolver } from "./verification-page-check-support.ts";

const noHostedPage = () => null;

const TASK_ID = "yuanta-trade-statements";
/** The run's task as its Task run plan carries it. */
const YUANTA_TRADE_TASK = { workflowId: TASK_ID };
const AUDIO_INPUT_RECT = { x: 10, y: 80, width: 120, height: 30 };
const CHECKBOX_RECT = { x: 10, y: 20, width: 32, height: 32 };
const AUDIO_PATH = "/NexusWebTrade/Login/VerificationCodeSound";

const at = (rect: { x: number; y: number; width: number; height: number }) =>
  `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;margin:0;box-sizing:border-box`;

/** Yuanta Trade's sign-in verification: the audio code field and the CAPTCHA checkbox. */
function loginPage(options: { checkboxSticks?: boolean } = {}) {
  return `<body style="margin:0">
    <input id="chbYCaptchaV2" type="checkbox" style="${at(CHECKBOX_RECT)}"
      ${options.checkboxSticks === false ? 'onclick="return false"' : ""}>
    <input id="audio-code" style="${at(AUDIO_INPUT_RECT)}">
  </body>`;
}

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

async function openLoginPage(options: { audio?: boolean; checkboxSticks?: boolean } = {}) {
  return openSyntheticPage(browser, loginPage(options), options.audio === false
    ? []
    : [{ path: AUDIO_PATH, contentType: "audio/wav", body: Buffer.from("fixture audio") }]);
}

/** The run's page lookup, recording every run id it is asked for. */
function hostedPage(taskRunId: string, page: Page, lookups: string[] = []) {
  return (candidate: string) => {
    lookups.push(candidate);
    return candidate === taskRunId ? page : null;
  };
}

function audioContract(): HumanAssistanceContractInput {
  return {
    stageId: "yuanta-trade-audio-verification",
    title: "Enter the YuanTa Trade audio verification code",
    challengeKind: "audio-captcha",
    challengeAudioSource: {
      id: "audio-challenge",
      label: "Verification audio challenge",
      semanticId: "yuanta-trade.login.audio-challenge",
    },
    charset: "digits",
    expectedAnswerLength: 6,
    targets: [{
      id: "audio-code-input",
      label: "Verification code",
      semanticId: "yuanta-trade.login.audio-code-input",
      modes: ["type"],
      rect: AUDIO_INPUT_RECT,
    }],
    contextRegions: [{
      id: "audio-verification",
      label: "Audio verification controls",
      semanticId: "yuanta-trade.login.audio-verification",
      rect: { x: 1, y: 2, width: 400, height: 200 },
    }],
    completion: { mode: "inline", targetIds: ["audio-code-input"] },
    focus: { targetId: "audio-code-input", contextRegionIds: ["audio-verification"] },
  };
}

function checkboxContract(): HumanAssistanceContractInput {
  return {
    stageId: "yuanta-trade-captcha-checkbox",
    title: "Complete the YuanTa Trade CAPTCHA checkbox",
    challengeKind: "checkbox",
    targets: [{
      id: "captcha-checkbox",
      label: "CAPTCHA checkbox",
      semanticId: "yuanta-trade.login.captcha-checkbox",
      modes: ["click"],
      rect: CHECKBOX_RECT,
    }],
    contextRegions: [{
      id: "captcha-control",
      label: "CAPTCHA control",
      semanticId: "yuanta-trade.login.captcha-control",
      rect: { x: 1, y: 2, width: 250, height: 120 },
    }],
    completion: { mode: "independent", targetIds: ["captcha-checkbox"] },
    focus: { targetId: "captcha-checkbox", contextRegionIds: ["captcha-control"] },
  };
}

function imageContract(): HumanAssistanceContractInput {
  return {
    stageId: "yuanta-trade-challenge",
    title: "Select the requested YuanTa Trade challenge images",
    challengeKind: "image-selection",
    targets: [
      {
        id: "challenge-image-1",
        label: "Challenge image 1",
        semanticId: "yuanta-trade.login.challenge-control",
        modes: ["click"],
        rect: { x: 10, y: 20, width: 96, height: 96 },
      },
      {
        id: "challenge-submit",
        label: "Verify challenge",
        semanticId: "yuanta-trade.login.challenge-submit",
        modes: ["click"],
        rect: { x: 220, y: 420, width: 90, height: 30 },
      },
    ],
    contextRegions: [{
      id: "image-challenge",
      label: "Image challenge",
      semanticId: "yuanta-trade.login.challenge-region",
      rect: { x: 1, y: 2, width: 400, height: 500 },
    }],
    challengeImageRegion: {
      id: "challenge-image-grid",
      label: "YuanTa Trade image challenge",
      semanticId: "yuanta-trade.login.challenge-image",
      rect: { x: 10, y: 20, width: 320, height: 320 },
    },
    completion: { mode: "inline", targetIds: ["challenge-submit"] },
    focus: {
      targetId: "challenge-image-1",
      contextRegionIds: ["image-challenge"],
      initialZoom: 1.15,
    },
  };
}

function certificateContract(): HumanAssistanceContractInput {
  return {
    stageId: "yuanta-trade-certificate-selection",
    title: "Select the YuanTa Trade certificate",
    targets: [{
      id: "certificate-picker",
      label: "Certificate file selection",
      semanticId: "yuanta-trade.login.certificate-picker",
      modes: ["click"],
      rect: { x: 10, y: 20, width: 140, height: 30 },
    }],
    contextRegions: [{
      id: "certificate-form",
      label: "Certificate sign-in form",
      semanticId: "yuanta-trade.login.certificate-form",
      rect: { x: 1, y: 2, width: 400, height: 240 },
    }],
    completion: { mode: "inline", targetIds: ["certificate-picker"] },
    focus: { targetId: "certificate-picker", contextRegionIds: ["certificate-form"] },
  };
}

async function createRun() {
  const store = new PGliteStore(await createTestPGlite("operational"));
  const provider = createPgliteOperationalProvider(store);
  const run = await provider.automation.createTaskRun({
    taskId: TASK_ID,
    kind: "crawler",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
  });
  return { store, provider, run };
}

/** Route each stage the way the CAPTCHA Retry Campaign does, without the campaign's retries. */
async function yuantaTradeAssistance(
  provider: AutomationPersistenceProvider,
  taskRunId: string,
  dependencies: YuantaTradeAppAssistanceDependencies,
) {
  return createAppWorkflowHumanAssistancePort(
    await openExecutionForCheck(provider.automation, taskRunId, async (request) => {
      const outcome = await routeYuantaTradeAppAssistanceRequest(request, dependencies);
      if (outcome?.kind === "retryable") {
        throw new Error(`Yuanta Trade verification is retryable: ${outcome.reason}`);
      }
    }),
  );
}

const solverSettings: AutomationSettingsFile = {
  VERIFICATION_AUDIO_CAPTCHA_CONFIDENCE_THRESHOLD: "0.7",
  VERIFICATION_IMAGE_SELECTION_CONFIDENCE_THRESHOLD: "0.7",
};

test("Yuanta Trade audio and checkbox stages continue through one App run", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "yuanta-trade-assistance-"));
  const originalCwd = process.cwd();
  const { store, provider, run } = await createRun();
  const page = await openLoginPage();
  const lookups: string[] = [];
  const answers: string[] = [];
  const solver = scriptedSolver((input) => {
    assert.equal(input.challengeKind, "audio-captcha");
    assert.deepEqual(input.audio, Buffer.from("fixture audio"));
    return { answer: "123456", confidence: 0.99 };
  });
  const dependencies: YuantaTradeAppAssistanceDependencies = {
    task: YUANTA_TRADE_TASK,
    settings: solverSettings,
    pageForRun: hostedPage(run.taskRunId, page, lookups),
    solver,
  };

  try {
    process.chdir(artifactRoot);
    const assistance = await yuantaTradeAssistance(provider, run.taskRunId, dependencies);
    for (const contract of [audioContract(), audioContract()]) {
      await assistance.request(contract, new AbortController().signal);
      answers.push(await page.inputValue("#audio-code"));
      await page.fill("#audio-code", "");
    }
    await assistance.request(checkboxContract(), new AbortController().signal);
    const finalRun = await provider.automation.taskRunById(run.taskRunId);
    assert.equal(finalRun?.status, "running");
    assert.deepEqual(answers, ["123456", "123456"]);
    assert.equal(solver.inputs.length, 2);
    assert.equal(await page.isChecked("#chbYCaptchaV2"), true);
    assert.ok(lookups.length > 0);
    assert.ok(lookups.every((session) => session === run.taskRunId));
    assert.deepEqual(await readdir(artifactRoot), [], "App assistance writes no workflow files");
  } finally {
    process.chdir(originalCwd);
    await page.close();
    await store.close();
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("Yuanta Trade fails closed when the CAPTCHA checkbox does not reach its verified state", async () => {
  const { store, provider, run } = await createRun();
  const page = await openLoginPage({ checkboxSticks: false });
  try {
    const assistance = await yuantaTradeAssistance(provider, run.taskRunId, {
      task: YUANTA_TRADE_TASK,
      settings: solverSettings,
      pageForRun: hostedPage(run.taskRunId, page),
    });
    await assert.rejects(
      assistance.request(checkboxContract(), new AbortController().signal),
      /checkbox did not reach its verified state/u,
    );
  } finally {
    await page.close();
    await store.close();
  }
});

test("Yuanta Trade solver exhaustion ends the stage as retryable", async () => {
  const { store, provider, run } = await createRun();
  const page = await openLoginPage();
  const controller = new AbortController();
  const solver = scriptedSolver(() => ({ answer: "123456", confidence: 0.1 }));
  try {
    const assistance = await yuantaTradeAssistance(provider, run.taskRunId, {
      task: YUANTA_TRADE_TASK,
      settings: solverSettings,
      pageForRun: hostedPage(run.taskRunId, page),
      solver,
    });
    await assert.rejects(
      Promise.race([
        assistance.request(audioContract(), controller.signal),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("Yuanta Trade solver silently kept waiting")),
          5_000,
        )),
      ]),
      /retryable: solver-exhausted/u,
    );
    assert.equal(solver.inputs.length, 1);
    assert.equal(await page.inputValue("#audio-code"), "");
  } finally {
    controller.abort();
    await page.close();
    await store.close();
  }
});

test("Yuanta Trade image challenge fails explicitly in solver mode", async () => {
  const { store, provider, run } = await createRun();
  try {
    const assistance = await yuantaTradeAssistance(provider, run.taskRunId, {
      task: YUANTA_TRADE_TASK,
      settings: solverSettings,
      pageForRun: noHostedPage,
    });
    await assert.rejects(
      assistance.request(imageContract(), new AbortController().signal),
      /image challenge has no supported local solver/u,
    );
  } finally {
    await store.close();
  }
});

test("Yuanta Trade fails closed when the audio challenge cannot be fetched", async () => {
  const { store, provider, run } = await createRun();
  const page = await openLoginPage({ audio: false });
  const solver = scriptedSolver(() => ({ answer: "123456", confidence: 0.99 }));
  try {
    const assistance = await yuantaTradeAssistance(provider, run.taskRunId, {
      task: YUANTA_TRADE_TASK,
      settings: solverSettings,
      pageForRun: hostedPage(run.taskRunId, page),
      solver,
    });
    await assert.rejects(
      assistance.request(audioContract(), new AbortController().signal),
      /verification assistance failed closed/u,
    );
    assert.equal(solver.inputs.length, 0);
    assert.equal(await page.inputValue("#audio-code"), "");
  } finally {
    await page.close();
    await store.close();
  }
});

test("Yuanta Trade unsupported native verification fails closed in solver mode", async () => {
  const { store, provider, run } = await createRun();
  try {
    const opened = await openExecutionForCheck(provider.automation, run.taskRunId);
    const { execution } = opened;
    await assert.rejects(
      routeYuantaTradeAppAssistanceRequest({
        ...opened,
        contract: certificateContract(),
        signal: new AbortController().signal,
      }, { task: YUANTA_TRADE_TASK, settings: {}, pageForRun: noHostedPage }),
      /not supported by the automatic solver/u,
    );
    const saved = await provider.automation.taskRunById(run.taskRunId);
    assert.ok(saved?.events.some((event) => event.code === "solver-challenge-unsupported"));
    assert.deepEqual(execution.events().map((event) => event.signal), ["solver-challenge-unsupported"]);
    assert.equal(saved?.status, "running");
  } finally {
    await store.close();
  }
});

test("Yuanta Trade assistance cancellation prevents delayed solver output from reaching the page", async () => {
  const { store, provider, run } = await createRun();
  const page = await openLoginPage();
  let releaseSolver!: () => void;
  let solverStarted!: () => void;
  const started = new Promise<void>((resolve) => { solverStarted = resolve; });
  const delayed = new Promise<void>((resolve) => { releaseSolver = resolve; });
  try {
    const controller = new AbortController();
    const assistance = await yuantaTradeAssistance(provider, run.taskRunId, {
      task: YUANTA_TRADE_TASK,
      settings: solverSettings,
      pageForRun: hostedPage(run.taskRunId, page),
      solver: {
        async solve() {
          solverStarted();
          await delayed;
          return { answer: "123456", confidence: 0.99 };
        },
      },
    });
    const request = assistance.request(audioContract(), controller.signal);
    await started;
    controller.abort(new Error("App shutdown"));
    releaseSolver();
    await assert.rejects(request, /App shutdown/u);
    assert.equal(await page.inputValue("#audio-code"), "");
  } finally {
    await page.close();
    await store.close();
  }
});
