import { signalRunEvent } from "../run-event.ts";
import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import {
  completeAppWorkflowHumanAssistance,
  type AppWorkflowHumanAssistanceRequest,
} from "./app-workflow-human-assistance.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import {
  appVerificationSolver,
  noPostSubmitOutcome,
  routeWaitingRunVerification,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";
import type { PageForRun } from "./automation-viewer.ts";
import type { VerificationSolver } from "./verification-solver.ts";
import {
  YUANTA_TRADE_AUDIO_SEMANTIC_ID,
  YUANTA_TRADE_CAPTCHA_CHECKBOX_SEMANTIC_ID,
  YUANTA_TRADE_CAPTCHA_CHECKBOX_STAGE_ID,
  YUANTA_TRADE_CHALLENGE_CONTROL_SEMANTIC_ID,
  YUANTA_TRADE_CHALLENGE_SUBMIT_SEMANTIC_ID,
} from "../yuanta-trade-captcha.ts";

export type YuantaTradeAppAssistanceDependencies = Readonly<{
  settings: AutomationSettingsFile;
  pageForRun: PageForRun;
  route?: typeof routeWaitingRunVerification;
  /** Defaults to the App's local solver. */
  solver?: VerificationSolver;
  onChallengeCaptured?: () => void | Promise<void>;
}>;

function targetWithSemanticId(
  contract: HumanAssistanceContractInput,
  semanticId: string,
) {
  return contract.targets.find((target) => target.semanticId === semanticId);
}

/**
 * Only these provider-declared stages are sent to automatic verification.
 * Unknown and certificate-selection contracts fail closed.
 */
function isSupportedAutomaticStage(contract: HumanAssistanceContractInput) {
  if (contract.stageId === "yuanta-trade-audio-verification") {
    return contract.challengeKind === "audio-captcha"
      && contract.challengeAudioSource?.semanticId === YUANTA_TRADE_AUDIO_SEMANTIC_ID
      && targetWithSemanticId(contract, "yuanta-trade.login.audio-code-input")?.modes.includes("type") === true;
  }
  if (contract.stageId === YUANTA_TRADE_CAPTCHA_CHECKBOX_STAGE_ID) {
    return contract.challengeKind === "checkbox"
      && targetWithSemanticId(contract, YUANTA_TRADE_CAPTCHA_CHECKBOX_SEMANTIC_ID)?.modes.includes("click") === true;
  }
  if (contract.stageId === "yuanta-trade-challenge") {
    const submit = contract.targets.find((target) => (
      target.id === "challenge-submit"
      && target.semanticId === YUANTA_TRADE_CHALLENGE_SUBMIT_SEMANTIC_ID
      && target.modes.includes("click")
    ));
    return contract.challengeKind === "image-selection"
      && contract.challengeImageRegion?.semanticId === "yuanta-trade.login.challenge-image"
      && targetWithSemanticId(contract, YUANTA_TRADE_CHALLENGE_CONTROL_SEMANTIC_ID)?.modes.includes("click") === true
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

export async function routeYuantaTradeAppAssistanceRequest(
  request: AppWorkflowHumanAssistanceRequest,
  dependencies: YuantaTradeAppAssistanceDependencies,
): Promise<VerificationRoutingOutcome | undefined> {
  request.signal.throwIfAborted();

  // ServiSign certificate selection is a native prerequisite the solver
  // cannot complete.
  if (!isSupportedAutomaticStage(request.contract)) {
    await request.execution.appendEvent(signalRunEvent("solver-challenge-unsupported", {
      runId: request.run.taskRunId,
      occurredAt: new Date().toISOString(),
    }));
    throw new Error("Yuanta Trade verification stage is not supported by the automatic solver.");
  }
  if (request.contract.stageId === "yuanta-trade-challenge") {
    await request.execution.appendEvent(signalRunEvent("solver-challenge-unsupported", {
      runId: request.run.taskRunId,
      occurredAt: new Date().toISOString(),
    }));
    throw new Error("Yuanta Trade image challenge has no supported local solver.");
  }

  const route = dependencies.route ?? routeWaitingRunVerification;
  const solver = dependencies.solver ?? appVerificationSolver;
  let assistanceResumed = false;
  const outcome = await route({
    run: request.run,
    pageForRun: dependencies.pageForRun,
    settings: dependencies.settings,
    // A cancelled request keeps a late solver answer off the page.
    solver: { solve: guardedAsync(request.signal, solver.solve.bind(solver)) },
    resume: guardedAsync(request.signal, async () => {
      await completeAppWorkflowHumanAssistance(request);
      assistanceResumed = true;
    }),
    postSubmitOutcome: noPostSubmitOutcome,
    finalizeFailed: async () => {
      // The executor owns the terminal transition. In particular, an abort
      // must remain a cancellation and never be converted into a route error.
      request.signal.throwIfAborted();
    },
    onChallengeCaptured: guardedAsync(request.signal, async () => {
      await dependencies.onChallengeCaptured?.();
    }),
  });
  if (request.signal.aborted) return;
  if (outcome.kind === "failed") {
    throw new Error("Yuanta Trade verification assistance failed closed.");
  }
  if (outcome.kind === "retryable") return outcome;
  // A stage the route did not resume never grants permission to continue.
  if (outcome.kind === "resumed" && !assistanceResumed) {
    throw new Error("Yuanta Trade verification did not complete the current stage.");
  }
  return outcome;
}
