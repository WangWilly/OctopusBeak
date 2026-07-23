# First-run Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a milestone-driven contextual coach that guides a new OctopusBeak user through one real source setup, collection, import, and visible Overview result.

**Architecture:** A pure renderer-side resolver derives the next onboarding display state from existing route, Automation, and Overview models plus one versioned localStorage record. A single Svelte coach locates stable `data-onboarding` targets and invokes their existing controls; existing screens only expose targets, source-selection callbacks, and Settings controls.

**Tech Stack:** Svelte 5, TypeScript, Electron 43 renderer, existing `node:test`/`node:assert` checks, native localStorage, DOM geometry, CSS animations, Electron CDP.

## Global Constraints

- Preserve the selected Precision Spotlight reference at `docs/assets/onboarding-precision-spotlight.png`.
- Do not add a tour dependency, backend service, database table, migration, dedicated route, analytics service, or Electron IPC channel.
- Persist only `{ version: 1, status, selectedCredentialGroupId }` under `octopusbeak-onboarding-v1`.
- Recalculate achieved milestones from real Automation and Overview data; never persist a numeric step.
- Treat collection as complete only when the selected crawler has `ranToday === true` and status `completed`, or status `partial` with the existing import gate unlocked.
- Treat onboarding as complete only when today's import task is `completed` and Overview has at least one account.
- Keep the coach non-modal; the scrim must use `pointer-events: none`.
- Escape pauses onboarding, milestone changes use `aria-live="polite"`, and reduced-motion disables coach movement and guide-icon animation.
- All new user-facing copy must exist in both English and Traditional Chinese in `src/lib/i18n/i18n.ts`.

---

## File structure

**Create**

- `src/lib/onboarding/state.ts` — versioned storage parsing, source narrowing, existing-user detection, milestone resolution, and target selection.
- `src/lib/onboarding/state.check.ts` — one runnable check covering the state machine and invalid storage.
- `src/lib/onboarding/OnboardingCoach.svelte` — spotlight geometry, coach content/actions, progress capsule, pause, and accessibility.
- `src/lib/onboarding/assets/onboarding-guide-sprite.webp` — purpose-built two-frame pixel guide sprite.

**Modify**

- `src/routes/+page.svelte` — eligibility loading, state ownership, resolver input, coach rendering, source callback, pause/resume/restart.
- `src/lib/automation/AutomationDashboard.svelte` — single-source onboarding mode, selected-source callback, and stable action markers.
- `src/lib/shared-shell/components/DashboardShell.svelte` — stable navigation markers.
- `src/lib/overview/OverviewDashboard.svelte` — imported-status and summary markers.
- `src/lib/settings/SettingsPage.svelte` — Continue and Restart onboarding actions.
- `src/lib/i18n/i18n.ts` — English and Traditional Chinese onboarding copy.

---

### Task 1: Pure onboarding state and milestone resolver

**Files:**

- Create: `src/lib/onboarding/state.ts`
- Create: `src/lib/onboarding/state.check.ts`

**Interfaces:**

- Consumes: `AutomationDesktopModel`, `AutomationTaskRow`, `CredentialGroupDto`, and `OverviewPageDto`.
- Produces:
  - `ONBOARDING_STORAGE_KEY`
  - `OnboardingState`
  - `OnboardingStep`
  - `OnboardingContext`
  - `readOnboardingState(storage)`
  - `writeOnboardingState(storage, state)`
  - `createOnboardingState()`
  - `hasExistingProductData(context)`
  - `singleSourceUpdates(groups, selectedGroupId, collectionGroupIds)`
  - `resolveOnboardingStep(context, state)`
  - `targetForOnboardingStep(step, state)`

- [ ] **Step 1: Write the failing state-machine check**

Create `src/lib/onboarding/state.check.ts`:

```ts
import assert from "node:assert/strict";
import type { AutomationDesktopModel, CredentialGroupDto } from "../desktop/api.ts";
import type { AutomationTaskRow } from "../automation/types.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import {
  ONBOARDING_STORAGE_KEY,
  createOnboardingState,
  hasExistingProductData,
  readOnboardingState,
  resolveOnboardingStep,
  singleSourceUpdates,
  targetForOnboardingStep,
  writeOnboardingState,
  type OnboardingContext,
} from "./state.ts";

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
  };
};

const state = { ...createOnboardingState(), selectedCredentialGroupId: "fubon" };
const selectedCrawler = task({
  id: "fubon-all-statements",
  kind: "crawler",
  credentialGroupId: "fubon",
  credentialKeys: ["USER", "PASSWORD"],
});

assert.equal(ONBOARDING_STORAGE_KEY, "octopusbeak-onboarding-v1");
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
  latestFinishedAt: "2026-07-23T06:00:00.000Z",
});
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "completed", ranToday: true }, {
  importTask: completedImport,
  accounts: 0,
}), state), "overview");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "completed", ranToday: true }, {
  route: "overview",
  importTask: completedImport,
  accounts: 0,
}), state), "overview-empty");
assert.equal(resolveOnboardingStep(context({ ...selectedCrawler, status: "completed", ranToday: true }, {
  route: "overview",
  importTask: completedImport,
  accounts: 1,
}), state), "complete");

assert.equal(hasExistingProductData(context(selectedCrawler, { accounts: 1 })), true);
assert.equal(hasExistingProductData(context(selectedCrawler, { importedAt: "2026-07-22T06:00:00.000Z" })), true);
assert.equal(hasExistingProductData(context(selectedCrawler, { importTask: completedImport })), true);
assert.equal(hasExistingProductData(context(selectedCrawler, {
  importTask: { ...completedImport, status: "failed" },
})), false);
assert.equal(hasExistingProductData(context(selectedCrawler)), false);
assert.equal(targetForOnboardingStep("credentials", state), '[data-onboarding="automation-credentials"]');
assert.equal(targetForOnboardingStep("collection", state), '[data-onboarding-task="fubon-all-statements"][data-onboarding-action="primary"]');

const storage = new MemoryStorage();
assert.equal(readOnboardingState(storage), null);
writeOnboardingState(storage, state);
assert.deepEqual(readOnboardingState(storage), state);
storage.setItem(ONBOARDING_STORAGE_KEY, "{broken");
assert.equal(readOnboardingState(storage), null);
storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ version: 2, status: "active" }));
assert.equal(readOnboardingState(storage), null);
```

