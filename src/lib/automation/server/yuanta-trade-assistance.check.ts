import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import type {
  HumanAssistanceContractInput,
} from "../human-assistance.ts";
import type { VerificationSolver } from "./verification-solver.ts";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  createAppWorkflowHumanAssistancePort,
  resumeAppWorkflowHumanAssistance,
} from "./app-workflow-human-assistance.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import type { ProviderVerificationHost } from "./provider-verification.ts";
import {
  routeYuantaTradeAppAssistanceRequest,
  registerYuantaTradeAppAssistanceHandler,
} from "./yuanta-trade-assistance.ts";
import { configureHostVerificationActorPolicy } from "../verification-config.ts";

const TASK_ID = "yuanta-trade-statements";

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
      rect: { x: 10, y: 20, width: 120, height: 30 },
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
      rect: { x: 10, y: 20, width: 32, height: 32 },
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

function verificationHost(input: {
  onAudio?: (session: string) => void;
  onImage?: (session: string) => void;
  onInput?: (session: string, targetId: string, contract: HumanAssistanceContractInput) => void;
  onResume?: (session: string, stageId: string) => void;
} = {}): ProviderVerificationHost {
  return {
    async captureChallengeImage(session) {
      input.onImage?.(session);
      return Buffer.from("fixture image");
    },
    async isChallengeImageCurrent() { return true; },
    handlesChallengeImage: (contract) => contract.challengeImageRegion?.semanticId
      === "yuanta-trade.login.challenge-image",
    handlesChallengeAudio: (contract) => contract.challengeAudioSource?.semanticId
      === "yuanta-trade.login.audio-challenge",
    async captureChallengeAudio(session) {
      input.onAudio?.(session);
      return Buffer.from("fixture audio");
    },
    async refreshTarget() { return null; },
    async sendInput(session, rawInput) {
      const targetId = typeof rawInput === "object" && rawInput !== null && "targetId" in rawInput
        ? String(rawInput.targetId)
        : "";
      input.onInput?.(session, targetId, imageContract());
      return { accepted: true };
    },
    async injectAnswer() {},
    async probePostSubmit(session, contract, resume) {
      input.onResume?.(session, contract.stageId);
      await resume();
      return "none";
    },
    async inspectCompletion(_session, contract) {
      return contract.stageId === "yuanta-trade-captcha-checkbox";
    },
    async waitForCompletion() { return false; },
    shouldCheckCompletion() { return false; },
    shouldAutoResume() { return false; },
  };
}

