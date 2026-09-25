import assert from "node:assert/strict";
import test from "node:test";
import {
  routeVerificationActor,
  routeWaitingRunVerification,
  selectVerificationChallengeImage,
  type VerificationRoutingDependencies,
} from "./verification-routing.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
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

test("human verification actor leaves the challenge untouched", async () => {
  const tracked = trackedDependencies();
  assert.deepEqual(await routeVerificationActor({
    actor: "human",
    contract: captchaContract(),
    taskRunId: "run-human",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  }), { kind: "human" });
  assert.deepEqual(tracked.calls, []);
});

test("solver route captures, validates, injects, and resumes through the declared seam", async () => {
  const tracked = trackedDependencies();
  assert.deepEqual(await routeVerificationActor({
    actor: "solver",
    contract: captchaContract(),
    taskRunId: "run-solver",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  }), { kind: "resumed" });
  assert.deepEqual(tracked.calls, ["capture", "solve", "inject", "resume"]);
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
  const provider = {
    automation: {
      async taskRunById(id: string) { return id === taskRunId ? run : null; },
    },
  } as unknown as AutomationPersistenceProvider;
  const outcome = await routeWaitingRunVerification({
    taskId: "sinopac-statements",
    taskRunId,
    provider,
    settings: { LIBRETTO_CLOUD_SINOPAC_VERIFICATION_ACTOR: "solver" },
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
