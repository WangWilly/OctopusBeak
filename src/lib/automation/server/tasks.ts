import type {
  AutomationCredentialGroup,
  AutomationTaskSummary,
} from "../types.ts";
import { statementSelectionGroup, VERIFIED_SOURCES } from "./sources/index.ts";
import type { VerifiedSource } from "./sources/verified-source.ts";
import { VERIFICATION_CONFIDENCE_THRESHOLD_KEYS } from "../verification-config.ts";
import {
  assertPreviewRegistry,
  PREVIEW_SOURCES,
  previewCredentialGroup,
} from "../../preview-sources/registry.ts";
import { previewTaskId } from "../../preview-sources/source-id.ts";
import {
  PACKAGED_BROWSER_FIXTURE_TASKS,
  packagedBrowserFixtureEnabled,
} from "./packaged-browser-fixture.ts";

export type {
  AutomationCredentialGroup,
  AutomationTaskKind,
  AutomationTaskSummary,
} from "../types.ts";

export type AutomationTask = AutomationTaskSummary & {
  maxAttempts: number;
  /** App-owned typed workflow definition, when this task has migrated. */
  workflowId?: string;
};

function verifiedCredentialGroup(source: VerifiedSource): AutomationCredentialGroup {
  return {
    ...statementSelectionGroup(source),
    id: source.id,
    label: source.label,
    displayName: source.displayName,
    searchAliases: source.searchAliases,
    enabledKey: source.enabledKey,
    credentialKeys: source.credentialFields.map((field) => field.key),
    credentialFields: source.credentialFields,
    setupGuide: source.setupGuide,
    ...(source.sessionTakeover ? { sessionTakeover: { notice: source.sessionTakeover.notice } } : {}),
  };
}

function verifiedTask(source: VerifiedSource): AutomationTask {
  return {
    id: source.task.id,
    label: source.task.label,
    displayName: source.displayName,
    workflowId: source.task.id,
    kind: source.task.kind,
    credentialGroupId: source.id,
    integrationNamespaces: [...new Set([
      source.integrationNamespace,
      ...source.statementSelection?.products.flatMap(({ integrationNamespace }) => integrationNamespace ?? []) ?? [],
    ])],
    credentialKeys: source.credentialFields.map((field) => field.key),
    dependencies: [],
    ...(source.task.externalPrerequisites ? { externalPrerequisites: source.task.externalPrerequisites } : {}),
    maxAttempts: 1,
  };
}

const VERIFIED_CREDENTIAL_GROUPS: readonly AutomationCredentialGroup[] =
  VERIFIED_SOURCES.map(verifiedCredentialGroup);

const PREVIEW_SOURCE_REGISTRY = assertPreviewRegistry(
  PREVIEW_SOURCES,
  VERIFIED_CREDENTIAL_GROUPS.map((group) => group.id),
);

export const AUTOMATION_CREDENTIAL_GROUPS: readonly AutomationCredentialGroup[] = [
  ...VERIFIED_CREDENTIAL_GROUPS,
  ...PREVIEW_SOURCE_REGISTRY.map(previewCredentialGroup),
];

const previewTasks: readonly AutomationTask[] = PREVIEW_SOURCE_REGISTRY.map((source) => ({
  id: previewTaskId(source),
  label: source.displayName.en,
  displayName: source.displayName,
  workflowId: previewTaskId(source),
  kind: "crawler",
  credentialGroupId: source.id,
  integrationNamespaces: [],
  credentialKeys: source.credentialFields.map((field) => field.key),
  dependencies: [],
  maxAttempts: 1,
}));

const EXCHANGE_RATE_TASK: AutomationTask = {
  id: "exchange-rates",
  label: "Exchange rates",
  displayName: { en: "Exchange rates", "zh-TW": "匯率同步" },
  workflowId: "exchange-rates",
  kind: "sync",
  integrationNamespaces: [],
  credentialKeys: [],
  dependencies: [],
  maxAttempts: 1,
};

const VERIFIED_TASKS = VERIFIED_SOURCES.map(verifiedTask);

const coreAutomationTasks: readonly AutomationTask[] = [
  ...VERIFIED_TASKS.filter((task) => task.kind === "crawler"),
  EXCHANGE_RATE_TASK,
  ...VERIFIED_TASKS.filter((task) => task.kind === "sync"),
];

const fixtureLabel = (index: number) => index === 0
  ? "Packaged browser fixture success"
  : "Packaged browser fixture cancellation";