async function createRun() {
  const store = new PGliteStore(await PGlite.create());
  await applyPgliteOperationalBaseline(store);
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

const solverSettings: AutomationSettingsFile = {
  LIBRETTO_CLOUD_YUANTA_TRADE_VERIFICATION_ACTOR: "solver",
  VERIFICATION_AUDIO_CAPTCHA_CONFIDENCE_THRESHOLD: "0.7",
  VERIFICATION_IMAGE_SELECTION_CONFIDENCE_THRESHOLD: "0.7",
};

test("Yuanta Trade audio and checkbox stages continue through one App run", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "yuanta-trade-assistance-"));
  const originalCwd = process.cwd();
  const { store, provider, run } = await createRun();
  const actions: string[] = [];
  const sessions: string[] = [];
  let solverCalls = 0;
  const host = verificationHost({
    onAudio(session) { sessions.push(session); actions.push("capture-audio"); },
    onResume(session, stageId) { sessions.push(session); actions.push(`resume:${stageId}`); },
  });
  const unregister = registerYuantaTradeAppAssistanceHandler({
    provider,
    settings: solverSettings,
    verificationHost: host,
    routeOptions: {
      solver: {
        async solve(input) {
          solverCalls += 1;
          actions.push(`solve:${input.challengeKind}`);
          assert.equal(input.challengeKind, "audio-captcha");
          return { answer: "123456", confidence: 0.99 };
        },
      } satisfies VerificationSolver,
      providerInjectAnswer: async (session, _contract, answer) => {
        sessions.push(session);
        actions.push(`answer:${answer}`);
      },
      clickTarget: async (session, _contract, targetId) => {
        sessions.push(session);
        actions.push(`click:${targetId}`);
      },
    },
  });

  try {
    process.chdir(artifactRoot);
    const assistance = createAppWorkflowHumanAssistancePort({
      taskRunId: run.taskRunId,
      persistence: provider.automation,
    });
    for (const contract of [audioContract(), audioContract(), checkboxContract()]) {
      await assistance.request(contract, new AbortController().signal);
    }
    const finalRun = await provider.automation.taskRunById(run.taskRunId);
    assert.equal(finalRun?.status, "running");
    assert.deepEqual(
      actions,
      [
        "capture-audio",
        "solve:audio-captcha",
        "answer:123456",
        "resume:yuanta-trade-audio-verification",
        "capture-audio",
        "solve:audio-captcha",
        "answer:123456",
        "resume:yuanta-trade-audio-verification",
        "click:captcha-checkbox",
      ],
    );
    assert.equal(solverCalls, 2);
    assert.equal(sessions.length, 7);
    assert.ok(sessions.every((session) => session === run.taskRunId));
    assert.deepEqual(await readdir(artifactRoot), [], "App assistance writes no workflow files");
  } finally {
    unregister();
    process.chdir(originalCwd);
    await store.close();
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("Yuanta Trade solver exhaustion rejects the active stage without switching to human", async () => {
  const { store, provider, run } = await createRun();
  const controller = new AbortController();
  let solverCalls = 0;
  const unregister = registerYuantaTradeAppAssistanceHandler({
    provider,
    settings: solverSettings,
    verificationHost: verificationHost(),
    routeOptions: {
      solver: {
        async solve() {
          solverCalls += 1;
          return { answer: "123456", confidence: 0.1 };
        },
      },
      providerCaptureChallengeAudio: async () => Buffer.from("fixture audio"),
    },
  });

  try {
    const assistance = createAppWorkflowHumanAssistancePort({
      taskRunId: run.taskRunId,
      persistence: provider.automation,
    });
    await assert.rejects(
      Promise.race([
        assistance.request(audioContract(), controller.signal),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("Yuanta Trade solver silently waited for human")),
          1_000,
        )),
      ]),
      /new CAPTCHA round required/u,
    );
    assert.equal(solverCalls, 1);
  } finally {
    controller.abort();
    unregister();
    await store.close();
  }
});

test("Yuanta Trade image challenge fails explicitly in solver mode", async () => {
  const { store, provider, run } = await createRun();
  const unregister = registerYuantaTradeAppAssistanceHandler({
    provider,
    settings: solverSettings,
    verificationHost: verificationHost(),
  });
  try {
    const assistance = createAppWorkflowHumanAssistancePort({
      taskRunId: run.taskRunId,
      persistence: provider.automation,
    });
    await assert.rejects(
      assistance.request(imageContract(), new AbortController().signal),
      /image challenge has no supported local solver/u,
    );
  } finally {
    unregister();
    await store.close();
  }
});

test("Yuanta Trade image challenge stays in Assist after an explicit human setting", async () => {
  const { store, provider, run } = await createRun();
  configureHostVerificationActorPolicy({
    isPackaged: false,
    env: { LIBRETTO_CLOUD_YUANTA_TRADE_VERIFICATION_ACTOR: "human" },
  });
  const unregister = registerYuantaTradeAppAssistanceHandler({
    provider,
    settings: { LIBRETTO_CLOUD_YUANTA_TRADE_VERIFICATION_ACTOR: "human" },
    verificationHost: verificationHost(),
  });
  try {
    const assistance = createAppWorkflowHumanAssistancePort({
      taskRunId: run.taskRunId,
      persistence: provider.automation,
    });
    const request = assistance.request(imageContract(), new AbortController().signal);
    const deadline = Date.now() + 3_000;
    let waiting = await provider.automation.taskRunById(run.taskRunId);
    while (waiting?.status !== "waiting_for_human" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      waiting = await provider.automation.taskRunById(run.taskRunId);
    }
    assert.equal(waiting?.status, "waiting_for_human");
    await provider.automation.updateHumanAssistanceCompletion(run.taskRunId, "entered");
    assert.equal(await resumeAppWorkflowHumanAssistance(run.taskRunId, "entered"), true);
    await request;
  } finally {
    unregister();
    configureHostVerificationActorPolicy({ isPackaged: true, env: {} });
    await store.close();
  }
});

