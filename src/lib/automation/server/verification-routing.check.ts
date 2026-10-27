import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  MAX_CHALLENGES_PER_ROUND,
  routeVerificationActor,
  routeWaitingRunVerification,
  solveChallengeRound,
  type VerificationPostSubmitOutcome,
  type VerificationRoutingSeams,
} from "./verification-routing.ts";
import type { AutomationTaskRun } from "./store.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";
import type { PageForRun } from "./automation-viewer.ts";
import type { VerificationSolver } from "./verification-solver.ts";
import {
  openSyntheticPage,
  pageForRunOf,
  pngDataUrl,
  scriptedSolver,
} from "./verification-page-check-support.ts";

const RUN = "routing-run";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const imageRect = { x: 20, y: 20, width: 120, height: 40 };
const inputRect = { x: 20, y: 80, width: 120, height: 24 };
const checkboxRect = { x: 20, y: 140, width: 20, height: 20 };

const at = (rect: { x: number; y: number; width: number; height: number }) =>
  `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;margin:0;box-sizing:border-box`;

/** A login page with no provider adapter: generic screenshot capture and rectangle typing. */
const LOGIN_PAGE = `<body style="margin:0">
  <img id="challenge" src="${pngDataUrl(120, 40)}" style="${at(imageRect)}">
  <input id="code" style="${at(inputRect)}">
  <input id="checkbox" type="checkbox" style="${at(checkboxRect)}">
</body>`;

function captchaContract(overrides: Partial<HumanAssistanceContract> = {}): HumanAssistanceContract {
  return {
    schemaVersion: 1,
    version: 1,
    stageId: "provider-captcha",
    title: "Complete the CAPTCHA",
    targets: [{
      id: "captcha-input",
      label: "CAPTCHA input",
      semanticId: "provider.login.captcha-input",
      modes: ["click", "type"],
      rect: inputRect,
    }],
    contextRegions: [],
    challengeKind: "text-captcha",
    charset: "digits",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "provider.login.captcha-image",
      rect: imageRect,
    },
    completion: { mode: "inline", targetIds: ["captcha-input"], status: "pending" },
    focus: { targetId: "captcha-input", contextRegionIds: [] },
    ...overrides,
  };
}

function audioContract(): HumanAssistanceContract {
  return captchaContract({
    stageId: "yuanta-trade-audio-verification",
    challengeKind: "audio-captcha",
    challengeImageRegion: undefined,
    challengeAudioSource: {
      id: "audio-challenge",
      label: "Audio challenge",
      semanticId: "yuanta-trade.login.audio-challenge",
    },
    expectedAnswerLength: 6,
    targets: [{
      id: "captcha-input",
      label: "Audio answer",
      semanticId: "yuanta-trade.login.audio-code-input",
      modes: ["type"],
      rect: inputRect,
    }],
  });
}

function checkboxContract(): HumanAssistanceContract {
  return captchaContract({
    stageId: "provider-checkbox",
    challengeKind: "checkbox",
    challengeImageRegion: undefined,
    targets: [{
      id: "checkbox",
      label: "I am not a robot",
      semanticId: "provider.login.checkbox",
      modes: ["click"],
      rect: checkboxRect,
    }],
    completion: { mode: "inline", targetIds: ["checkbox"], status: "pending" },
    focus: { targetId: "checkbox", contextRegionIds: [] },
  });
}

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

type Recorded = { seams: VerificationRoutingSeams; calls: string[]; failures: string[] };

function recordingSeams(
  pageForRun: PageForRun,
  solver: VerificationSolver,
  postSubmit: VerificationPostSubmitOutcome = "none",
): Recorded {
  const calls: string[] = [];
  const failures: string[] = [];
  return {
    calls,
    failures,
    seams: {
      pageForRun,
      solver,
      resume: () => { calls.push("resume"); },
      postSubmitOutcome: async () => { calls.push("post-submit"); return postSubmit; },
      finalizeFailed: (message) => { failures.push(message); },
      onChallengeCaptured: () => { calls.push("captured"); },
    },
  };
}

async function withLoginPage<T>(
  action: (page: Page) => Promise<T>,
  html = LOGIN_PAGE,
  routes: Parameters<typeof openSyntheticPage>[2] = [],
) {
  const page = await openSyntheticPage(browser, html, routes);
  try {
    return await action(page);
  } finally {
    await page.close();
  }
}

const route = (contract: HumanAssistanceContract, seams: VerificationRoutingSeams) =>
  routeVerificationActor({ contract, taskRunId: RUN, confidenceThreshold: 0.9, seams });

