import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHALLENGES_PER_ROUND,
  routeVerificationActor,
  routeWaitingRunVerification,
  selectVerificationChallengeImage,
  verificationRoutingDependencies,
  type VerificationRoutingDependencies,
} from "./verification-routing.ts";
import type { AutomationTaskRun } from "./store.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";
import type { VerificationSolver } from "./verification-solver.ts";

function captchaContract(): HumanAssistanceContract {
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
      rect: { x: 10, y: 20, width: 100, height: 24 },
    }],
    contextRegions: [],
    challengeKind: "text-captcha",
    charset: "digits",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "provider.login.captcha-image",
      rect: { x: 0, y: 0, width: 200, height: 80 },
    },
    completion: { mode: "inline", targetIds: ["captcha-input"], status: "pending" },
    focus: { targetId: "captcha-input", contextRegionIds: [] },
  };
}

function trackedDependencies(): { calls: string[]; dependencies: VerificationRoutingDependencies } {
  const calls: string[] = [];
  const solver: VerificationSolver = {
    async solve() {
      calls.push("solve");
      return { answer: "1234", confidence: 0.99 };
    },
  };
  return {
    calls,
    dependencies: {
      solver,
      captureChallengeImage: async () => {
        calls.push("capture");
        return Buffer.from("captcha");
      },
      injectAnswer: async (_session, _contract, answer) => {
        assert.equal(answer, "1234");
        calls.push("inject");
      },
      injectSelections: async () => {},
      clickTarget: async () => {},
      resumeAppWorkflow: async () => { calls.push("resume"); },
      finalizeFailed: async () => { calls.push("failed"); },
    },
  };
}

test("solver route captures, validates, injects, and resumes through the declared seam", async () => {
  const tracked = trackedDependencies();
  assert.deepEqual(await routeVerificationActor({
    contract: captchaContract(),
    taskRunId: "run-solver",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  }), { kind: "resumed" });
  assert.deepEqual(tracked.calls, ["capture", "solve", "inject", "resume"]);
});

test("audio capture opens exactly one CAPTCHA campaign round", async () => {
  const tracked = trackedDependencies();
  let captures = 0;
  const contract: HumanAssistanceContract = {
    ...captchaContract(),
    challengeKind: "audio-captcha",
    challengeImageRegion: undefined,
    challengeAudioSource: {
      id: "audio",
      label: "Audio challenge",
      semanticId: "provider.login.audio",
    },
    expectedAnswerLength: 6,
  };
  assert.deepEqual(await routeVerificationActor({
    contract,
    taskRunId: "audio-run",
    confidenceThreshold: 0.9,
    dependencies: {
      ...tracked.dependencies,
      solver: { async solve() { return { answer: "123456", confidence: 0.1 }; } },
      captureChallengeAudio: async () => Buffer.from("audio bytes"),
      onChallengeCaptured: async () => { captures += 1; },
    },
  }), { kind: "retryable", reason: "solver-exhausted" });
  assert.equal(captures, 1);
});

test("a provider image owner never falls back to generic capture after failure", async () => {
  const calls: string[] = [];
  const selection = selectVerificationChallengeImage(captchaContract(), {
    provider: {
      handlesChallengeImage: () => true,
      captureChallengeImage: async () => {
        calls.push("provider");
        return null;
      },
      isChallengeImageCurrent: async () => true,
      refreshesChallengeImage: () => false,
      refreshChallengeImage: async () => false,
    },
    genericCaptureChallengeImage: async () => {
      calls.push("generic");
      return Buffer.from("generic");
    },
  });
  assert.equal(selection.providerOwned, true);
  assert.equal(await selection.captureChallengeImage("ses-owner", captchaContract()), null);
  assert.deepEqual(calls, ["provider"]);
});

