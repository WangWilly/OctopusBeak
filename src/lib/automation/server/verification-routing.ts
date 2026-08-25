import type { LedgerDatabase } from "../../../ledger/db/client.ts";
import type { HumanAssistanceContract, ChallengeCharacterSet } from "../human-assistance.ts";
import {
  DEFAULT_VERIFICATION_CONFIDENCE_THRESHOLD,
  challengeConfidenceThreshold,
  isSolverChallengeKind,
  verificationActorForSource,
  type VerificationActor,
} from "../verification-config.ts";
import {
  solveVerificationChallenge,
  verificationPlanForContract,
  type SolveOutcome,
  type VerificationSelectionPoint,
  type VerificationSolver,
} from "./verification-solver.ts";
import { localVerificationSolver } from "./local-verification-solver.ts";
import {
  captureChallengeImageForContract,
  clickVerificationTarget,
  injectVerificationAnswer,
  injectVerificationSelections,
} from "./automation-viewer.ts";
import { finalizeFailedWaitingRun } from "./task-run-finalization.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";
import { readAutomationSettings } from "./settings.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import { sessionFromRun } from "./automation-session-disposition.ts";
import { taskRunById } from "./store.ts";

export type VerificationRoutingDependencies = {
  solver: VerificationSolver;
  captureChallengeImage: (
    session: string,
    contract: HumanAssistanceContract,
  ) => Promise<Buffer | null>;
  injectAnswer: (
    session: string,
    contract: HumanAssistanceContract,
    answer: string,
  ) => Promise<void>;
  injectSelections: (
    session: string,
    contract: HumanAssistanceContract,
    selections: readonly VerificationSelectionPoint[],
  ) => Promise<void>;
  clickTarget: (
    session: string,
    contract: HumanAssistanceContract,
    targetId: string,
  ) => Promise<void>;
  resume: (session: string) => void | Promise<void>;
  finalizeFailed: (message: string) => void | Promise<void>;
};

export type VerificationRoutingOutcome =
  | { kind: "human" }
  | { kind: "resumed" }
  | { kind: "failed" };

const defaultLocalSolver = localVerificationSolver();

export async function routeVerificationActor(input: {
  actor: VerificationActor;
  contract: HumanAssistanceContract | null;
  session: string;
  confidenceThreshold: number | undefined;
  prompt?: string;
  charset?: ChallengeCharacterSet;
  dependencies: VerificationRoutingDependencies;
}): Promise<VerificationRoutingOutcome> {
  if (input.actor !== "solver") return { kind: "human" };
  const contract = input.contract;
  const plan = verificationPlanForContract(contract);
  const deps = input.dependencies;
  if (plan.kind === "proceed") {
    await deps.resume(input.session);
    return { kind: "resumed" };
  }
  if (plan.kind === "click") {
    await deps.clickTarget(input.session, contract!, plan.targetId);
    await deps.resume(input.session);
    return { kind: "resumed" };
  }
  if (plan.kind === "unsolvable") {
    await deps.finalizeFailed("Verification challenge cannot be solved.");
    return { kind: "failed" };
  }
  let outcome: SolveOutcome;
  try {
    outcome = await solveVerificationChallenge({
      challengeKind: plan.challengeKind,
      confidenceThreshold:
        input.confidenceThreshold ?? DEFAULT_VERIFICATION_CONFIDENCE_THRESHOLD,
      solver: deps.solver,
      captureChallengeImage: () =>
        deps.captureChallengeImage(input.session, contract!),
      injectAnswer: (answer) =>
        deps.injectAnswer(input.session, contract!, answer),
      injectSelections: (selections) =>
        deps.injectSelections(input.session, contract!, selections),
      prompt: input.prompt,
      charset: input.charset,
    });
  } catch {
    await deps.finalizeFailed("Verification solver failed to solve the challenge.");
    return { kind: "failed" };
  }
  if (outcome.status === "solved" || outcome.status === "absent") {
    await deps.resume(input.session);
    return { kind: "resumed" };
  }
  await deps.finalizeFailed("Verification solver exhausted its attempts.");
  return { kind: "failed" };
}

export async function routeWaitingRunVerification(input: {
  taskId: string;
  taskRunId: string;
  db: LedgerDatabase;
  scheduleResume: (session: string) => void;
  solver?: VerificationSolver;
  captureChallengeImage?: VerificationRoutingDependencies["captureChallengeImage"];
  injectAnswer?: VerificationRoutingDependencies["injectAnswer"];
  injectSelections?: VerificationRoutingDependencies["injectSelections"];
  clickTarget?: VerificationRoutingDependencies["clickTarget"];
  finalizeFailed?: VerificationRoutingDependencies["finalizeFailed"];
  settings?: AutomationSettingsFile;
}): Promise<VerificationRoutingOutcome> {
  const task = taskById(input.taskId);
  const group = task?.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  const settings = input.settings ?? readAutomationSettings();
  const actor = verificationActorForSource(group?.verificationActorKey, settings);
  if (actor !== "solver") return { kind: "human" };

  const run = taskRunById(input.db, input.taskRunId);
  if (!run) return { kind: "human" };
  const contract = run.humanAssistanceContract;
  const session = sessionFromRun(run);

  const finalizeFailed =
    input.finalizeFailed ??
    ((message: string) => finalizeFailedWaitingRun(input.db, run, message));

  if (!session) {
    await finalizeFailed("Verification solver could not resolve the session.");
    return { kind: "failed" };
  }

  const kind = contract?.challengeKind;
  const confidenceThreshold = isSolverChallengeKind(kind)
    ? challengeConfidenceThreshold(settings, kind)
    : undefined;

  const dependencies: VerificationRoutingDependencies = {
    solver: input.solver ?? defaultLocalSolver,
    captureChallengeImage:
      input.captureChallengeImage ?? captureChallengeImageForContract,
    injectAnswer: input.injectAnswer ?? injectVerificationAnswer,
    injectSelections: input.injectSelections ?? injectVerificationSelections,
    clickTarget: input.clickTarget ?? clickVerificationTarget,
    resume: (session) => {
      input.scheduleResume(session);
    },
    finalizeFailed,
  };

  return routeVerificationActor({
    actor,
    contract,
    session,
    confidenceThreshold,
    charset: contract?.charset,
    prompt: contract?.prompt,
    dependencies,
  });
}