- [ ] **Step 2: Run the check and verify the missing module failure**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/onboarding/state.check.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/onboarding/state.ts`.

- [ ] **Step 3: Implement the versioned storage and resolver**

Create `src/lib/onboarding/state.ts`:

```ts
import type { AutomationDesktopModel, CredentialGroupDto } from "../desktop/api.ts";
import type { AutomationTaskRow } from "../automation/types.ts";
import type { OverviewPageDto } from "../overview/types.ts";

export const ONBOARDING_STORAGE_KEY = "octopusbeak-onboarding-v1";

export type OnboardingStatus = "active" | "paused" | "completed";
export type OnboardingStep =
  | "automation-nav"
  | "credentials"
  | "collection"
  | "assist"
  | "collection-failed"
  | "import"
  | "import-failed"
  | "overview"
  | "overview-empty"
  | "complete"
  | "hidden";

export type OnboardingState = {
  version: 1;
  status: OnboardingStatus;
  selectedCredentialGroupId: string | null;
};

export type OnboardingContext = {
  route: "overview" | "assets" | "liabilities" | "spending" | "automation" | "data-issues" | "settings";
  automation: AutomationDesktopModel | null;
  overview: OverviewPageDto | null;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function createOnboardingState(): OnboardingState {
  return { version: 1, status: "active", selectedCredentialGroupId: null };
}

export function readOnboardingState(storage: StorageReader = localStorage): OnboardingState | null {
  try {
    const value = JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) ?? "null");
    if (
      value?.version !== 1
      || !["active", "paused", "completed"].includes(value.status)
      || !(typeof value.selectedCredentialGroupId === "string" || value.selectedCredentialGroupId === null)
    ) return null;
    return value as OnboardingState;
  } catch {
    return null;
  }
}

export function writeOnboardingState(
  storage: StorageWriter = localStorage,
  state: OnboardingState,
) {
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
}

export function singleSourceUpdates(
  groups: readonly CredentialGroupDto[],
  selectedGroupId: string,
  collectionGroupIds: ReadonlySet<string>,
) {
  return Object.fromEntries(
    groups
      .filter((group) => collectionGroupIds.has(group.id))
      .map((group) => [
        group.enabledKey,
        group.id === selectedGroupId ? "true" : "false",
      ]),
  );
}

function importTask(context: OnboardingContext) {
  return context.automation?.automation.tasks.find((item) => item.id === "import-downloads-csv") ?? null;
}

export function hasExistingProductData(context: OnboardingContext) {
  const importer = importTask(context);
  return Boolean(
    context.overview?.accounts.length
    || context.overview?.importedAt
    || (importer?.status === "completed" && importer.latestFinishedAt),
  );
}

function selectedGroup(context: OnboardingContext, state: OnboardingState) {
  return context.automation?.credentialGroups.find(
    (group) => group.id === state.selectedCredentialGroupId,
  ) ?? null;
}

function selectedTask(context: OnboardingContext, state: OnboardingState) {
  return context.automation?.automation.tasks.find(
    (item) => item.kind === "crawler" && item.credentialGroupId === state.selectedCredentialGroupId,
  ) ?? null;
}

function groupReady(
  context: OnboardingContext,
  group: CredentialGroupDto | null,
) {
  if (!context.automation || !group?.enabled || group.statementSetupRequired) return false;
  return group.credentialKeys.every((key) => context.automation!.automation.credentials[key]);
}

export function resolveOnboardingStep(
  context: OnboardingContext,
  state: OnboardingState | null,
): OnboardingStep {
  if (!state || state.status !== "active" || !context.automation || !context.overview) return "hidden";
  const importer = importTask(context);
  const importComplete = importer?.status === "completed" && importer.ranToday;
  if (!importComplete && context.route !== "automation") return "automation-nav";
  const group = selectedGroup(context, state);
  if (!state.selectedCredentialGroupId || !groupReady(context, group)) return "credentials";
  const crawler = selectedTask(context, state);
  if (!crawler) return "credentials";
  if (crawler.status === "waiting_for_human") return "assist";
  if (crawler.status === "failed" && crawler.ranToday) return "collection-failed";
  const collectionComplete = crawler.ranToday
    && (crawler.status === "completed"
      || (crawler.status === "partial" && !context.automation.automation.importGate.locked));
  if (!collectionComplete) return "collection";
  if (importer?.status === "failed" && importer.ranToday) return "import-failed";
  if (!importComplete) return "import";
  if (context.route !== "overview") return "overview";
  return context.overview.accounts.length > 0 ? "complete" : "overview-empty";
}

