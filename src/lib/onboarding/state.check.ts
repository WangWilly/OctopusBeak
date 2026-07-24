import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AutomationDesktopModel, CredentialGroupDto } from "../desktop/api.ts";
import type { AutomationTaskRow } from "../automation/types.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import * as onboardingState from "./state.ts";
import {
  ONBOARDING_STORAGE_KEY,
  canResumeAssist,
  createOnboardingState,
  hasExistingProductData,
  nextOnboardingCredentialKey,
  onboardingCopyKey,
  onboardingStepNumber,
  onboardingTaskDisclosure,
  readOnboardingState,
  resolveOnboardingStep,
  settleAssistTextSubmission,
  shouldNarrowOnboardingSources,
  singleSourceUpdates,
  targetForOnboardingStep,
  writeOnboardingState,
  type OnboardingContext,
} from "./state.ts";
import { activateOnboardingTarget, observeOnboardingTarget } from "./target-observer.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const task = (
  input: Partial<AutomationTaskRow> & Pick<AutomationTaskRow, "id" | "kind">,
): AutomationTaskRow => ({
  label: input.id,
  script: input.id,
  credentialKeys: [],
  dependencies: [],
  status: "queued",
  attempt: 0,
  maxAttempts: 1,
  latestStartedAt: null,
  latestFinishedAt: null,
  logTail: "",
  errorMessage: null,
  logPath: null,
  progressPercent: null,
  progressText: "",
  statementFailures: [],
  humanSession: null,
  isActive: false,
  ranToday: false,
  primaryAction: "Run",
  canRun: true,
  ...input,
});

const fubonGroup: CredentialGroupDto = {
  id: "fubon",
  label: "Fubon",
  enabledKey: "LIBRETTO_CLOUD_FUBON_ENABLED",
  credentialKeys: ["USER", "PASSWORD"],
  statementTypes: [{ id: "deposit" }],
  statementSelectionKey: "FUBON_TYPES",
  enabled: true,
  selectedStatementTypeIds: ["deposit"],
  statementSetupRequired: false,
};

const esunGroup: CredentialGroupDto = {
  ...fubonGroup,
  id: "esun",
  label: "E.SUN",
  enabledKey: "LIBRETTO_CLOUD_ESUN_ENABLED",
  statementSelectionKey: "ESUN_TYPES",
};

const maicoinGroup: CredentialGroupDto = {
  ...fubonGroup,
  id: "maicoin",
  label: "MaiCoin",
  enabledKey: "LIBRETTO_CLOUD_MAICOIN_ENABLED",
  statementSelectionKey: "MAICOIN_TYPES",
};

const overview = (accounts = 0, importedAt: string | null = null): OverviewPageDto => ({
  importedAt,
  summary: [],
  dailyHistory: [],
  accounts: Array.from({ length: accounts }, (_, index) => ({ id: String(index) } as never)),
  sankey: null,
  sankeyExchangeRates: [],
  sankeyLatestExchangeRateDate: null,
  exchangeRates: [],
  latestExchangeRateDate: null,
});

const automation = (
  selectedTask: AutomationTaskRow,
  importTask = task({ id: "import-downloads-csv", kind: "import", status: "locked", primaryAction: "Locked", canRun: false }),
): AutomationDesktopModel => ({
  automation: {
    businessDate: "2026-07-23",
    active: selectedTask.isActive || importTask.isActive,
    activeTaskCount: Number(selectedTask.isActive) + Number(importTask.isActive),
    parallelRunnableTaskIds: [],
    credentials: { USER: true, PASSWORD: true },
    importGate: { locked: true, missingTaskIds: [selectedTask.id], warnings: [] },
    tasks: [selectedTask, importTask],
  },
  credentialGroups: [fubonGroup, esunGroup],
});

const context = (
  selectedTask: AutomationTaskRow,
  options: {
    route?: OnboardingContext["route"];
    importTask?: AutomationTaskRow;
    accounts?: number;
    importedAt?: string | null;
    gateLocked?: boolean;
    overviewLoadedForImportFinishedAt?: string | null;
  } = {},
): OnboardingContext => {
  const model = automation(selectedTask, options.importTask);
  model.automation.importGate = {
    ...model.automation.importGate,
    locked: options.gateLocked ?? model.automation.importGate.locked,
  };
  return {
    route: options.route ?? "automation",
    automation: model,
    overview: overview(options.accounts, options.importedAt),
    overviewLoadedForImportFinishedAt: options.overviewLoadedForImportFinishedAt ?? null,
  };
};

const configuredAt = "2026-07-23T08:00:00.000Z";
const freshState = {
  ...createOnboardingState(),
  selectedCredentialGroupId: "fubon",
  sourceConfiguredAt: configuredAt,
};
const state = freshState;
const selectedCrawler = task({
  id: "fubon-all-statements",
  kind: "crawler",
  credentialGroupId: "fubon",
  credentialKeys: ["USER", "PASSWORD"],
  latestStartedAt: "2026-07-23T08:01:00.000Z",
  latestFinishedAt: "2026-07-23T08:05:00.000Z",
});