test("an accepted answer is captured from the page, typed into it, resumed and then classified", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => ({ answer: "1234", confidence: 0.99 }));
    const recorded = recordingSeams(pageForRunOf(RUN, page), solver);
    assert.deepEqual(await route(captchaContract(), recorded.seams), { kind: "resumed" });
    assert.equal(await page.inputValue("#code"), "1234");
    assert.deepEqual(recorded.calls, ["captured", "resume", "post-submit"]);
    assert.equal(solver.inputs.length, 1);
    assert.deepEqual(solver.inputs[0]!.image!.subarray(0, 4), PNG_SIGNATURE);
    assert.deepEqual(recorded.failures, []);
  }));

test("an unaccepted challenge exhausts the round without typing or resuming", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => ({ answer: "1234", confidence: 0.1 }));
    const recorded = recordingSeams(pageForRunOf(RUN, page), solver);
    assert.deepEqual(await route(captchaContract(), recorded.seams), {
      kind: "retryable",
      reason: "solver-exhausted",
    });
    assert.equal(await page.inputValue("#code"), "");
    assert.deepEqual(recorded.calls, ["captured"], "the round is consumed once, never submitted");
    assert.ok(solver.inputs.length >= 1);
  }));

test("a provider rejection reported after resume makes the round retryable", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => ({ answer: "1234", confidence: 0.99 }));
    const recorded = recordingSeams(pageForRunOf(RUN, page), solver, "provider-rejected");
    assert.deepEqual(await route(captchaContract(), recorded.seams), {
      kind: "retryable",
      reason: "provider-rejected",
    });
    assert.deepEqual(recorded.calls, ["captured", "resume", "post-submit"]);
  }));

test("an unrecognized post-submit dialog fails the route closed", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => ({ answer: "1234", confidence: 0.99 }));
    const recorded = recordingSeams(pageForRunOf(RUN, page), solver, "unrecognized-dialog");
    assert.deepEqual(await route(captchaContract(), recorded.seams), { kind: "failed" });
    assert.deepEqual(recorded.failures, ["Provider login dialog was not recognized."]);
  }));

test("a provider-owned image that cannot be captured fails without a generic screenshot", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => ({ answer: "123456", confidence: 0.99 }));
    const recorded = recordingSeams(pageForRunOf(RUN, page), solver);
    // SinoPac's adapter owns this image; the page has no #imgCode to capture.
    const sinopac = captchaContract({
      stageId: "sinopac-login-captcha",
      targets: [{ ...captchaContract().targets[0]!, semanticId: "sinopac.login.captcha-input" }],
      challengeImageRegion: { ...captchaContract().challengeImageRegion!, semanticId: "sinopac.login.captcha-image" },
    });
    assert.deepEqual(await route(sinopac, recorded.seams), { kind: "failed" });
    assert.deepEqual(recorded.failures, ["Verification challenge image capture failed."]);
    assert.equal(solver.inputs.length, 0);
    assert.deepEqual(recorded.calls, []);
  }));

test("the route reaches only the page its run hosts", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => ({ answer: "1234", confidence: 0.99 }));
    const recorded = recordingSeams(pageForRunOf("another-run", page), solver);
    assert.deepEqual(await route(captchaContract(), recorded.seams), { kind: "failed" });
    assert.equal(solver.inputs.length, 0);
    assert.equal(await page.inputValue("#code"), "");
    assert.deepEqual(recorded.calls, []);
  }));

const AUDIO_PATH = "/NexusWebTrade/Login/VerificationCodeSound";

test("provider-owned audio is fetched in the page, solved and typed", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => ({ answer: "123456", confidence: 0.99 }));
    const recorded = recordingSeams(pageForRunOf(RUN, page), solver);
    assert.deepEqual(await route(audioContract(), recorded.seams), { kind: "resumed" });
    assert.deepEqual(solver.inputs[0]!.audio, Buffer.from("fixture audio"));
    assert.equal(await page.inputValue("#code"), "123456");
    assert.deepEqual(recorded.calls, ["captured", "resume", "post-submit"]);
  }, LOGIN_PAGE, [{ path: AUDIO_PATH, contentType: "audio/wav", body: Buffer.from("fixture audio") }]));

test("provider-owned audio that cannot be fetched fails instead of resuming unanswered", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => ({ answer: "123456", confidence: 0.99 }));
    const recorded = recordingSeams(pageForRunOf(RUN, page), solver);
    assert.deepEqual(await route(audioContract(), recorded.seams), { kind: "failed" });
    assert.deepEqual(recorded.failures, ["Verification challenge audio capture failed."]);
    assert.deepEqual(recorded.calls, []);
  }));