test("Yuanta Trade certificate selection stays with the user for native ServiSign", async () => {
  const { store, provider, run } = await createRun();
  configureHostVerificationActorPolicy({
    isPackaged: false,
    env: { LIBRETTO_CLOUD_YUANTA_TRADE_VERIFICATION_ACTOR: "human" },
  });
  let routed = false;
  const unregister = registerYuantaTradeAppAssistanceHandler({
    provider,
    settings: solverSettings,
    verificationHost: verificationHost(),
    routeOptions: { solver: { async solve() { routed = true; return { answer: "123456", confidence: 1 }; } } },
  });

  try {
    const assistance = createAppWorkflowHumanAssistancePort({
      taskRunId: run.taskRunId,
      persistence: provider.automation,
    });
    const request = assistance.request(certificateContract(), new AbortController().signal);
    const deadline = Date.now() + 3_000;
    let waiting = await provider.automation.taskRunById(run.taskRunId);
    while (waiting?.status !== "waiting_for_human" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      waiting = await provider.automation.taskRunById(run.taskRunId);
    }
    assert.equal(waiting?.status, "waiting_for_human");
    assert.equal(waiting?.humanAssistanceContract?.stageId, certificateContract().stageId);
    assert.equal(routed, false);

    await provider.automation.updateHumanAssistanceCompletion(run.taskRunId, "entered");
    assert.equal(await resumeAppWorkflowHumanAssistance(run.taskRunId, "entered"), true);
    await request;
  } finally {
    unregister();
    configureHostVerificationActorPolicy({ isPackaged: true, env: {} });
    await store.close();
  }
});

test("Yuanta Trade unsupported native verification fails closed in solver mode", async () => {
  const { store, provider, run } = await createRun();
  configureHostVerificationActorPolicy({ isPackaged: true, env: {} });
  try {
    await assert.rejects(
      routeYuantaTradeAppAssistanceRequest({
        taskId: TASK_ID,
        taskRunId: run.taskRunId,
        contract: certificateContract(),
        signal: new AbortController().signal,
      }, { provider, settings: {} }),
      /not supported by the automatic solver/u,
    );
    const saved = await provider.automation.taskRunById(run.taskRunId);
    assert.ok(saved?.events.some((event) => event.code === "solver-challenge-unsupported"));
    assert.equal(saved?.status, "running");
  } finally {
    configureHostVerificationActorPolicy({ isPackaged: true, env: {} });
    await store.close();
  }
});

test("Yuanta Trade assistance cancellation prevents delayed solver output from reaching the page", async () => {
  const { store, provider, run } = await createRun();
  let releaseSolver!: () => void;
  let solverStarted!: () => void;
  const started = new Promise<void>((resolve) => { solverStarted = resolve; });
  const delayed = new Promise<void>((resolve) => { releaseSolver = resolve; });
  const injected: string[] = [];
  const unregister = registerYuantaTradeAppAssistanceHandler({
    provider,
    settings: solverSettings,
    verificationHost: verificationHost(),
    routeOptions: {
      solver: {
        async solve() {
          solverStarted();
          await delayed;
          return { answer: "123456", confidence: 0.99 };
        },
      },
      providerCaptureChallengeAudio: async () => Buffer.from("fixture audio"),
      providerInjectAnswer: async (_session, _contract, answer) => { injected.push(answer); },
    },
  });

  try {
    const controller = new AbortController();
    const assistance = createAppWorkflowHumanAssistancePort({
      taskRunId: run.taskRunId,
      persistence: provider.automation,
    });
    const request = assistance.request(audioContract(), controller.signal);
    await started;
    controller.abort(new Error("App shutdown"));
    releaseSolver();
    await assert.rejects(request, /App shutdown/u);
    assert.deepEqual(injected, []);
  } finally {
    unregister();
    await store.close();
  }
});
