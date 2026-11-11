import type { PGliteWorkflowRpc } from "../../pglite-rpc/pglite-child-rpc-client.ts";
import type { WorkflowDefinition } from "../workflow-executor.ts";
import { appWorkflowRegistration, type AppWorkflowRuntime } from "./app-workflow-registry.ts";
import {
  automationConfigEnv,
  type AutomationCredentialStore,
  type AutomationSettingsFile,
  type AutomationSettingsStore,
} from "./config-files.ts";
import type { AutomationTask } from "./tasks.ts";
import { sourceVerificationFacts, type SourceVerificationFacts } from "./verification-routing.ts";

/**
 * Everything one Active run executes with, resolved once after queue
 * admission (ADR 0075). Every round of the run reads it; nothing below the
 * runner looks the task up again.
 */
export type TaskRunPlan = Readonly<{
  task: AutomationTask;
  workflowId: string;
  registration: Readonly<{
    definition: WorkflowDefinition;
    runtime: AppWorkflowRuntime;
    /**
     * Builds the workflow input from `launchEnv`. Execution calls it inside
     * its failure handling, so an input that cannot be built (a Statement
     * Selection cleared while the run queued) is classified and recorded
     * like any other execution failure.
     */
    inputFromEnvironment(environment: NodeJS.ProcessEnv): unknown;
  }>;
  /** Null for a task without a Verified source: exchange rates, preview sources, fixtures. */
  verification: SourceVerificationFacts | null;
  /** Process configuration as the run launched with it. */
  launchEnv: NodeJS.ProcessEnv;
  /** Settings verification routing reads, as the run launched with them. */
  launchVerificationSettings: AutomationSettingsFile;
  /** The authenticated PGlite endpoint every workflow commits or reads through. */
  pgliteRpc: PGliteWorkflowRpc;
  credentials: AutomationCredentialStore;
  /** Absolute App user-data directory; browser workflows keep their profiles under it. */
  userDataDirectory: string;
}>;

export type TaskRunPlanDependencies = Readonly<{
  /** Absent or blank fails the resolution. */
  pgliteRpc: PGliteWorkflowRpc | undefined;
  credentials: AutomationCredentialStore;
  settings: AutomationSettingsStore;
  userDataDirectory: string;
  /** Defaults to `process.env` with every settings and credential key taken from the stores only. */
  launchEnv?: NodeJS.ProcessEnv;
  /** Defaults to the App settings file. */
  launchVerificationSettings?: AutomationSettingsFile;
}>;

/** Resolve a run's plan, or throw when the task cannot run: an unknown workflow or no PGlite RPC. */
export function resolveTaskRunPlan(
  task: AutomationTask,
  dependencies: TaskRunPlanDependencies,
): TaskRunPlan {
  const { workflowId } = task;
  if (!workflowId) throw new Error(`Automation task is not registered with the App executor: ${task.id}`);
  const registration = appWorkflowRegistration(workflowId);
  if (!registration) throw new Error(`App workflow definition is unavailable: ${workflowId}`);
  const { pgliteRpc, credentials, userDataDirectory } = dependencies;
  if (!pgliteRpc?.endpoint.trim() || !pgliteRpc.token.trim()) {
    throw new Error("PGlite workflow transport is unavailable.");
  }
  let settings: AutomationSettingsFile | undefined;
  const launchSettings = () => (settings ??= dependencies.settings.read());
  const launchEnv = dependencies.launchEnv ?? automationConfigEnv({
    baseEnv: process.env,
    settings: launchSettings(),
    credentials: credentials.read(),
  });
  return {
    task,
    workflowId,
    registration: {
      definition: registration.definition,
      runtime: registration.runtime,
      inputFromEnvironment: registration.inputFromEnvironment,
    },
    verification: sourceVerificationFacts(task.id),
    launchEnv,
    launchVerificationSettings: dependencies.launchVerificationSettings ?? { ...launchSettings() },
    pgliteRpc,
    credentials,
    userDataDirectory,
  };
}