test("a checkbox stage is clicked on the page and resumed without a post-submit outcome", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => assert.fail("a checkbox is not solved"));
    const recorded = recordingSeams(pageForRunOf(RUN, page), solver);
    assert.deepEqual(await route(checkboxContract(), recorded.seams), { kind: "resumed" });
    assert.equal(await page.isChecked("#checkbox"), true);
    assert.deepEqual(recorded.calls, ["resume"]);
  }));

test("a stage without challenge media is unsolvable", () =>
  withLoginPage(async (page) => {
    const solver = scriptedSolver(() => assert.fail("nothing to solve"));
    const recorded = recordingSeams(pageForRunOf(RUN, page), solver);
    assert.deepEqual(
      await route(captchaContract({ challengeImageRegion: undefined }), recorded.seams),
      { kind: "failed" },
    );
    assert.deepEqual(recorded.failures, ["Verification challenge cannot be solved."]);
  }));

test("App verification routes the waiting run's contract against that run's page", () =>
  withLoginPage(async (page) => {
    const taskRunId = "typed-verification-run";
    const run = {
      taskId: "sinopac-statements",
      taskRunId,
      kind: "crawler",
      status: "waiting_for_human",
      logPath: "",
      logTail: "Workflow paused. libretto resume --session stale-session-id",
      humanAssistanceContract: captchaContract(),
      events: [],
    };
    const solver = scriptedSolver(() => ({ answer: "1234", confidence: 0.99 }));
    const recorded = recordingSeams(pageForRunOf(taskRunId, page), solver);
    const outcome = await routeWaitingRunVerification({
      ...recorded.seams,
      run: {
        taskId: "sinopac-statements",
        taskRunId,
        current: () => run as unknown as AutomationTaskRun,
      },
      settings: {},
    });
    assert.deepEqual(outcome, { kind: "resumed" });
    assert.equal(await page.inputValue("#code"), "1234");
    assert.deepEqual(recorded.failures, []);
  }));

function refreshRound(options: { refresh?: "new-challenge" | "unchanged" | "throws"; acceptOnChallenge?: number }) {
  let challenge = 1;
  const solved: number[] = [];
  let refreshes = 0;
  return {
    solved,
    refreshes: () => refreshes,
    round: () => solveChallengeRound({
      budget: options.refresh ? MAX_CHALLENGES_PER_ROUND : 1,
      solveOnce: async () => {
        solved.push(challenge);
        return { status: challenge === options.acceptOnChallenge ? "solved" : "exhausted" };
      },
      refresh: options.refresh
        ? async () => {
          refreshes += 1;
          if (options.refresh === "throws") throw new Error("refresh control detached");
          if (options.refresh === "unchanged") return false;
          challenge += 1;
          return true;
        }
        : undefined,
    }),
  };
}

test("a refresh-capable round tries five challenges without submitting any", async () => {
  const round = refreshRound({ refresh: "new-challenge" });
  assert.deepEqual(await round.round(), { status: "exhausted" });
  assert.equal(MAX_CHALLENGES_PER_ROUND, 5);
  assert.deepEqual(round.solved, [1, 2, 3, 4, 5]);
  assert.equal(round.refreshes(), 4);
});

test("a refresh-capable round stops at the first accepted challenge", async () => {
  const round = refreshRound({ refresh: "new-challenge", acceptOnChallenge: 3 });
  assert.deepEqual(await round.round(), { status: "solved" });
  assert.deepEqual(round.solved, [1, 2, 3]);
  assert.equal(round.refreshes(), 2);
});

test("a refresh that yields no new challenge ends the round", async () => {
  const round = refreshRound({ refresh: "unchanged" });
  assert.deepEqual(await round.round(), { status: "exhausted" });
  assert.deepEqual(round.solved, [1]);
  assert.equal(round.refreshes(), 1);
});

test("a provider without a refresh control keeps one challenge per round", async () => {
  const round = refreshRound({});
  assert.deepEqual(await round.round(), { status: "exhausted" });
  assert.deepEqual(round.solved, [1]);
});

test("a refresh error propagates so the route fails instead of restarting", async () => {
  const round = refreshRound({ refresh: "throws" });
  await assert.rejects(round.round(), /refresh control detached/u);
  assert.deepEqual(round.solved, [1]);
});
