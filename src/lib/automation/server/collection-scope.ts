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

type RunScope = {
  readonly task: Pick<AutomationTask, "credentialGroupId">;
  readonly launchFingerprint: string;
  refused: boolean;
};

const runScopes = new Map<string, RunScope>();

export type CollectionScopeRegistration = Readonly<{
  release(): void;
}>;

export function registerCollectionScope(
  taskRunId: string,
  task: Pick<AutomationTask, "credentialGroupId">,
  launchEnvironment: ScopeEnvironment,
): CollectionScopeRegistration {
  const scope: RunScope = {
    task,
    launchFingerprint: collectionScopeFingerprint(task, launchEnvironment),
    refused: false,
  };
  runScopes.set(taskRunId, scope);
  return {
    release: () => {
      if (runScopes.get(taskRunId) === scope) runScopes.delete(taskRunId);
    },
  };
}

/** False once the run's Collection scope version changed; it stays false for the rest of the run. */
export function collectionScopeCurrent(
  taskRunId: string,
  currentEnvironment: () => ScopeEnvironment = automationConfigEnv,
): boolean {
  const scope = runScopes.get(taskRunId);
  if (!scope) return true;
  if (!scope.refused
    && collectionScopeFingerprint(scope.task, currentEnvironment()) !== scope.launchFingerprint) {
    scope.refused = true;
  }
  return !scope.refused;
}