export function automationTasksForEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): readonly AutomationTask[] {
  const packagedBrowserFixtureTasks: readonly AutomationTask[] =
    packagedBrowserFixtureEnabled(environment)
    ? PACKAGED_BROWSER_FIXTURE_TASKS.map(({ taskId, workflowId }, index) => ({
      id: taskId,
      label: fixtureLabel(index),
      displayName: { en: fixtureLabel(index), "zh-TW": fixtureLabel(index) },
      workflowId,
      kind: "crawler",
      integrationNamespaces: [],
      credentialKeys: [],
      dependencies: [],
      maxAttempts: 1,
    }))
    : [];
  return [...coreAutomationTasks, ...previewTasks, ...packagedBrowserFixtureTasks];
}

export const AUTOMATION_TASKS: readonly AutomationTask[] = automationTasksForEnvironment();

export const AUTOMATION_CREDENTIAL_KEYS = Array.from(
  new Set(
    AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) => group.credentialKeys),
  ),
);

/** Secrets owned by the application rather than exposed as credential fields. */
export const AUTOMATION_MANAGED_SECRET_KEYS = [
  "LIBRETTO_CLOUD_FUBON_CARD_IDENTITY_FINGERPRINT_KEY",
] as const;

/**
 * First-run settings. Each Verified source is written disabled rather than
 * left unset, because a setting takes precedence over the environment.
 */
export const DEFAULT_AUTOMATION_SETTINGS: Readonly<Record<string, string | boolean>> = {
  AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
  ...Object.fromEntries(VERIFIED_SOURCES.map((source) => [source.enabledKey, false])),
  MAX_SUB_ACCOUNT: "main",
};

export const AUTOMATION_ENABLED_KEYS = AUTOMATION_CREDENTIAL_GROUPS.map(
  (group) => group.enabledKey,
);

const AUTOMATION_STATEMENT_SELECTION_KEYS =
  AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) =>
    group.statementSelectionKey ? [group.statementSelectionKey] : [],
  );

const AUTOMATION_CONFIDENCE_THRESHOLD_KEYS = Object.values(
  VERIFICATION_CONFIDENCE_THRESHOLD_KEYS,
);

export const AUTOMATION_NON_SECRET_KEYS = [
  "SYSTEM_TIMEZONE",
  "EXCHANGE_RATE_UPDATE_TIME",
  "SCHEDULED_COLLECTION_ENABLED",
  "SCHEDULED_COLLECTION_TIME",
  "PREVIEW_FEATURES_ENABLED",
  "USAGE_STATISTICS_ENABLED",
  "USAGE_STATISTICS_PROMPTED",
  "USAGE_STATISTICS_RETIRED",
  "USAGE_REFUSED_DAY",
  "USAGE_COHORT_WEEK",
  "USAGE_LAST_SENT_DAY",
  "AUTOMATION_BUSINESS_TIMEZONE",
  "MAX_SUB_ACCOUNT",
  ...AUTOMATION_ENABLED_KEYS,
  ...AUTOMATION_STATEMENT_SELECTION_KEYS,
  ...AUTOMATION_CONFIDENCE_THRESHOLD_KEYS,
] as const;

const nonSecretCredentialKeys = new Set<string>(["MAX_SUB_ACCOUNT"]);

/** Device identities the App creates beside a Preview source's sign-in details (ADR 0082). */
const PREVIEW_DEVICE_IDENTITY_KEYS = PREVIEW_SOURCE_REGISTRY.flatMap((source) =>
  source.deviceIdentityKey ? [source.deviceIdentityKey] : []);

export const AUTOMATION_SECRET_KEYS = [
  ...AUTOMATION_CREDENTIAL_KEYS.filter(
    (key) => !nonSecretCredentialKeys.has(key),
  ),
  ...AUTOMATION_MANAGED_SECRET_KEYS,
  ...PREVIEW_DEVICE_IDENTITY_KEYS,
];

export function automationCredentialKeyIsSecret(key: string) {
  return !nonSecretCredentialKeys.has(key);
}

export function taskById(taskId: string) {
  return AUTOMATION_TASKS.find((task) => task.id === taskId) ?? null;
}

function taskIsEnabled(
  task: AutomationTask,
  enabledGroups: Record<string, boolean>,
) {
  return (
    !task.credentialGroupId || enabledGroups[task.credentialGroupId] !== false
  );
}

export function enabledAutomationTasks(enabledGroups: Record<string, boolean>) {
  return AUTOMATION_TASKS.filter((task) => taskIsEnabled(task, enabledGroups));
}