assert.equal(ONBOARDING_STORAGE_KEY, "octopusbeak-onboarding-v2");
assert.equal(createOnboardingState().version, 2);
assert.equal(nextOnboardingCredentialKey(["USER", "PASSWORD"], "USER", {}), "USER");
assert.equal(nextOnboardingCredentialKey(["USER", "PASSWORD"], "USER", { USER: "demo-user" }), "PASSWORD");
assert.equal(nextOnboardingCredentialKey(["USER", "PASSWORD"], "PASSWORD", { PASSWORD: "secret" }), null);
assert.deepEqual(singleSourceUpdates(
  [fubonGroup, esunGroup, maicoinGroup],
  "fubon",
  new Set(["fubon", "esun"]),
), {
  LIBRETTO_CLOUD_FUBON_ENABLED: "true",
  LIBRETTO_CLOUD_ESUN_ENABLED: "false",
});
assert.equal(resolveOnboardingStep(context(selectedCrawler, { route: "overview" }), state), "automation-nav");
assert.equal(resolveOnboardingStep(context(selectedCrawler), createOnboardingState()), "credentials");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "running", isActive: true }), state), "collection");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "waiting_for_human", humanSession: "fubon" }), state), "assist");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "failed", ranToday: true }), state), "collection-failed");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "partial", ranToday: true }, { gateLocked: true }), state), "collection");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "partial", ranToday: true }, { gateLocked: false }), state), "import");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "completed", ranToday: true }, { gateLocked: false }), state), "import");

const completedImport = task({
  id: "import-downloads-csv",
  kind: "import",
  status: "completed",
  ranToday: true,
  latestStartedAt: "2026-07-23T08:06:00.000Z",
  latestFinishedAt: "2026-07-23T08:07:00.000Z",
});
assert.equal(resolveOnboardingStep(context({
  ...selectedCrawler,
  status: "completed",
  ranToday: true,
  latestStartedAt: "2026-07-23T07:00:00.000Z",
  latestFinishedAt: "2026-07-23T07:30:00.000Z",
}, {
  gateLocked: false,
  importTask: {
    ...completedImport,
    latestStartedAt: "2026-07-23T07:31:00.000Z",
  },
}), freshState), "collection");
const freshCrawler = {
  ...selectedCrawler,
  status: "completed" as const,
  ranToday: true,
  latestStartedAt: "2026-07-23T08:01:00.000Z",
  latestFinishedAt: "2026-07-23T08:05:00.000Z",
};
const freshImporter = {
  ...completedImport,
  latestStartedAt: "2026-07-23T08:06:00.000Z",
  latestFinishedAt: "2026-07-23T08:07:00.000Z",
};
test("stale completed import cannot suppress Automation navigation", () => {
  assert.equal(resolveOnboardingStep(context(freshCrawler, {
    route: "overview",
    gateLocked: false,
    importTask: {
      ...freshImporter,
      latestStartedAt: "2026-07-23T08:04:00.000Z",
    },
  }), freshState), "automation-nav");
});

test("stale failed import cannot report a fresh import failure", () => {
  assert.equal(resolveOnboardingStep(context(freshCrawler, {
    gateLocked: false,
    importTask: {
      ...freshImporter,
      status: "failed",
      latestStartedAt: "2026-07-23T08:04:00.000Z",
    },
  }), freshState), "import");
});

assert.equal(resolveOnboardingStep(context(freshCrawler, {
  gateLocked: false,
  importTask: freshImporter,
  accounts: 1,
  overviewLoadedForImportFinishedAt: freshImporter.latestFinishedAt,
}), freshState), "overview");
assert.equal(resolveOnboardingStep(context(freshCrawler, {
  gateLocked: false,
  importTask: {
    ...freshImporter,
    latestStartedAt: "2026-07-23T08:04:00.000Z",
  },
}), freshState), "import");
assert.equal(resolveOnboardingStep(context({
  ...selectedCrawler,
  status: "waiting_for_human",
  latestStartedAt: "2026-07-23T07:00:00.000Z",
}, { gateLocked: false }), freshState), "collection");
assert.equal(resolveOnboardingStep(context({
  ...selectedCrawler,
  status: "waiting_for_human",
}, { gateLocked: false }), freshState), "assist");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "completed", ranToday: true }, {
  importTask: completedImport,
  accounts: 0,
}), state), "overview");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "completed", ranToday: true }, {
  route: "overview",
  importTask: completedImport,
  accounts: 0,
  overviewLoadedForImportFinishedAt: completedImport.latestFinishedAt,
}), state), "overview-empty");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "completed", ranToday: true }, {
  route: "overview",
  importTask: completedImport,
  accounts: 1,
  overviewLoadedForImportFinishedAt: completedImport.latestFinishedAt,
}), state), "complete");
assert.equal(resolveOnboardingStep(context(selectedCrawler), { ...state, status: "paused" }), "hidden");
assert.equal(resolveOnboardingStep(context(selectedCrawler), { ...state, status: "completed" }), "hidden");