test("App verification uses its task-run ID and ignores legacy session text", async () => {
  const taskRunId = "typed-verification-run";
  const routeIds: string[] = [];
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
  const outcome = await routeWaitingRunVerification({
    run: {
      taskId: "sinopac-statements",
      taskRunId,
      current: () => run as unknown as AutomationTaskRun,
    },
    pageForRun: () => null,
    settings: {},
    solver: { async solve() { return { answer: "1234", confidence: 0.99 }; } },
    providerVerification: {
      handlesChallengeImage: () => true,
      async captureChallengeImage(viewerKey) {
        routeIds.push(viewerKey);
        return Buffer.from("challenge");
      },
      async isChallengeImageCurrent(viewerKey) {
        routeIds.push(viewerKey);
        return true;
      },
      refreshesChallengeImage: () => false,
      async refreshChallengeImage() { return false; },
    },
    injectAnswer: async (viewerKey) => { routeIds.push(viewerKey); },
    providerProbePostSubmit: async (viewerKey, _contract, resume) => {
      routeIds.push(viewerKey);
      await resume();
      return "none";
    },
    resumeAppWorkflow: async () => { routeIds.push(taskRunId); },
    finalizeFailed: async () => { assert.fail("valid typed challenge should not fail"); },
  });

  assert.deepEqual(outcome, { kind: "resumed" });
  assert.equal(routeIds.length, 4);
  assert.ok(routeIds.every((viewerKey) => viewerKey === taskRunId));
});

type RefreshBehavior = "new-challenge" | "unchanged" | "throws";

function refreshRound(options: { refresh?: RefreshBehavior; acceptOnChallenge?: number }) {
  let challenge = 1;
  const capturedChallenges = new Set<number>();
  const counts = { refreshes: 0, injects: 0, probes: 0, resumes: 0, captureEvents: 0 };
  const failures: string[] = [];
  const dependencies: VerificationRoutingDependencies = {
    solver: {
      async solve() {
        return {
          answer: "1234",
          confidence: challenge === options.acceptOnChallenge ? 0.99 : 0.1,
        };
      },
    },
    captureChallengeImage: async () => {
      capturedChallenges.add(challenge);
      return Buffer.from(`challenge-${challenge}`);
    },
    injectAnswer: async () => { counts.injects += 1; },
    probePostSubmit: async (_session, _contract, resume) => {
      counts.probes += 1;
      await resume();
      return "none";
    },
    injectSelections: async () => {},
    clickTarget: async () => {},
    resumeAppWorkflow: async () => { counts.resumes += 1; },
    finalizeFailed: async (message) => { failures.push(message); },
    onChallengeCaptured: async () => { counts.captureEvents += 1; },
    ...(options.refresh
      ? {
          refreshChallenge: async () => {
            counts.refreshes += 1;
            if (options.refresh === "throws") throw new Error("refresh control detached");
            if (options.refresh === "unchanged") return false;
            challenge += 1;
            return true;
          },
        }
      : {}),
  };
  return {
    counts,
    failures,
    capturedChallenges,
    route: () => routeVerificationActor({
      contract: captchaContract(),
      taskRunId: "refresh-run",
      confidenceThreshold: 0.9,
      dependencies,
    }),
  };
}

test("a refresh-capable round solves five challenges without submitting any", async () => {
  const round = refreshRound({ refresh: "new-challenge" });
  assert.deepEqual(await round.route(), { kind: "retryable", reason: "solver-exhausted" });
  assert.deepEqual([...round.capturedChallenges], [1, 2, 3, 4, 5]);
  assert.equal(MAX_CHALLENGES_PER_ROUND, 5);
  assert.deepEqual(round.counts, {
    refreshes: 4,
    injects: 0,
    probes: 0,
    resumes: 0,
    captureEvents: 1,
  });
  assert.deepEqual(round.failures, []);
});

test("a refresh-capable round submits once when a later challenge is accepted", async () => {
  const round = refreshRound({ refresh: "new-challenge", acceptOnChallenge: 3 });
  assert.deepEqual(await round.route(), { kind: "resumed" });
  assert.deepEqual([...round.capturedChallenges], [1, 2, 3]);
  assert.deepEqual(round.counts, {
    refreshes: 2,
    injects: 1,
    probes: 1,
    resumes: 1,
    captureEvents: 1,
  });
});

test("a refresh that yields no new challenge ends the round without submitting", async () => {
  const round = refreshRound({ refresh: "unchanged" });
  assert.deepEqual(await round.route(), { kind: "retryable", reason: "solver-exhausted" });
  assert.deepEqual([...round.capturedChallenges], [1]);
  assert.equal(round.counts.refreshes, 1);
  assert.equal(round.counts.injects, 0);
  assert.equal(round.counts.resumes, 0);
});

