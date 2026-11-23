import { createHash } from "node:crypto";
import {
  automationFlagEnabled,
  isStatementSelectionGroup,
  selectStatementTypes,
} from "../statement-selection.ts";
import { PREVIEW_SOURCES } from "../../preview-sources/registry.ts";
import { previewVisibilityFromEnvironment } from "../../preview-sources/visibility.ts";
import { offeredStatementTypes } from "./settings.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, type AutomationTask } from "./tasks.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";
import type { WorkflowWriteAdmission } from "../../pglite-rpc/workflow-admission.ts";

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
 * Write admission for the PGlite child RPC: the run's current execution
 * checks its launched Collection scope version. Only a current execution
 * writes, so anything else is `run-not-current` (ADR 0148).
 */
export function collectionScopeAdmission(
  run: Pick<ActiveAutomationTaskRun, "currentExecution"> | null,
  currentEnvironment: () => ScopeEnvironment,
): WorkflowWriteAdmission {
  const scope = run?.currentExecution()?.collectionScope();
  if (!scope) return "run-not-current";
  return scope.current(currentEnvironment) ? "admitted" : "scope-changed";
}

