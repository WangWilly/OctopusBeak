import type { AutomationRuntime } from "../src/lib/automation/server/automation-runtime.ts";
import type { AutomationPersistenceProvider } from "../src/lib/automation/server/store.ts";
import { createHumanAssistanceContract } from "../src/lib/automation/human-assistance.ts";

/**
 * What the disposable CDP fixture seeds once the runtime has recovered. It is
 * test-only: main runs it only for a fixture launch, never against a person's
 * ledger.
 */
export type CdpRuntimeFixture = Readonly<{
  /** A waiting E.SUN verification run, so the assistance UI can be driven. */
  verification: boolean;
  /** An active task the runtime does not know, so the fatal invariant can be exercised. */
  unknownActiveTask: boolean;
}>;

export async function seedCdpRuntimeFixture(
  runtime: AutomationRuntime,
  provider: AutomationPersistenceProvider,
  fixture: CdpRuntimeFixture,
): Promise<void> {
  if (fixture.verification) {
    const contract = createHumanAssistanceContract({
      stageId: "esun-credit-card-login-captcha",
      title: "Complete the E.SUN verification challenge",
      targets: [{
        id: "captcha-input",
        label: "Verification code",
        semanticId: "esun.login.captcha-input",
        modes: ["type"],
        rect: { x: 220, y: 280, width: 220, height: 42 },
      }],
      contextRegions: [],
      challengeKind: "text-captcha",
      charset: "digits",
      expectedAnswerLength: 6,
      challengeImageRegion: {
        id: "captcha-image",
        label: "Verification image",
        semanticId: "esun.login.captcha-image",
        rect: { x: 220, y: 210, width: 220, height: 54 },
      },
      completion: { mode: "inline", targetIds: ["captcha-input"] },
      focus: { targetId: "captcha-input", contextRegionIds: [] },
    }, 1);
    await provider.automation.createTaskRun({
      taskId: "esun-credit-card-statements",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      humanAssistanceContract: contract,
    });
    await runtime.rehydrate();
  }
  if (fixture.unknownActiveTask) {
    runtime.upsertRuntimeTask({
      taskId: "unknown-cdp-active-task",
      runId: "unknown-cdp-run",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      progress: {
        phaseCode: "fixture",
        completed: 0,
        total: 1,
        percent: 0,
        attempt: 1,
      },
      appWorkflowOutcome: null,
      updatedAt: new Date().toISOString(),
    });
  }
}