assert.equal(hasExistingProductData(context(selectedCrawler, { accounts: 1 })), true);
assert.equal(hasExistingProductData(context(selectedCrawler, { importedAt: "2026-07-22T06:00:00.000Z" })), true);
assert.equal(hasExistingProductData(context(selectedCrawler, { importTask: completedImport })), true);
assert.equal(hasExistingProductData(context(selectedCrawler, {
  importTask: { ...completedImport, status: "failed" },
})), false);
assert.equal(hasExistingProductData(context(selectedCrawler)), false);
assert.equal(targetForOnboardingStep("credentials", state), '[data-onboarding="automation-credentials"]');
assert.equal(targetForOnboardingStep("assist", state), '[data-onboarding="automation-assist"]');
assert.equal(onboardingStepNumber("assist"), 3);
assert.equal(onboardingStepNumber("import-failed"), 4);
assert.equal(onboardingCopyKey("collection-failed"), "collectionFailed");
assert.equal(onboardingCopyKey("overview-empty"), "overviewEmpty");
assert.equal(onboardingCopyKey("hidden"), null);
assert.equal(
  targetForOnboardingStep("collection", state),
  '[data-onboarding-group="fubon"][data-onboarding-action="primary"],'
    + '[data-onboarding-task="fubon"][data-onboarding-action="primary"]',
);