test("a provider without a refresh control keeps one challenge per round", async () => {
  const round = refreshRound({});
  assert.deepEqual(await round.route(), { kind: "retryable", reason: "solver-exhausted" });
  assert.deepEqual([...round.capturedChallenges], [1]);
  assert.equal(round.counts.refreshes, 0);
  assert.equal(round.counts.injects, 0);
  assert.equal(round.counts.resumes, 0);
});

test("a refresh error fails the run instead of restarting it", async () => {
  const round = refreshRound({ refresh: "throws" });
  assert.deepEqual(await round.route(), { kind: "failed" });
  assert.equal(round.failures.length, 1);
  assert.equal(round.counts.resumes, 0);
  assert.equal(round.counts.probes, 0);
  assert.equal(round.counts.injects, 0);
});

test("only a provider-owned image whose owner declares a control gets a refresh seam", async () => {
  const refreshed: string[] = [];
  const provider = (owns: boolean, declaresRefresh: boolean) => ({
    handlesChallengeImage: () => owns,
    captureChallengeImage: async () => Buffer.from("provider"),
    isChallengeImageCurrent: async () => true,
    refreshesChallengeImage: () => declaresRefresh,
    refreshChallengeImage: async (session: string) => {
      refreshed.push(session);
      return true;
    },
  });
  const genericCaptureChallengeImage = async () => Buffer.from("generic");
  const select = (owns: boolean, declaresRefresh: boolean) => selectVerificationChallengeImage(
    captchaContract(),
    { provider: provider(owns, declaresRefresh), genericCaptureChallengeImage },
  );

  const declaring = select(true, true);
  assert.ok(declaring.refreshChallenge);
  assert.equal(await declaring.refreshChallenge("owner-session", captchaContract()), true);
  assert.deepEqual(refreshed, ["owner-session"]);
  assert.equal(select(true, false).refreshChallenge, undefined);
  assert.equal(select(false, true).refreshChallenge, undefined);

  const wired = verificationRoutingDependencies(captchaContract(), {
    providerVerification: provider(true, true),
    pageForRun: () => null,
    resumeAppWorkflow: async () => {},
    providerProbePostSubmit: async () => "none",
    finalizeFailed: async () => {},
  });
  assert.ok(wired.refreshChallenge);
  const generic = verificationRoutingDependencies(captchaContract(), {
    providerVerification: provider(false, true),
    pageForRun: () => null,
    resumeAppWorkflow: async () => {},
    providerProbePostSubmit: async () => "none",
    finalizeFailed: async () => {},
  });
  assert.equal(generic.refreshChallenge, undefined);
});

test("the default viewer seams reach a run's page only through the page lookup", async () => {
  const shots: unknown[] = [];
  const clicks: Array<[number, number]> = [];
  const page = {
    screenshot: async (options: unknown) => { shots.push(options); return Buffer.from("challenge"); },
    mouse: { click: async (x: number, y: number) => { clicks.push([x, y]); } },
  };
  const pageForRun = (taskRunId: string) => taskRunId === "hosted-run" ? page as never : null;
  const dependencies = verificationRoutingDependencies(captchaContract(), {
    pageForRun,
    resumeAppWorkflow: async () => {},
    providerProbePostSubmit: async () => "none",
    finalizeFailed: async () => {},
  });
  assert.deepEqual(await dependencies.captureChallengeImage("hosted-run", captchaContract()), Buffer.from("challenge"));
  assert.deepEqual(shots, [{ clip: { x: 0, y: 0, width: 200, height: 80 }, type: "png" }]);
  await dependencies.injectSelections("hosted-run", captchaContract(), [{ x: 5, y: 6 }]);
  assert.deepEqual(clicks, [[5, 6]]);
  await assert.rejects(
    dependencies.captureChallengeImage("other-run", captchaContract()),
    /No active App browser page is available/u,
  );
  await assert.rejects(
    dependencies.injectSelections("other-run", captchaContract(), [{ x: 5, y: 6 }]),
    /No active App browser page is available/u,
  );
  assert.equal(shots.length, 1);
  assert.equal(clicks.length, 1);
});
