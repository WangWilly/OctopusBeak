import { createHash } from "node:crypto";
import {
  automationFlagEnabled,
  isStatementSelectionGroup,
  selectStatementTypes,
} from "../statement-selection.ts";
import { PREVIEW_SOURCES } from "../../preview-sources/registry.ts";
import { previewVisibilityFromEnvironment } from "../../preview-sources/visibility.ts";
import { automationConfigEnv } from "./config-files.ts";
import { offeredStatementTypes } from "./settings.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, type AutomationTask } from "./tasks.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";

type ScopeEnvironment = Readonly<Record<string, string | undefined>>;

export function collectionScopeFingerprint(
  task: Pick<AutomationTask, "credentialGroupId">,
  environment: ScopeEnvironment,
): string {
  const registered = AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === task.credentialGroupId);
  const group = registered && offeredStatementTypes(registered, previewVisibilityFromEnvironment(environment, PREVIEW_SOURCES));
  const scope = group
    ? {
      enabled: automationFlagEnabled(environment[group.enabledKey]),
      statementTypes: isStatementSelectionGroup(group)
        ? selectStatementTypes(group, environment, "display").selectedIds
        : [],
      identity: group.credentialFields
        .filter((field) => field.input === "text")
        .map((field) => [field.key, environment[field.key]?.trim() ?? ""]),
    }
    : null;
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

/** The Collection scope version a Workflow execution was launched with (ADR 0067). */
export type LaunchedCollectionScope = Readonly<{
  /** False once the Collection scope version changed; it stays false for the rest of the execution. */
  current(currentEnvironment: () => ScopeEnvironment): boolean;
}>;

export function launchedCollectionScope(
  task: Pick<AutomationTask, "credentialGroupId">,
  launchEnvironment: ScopeEnvironment,
): LaunchedCollectionScope {
  const launchFingerprint = collectionScopeFingerprint(task, launchEnvironment);
  let refused = false;
  return {
    current(currentEnvironment) {
      if (!refused && collectionScopeFingerprint(task, currentEnvironment()) !== launchFingerprint) {
        refused = true;
      }
      return !refused;
    },
  };
}

/**
 * Commit admission for the PGlite child RPC: the run's current execution
 * checks its launched Collection scope version. A run id with no active run,
 * or an active run with no current execution, is not gated.
 */
export function collectionScopeAdmitsCommit(
  run: Pick<ActiveAutomationTaskRun, "currentExecution"> | null,
  currentEnvironment: () => ScopeEnvironment = automationConfigEnv,
): boolean {
  const scope = run?.currentExecution()?.collectionScope();
  return scope ? scope.current(currentEnvironment) : true;
}