const automationDashboard = readFileSync("src/lib/automation/AutomationDashboard.svelte", "utf8");
const dashboardShell = readFileSync("src/lib/shared-shell/components/DashboardShell.svelte", "utf8");
const overviewDashboard = readFileSync("src/lib/overview/OverviewDashboard.svelte", "utf8");
const onboardingCoach = readFileSync("src/lib/onboarding/OnboardingCoach.svelte", "utf8");
const onboardingStateSource = readFileSync("src/lib/onboarding/state.ts", "utf8");
const targetObserverSource = readFileSync("src/lib/onboarding/target-observer.ts", "utf8");
const page = readFileSync("src/routes/+page.svelte", "utf8");
const settingsPage = readFileSync("src/lib/settings/SettingsPage.svelte", "utf8");
const i18n = readFileSync("src/lib/i18n/i18n.ts", "utf8");
for (const source of [automationDashboard, dashboardShell, overviewDashboard]) {
  assert.match(source, /data-onboarding/);
}
assert.match(automationDashboard, /singleSourceUpdates/);
assert.match(onboardingStateSource, /export function settleAssistTextSubmission/);
assert.match(targetObserverSource, /export function activateOnboardingTarget/);
assert.match(i18n, /welcomeTitle: "Build your first local overview"/);
assert.match(automationDashboard, /class="viewer-frame"[\s\S]*?data-onboarding-action="choose-verification-control"/);
assert.match(automationDashboard, /class="viewer-floating-input"[\s\S]*?data-onboarding-action="enter-verification"/);
assert.match(automationDashboard, /resumeHumanViewer[\s\S]*?data-onboarding-action="resume-collection"/);
assert.match(automationDashboard, /humanTask[\s\S]*?assistInteracted/);
assert.match(onboardingCoach, /\.human-viewer-modal \.viewer-floating-input/);
assert.match(onboardingCoach, /if \(copyKey === "assist"\)[\s\S]*?targetAction/);
assert.match(onboardingCoach, /\$: key = visible \? onboardingCopyKey\(step\) : null;/);
assert.match(onboardingCoach, /coachCopy\(\$t,\s*key,\s*target\?\.dataset\.onboardingAction\)/);
assert.match(onboardingCoach, /function primaryLabel\([\s\S]*nextStep: OnboardingStep,[\s\S]*dictionary: Translation,[\s\S]*nextRoute: OnboardingContext\["route"\]/);
assert.match(onboardingCoach, /\{primaryLabel\(step, \$t, route, target\?\.dataset\.onboardingAction\)\}/);
assert.match(onboardingCoach, /animation: guide-idle 1\.2s step-end infinite;/);
assert.doesNotMatch(onboardingCoach, /steps\(2,\s*end\)/);
assert.match(onboardingCoach, /import \{ placeOnboardingCoach \} from "\.\/placement\.ts";/);
assert.match(onboardingCoach, /\$: coachPosition = targetRect[\s\S]*placeOnboardingCoach\(/);
assert.match(onboardingCoach, /viewportWidth = innerWidth;/);
assert.match(onboardingCoach, /\{#if targetRect && coachPosition/);
assert.match(onboardingCoach, /bind:clientWidth=\{null, measureCoachWidth\}/);
assert.match(onboardingCoach, /bind:clientHeight=\{null, measureCoachHeight\}/);
assert.match(onboardingCoach, /--coach-left:\$\{coachPosition\.left\}px;--coach-top:\$\{coachPosition\.top\}px/);
assert.match(onboardingCoach, /top: var\(--coach-top\);/);
assert.match(onboardingCoach, /left: var\(--coach-left\);/);
assert.match(onboardingCoach, /class:corner=\{coachPosition\?\.compact\}/);
assert.doesNotMatch(onboardingCoach, /class:fallback|\.coach\.fallback/);
assert.match(onboardingCoach, /max-height: calc\(100vh - 48px\);/);
assert.match(onboardingCoach, /overflow-y: auto;/);
assert.match(onboardingCoach, /\.coach\.corner \{[\s\S]*height: var\(--coach-height\);/);
assert.match(onboardingCoach, /\.coach\.corner \.coach-actions \.primary \{[\s\S]*display: inline-flex;/);
assert.doesNotMatch(onboardingCoach, /transition:[^;]*(top|left)/);
assert.doesNotMatch(onboardingCoach, /class:above=\{placeAbove\}|\.coach\.above/);
assert.doesNotMatch(onboardingCoach, /bind:this=\{coach\}/);
assert.match(page, /<OnboardingCoach/);
assert.match(settingsPage, /export let onboardingStatus/);
assert.match(
  i18n,
  /openAssistCopy: \{ title: "完成銀行驗證", body: "開啟操作畫面，完成 CAPTCHA、OTP 或銀行要求的驗證。" \}/,
);
assert.match(
  i18n,
  /chooseVerificationCopy: \{ title: "點選驗證欄位", body: "直接點選銀行畫面中的驗證碼或 OTP 輸入欄位。" \}/,
);
assert.match(
  i18n,
  /enterVerificationCopy: \{ title: "輸入驗證碼", body: "輸入畫面或手機收到的驗證碼，按送出套用到銀行頁面。" \}/,
);
assert.match(
  i18n,
  /resumeCollectionCopy: \{ title: "確認驗證完成", body: "銀行頁面完成驗證後，繼續資料收集。" \}/,
);
assert.match(i18n, /resumeCollection: "已完成驗證，繼續收集"/);
assert.doesNotMatch(onboardingCoach, /assistTargetInModal/);
assert.match(onboardingCoach, /class="interaction-blocker top"/);
assert.match(onboardingCoach, /document\.documentElement\.style\.overflow = "hidden"/);
assert.match(onboardingCoach, /nextTarget\.scrollIntoView/);
assert.match(onboardingCoach, /\.guide \{[\s\S]*?width: 32px;[\s\S]*?height: 32px;/);
assert.match(onboardingCoach, /event\.key === "Escape" && !event\.defaultPrevented/);
assert.match(automationDashboard, /<svelte:window onkeydowncapture=\{handleWindowKeydown\}/);
assert.match(automationDashboard, /event\.stopImmediatePropagation\(\);[\s\S]*?floatingInput = null;/);
assert.match(
  automationDashboard,
  /<nav[\s\S]*?data-onboarding=\{onboardingSourceSelection[\s\S]*?data-onboarding-action="select-source"/,
);
assert.match(automationDashboard, /ononboardingadvance=\{advanceOnboardingCredential\}/);
assert.match(automationDashboard, /ononboardingback=\{backOnboardingCredential\}/);
assert.match(automationDashboard, /ononboardingback=\{backOnboardingAssist\}/);
assert.match(
  automationDashboard,
  /data-onboarding=\{key === onboardingCredentialTargetKey[\s\S]*?data-onboarding-action="enter-credentials"/,
);
assert.match(onboardingCoach, /new CustomEvent\("onboardingback", \{ bubbles: true, cancelable: true \}\)/);
assert.match(onboardingCoach, /onclick=\{back\}>\{\$t\.onboarding\.back\}<\/button>/);
assert.match(page, /onBack=\{backOnboarding\}/);
assert.match(i18n, /back: "Back"/);
assert.match(i18n, /back: "上一步"/);

const storage = new MemoryStorage();
assert.equal(readOnboardingState(storage), null);
writeOnboardingState(storage, state);
assert.deepEqual(readOnboardingState(storage), state);
storage.setItem(ONBOARDING_STORAGE_KEY, "{broken");
assert.equal(readOnboardingState(storage), null);
storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ version: 2, status: "active" }));
assert.equal(readOnboardingState(storage), null);
storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
  ...state,
  sourceConfiguredAt: "July 23, 2026",
}));
assert.equal(readOnboardingState(storage), null);

test("onboarding discloses hidden collection and import targets", () => {
  const collectionTasks = Array.from({ length: 6 }, (_, index) => task({
    id: `collection-${index}`,
    kind: "crawler",
    credentialGroupId: `group-${index}`,
  }));
  const importRow = task({ id: "import-downloads-csv", kind: "import" });
  const tasks = [...collectionTasks, importRow];

  assert.deepEqual(
    onboardingTaskDisclosure("collection", "group-5", tasks),
    { stageId: "collect", showAllCollectTasks: true },
  );
  assert.deepEqual(
    onboardingTaskDisclosure("import", "group-5", tasks),
    { stageId: "import", showAllCollectTasks: false },
  );
  assert.deepEqual(
    onboardingTaskDisclosure("overview-empty", "group-5", tasks),
    { stageId: "import", showAllCollectTasks: false },
  );
  assert.match(automationDashboard, /onboardingTaskDisclosure/);
});

test("coach relocalizes when a disclosed target mounts", () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
  let mountedTarget: HTMLElement | null = null;
  let notifyMutation: () => void = () => {
    assert.fail("observer was not initialized");
  };
  let observedOptions: MutationObserverInit | undefined;
  let disconnected = false;

  class FakeMutationObserver {
    constructor(callback: MutationCallback) {
      notifyMutation = () => callback([], this as unknown as MutationObserver);
    }
    observe(_target: Node, options?: MutationObserverInit) {
      observedOptions = options;
    }
    disconnect() {
      disconnected = true;
    }
  }

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: {},
      querySelector: () => mountedTarget,
    },
  });
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    value: FakeMutationObserver,
  });

  try {
    const targets: Array<HTMLElement | null> = [];
    const stop = observeOnboardingTarget("[data-onboarding]", (target) => targets.push(target));
    assert.deepEqual(targets, [null]);
    assert.deepEqual(observedOptions, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-onboarding"],
    });

    mountedTarget = { id: "mounted-target" } as HTMLElement;
    notifyMutation();
    assert.deepEqual(targets, [null, mountedTarget]);

    stop();
    assert.equal(disconnected, true);
    assert.match(onboardingCoach, /observeOnboardingTarget/);
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
    if (observerDescriptor) Object.defineProperty(globalThis, "MutationObserver", observerDescriptor);
    else Reflect.deleteProperty(globalThis, "MutationObserver");
  }
});