export function targetForOnboardingStep(
  step: OnboardingStep,
  state: OnboardingState,
) {
  if (step === "automation-nav") return '[data-onboarding="nav-automation"]';
  if (step === "credentials") return '[data-onboarding="automation-credentials"]';
  if (step === "overview") return '[data-onboarding="nav-overview"]';
  if (step === "overview-empty" || step === "complete") return '[data-onboarding="overview-summary"]';
  const taskId = step === "import" || step === "import-failed"
    ? "import-downloads-csv"
    : state.selectedCredentialGroupId;
  const action = step === "assist" ? "assist" : step.endsWith("failed") ? "logs" : "primary";
  return taskId
    ? `[data-onboarding-group="${taskId}"][data-onboarding-action="${action}"],`
      + `[data-onboarding-task="${taskId}"][data-onboarding-action="${action}"]`
    : null;
}
```

Before implementation, correct the test's expected collection selector to match the group-based selector returned above:

```ts
assert.equal(
  targetForOnboardingStep("collection", state),
  '[data-onboarding-group="fubon"][data-onboarding-action="primary"],'
    + '[data-onboarding-task="fubon"][data-onboarding-action="primary"]',
);
```

- [ ] **Step 4: Run the focused check**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/onboarding/state.check.ts
```

Expected: exit code 0 with no output.

- [ ] **Step 5: Run the full test suite**

Run:

```bash
npm test
```

Expected: all existing checks and `state.check.ts` pass.

- [ ] **Step 6: Commit the state machine**

```bash
git add src/lib/onboarding/state.ts src/lib/onboarding/state.check.ts
git commit -m "feat: add onboarding milestone resolver"
```

---

### Task 2: Expose real product targets and first-source save behavior

**Files:**

- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Modify: `src/lib/shared-shell/components/DashboardShell.svelte`
- Modify: `src/lib/overview/OverviewDashboard.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Test: `src/lib/onboarding/state.check.ts`

**Interfaces:**

- Consumes: `singleSourceUpdates(groups, selectedGroupId, collectionGroupIds)` from Task 1.
- Produces:
  - `AutomationDashboard` props `onboardingSingleSource` and `onOnboardingSourceSaved`.
  - Stable markers:
    - `data-onboarding="nav-overview"`
    - `data-onboarding="nav-automation"`
    - `data-onboarding="automation-credentials"`
    - `data-onboarding-group="<credentialGroupId>"`
    - `data-onboarding-task="<taskId>"`
    - `data-onboarding-action="primary|logs|assist"`
    - `data-onboarding="overview-imported"`
    - `data-onboarding="overview-summary"`
  - `t.onboarding` English and Traditional Chinese copy.

- [ ] **Step 1: Add the component contract and source narrowing**

At the top of `src/lib/automation/AutomationDashboard.svelte`, import:

```ts
import { singleSourceUpdates } from "$lib/onboarding/state.ts";
```

Add optional props after `reload`:

```ts
export let onboardingSingleSource = false;
export let onOnboardingSourceSaved: (groupId: string) => void = () => {};
```

Derive the eligible collection groups and filter the credential list during onboarding:

```ts
$: collectionGroupIds = new Set(
  automation.tasks
    .filter((task) => task.kind === "crawler" && task.credentialGroupId)
    .map((task) => task.credentialGroupId as string),
);
$: visibleCredentialGroups = credentialGroups.filter(
  (group) => (!onboardingSingleSource || collectionGroupIds.has(group.id))
    && group.label.toLowerCase().includes(credentialSearch.trim().toLowerCase()),
);
```

Use `visibleCredentialGroups` in the existing credential-group `{#each}` block. In `selectCredentialGroup`, make the first-run single-source choice explicit and visible without changing non-collection sources:

```ts
function selectCredentialGroup(groupId: string) {
  statementSelectionError = "";
  selectedCredentialGroupId = groupId;
  if (onboardingSingleSource) {
    groupEnabled = Object.fromEntries(
      credentialGroups.map((group) => [
        group.id,
        collectionGroupIds.has(group.id) ? group.id === groupId : group.enabled,
      ]),
    );
  }
}
```

In `saveCredentials`, merge the exact first-source enabled flags before saving and notify only after the existing save succeeds:

```ts
if (onboardingSingleSource && selectedCredentialGroupId) {
  Object.assign(
    updates,
    singleSourceUpdates(
      credentialGroups,
      selectedCredentialGroupId,
      collectionGroupIds,
    ),
  );
}
```

Store the selected ID before `resetCredentialChanges()` so the callback receives it:

```ts
const savedGroupId = selectedCredentialGroupId;
await window.octopusBeak.automation.saveCredentials(updates);
resetCredentialChanges();
credentialsOpen = false;
await reload();
if (onboardingSingleSource && savedGroupId) onOnboardingSourceSaved(savedGroupId);
```

- [ ] **Step 2: Add stable markers to the existing controls**

In `AutomationDashboard.svelte`, mark the existing Credentials button:

```svelte
<button
  class="button secondary topbar-action"
  type="button"
  data-onboarding="automation-credentials"
  onclick={openCredentials}
>
  {$t.automation.credentials}
</button>
```

On each task row's primary and Logs controls, add:

```svelte
data-onboarding-task={task.id}
data-onboarding-group={task.credentialGroupId}
data-onboarding-action="primary"
```

and:

```svelte
data-onboarding-task={task.id}
data-onboarding-group={task.credentialGroupId}
data-onboarding-action="logs"
```

On the active task jump button used by `waiting_for_human`, add:

```svelte
data-onboarding-task={task.id}
data-onboarding-group={task.credentialGroupId}
data-onboarding-action={task.status === "waiting_for_human" ? "assist" : "logs"}
```

Do not add new buttons; these attributes annotate the current handlers.

- [ ] **Step 3: Add shell and Overview markers**

In `src/lib/shared-shell/components/DashboardShell.svelte`, add a stable marker to each nav link:

```svelte
<a
  class:active={active === item.id}
  class="nav-link"
  href={item.href}
  aria-label={item.label}
  data-onboarding={`nav-${item.id}`}
>
```

In `src/lib/shared-shell/components/DashboardShell.svelte`, extend the existing sync-chip contract:

```svelte
export let syncDataOnboarding: string | null = null;
```

and apply it to the existing sync chip:

```svelte
<span class="chip good" data-onboarding={syncDataOnboarding ?? undefined}>{syncLabel}</span>
```

Pass:

```svelte
syncDataOnboarding="overview-imported"
```

In `src/lib/overview/OverviewDashboard.svelte`, pass that prop to `DashboardShell` and mark the existing summary section:

```svelte
<section aria-label={$t.overview.summaryAria} data-onboarding="overview-summary">
```

- [ ] **Step 4: Add the complete bilingual copy contract**

Add this object beside the existing `automation` and `settings` dictionaries in both translations in `src/lib/i18n/i18n.ts`.

English:

```ts
onboarding: {
  welcomeTitle: "Build your first local overview",
  welcomeBody: "Connect one source, collect its data, import it locally, and see the result in Overview.",
  automationTitle: "Open Automation",
  automationBody: "This is where OctopusBeak collects and imports your financial data.",
  credentialsTitle: "Choose your first data source",
  credentialsBody: "Start with one bank or service. You can add the others after your first import. Sign-in data stays on this Mac.",
  collectionTitle: "Collect your first statement",
  collectionBody: "Run the selected source. The guide will wait while the task works.",
  assistTitle: "Complete verification",
  assistBody: "Finish the CAPTCHA, OTP, email, or certificate step in Assist, then the collection will continue.",
  collectionFailedTitle: "Collection needs attention",
  collectionFailedBody: "Open Logs to review the failure, then retry the same source.",
  importTitle: "Import into the local ledger",
  importBody: "The source is ready. Start the existing import task to add it to your local ledger.",
  importFailedTitle: "Import needs attention",
  importFailedBody: "Open Logs, fix the reported issue, and retry the import.",
  overviewTitle: "See your first result",
  overviewBody: "Open Overview to confirm the imported account and latest import time.",
  overviewEmptyTitle: "The import finished, but no account is visible",
  overviewEmptyBody: "Return to Automation and review the import log before completing setup.",
  completeTitle: "Your first overview is ready",
  completeBody: "You can finish here or add another data source.",
  stepLabel: (current: number, total: number) => `Step ${current} of ${total}`,
  pause: "Pause onboarding",
  continue: "Continue onboarding",
  restart: "Restart onboarding",
  restartConfirm: "Restart onboarding from the beginning?",
  openCredentials: "Open Credentials",
  openAutomation: "Open Automation",
  openOverview: "Open Overview",
  retry: "Retry",
  logs: "Logs",
  finish: "Finish",
  addSource: "Add another source",
  progress: "Setup in progress",
},
```

Traditional Chinese:

```ts
onboarding: {
  welcomeTitle: "建立第一個本機總覽",
  welcomeBody: "連結一個資料來源、完成收集並匯入本機帳本，最後在總覽看見結果。",
  automationTitle: "前往自動化",
  automationBody: "OctopusBeak 會在這裡收集並匯入你的財務資料。",
  credentialsTitle: "選擇第一個資料來源",
  credentialsBody: "先設定一間銀行或服務，第一次匯入完成後再加入其他來源。登入資料只保存在這台 Mac。",
  collectionTitle: "收集第一份帳務資料",
  collectionBody: "執行選定的資料來源；工作進行時，引導會留在這一步等待。",
  assistTitle: "完成人工驗證",
  assistBody: "在 Assist 完成 CAPTCHA、OTP、Email 或憑證驗證，收集工作就會繼續。",
  collectionFailedTitle: "收集工作需要處理",
  collectionFailedBody: "先開啟 Logs 查看失敗原因，再重試相同資料來源。",
  importTitle: "匯入本機帳本",
  importBody: "資料已準備完成，執行現有匯入工作即可寫入本機帳本。",
  importFailedTitle: "匯入工作需要處理",
  importFailedBody: "開啟 Logs、處理回報的問題，再重試匯入。",
  overviewTitle: "查看第一筆成果",
  overviewBody: "前往總覽，確認匯入的帳戶與最新匯入時間。",
  overviewEmptyTitle: "匯入完成，但還沒有可見帳戶",
  overviewEmptyBody: "回到自動化查看匯入紀錄，處理完成後再結束設定。",
  completeTitle: "第一個總覽已完成",
  completeBody: "你可以完成引導，或繼續加入其他資料來源。",
  stepLabel: (current: number, total: number) => `步驟 ${current} / ${total}`,
  pause: "暫停引導",
  continue: "繼續新手引導",
  restart: "重新開始新手引導",
  restartConfirm: "要從頭重新開始新手引導嗎？",
  openCredentials: "開啟 Credentials",
  openAutomation: "前往自動化",
  openOverview: "前往總覽",
  retry: "重試",
  logs: "Logs",
  finish: "完成",
  addSource: "加入其他資料來源",
  progress: "設定進行中",
},
```

- [ ] **Step 5: Typecheck the annotated screens**

Run:

```bash
npm run typecheck
```

Expected: zero Svelte and TypeScript errors.

- [ ] **Step 6: Run the state check and full suite**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/onboarding/state.check.ts
npm test
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit product targets and source behavior**

```bash
git add src/lib/automation/AutomationDashboard.svelte src/lib/shared-shell/components/DashboardShell.svelte src/lib/overview/OverviewDashboard.svelte src/lib/i18n/i18n.ts src/lib/onboarding/state.check.ts
git commit -m "feat: expose onboarding product milestones"
```

---

### Task 3: Build the Precision Spotlight coach

**Files:**

- Create: `src/lib/onboarding/OnboardingCoach.svelte`
- Create: `src/lib/onboarding/assets/onboarding-guide-sprite.webp`
- Modify: `src/lib/onboarding/state.ts`
- Test: `src/lib/onboarding/state.check.ts`

**Interfaces:**

- Consumes: `OnboardingStep`, `OnboardingState`, `targetForOnboardingStep`, and `t.onboarding`.
- Produces `OnboardingCoach` props:
  - `step: OnboardingStep`
  - `state: OnboardingState`
  - `onPause(): void`
  - `onFinish(): void`
  - `onAddSource(): void`
  - `onRetryTarget(): void`
  - `compact?: boolean`

- [ ] **Step 1: Generate and inspect the dedicated guide sprite**

Use Image Gen with the selected mock as visual reference and this exact prompt:

```text
Create one purpose-built horizontal two-frame pixel-art sprite strip for the OctopusBeak onboarding guide. Transparent background, exactly two equal square frames side by side, tiny blue-gray octopus with a subtle beak, dark navy outline, restrained financial-app character, no text, no emoji, no device, no extra objects. Frame one is neutral; frame two moves only the eyes and one tentacle by one pixel. The final strip must remain readable when displayed as two 24×24 px frames.
```

Save the generated result as `src/lib/onboarding/assets/onboarding-guide-sprite.webp`. Inspect the actual file before use. If the generated canvas is not two equal side-by-side frames, use Image Gen edit to correct the composition; do not crop an unrelated mascot or use CSS art.

- [ ] **Step 2: Add a display metadata helper and its check**

In `src/lib/onboarding/state.ts`, add:

```ts
export type OnboardingCopyKey =
  | "automation"
  | "credentials"
  | "collection"
  | "assist"
  | "collectionFailed"
  | "import"
  | "importFailed"
  | "overview"
  | "overviewEmpty"
  | "complete";

export function onboardingStepNumber(step: OnboardingStep) {
  if (step === "automation-nav") return 1;
  if (step === "credentials") return 2;
  if (["collection", "assist", "collection-failed"].includes(step)) return 3;
  if (["import", "import-failed"].includes(step)) return 4;
  return 5;
}

export function onboardingCopyKey(step: OnboardingStep): OnboardingCopyKey {
  if (step === "automation-nav") return "automation";
  if (step === "collection-failed") return "collectionFailed";
  if (step === "import-failed") return "importFailed";
  if (step === "overview-empty") return "overviewEmpty";
  if (step === "complete") return "complete";
  return step as OnboardingCopyKey;
}
```

Add `onboardingCopyKey` and `onboardingStepNumber` to the existing import from `./state.ts`, then append:

```ts
assert.equal(onboardingStepNumber("assist"), 3);
assert.equal(onboardingStepNumber("import-failed"), 4);
assert.equal(onboardingCopyKey("collection-failed"), "collectionFailed");
assert.equal(onboardingCopyKey("overview-empty"), "overviewEmpty");
```

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/onboarding/state.check.ts
```

Expected: exit 0.

- [ ] **Step 3: Create the coach component**

Create `src/lib/onboarding/OnboardingCoach.svelte`:

```svelte
<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { t, type Translation } from "$lib/i18n/i18n.ts";
  import {
    onboardingCopyKey,
    onboardingStepNumber,
    targetForOnboardingStep,
    type OnboardingCopyKey,
    type OnboardingState,
    type OnboardingStep,
  } from "./state.ts";

  export let step: OnboardingStep;
  export let state: OnboardingState;
  export let onPause: () => void;
  export let onFinish: () => void;
  export let onAddSource: () => void;
  export let onRetryTarget: () => void;
  export let compact = false;

  let target: HTMLElement | null = null;
  let targetRect: DOMRect | null = null;
  let coach: HTMLDivElement | null = null;
  let listening = false;
  let announcement = "";

  $: visible = step !== "hidden";
  $: key = onboardingCopyKey(step);
  $: copy = coachCopy($t, key);
  $: title = copy.title;
  $: body = copy.body;
  $: current = onboardingStepNumber(step);
  $: locate(step, state);
  $: if (visible) announce(title);

  async function announce(value: string) {
    announcement = "";
    await tick();
    announcement = value;
  }

  function coachCopy(dictionary: Translation, copyKey: OnboardingCopyKey) {
    const copies = {
      automation: { title: dictionary.onboarding.automationTitle, body: dictionary.onboarding.automationBody },
      credentials: { title: dictionary.onboarding.credentialsTitle, body: dictionary.onboarding.credentialsBody },
      collection: { title: dictionary.onboarding.collectionTitle, body: dictionary.onboarding.collectionBody },
      assist: { title: dictionary.onboarding.assistTitle, body: dictionary.onboarding.assistBody },
      collectionFailed: { title: dictionary.onboarding.collectionFailedTitle, body: dictionary.onboarding.collectionFailedBody },
      import: { title: dictionary.onboarding.importTitle, body: dictionary.onboarding.importBody },
      importFailed: { title: dictionary.onboarding.importFailedTitle, body: dictionary.onboarding.importFailedBody },
      overview: { title: dictionary.onboarding.overviewTitle, body: dictionary.onboarding.overviewBody },
      overviewEmpty: { title: dictionary.onboarding.overviewEmptyTitle, body: dictionary.onboarding.overviewEmptyBody },
      complete: { title: dictionary.onboarding.completeTitle, body: dictionary.onboarding.completeBody },
    } satisfies Record<OnboardingCopyKey, { title: string; body: string }>;
    return copies[copyKey];
  }

  function locate(nextStep: OnboardingStep, nextState: OnboardingState) {
    const selector = targetForOnboardingStep(nextStep, nextState);
    target = selector ? document.querySelector<HTMLElement>(selector) : null;
    updateRect();
    if (!listening) {
      addEventListener("resize", updateRect);
      addEventListener("scroll", updateRect, true);
      listening = true;
    }
  }

  function updateRect() {
    targetRect = target?.getBoundingClientRect() ?? null;
  }

  function activateTarget() {
    if (!target) {
      onRetryTarget();
      return;
    }
    target.focus();
    target.click();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (visible && event.key === "Escape") {
      event.preventDefault();
      onPause();
    }
  }

  function primaryLabel() {
    if (step === "automation-nav") return $t.onboarding.openAutomation;
    if (step === "credentials") return $t.onboarding.openCredentials;
    if (step === "overview") return $t.onboarding.openOverview;
    if (step.endsWith("failed")) return $t.onboarding.logs;
    if (step === "complete") return $t.onboarding.finish;
    return $t.onboarding.continue;
  }

  onDestroy(() => {
    if (!listening) return;
    removeEventListener("resize", updateRect);
    removeEventListener("scroll", updateRect, true);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
  <div class="onboarding-layer" aria-hidden="true">
    {#if targetRect}
      <div
        class="spotlight"
        style={`--target-top:${targetRect.top}px;--target-left:${targetRect.left}px;--target-width:${targetRect.width}px;--target-height:${targetRect.height}px`}
      ></div>
    {/if}
  </div>

  <div
    bind:this={coach}
    class:compact
    class:fallback={!targetRect}
    class="coach"
    role="dialog"
    aria-modal="false"
    aria-labelledby="onboarding-title"
    style={targetRect
      ? `--target-top:${targetRect.top}px;--target-left:${targetRect.left}px;--target-width:${targetRect.width}px;--target-height:${targetRect.height}px`
      : undefined}
  >
    <div class="coach-meta">
      <span>{$t.onboarding.stepLabel(current, 5)}</span>
      <span class="guide" aria-hidden="true"></span>
    </div>
    <div class="milestones" aria-hidden="true">
      {#each [1, 2, 3, 4, 5] as item}<span class:active={item === current}></span>{/each}
    </div>
    <h2 id="onboarding-title">{title}</h2>
    <p>{body}</p>
    <div class="coach-actions">
      {#if step === "complete"}
        <button class="button secondary" type="button" onclick={onAddSource}>{$t.onboarding.addSource}</button>
        <button class="button primary" type="button" onclick={onFinish}>{$t.onboarding.finish}</button>
      {:else}
        <button class="button secondary" type="button" onclick={onPause}>{$t.onboarding.pause}</button>
        <button class="button primary" type="button" onclick={activateTarget}>{primaryLabel()}</button>
      {/if}
    </div>
  </div>
{/if}

<span class="visually-hidden" aria-live="polite">{announcement}</span>

<style>
  .onboarding-layer {
    position: fixed;
    inset: 0;
    z-index: 80;
    pointer-events: none;
  }
  .spotlight {
    position: fixed;
    top: calc(var(--target-top) - 6px);
    left: calc(var(--target-left) - 6px);
    width: calc(var(--target-width) + 12px);
    height: calc(var(--target-height) + 12px);
    border: 3px solid white;
    border-radius: 12px;
    box-shadow:
      0 0 0 4px var(--accent),
      0 0 0 9999px rgb(10 14 18 / 0.56);
  }
  .coach {
    position: fixed;
    z-index: 81;
    top: min(calc(var(--target-top) + var(--target-height) + 18px), calc(100vh - 330px));
    left: min(max(24px, calc(var(--target-left) + var(--target-width) - 360px)), calc(100vw - 384px));
    width: min(360px, calc(100vw - 48px));
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: 0 22px 50px rgb(0 0 0 / 0.28);
    transition: top 180ms ease, left 180ms ease, width 180ms ease;
  }
  .coach.fallback {
    top: calc(var(--topbar-height, 60px) + 20px);
    right: 24px;
    left: auto;
  }
  .coach.compact {
    width: min(320px, calc(100vw - 48px));
    padding: 14px 18px;
  }
  .coach.compact .milestones,
  .coach.compact p,
  .coach.compact .coach-actions .primary {
    display: none;
  }
  .coach.compact h2 {
    margin: 8px 0 12px;
    font-size: 15px;
  }
  .coach-meta, .coach-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .coach-meta {
    color: var(--muted);
    font-size: 12px;
    font-weight: 750;
  }
  .guide {
    width: 24px;
    height: 24px;
    background: url("./assets/onboarding-guide-sprite.webp") left center / 200% 100% no-repeat;
    animation: guide-idle 1.2s steps(2, end) infinite;
    image-rendering: pixelated;
  }
  .milestones { display: flex; gap: 7px; margin: 8px 0 18px; }
  .milestones span { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .milestones span.active { background: var(--accent); }
  h2 { margin: 0 0 10px; font-size: 24px; line-height: 1.2; }
  p { margin: 0 0 22px; color: var(--muted); line-height: 1.55; }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @keyframes guide-idle { to { background-position: right center; } }
  @media (prefers-reduced-motion: reduce) {
    .guide { animation: none; }
    .coach { transition: none; }
  }
</style>
```

- [ ] **Step 4: Typecheck and run the focused check**

Run:

```bash
npm run typecheck
node --no-warnings --experimental-strip-types src/lib/onboarding/state.check.ts
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the coach and asset**

```bash
git add src/lib/onboarding/OnboardingCoach.svelte src/lib/onboarding/assets/onboarding-guide-sprite.webp src/lib/onboarding/state.ts src/lib/onboarding/state.check.ts
git commit -m "feat: add precision spotlight coach"
```

---

### Task 4: Integrate eligibility, persistence, Settings controls, and completion

**Files:**

- Modify: `src/routes/+page.svelte`
- Modify: `src/lib/settings/SettingsPage.svelte`
- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Test: `src/lib/onboarding/state.check.ts`

**Interfaces:**

- Consumes: all Task 1 resolver/storage APIs and Task 3 `OnboardingCoach`.
- Produces a complete first-run flow with pause, resume, restart, finish, add-source, and existing-user suppression.

- [ ] **Step 1: Own onboarding state and eligibility in `+page.svelte`**

Add imports:

```ts
import OnboardingCoach from "$lib/onboarding/OnboardingCoach.svelte";
import {
  createOnboardingState,
  hasExistingProductData,
  readOnboardingState,
  resolveOnboardingStep,
  writeOnboardingState,
  type OnboardingState,
} from "$lib/onboarding/state.ts";
```

Add state:

```ts
let onboardingState: OnboardingState | null = null;
let onboardingEligibilityChecked = false;

$: onboardingContext = {
  route,
  automation: automation.status === "ready" ? automation.data : null,
  overview: overview.status === "ready" ? overview.data : null,
};
$: onboardingStep = resolveOnboardingStep(onboardingContext, onboardingState);
$: onboardingCompact = automation.status === "ready"
  && (onboardingStep === "collection" || onboardingStep === "import")
  && automation.data.automation.tasks.some((task) =>
    task.isActive
    && (onboardingStep === "import"
      ? task.id === "import-downloads-csv"
      : task.credentialGroupId === onboardingState?.selectedCredentialGroupId),
  );
```

Add helpers:

```ts
function saveOnboarding(next: OnboardingState) {
  onboardingState = next;
  writeOnboardingState(localStorage, next);
}

function pauseOnboarding() {
  if (onboardingState) saveOnboarding({ ...onboardingState, status: "paused" });
}

function resumeOnboarding() {
  saveOnboarding(onboardingState
    ? { ...onboardingState, status: "active" }
    : createOnboardingState());
  location.hash = "/automation";
}

function restartOnboarding() {
  saveOnboarding(createOnboardingState());
  location.hash = "/automation";
}

function finishOnboarding() {
  if (onboardingState) saveOnboarding({ ...onboardingState, status: "completed" });
}

function selectOnboardingSource(groupId: string) {
  const current = onboardingState ?? createOnboardingState();
  saveOnboarding({ ...current, selectedCredentialGroupId: groupId, status: "active" });
}

function addOnboardingSource() {
  finishOnboarding();
  location.hash = "/automation";
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('[data-onboarding="automation-credentials"]')?.click();
  });
}
```

Inside the existing settings-load `.finally(...)`, restore onboarding before the first route render:

```ts
onboardingState = readOnboardingState(localStorage);
initialized = true;
normalizeRoute();
```

Add an eligibility effect that uses the existing APIs exactly once:

```ts
$: if (
  initialized
  && !onboardingEligibilityChecked
  && overview.status === "ready"
) {
  onboardingEligibilityChecked = true;
  void checkOnboardingEligibility();
}

async function checkOnboardingEligibility() {
  try {
    if (automation.status !== "ready") {
      automation = { status: "ready", data: await window.octopusBeak.automation.load() };
    }
    if (!onboardingState && !hasExistingProductData({
      route,
      automation: automation.status === "ready" ? automation.data : null,
      overview: overview.status === "ready" ? overview.data : null,
    })) {
      saveOnboarding(createOnboardingState());
    }
  } catch (error) {
    console.warn("onboarding-eligibility-load-failed", message(error));
  }
}
```

The catch intentionally leaves onboarding hidden and does not replace the visible Overview error state.

- [ ] **Step 2: Pass onboarding mode into real screens**

Update the Automation rendering:

```svelte
<AutomationDashboard
  automation={automation.data.automation}
  credentialGroups={automation.data.credentialGroups}
  reload={() => loadRoute("automation")}
  onboardingSingleSource={onboardingStep === "credentials" && !onboardingState?.selectedCredentialGroupId}
  onOnboardingSourceSaved={selectOnboardingSource}
/>
```

Update Settings rendering:

```svelte
<SettingsPage
  onboardingStatus={onboardingState?.status ?? null}
  onResumeOnboarding={resumeOnboarding}
  onRestartOnboarding={restartOnboarding}
/>
```

Render the coach after the route content:

```svelte
{#if onboardingState}
  <OnboardingCoach
    step={onboardingStep}
    state={onboardingState}
    onPause={pauseOnboarding}
    onFinish={finishOnboarding}
    onAddSource={addOnboardingSource}
    onRetryTarget={() => loadRoute(route)}
    compact={onboardingCompact}
  />
{/if}
```

- [ ] **Step 3: Add Settings controls without a new settings API**

In `src/lib/settings/SettingsPage.svelte`, add props:

```ts
export let onboardingStatus: "active" | "paused" | "completed" | null = null;
export let onResumeOnboarding: () => void = () => {};
export let onRestartOnboarding: () => void = () => {};

function restartOnboarding() {
  if (confirm($t.onboarding.restartConfirm)) onRestartOnboarding();
}
```

Add a third settings group after the Personal group:

```svelte
<section class="card settings-group">
  <div class="panel-title group-title">
    <div>
      <h2>{$t.onboarding.welcomeTitle}</h2>
      <p class="lead">{$t.onboarding.welcomeBody}</p>
    </div>
  </div>
  <div class="settings-rows">
    <div class="setting-row">
      <span class="setting-label">
        {onboardingStatus === "completed"
          ? $t.onboarding.completeTitle
          : onboardingStatus
            ? $t.onboarding.progress
            : $t.onboarding.welcomeTitle}
      </span>
      <div class="onboarding-setting-actions">
        {#if onboardingStatus === "paused"}
          <button class="button primary" type="button" onclick={onResumeOnboarding}>
            {$t.onboarding.continue}
          </button>
        {/if}
        <button class="button secondary" type="button" onclick={restartOnboarding}>
          {$t.onboarding.restart}
        </button>
      </div>
    </div>
  </div>
</section>
```

Add only layout CSS:

```css
.onboarding-setting-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-3);
}
```

- [ ] **Step 4: Add regression assertions for paused and completed states**

Append to `state.check.ts`:

```ts
assert.equal(resolveOnboardingStep(context(selectedCrawler), { ...state, status: "paused" }), "hidden");
assert.equal(resolveOnboardingStep(context(selectedCrawler), { ...state, status: "completed" }), "hidden");
```

- [ ] **Step 5: Run focused checks and typecheck**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/onboarding/state.check.ts
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Run the full suite**

Run:

```bash
npm test
```

Expected: all checks pass.

- [ ] **Step 7: Commit the integrated flow**

```bash
git add src/routes/+page.svelte src/lib/settings/SettingsPage.svelte src/lib/automation/AutomationDashboard.svelte src/lib/onboarding/state.check.ts
git commit -m "feat: integrate first-run onboarding"
```

---

### Task 5: Verify the live Electron experience

**Files:**

- Modify only if a concrete verification failure requires it: files from Tasks 1–4.

**Interfaces:**

- Consumes the complete implementation.
- Produces a CDP-verified first-run flow at the application's real 1280 × 726 window.

- [ ] **Step 1: Run all automated checks**

```bash
npm test
npm run typecheck
npm run build
```

Expected: every command exits 0.

- [ ] **Step 2: Start the clean mock desktop app**

Use a new mock user-data directory so onboarding storage and ledger state are isolated:

```bash
npm run run:seed-mock-ledger-db -- "$PWD/data/mock-onboarding/data/ledger"
OCTOPUSBEAK_USER_DATA="$PWD/data/mock-onboarding" npm run desktop:dev
```

Expected terminal output:

```text
Electron remote debugging listening on port 9222
DevTools listening on ws://127.0.0.1:9222/devtools/browser/...
```

If seeded account data suppresses onboarding, start with an empty ledger directory instead of the seeded file; do not weaken existing-user suppression.

- [ ] **Step 3: Verify first-run eligibility and Precision Spotlight layout through CDP**

Connect to `http://127.0.0.1:9222` and verify:

```text
1. Overview and Automation eligibility models load without a visible route jump.
2. A new empty installation shows Step 1; an installation with Overview accounts does not.
3. The coach matches docs/assets/onboarding-precision-spotlight.png.
4. The highlighted target remains clickable and the scrim does not intercept it.
5. The coach remains inside 1280 × 726 after window resize and page scroll.
6. The guide icon is 24 px, pixel-crisp, and static under reduced motion.
```

Capture:

```text
/tmp/octopusbeak-onboarding-step-2.png
```

- [ ] **Step 4: Verify interaction and recovery states**

Through CDP, confirm:

```text
1. Selecting a group in first-run mode visibly disables the other collection groups.
2. Failed credential save keeps the Credentials milestone and existing error.
3. Successful save records selectedCredentialGroupId and moves to collection.
4. waiting_for_human targets Assist and returns to collection afterward.
5. failed collection targets Logs and never advances.
6. importable partial advances only when importGate.locked is false.
7. Escape pauses; Settings continues from the same source.
8. Restart requires confirmation and clears the selected source.
9. Completed import with zero Overview accounts shows overview-empty.
10. At least one Overview account shows complete.
```

- [ ] **Step 5: Compare source and implementation together**

Create a side-by-side comparison containing:

- `docs/assets/onboarding-precision-spotlight.png`
- `/tmp/octopusbeak-onboarding-step-2.png`

Inspect spacing, coach placement, type sizes, focus ring, scrim opacity, control visibility, borders, radii, and icon scale. If a mismatch is found, change the smallest responsible CSS value in `OnboardingCoach.svelte`, repeat Steps 1 and 3, and replace the implementation screenshot.

- [ ] **Step 6: Confirm the final worktree**

Run:

```bash
git status --short
git log -5 --oneline
```

Expected: the worktree is clean; no generated credentials, mock ledger, screenshots, logs, `.superpowers`, or user-data files are staged.

- [ ] **Step 7: Commit any verification-only correction**

If Step 5 required a concrete correction:

```bash
git add src/lib/onboarding/OnboardingCoach.svelte
git commit -m "fix: align onboarding coach with selected design"
```

If no correction was required, do not create an empty commit.
