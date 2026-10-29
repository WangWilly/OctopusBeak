import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_CREDENTIAL_KEYS,
  enabledAutomationTasks,
  taskById,
} from "./tasks.ts";
import {
  isStatementSelectionGroup,
  selectStatementTypes,
} from "../statement-selection.ts";
import {
  credentialStatusFromValues,
  readAutomationCredentialsFile,
} from "./config-files.ts";
import { businessDayUtcRange } from "./business-day.ts";
import { buildAutomationPageModel } from "./page-model.ts";
import {
  automationBusinessTimezone,
  offeredAutomationSources,
  readAutomationSettings,
} from "./settings.ts";
import type {
  AutomationPersistenceProvider,
  AutomationTaskPrerequisiteNoticeRecord,
} from "./store.ts";
import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
import {
  certificateFilename,
  validateCertificateFilePath,
} from "./credential-file.ts";
import type {
  AutomationCoreSnapshot,
  AutomationCredentialGroupCoreDto,
  AutomationCredentialStateDto,
  AutomationDesktopModel,
  AutomationRuntimeSnapshot,
} from "$lib/desktop/api.ts";

const optionalCredentialKeys = new Set(["MAX_SUB_ACCOUNT"]);
/** Credentials whose value is a certificate file path rather than a secret. */
export const CERTIFICATE_FILE_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
]);

function pagePrerequisiteNoticesFromRows(
  notices: readonly AutomationTaskPrerequisiteNoticeRecord[],
) {
  return notices.flatMap((notice) => {
    const prerequisite = taskById(notice.taskId)?.externalPrerequisites?.find(
      (candidate) => candidate.id === notice.prerequisiteId,
    );
    if (!prerequisite || !isValidExternalPrerequisiteMetadata(prerequisite))
      return [];
    return [{ ...notice, prerequisite }];
  });
}

function currentCredentialState() {
  const settings = readAutomationSettings();
  const credentials = readAutomationCredentialsFile();
  const status = credentialStatusFromValues(
    credentials,
    AUTOMATION_CREDENTIAL_KEYS,
  );
  const fileNames: Record<string, string> = {};
  const invalidFileKeys: string[] = [];
  const invalidFileReasons: Record<
    string,
    "invalid-extension" | "missing-or-unreadable"
  > = {};
  for (const key of AUTOMATION_CREDENTIAL_KEYS) {
    const settingValue =
      typeof settings[key] === "string" ? settings[key].trim() : "";
    const storedValue =
      credentials[key]?.trim() ||
      settingValue ||
      process.env[key]?.trim() ||
      "";
    if (CERTIFICATE_FILE_CREDENTIAL_KEYS.has(key)) {
      if (storedValue) fileNames[key] = certificateFilename(storedValue);
      const validation = storedValue
        ? validateCertificateFilePath(storedValue)
        : null;
      status[key] = validation?.valid === true;
      if (storedValue && validation?.valid === false) {
        invalidFileKeys.push(key);
        invalidFileReasons[key] = validation.reason;
      }
      continue;
    }
    status[key] = Boolean(storedValue);
  }
  for (const key of optionalCredentialKeys) status[key] = true;
  return { status, fileNames, invalidFileKeys, invalidFileReasons };
}

function credentialStatesFromStatus(status: Readonly<Record<string, boolean>>) {
  return Object.fromEntries(
    Object.entries(status).map(([key, value]) => [key, value ? "ready" : "missing"]),
  ) as Record<string, "ready" | "missing">;
}

/** Main-process-only credential reader; never call this from a worker. */
export function readAutomationCredentialState() {
  const state = currentCredentialState();
  return {
    status: state.status,
    fileNames: state.fileNames,
    invalidFileKeys: state.invalidFileKeys,
    invalidFileReasons: state.invalidFileReasons,
  };
}

function coreCredentialGroup(
  group: (typeof AUTOMATION_CREDENTIAL_GROUPS)[number],
  enabled: boolean,
  selectedStatementTypeIds: readonly string[],
  statementSetupRequired: boolean,
): AutomationCredentialGroupCoreDto & {
  storedCredentialFileNames: Readonly<Record<string, string>>;
  invalidCredentialFileKeys: readonly string[];
  invalidCredentialFileReasons: Readonly<Record<string, "invalid-extension" | "missing-or-unreadable">>;
} {
  return {
    ...group,
    enabled,
    selectedStatementTypeIds,
    statementSetupRequired,
    storedCredentialFileNames: {},
    invalidCredentialFileKeys: [],
    invalidCredentialFileReasons: {},
  };
}

/** What the App process knows about runs right now, beside the persisted history. */
export type AutomationLiveRuns = Readonly<{
  snapshot: AutomationRuntimeSnapshot;
  activeTaskIds: readonly string[];
}>;

/**
 * Build the automation data that does not require access to encrypted
 * credentials.  Workers use this function directly; the credential state is
 * supplied separately by Electron main only for the details block.
 */
/**
 * Promise-based page snapshot seam for the worker-owned PGlite store.  All
 * persistence reads are awaited before the page model is assembled, keeping
 * runtime state and persisted history from being published out of order.
 */