test("coach remeasures its target after modal animation", () => {
  assert.match(onboardingCoach, /addEventListener\("animationend", updateRect, true\)/);
  assert.match(onboardingCoach, /removeEventListener\("animationend", updateRect, true\)/);
});

test("coach measures only while a target selector is active", () => {
  const watchTargetSource = onboardingCoach.slice(
    onboardingCoach.indexOf("function watchTarget"),
    onboardingCoach.indexOf("function updateRect"),
  );
  assert.match(watchTargetSource, /if \(!selector\) \{[\s\S]*stopListening\(\);[\s\S]*return;/);
  assert.match(watchTargetSource, /addEventListener\("resize", updateRect\)/);
  assert.match(watchTargetSource, /function stopListening\(\)[\s\S]*listening = false;/);
});

test("failed viewer text input keeps the value retryable and Resume locked", () => {
  const floatingInput = { left: 24, top: 48, value: "123456" };
  assert.deepEqual(settleAssistTextSubmission(floatingInput, false), {
    floatingInput,
    assistInteracted: false,
  });
  assert.deepEqual(settleAssistTextSubmission(floatingInput, true), {
    floatingInput: null,
    assistInteracted: true,
  });
});

test("Assist Resume stays locked until a successful interaction settles", () => {
  assert.equal(canResumeAssist(false, false), false);
  assert.equal(canResumeAssist(false, true), false);
  assert.equal(canResumeAssist(true, true), false);
  assert.equal(canResumeAssist(true, false), true);
});

test("Assist drag unlocks Resume only after successful viewer input", () => {
  const settleAssistDrag = (
    onboardingState as unknown as { settleAssistDrag?: (succeeded: boolean) => boolean }
  ).settleAssistDrag;
  assert.equal(typeof settleAssistDrag, "function");
  if (!settleAssistDrag) return;

  assert.equal(canResumeAssist(settleAssistDrag(false), false), false);
  assert.equal(canResumeAssist(settleAssistDrag(true), false), true);
  assert.equal(
    automationDashboard.match(/data-onboarding-action="resume-collection"/g)?.length,
    1,
  );
  const pointerUpSource = automationDashboard.slice(
    automationDashboard.indexOf("function handleViewerPointerUp"),
    automationDashboard.indexOf("async function submitViewerDrag"),
  );
  assert.match(pointerUpSource, /void submitViewerDrag\(start, point\)/);
  assert.match(
    automationDashboard,
    /async function submitViewerDrag[\s\S]*?if \(settleAssistDrag\(succeeded\)\) assistInteracted = true;/,
  );
  assert.match(
    automationDashboard,
    /disabled=\{!canResumeAssist\(assistInteracted, Boolean\(floatingInput\)\)\}[\s\S]*?data-onboarding=\{[\s\S]*?canResumeAssist\(assistInteracted, Boolean\(floatingInput\)\)/,
  );
});

test("pointer-only verification target is focused without an inert synthetic click", () => {
  let focused = 0;
  let clicked = 0;
  const target = {
    dataset: { onboardingAction: "choose-verification-control" },
    focus: () => focused += 1,
    click: () => clicked += 1,
  } as unknown as HTMLElement;
  activateOnboardingTarget(target);
  assert.deepEqual({ focused, clicked }, { focused: 1, clicked: 0 });

  target.dataset.onboardingAction = "open-assist";
  activateOnboardingTarget(target);
  assert.deepEqual({ focused, clicked }, { focused: 2, clicked: 1 });
});

test("verification screenshot exposes a clear keyboard focus path", () => {
  assert.match(
    automationDashboard,
    /class="viewer-image"[\s\S]*?tabindex="-1"[\s\S]*?aria-label=\{\$t\.onboarding\.verificationViewerAria\}/,
  );
  assert.match(automationDashboard, /\.viewer-image:focus-visible/);
  assert.match(onboardingCoach, /activateOnboardingTarget\(target\)/);
  assert.match(
    onboardingCoach,
    /targetAction === "choose-verification-control"[\s\S]*?focusVerificationViewer/,
  );
});

test("opening first-run credentials leaves the source unselected", () => {
  const openCredentialsSource = automationDashboard.slice(
    automationDashboard.indexOf("function openCredentials"),
    automationDashboard.indexOf("function closeCredentials"),
  );
  assert.match(openCredentialsSource, /remembered = onboardingSelectedCredentialGroupId/);
  assert.match(openCredentialsSource, /onboardingSourceSelection\s*\? remembered && collectionGroupIds\.has\(remembered\) \? remembered : ""/);
});

test("credentials opener is the onboarding target only while the modal is closed", () => {
  const credentialsOpener = automationDashboard.slice(
    automationDashboard.indexOf('<svelte:fragment slot="topbar-actions">'),
    automationDashboard.indexOf('<div class:sync-sheet-open'),
  );
  assert.match(
    credentialsOpener,
    /data-onboarding=\{!credentialsOpen \? "automation-credentials" : undefined\}/,
  );
});

test("credentials onboarding requires source, credentials, statements, then save", () => {
  assert.match(automationDashboard, /data-onboarding-action="select-source"/);
  assert.match(automationDashboard, /data-onboarding-action="enter-credentials"/);
  assert.match(automationDashboard, /data-onboarding-action="select-statements"/);
  assert.match(automationDashboard, /onboardingCredentialsReady[\s\S]*?data-onboarding-action="save-credentials"/);
  assert.match(automationDashboard, /onOnboardingSourceSaved\(savedGroupId, new Date\(\)\.toISOString\(\)\)/);
  assert.match(automationDashboard, /savedGroupId[\s\S]*?automation\.tasks\.find/);
  assert.match(automationDashboard, /automation\.run\(selectedTask\.id\)/);
  assert.match(onboardingCoach, /select-source[\s\S]*?enter-credentials[\s\S]*?select-statements/);
});

test("credentials onboarding requires current-session input and statement selection", () => {
  assert.match(automationDashboard, /selectedCredentialGroup\.credentialKeys\.find\([\s\S]*?!credentialDrafts\[key\]\?\.trim\(\)/);
  assert.doesNotMatch(automationDashboard, /!automation\.credentials\[key\]\s*&&\s*!credentialDrafts/);
  assert.match(automationDashboard, /statementSelectionConfirmed/);
  assert.match(automationDashboard, /toggleStatementType[\s\S]*?statementSelectionConfirmed\s*=/);
  assert.match(automationDashboard, /selectAllStatementTypes[\s\S]*?statementSelectionConfirmed\s*=/);
});

test("credentials Save rejects incomplete onboarding and allows ready or ordinary submission", () => {
  const candidate = (onboardingState as unknown as {
    canSubmitCredentials?: (onboarding: boolean, ready: boolean) => boolean;
  }).canSubmitCredentials;
  assert.equal(typeof candidate, "function");
  const canSubmitCredentials = candidate!;
  assert.deepEqual([
    canSubmitCredentials(true, false),
    canSubmitCredentials(true, true),
    canSubmitCredentials(false, false),
  ], [false, true, true]);

  const saveCredentialsSource = automationDashboard.slice(
    automationDashboard.indexOf("async function saveCredentials"),
    automationDashboard.indexOf("async function refreshViewerImage"),
  );
  const saveButtonSource = automationDashboard.slice(
    automationDashboard.indexOf('data-onboarding-action="save-credentials"') - 300,
    automationDashboard.indexOf('data-onboarding-action="save-credentials"') + 100,
  );
  assert.match(
    saveCredentialsSource,
    /if \(!canSubmitCredentials\(onboardingSourceSelection, onboardingCredentialsReady\)\) return;/,
  );
  assert.match(
    saveButtonSource,
    /disabled=\{!canSubmitCredentials\(onboardingSourceSelection, onboardingCredentialsReady\)\}/,
  );
});

test("cross-midnight collection and import advance from fresh timestamps and terminal statuses", () => {
  const crossMidnightState = {
    ...freshState,
    sourceConfiguredAt: "2026-07-23T23:58:00.000Z",
  };
  const crossMidnightCrawler = {
    ...freshCrawler,
    ranToday: false,
    latestStartedAt: "2026-07-23T23:59:00.000Z",
    latestFinishedAt: "2026-07-24T00:01:00.000Z",
  };
  const crossMidnightImporter = {
    ...freshImporter,
    ranToday: false,
    latestStartedAt: "2026-07-24T00:02:00.000Z",
    latestFinishedAt: "2026-07-24T00:03:00.000Z",
  };

  assert.equal(
    resolveOnboardingStep(
      context(crossMidnightCrawler, { gateLocked: false }),
      crossMidnightState,
    ),
    "import",
  );
  assert.equal(
    resolveOnboardingStep(context(crossMidnightCrawler, {
      gateLocked: false,
      importTask: crossMidnightImporter,
      accounts: 1,
      overviewLoadedForImportFinishedAt: crossMidnightImporter.latestFinishedAt,
    }), crossMidnightState),
    "overview",
  );
});

test("route freshness marker lets cross-midnight empty Overview resolve while stale import stays blocked", () => {
  assert.doesNotMatch(page, /importer\?\.status === "completed" && importer\.ranToday/);
  const candidate = (onboardingState as unknown as {
    completedImportFinishedAt?: (tasks: readonly AutomationTaskRow[]) => string | null;
  }).completedImportFinishedAt;
  assert.equal(typeof candidate, "function");
  const completedImportFinishedAt = candidate!;
  const crossMidnightState = {
    ...freshState,
    sourceConfiguredAt: "2026-07-23T23:58:00.000Z",
  };
  const crossMidnightCrawler = {
    ...freshCrawler,
    ranToday: false,
    latestStartedAt: "2026-07-23T23:59:00.000Z",
    latestFinishedAt: "2026-07-24T00:01:00.000Z",
  };
  const crossMidnightImporter = {
    ...freshImporter,
    ranToday: false,
    latestStartedAt: "2026-07-24T00:02:00.000Z",
    latestFinishedAt: "2026-07-24T00:03:00.000Z",
  };
  const marker = completedImportFinishedAt([crossMidnightCrawler, crossMidnightImporter]);

  assert.equal(marker, crossMidnightImporter.latestFinishedAt);
  assert.equal(resolveOnboardingStep(context(crossMidnightCrawler, {
    route: "overview",
    gateLocked: false,
    importTask: crossMidnightImporter,
    accounts: 0,
    overviewLoadedForImportFinishedAt: marker,
  }), crossMidnightState), "overview-empty");

  const staleImporter = {
    ...crossMidnightImporter,
    ranToday: true,
    latestStartedAt: "2026-07-24T00:00:59.999Z",
  };
  assert.equal(resolveOnboardingStep(context(crossMidnightCrawler, {
    route: "overview",
    gateLocked: false,
    importTask: staleImporter,
    accounts: 0,
    overviewLoadedForImportFinishedAt: completedImportFinishedAt([
      crossMidnightCrawler,
      staleImporter,
    ]),
  }), crossMidnightState), "automation-nav");
  assert.match(page, /completedImportFinishedAt\(automation\.data\.automation\.tasks\)/);
});

test("freshness timestamps still block stale collection and import history", () => {
  assert.deepEqual({
    collection: resolveOnboardingStep(context({
      ...freshCrawler,
      ranToday: true,
      latestStartedAt: "2026-07-23T07:59:59.999Z",
    }, { gateLocked: false }), freshState),
    import: resolveOnboardingStep(context(freshCrawler, {
      gateLocked: false,
      importTask: {
        ...freshImporter,
        ranToday: true,
        latestStartedAt: "2026-07-23T08:04:59.999Z",
      },
    }), freshState),
  }, {
    collection: "collection",
    import: "import",
  });
});

test("fresh milestones advance in order while stale runs stay blocked", () => {
  const freshImportRunning = {
    ...freshImporter,
    status: "running" as const,
    isActive: true,
    ranToday: true,
  };
  const refreshedOverview = {
    gateLocked: false,
    importTask: freshImporter,
    accounts: 1,
    overviewLoadedForImportFinishedAt: freshImporter.latestFinishedAt,
  };
  assert.deepEqual([
    resolveOnboardingStep(context({
      ...selectedCrawler,
      latestStartedAt: null,
      latestFinishedAt: null,
    }), freshState),
    resolveOnboardingStep(context({ ...selectedCrawler, status: "running", isActive: true }), freshState),
    resolveOnboardingStep(context({ ...selectedCrawler, status: "waiting_for_human" }), freshState),
    resolveOnboardingStep(context(freshCrawler, { gateLocked: false }), freshState),
    resolveOnboardingStep(context(freshCrawler, {
      gateLocked: false,
      importTask: freshImportRunning,
    }), freshState),
    resolveOnboardingStep(context(freshCrawler, {
      gateLocked: false,
      importTask: freshImporter,
      accounts: 1,
    }), freshState),
    resolveOnboardingStep(context(freshCrawler, refreshedOverview), freshState),
    resolveOnboardingStep(context(freshCrawler, {
      ...refreshedOverview,
      route: "overview",
    }), freshState),
  ], [
    "collection",
    "collection",
    "assist",
    "import",
    "import",
    "overview",
    "overview",
    "complete",
  ]);

  assert.deepEqual({
    staleCrawler: resolveOnboardingStep(context({
      ...freshCrawler,
      latestStartedAt: "2026-07-23T07:00:00.000Z",
    }, { gateLocked: false }), freshState),
    staleImporter: resolveOnboardingStep(context(freshCrawler, {
      gateLocked: false,
      importTask: {
        ...freshImporter,
        latestStartedAt: "2026-07-23T08:04:00.000Z",
      },
    }), freshState),
  }, {
    staleCrawler: "collection",
    staleImporter: "import",
  });
});

test("restart narrows sources only on an empty installation", () => {
  const restarted = createOnboardingState();
  assert.equal(
    shouldNarrowOnboardingSources(context(selectedCrawler), restarted, "credentials"),
    true,
  );
  assert.equal(
    shouldNarrowOnboardingSources(
      context(selectedCrawler, { accounts: 1 }),
      restarted,
      "credentials",
    ),
    false,
  );
  assert.equal(
    shouldNarrowOnboardingSources(
      context(selectedCrawler, { importedAt: "2026-07-22T06:00:00.000Z" }),
      restarted,
      "credentials",
    ),
    false,
  );
  assert.equal(
    shouldNarrowOnboardingSources(
      context(selectedCrawler, { importTask: completedImport }),
      restarted,
      "credentials",
    ),
    false,
  );
  assert.match(page, /shouldNarrowOnboardingSources/);
});

test("overview-empty recovers through Automation and Import Logs without a route loop", () => {
  const emptyAfterImport = context(
    { ...selectedCrawler, status: "completed", ranToday: true },
    {
      importTask: completedImport,
      accounts: 0,
      overviewLoadedForImportFinishedAt: completedImport.latestFinishedAt,
    },
  );
  assert.equal(resolveOnboardingStep(emptyAfterImport, state), "overview-empty");
  assert.equal(
    targetForOnboardingStep("overview-empty", state, "overview"),
    '[data-onboarding="nav-automation"]',
  );
  assert.equal(
    targetForOnboardingStep("overview-empty", state, "automation"),
    '[data-onboarding-task="import-downloads-csv"][data-onboarding-action="logs"]',
  );
});

test("completed import refreshes stale Overview before confirming empty", () => {
  const staleOverview = context(
    { ...selectedCrawler, status: "completed", ranToday: true },
    { importTask: completedImport, accounts: 0 },
  );
  const freshOverview = context(
    { ...selectedCrawler, status: "completed", ranToday: true },
    {
      route: "overview",
      importTask: completedImport,
      accounts: 0,
      overviewLoadedForImportFinishedAt: completedImport.latestFinishedAt,
    },
  );
  const confirmedEmptyBackOnAutomation = {
    ...freshOverview,
    route: "automation" as const,
  };

  assert.equal(resolveOnboardingStep(staleOverview, state), "overview");
  assert.equal(resolveOnboardingStep(freshOverview, state), "overview-empty");
  assert.equal(resolveOnboardingStep(confirmedEmptyBackOnAutomation, state), "overview-empty");
});

test("existing-user restart keeps onboarding provider selection and save advance active", () => {
  const openCredentialsSource = automationDashboard.slice(
    automationDashboard.indexOf("function openCredentials"),
    automationDashboard.indexOf("function closeCredentials"),
  );
  const saveCredentialsSource = automationDashboard.slice(
    automationDashboard.indexOf("async function saveCredentials"),
    automationDashboard.indexOf("async function refreshViewerImage"),
  );

  assert.deepEqual({
    prop: automationDashboard.includes("export let onboardingSourceSelection = false"),
    providerFilter: automationDashboard.includes("!onboardingSourceSelection || collectionGroupIds.has(group.id)"),
    initialProvider: openCredentialsSource.includes("onboardingSourceSelection\n        ? remembered"),
    savedProvider: saveCredentialsSource.includes("if (onboardingSourceSelection && savedGroupId)"),
    pageWiring: page.includes('onboardingSourceSelection={onboardingStep === "credentials"}'),
  }, {
    prop: true,
    providerFilter: true,
    initialProvider: true,
    savedProvider: true,
    pageWiring: true,
  });
});
