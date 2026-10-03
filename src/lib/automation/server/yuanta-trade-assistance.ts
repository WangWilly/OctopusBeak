import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import {
  registerAppWorkflowHumanAssistanceRequestHandler,
  resumeAppWorkflowHumanAssistance,
  type AppWorkflowHumanAssistanceRequest,
} from "./app-workflow-human-assistance.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import { hostVerificationActorForSourceKey } from "../verification-config.ts";
import {
  createProviderVerificationHost,
  type ProviderVerificationHost,
} from "./provider-verification.ts";
import {
  routeWaitingRunVerification,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";
import {
  clickVerificationTarget,
  captureChallengeImageForContract,
  injectVerificationSelections,
  withViewerPage,
} from "./automation-viewer.ts";
import { YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR } from "../yuanta-trade-captcha.ts";
import type { AutomationPersistenceProvider } from "./store.ts";

export const YUANTA_TRADE_APP_TASK_ID = "yuanta-trade-statements";

type VerificationRouteInput = Parameters<typeof routeWaitingRunVerification>[0];

/** Injectable browser and solver seams for deterministic App-side checks. */
export type YuantaTradeVerificationRouteOptions = Partial<Pick<
  VerificationRouteInput,
  | "solver"
  | "captureChallengeImage"
  | "captureChallengeAudio"
  | "providerCaptureChallengeAudio"
  | "validateChallengeImage"
  | "injectAnswer"
  | "providerInjectAnswer"
  | "injectSelections"
  | "clickTarget"
  | "genericCaptureChallengeImage"
  | "onChallengeCaptured"
>>;

export type YuantaTradeAppAssistanceDependencies = Readonly<{
  provider: AutomationPersistenceProvider;
  settings: AutomationSettingsFile;
  verificationHost?: ProviderVerificationHost;
  route?: typeof routeWaitingRunVerification;
  waitForImageChallengeSubmission?: (
    viewerKey: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  routeOptions?: YuantaTradeVerificationRouteOptions;
}>;

function targetWithSemanticId(
  contract: HumanAssistanceContractInput,
  semanticId: string,
) {
  return contract.targets.find((target) => target.semanticId === semanticId);
}

/**
 * Only these provider-declared stages are sent to automatic verification.
 * Unknown and certificate-selection contracts remain available to the user.
 */
function isSupportedAutomaticStage(contract: HumanAssistanceContractInput) {
  if (contract.stageId === "yuanta-trade-audio-verification") {
    return contract.challengeKind === "audio-captcha"
      && contract.challengeAudioSource?.semanticId === "yuanta-trade.login.audio-challenge"
      && targetWithSemanticId(contract, "yuanta-trade.login.audio-code-input")?.modes.includes("type") === true;
  }
  if (contract.stageId === "yuanta-trade-captcha-checkbox") {
    return contract.challengeKind === "checkbox"
      && targetWithSemanticId(contract, "yuanta-trade.login.captcha-checkbox")?.modes.includes("click") === true;
  }
  if (contract.stageId === "yuanta-trade-challenge") {
    const submit = contract.targets.find((target) => (
      target.id === "challenge-submit"
      && target.semanticId === "yuanta-trade.login.challenge-submit"
      && target.modes.includes("click")
    ));
    return contract.challengeKind === "image-selection"
      && contract.challengeImageRegion?.semanticId === "yuanta-trade.login.challenge-image"
      && targetWithSemanticId(contract, "yuanta-trade.login.challenge-control")?.modes.includes("click") === true
      && submit !== undefined;
  }
  return false;
}

function guardedAsync<TArgs extends unknown[], TResult>(
  signal: AbortSignal,
  operation: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args) => {
    signal.throwIfAborted();
    const result = await operation(...args);
    signal.throwIfAborted();
    return result;
  };
}

function guardedHost(host: ProviderVerificationHost, signal: AbortSignal): ProviderVerificationHost {
  return {
    captureChallengeImage: guardedAsync(signal, host.captureChallengeImage),
    isChallengeImageCurrent: guardedAsync(signal, host.isChallengeImageCurrent),
    handlesChallengeImage(contract) {
      signal.throwIfAborted();
      return host.handlesChallengeImage(contract);
    },
    handlesChallengeAudio(contract) {
      signal.throwIfAborted();
      return host.handlesChallengeAudio(contract);
    },
    captureChallengeAudio: guardedAsync(signal, host.captureChallengeAudio),
    refreshTarget: guardedAsync(signal, host.refreshTarget),
    sendInput: guardedAsync(signal, host.sendInput),
    injectAnswer: guardedAsync(signal, host.injectAnswer),
    probePostSubmit: guardedAsync(signal, async (viewerKey, contract, resume) => (
      host.probePostSubmit(
        viewerKey,
        contract,
        guardedAsync(signal, async () => resume()),
      )
    )),
    inspectCompletion: guardedAsync(signal, host.inspectCompletion),
    waitForCompletion: guardedAsync(signal, host.waitForCompletion),
    shouldCheckCompletion(inputType, semanticId) {
      signal.throwIfAborted();
      return host.shouldCheckCompletion(inputType, semanticId);
    },
    shouldAutoResume(contract, targetId, verified) {
      signal.throwIfAborted();
      return host.shouldAutoResume(contract, targetId, verified);
    },
  };
}

async function resumeCurrentAssistance(
  request: AppWorkflowHumanAssistanceRequest,
  provider: AutomationPersistenceProvider,
) {
  request.signal.throwIfAborted();
  const current = await provider.automation.taskRunById(request.taskRunId);
  const assistance = current?.humanAssistanceContract;
  if (
    current?.status !== "waiting_for_human"
    || assistance?.stageId !== request.contract.stageId
  ) {
    throw new Error("Yuanta Trade assistance stage is no longer current.");
  }
  const status = assistance.completion.mode === "independent" ? "verified" : "entered";
  await provider.automation.updateHumanAssistanceCompletion(request.taskRunId, status);
  request.signal.throwIfAborted();
  if (!await resumeAppWorkflowHumanAssistance(request.taskRunId, status)) {
    throw new Error("Yuanta Trade App workflow could not resume the current assistance stage.");
  }
}

export async function routeYuantaTradeAppAssistanceRequest(
  request: AppWorkflowHumanAssistanceRequest,
  dependencies: YuantaTradeAppAssistanceDependencies,
): Promise<VerificationRoutingOutcome | undefined> {
  request.signal.throwIfAborted();
  const verificationActor = hostVerificationActorForSourceKey(
    "LIBRETTO_CLOUD_YUANTA_TRADE_VERIFICATION_ACTOR",
  );

  // ServiSign certificate selection is a native prerequisite and stays in the
  // live Assist session only in the explicit development human mode.
  if (!isSupportedAutomaticStage(request.contract)) {
    if (verificationActor === "human") return undefined;
    await dependencies.provider.automation.appendRunEvent({
      runId: request.taskRunId,
      stage: "authentication",
      code: "solver-challenge-unsupported",
      occurredAt: new Date().toISOString(),
    });
    throw new Error("Yuanta Trade verification stage is not supported by the automatic solver.");
  }
  if (
    request.contract.stageId === "yuanta-trade-challenge"
    && verificationActor === "solver"
  ) {
    await dependencies.provider.automation.appendRunEvent({
      runId: request.taskRunId,
      stage: "authentication",
      code: "solver-challenge-unsupported",
      occurredAt: new Date().toISOString(),
    });
    throw new Error("Yuanta Trade image challenge has no supported local solver.");
  }

  const host = guardedHost(
    dependencies.verificationHost ?? createProviderVerificationHost(),
    request.signal,
  );
  const route = dependencies.route ?? routeWaitingRunVerification;
  const routeOptions = dependencies.routeOptions ?? {};
  let audioAnswerInjected = false;
  let imageSelectionsInjected = false;
  const audioCapture = routeOptions.captureChallengeAudio
    ?? routeOptions.providerCaptureChallengeAudio
    ?? host.captureChallengeAudio;
  const answerInjection = routeOptions.injectAnswer
    ?? routeOptions.providerInjectAnswer
    ?? host.injectAnswer;
  const imageCapture = routeOptions.captureChallengeImage
    ?? captureChallengeImageForContract;
  const selectionInjection = routeOptions.injectSelections
    ?? injectVerificationSelections;
  const targetClick = routeOptions.clickTarget
    ?? clickVerificationTarget;
  let assistanceResumed = false;
  const waitForImageSubmit = dependencies.waitForImageChallengeSubmission
    ?? (async (viewerKey: string, signal: AbortSignal) => withViewerPage(viewerKey, async (page) => {
      signal.throwIfAborted();
      try {
        await page.locator(YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR)
          .first()
          .waitFor({ state: "hidden", timeout: 12_000 });
        signal.throwIfAborted();
        return true;
      } catch {
        signal.throwIfAborted();
        return false;
      }
    }));
  const options: VerificationRouteInput = {
    ...(routeOptions.solver
      ? {
        solver: {
          solve: guardedAsync(request.signal, routeOptions.solver.solve.bind(routeOptions.solver)),
        },
      }
      : {}),
    taskId: YUANTA_TRADE_APP_TASK_ID,
    taskRunId: request.taskRunId,
    provider: dependencies.provider,
    settings: dependencies.settings,
    providerVerification: host,
    ...(routeOptions.captureChallengeImage
      ? { captureChallengeImage: guardedAsync(request.signal, routeOptions.captureChallengeImage) }
      : {}),
    captureChallengeAudio: guardedAsync(request.signal, audioCapture),
    providerCaptureChallengeAudio: guardedAsync(request.signal, audioCapture),
    ...(routeOptions.validateChallengeImage
      ? { validateChallengeImage: guardedAsync(request.signal, routeOptions.validateChallengeImage) }
      : {}),
    injectAnswer: guardedAsync(request.signal, async (viewerKey, contract, answer) => {
      await answerInjection(viewerKey, contract, answer);
      if (contract.stageId === "yuanta-trade-audio-verification") audioAnswerInjected = true;
    }),
    providerInjectAnswer: guardedAsync(request.signal, async (viewerKey, contract, answer) => {
      await answerInjection(viewerKey, contract, answer);
      if (contract.stageId === "yuanta-trade-audio-verification") audioAnswerInjected = true;
    }),
    injectSelections: guardedAsync(request.signal, async (viewerKey, contract, selections) => {
      await selectionInjection(viewerKey, contract, selections);
      if (contract.stageId === "yuanta-trade-challenge") imageSelectionsInjected = true;
    }),
    clickTarget: guardedAsync(request.signal, async (viewerKey, contract, targetId) => {
      await targetClick(viewerKey, contract, targetId);
      if (
        contract.stageId === "yuanta-trade-captcha-checkbox"
        && !await host.inspectCompletion(viewerKey, contract)
      ) {
        throw new Error("Yuanta Trade CAPTCHA checkbox did not reach its verified state.");
      }
    }),
    genericCaptureChallengeImage: guardedAsync(request.signal,
      routeOptions.genericCaptureChallengeImage ?? imageCapture),
    ...(routeOptions.onChallengeCaptured
      ? {
        onChallengeCaptured: guardedAsync(request.signal, async () => {
          await routeOptions.onChallengeCaptured?.();
        }),
      }
      : {}),
    providerProbePostSubmit: guardedAsync(
      request.signal,
      async (viewerKey, contract, resume) => {
        if (
          contract.stageId === "yuanta-trade-audio-verification"
          && !audioAnswerInjected
        ) {
          return "none";
        }
        // The image-selection solver only clicks selected tiles. Yuanta's
        // provider contract declares submission separately, so click its
        // declared target before the workflow continues on this same run.
        if (contract.stageId === "yuanta-trade-challenge") {
          if (!imageSelectionsInjected) return "none";
          const submit = contract.targets.find((target) => (
            target.id === "challenge-submit"
            && target.semanticId === "yuanta-trade.login.challenge-submit"
            && target.modes.includes("click")
          ));
          if (!submit) {
            throw new Error("Yuanta Trade image challenge has no declared submit target.");
          }
          await host.sendInput(viewerKey, {
            type: "click",
            targetId: submit.id,
            contractVersion: contract.version,
          }, contract);
          if (!await waitForImageSubmit(viewerKey, request.signal)) {
            return "none";
          }
        }
        return host.probePostSubmit(
          viewerKey,
          contract,
          async () => { await resume(); },
        );
      },
    ),
    resumeAppWorkflow: async () => {
      await resumeCurrentAssistance(request, dependencies.provider);
      assistanceResumed = true;
    },
    finalizeFailed: async () => {
      // The executor owns the terminal transition. In particular, an abort
      // must remain a cancellation and never be converted into a route error.
      request.signal.throwIfAborted();
    },
  };

  const outcome = await route(options);
  if (request.signal.aborted) return;
  if (outcome.kind === "failed") {
    throw new Error("Yuanta Trade verification assistance failed closed.");
  }
  if (outcome.kind === "retryable") return outcome;
  // A missing audio/image source or a still-visible image challenge is a
  // handoff to the user's current Assist stage, not permission to resume.
  if (outcome.kind === "resumed" && !assistanceResumed) return { kind: "human" };
  return outcome;
}

/** Register the task-scoped handler while an App-owned Yuanta Trade run is active. */
export function registerYuantaTradeAppAssistanceHandler(
  dependencies: YuantaTradeAppAssistanceDependencies,
) {
  return registerAppWorkflowHumanAssistanceRequestHandler(
    YUANTA_TRADE_APP_TASK_ID,
    async (request) => {
      if (request.taskId !== YUANTA_TRADE_APP_TASK_ID) {
        throw new Error("Yuanta Trade assistance received a request for another App task.");
      }
      const outcome = await routeYuantaTradeAppAssistanceRequest(request, dependencies);
      if (outcome?.kind === "retryable") {
        throw new Error("Yuanta Trade verification failed; new CAPTCHA round required.");
      }
    },
  );
}