export async function loadAutomationCoreSnapshot(
  provider: AutomationPersistenceProvider,
  live: AutomationLiveRuns,
  credentialStatus: Readonly<Record<string, boolean>> = {},
  credentialStates: Readonly<Record<string, "loading" | "ready" | "missing" | "read_failed">> = credentialStatesFromStatus(credentialStatus),
): Promise<AutomationCoreSnapshot> {
  const settings = readAutomationSettings();
  const { credentialGroups: offeredGroups, enabledGroups } = offeredAutomationSources(settings);
  const { snapshot: runtime, activeTaskIds } = live;
  const range = businessDayUtcRange(undefined, automationBusinessTimezone(settings));
  const [latestRuns, todayRunTaskIds, notices, resetRequiredNamespaces] = await Promise.all([
    provider.automation.latestTaskRuns(),
    provider.automation.todayTaskRunIds({ startUtc: range.startUtc, endUtc: range.endUtc }),
    provider.automation.activeTaskPrerequisiteNotices(),
    provider.canonicalReset?.requiredNamespaces() ?? [],
  ]);
  const credentialGroups = offeredGroups.map((group) => {
    const enabled = enabledGroups[group.id] !== false;
    const selectionSettings = { ...settings, [group.enabledKey]: enabled };
    const selection = isStatementSelectionGroup(group)
      ? selectStatementTypes(group, selectionSettings, "display")
      : { selectedIds: [], needsSetup: false };
    return coreCredentialGroup(
      group,
      enabled,
      selection.selectedIds,
      selection.needsSetup,
    );
  });
  return {
    runtimeSessionId: runtime.sessionId,
    runtimeRevision: runtime.revision,
    automation: {
      ...buildAutomationPageModel({
        tasks: enabledAutomationTasks(enabledGroups),
        latestRuns,
        todayRunTaskIds,
        activeTaskIds,
        credentials: { ...credentialStatus },
        setupRequiredGroupIds: new Set(
          credentialGroups
            .filter((group) => group.statementSetupRequired)
            .map((group) => group.id),
        ),
        canonicalResetRequiredNamespaces: new Set(resetRequiredNamespaces),
        externalPrerequisiteNotices: pagePrerequisiteNoticesFromRows(notices),
        active: activeTaskIds.length > 0,
        businessDate: range.businessDate,
        runtime,
        credentialStates: { ...credentialStates },
      }),
    },
    credentialGroups,
  };
}

/** Apply the sanitized main-process state without reading credentials. */
export function applyAutomationCredentialState(
  core: AutomationCoreSnapshot,
  credentialState: AutomationCredentialStateDto,
): AutomationDesktopModel {
  const credentialGroups = core.credentialGroups.map((group) => ({
    ...group,
    storedCredentialFileNames: credentialState.fileNames,
    invalidCredentialFileKeys: credentialState.invalidFileKeys,
    invalidCredentialFileReasons: credentialState.invalidFileReasons,
  }));
  return {
    runtimeSessionId: core.runtimeSessionId,
    runtimeRevision: core.runtimeRevision,
    automation: {
      ...core.automation,
      credentials: { ...credentialState.status },
      credentialStates: credentialState.states
        ? { ...credentialState.states }
        : credentialStatesFromStatus(credentialState.status),
    },
    credentialGroups,
  };
}

export async function loadAutomationDesktopModel(
  provider: AutomationPersistenceProvider,
  live: AutomationLiveRuns,
): Promise<AutomationDesktopModel> {
  const raw = currentCredentialState();
  const credentialState: AutomationCredentialStateDto = {
    revision: 0,
    status: raw.status,
    fileNames: raw.fileNames,
    invalidFileKeys: raw.invalidFileKeys,
    invalidFileReasons: raw.invalidFileReasons,
  };
  return applyAutomationCredentialState(
    await loadAutomationCoreSnapshot(provider, live, raw.status),
    credentialState,
  );
}

function missingCredentialKeys(
  taskId: string,
  status = currentCredentialState().status,
) {
  const task = taskById(taskId);
  if (!task) return [];
  return task.credentialKeys.filter(
    (key) => !optionalCredentialKeys.has(key) && !status[key],
  );
}

export function assertAutomationTaskCanStartInModel(
  taskId: string,
  model: AutomationDesktopModel,
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const row = model.automation.tasks.find((item) => item.id === taskId);
  if (!row) throw new Error("Task is disabled.");
  if (row.status === "waiting_for_human") {
    throw new Error(
      "Task is waiting for verification. Wait for it to finish or cancel the run first.",
    );
  }
  const group = task.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  if (group && isStatementSelectionGroup(group)) {
    const modelGroup = model.credentialGroups.find(
      (candidate) => candidate.id === group.id,
    );
    const selectionSettings = {
      ...readAutomationSettings(),
      ...(modelGroup ? { [group.enabledKey]: modelGroup.enabled } : {}),
    };
    selectStatementTypes(group, selectionSettings, "strict");
  }
  const missing = missingCredentialKeys(taskId, model.automation.credentials);
  if (missing.length > 0)
    throw new Error(`Missing credentials: ${missing.join(", ")}`);
  return task;
}
