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
import type { RunConfiguration } from "./config-files.ts";

export function collectionScopeFingerprint(
  task: Pick<AutomationTask, "credentialGroupId">,
  { settings, credentials }: RunConfiguration,
): string {
  const registered = AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === task.credentialGroupId);
  const group = registered && offeredStatementTypes(registered, previewVisibilityFromEnvironment(settings, PREVIEW_SOURCES));
  const scope = group
    ? {
      enabled: automationFlagEnabled(settings[group.enabledKey]),
      statementTypes: isStatementSelectionGroup(group)
        ? selectStatementTypes(group, settings, "display").selectedIds
        : [],
      // A text sign-in field is a credential, or a setting such as the MAX sub-account.
      identity: group.credentialFields
        .filter((field) => field.input === "text")
        .map((field) => [field.key, (credentials[field.key] ?? settings[field.key])?.trim() ?? ""]),
    }
    : null;
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

/** The Collection scope version a Workflow execution was launched with (ADR 0067). */
export type LaunchedCollectionScope = Readonly<{
  /** False once the Collection scope version changed; it stays false for the rest of the execution. */
  current(currentConfiguration: () => RunConfiguration): boolean;
}>;

export function launchedCollectionScope(
  task: Pick<AutomationTask, "credentialGroupId">,
  launchConfiguration: RunConfiguration,
): LaunchedCollectionScope {
  const launchFingerprint = collectionScopeFingerprint(task, launchConfiguration);
  let refused = false;
  return {
    current(currentConfiguration) {
      if (!refused && collectionScopeFingerprint(task, currentConfiguration()) !== launchFingerprint) {
        refused = true;
      }
      return !refused;
    },
  };
}

/**
 * Write admission for the PGlite child RPC: the run's current execution
 * checks its launched Collection scope version against the configuration
 * its task would launch with now. Only a current execution writes, so
 * anything else is `run-not-current` (ADR 0148).
 */
export function collectionScopeAdmission(
  run: Pick<ActiveAutomationTaskRun, "taskId" | "currentExecution"> | null,
  currentConfiguration: (taskId: string) => RunConfiguration,
): WorkflowWriteAdmission {
  const scope = run?.currentExecution()?.collectionScope();
  if (!run || !scope) return "run-not-current";
  return scope.current(() => currentConfiguration(run.taskId)) ? "admitted" : "scope-changed";
}

