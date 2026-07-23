# Fresh Guided Onboarding Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the coach clear of its target and require one newly configured source to complete a fresh collection, conditional human verification, fresh import, and Overview validation.

**Architecture:** Keep product milestones derived from the existing Automation and Overview models. Add one persisted configuration timestamp so stale task history cannot advance a new onboarding run, hand the Credentials milestone across the existing modal controls, and isolate collision-free coach placement in one pure geometry helper.

**Tech Stack:** Svelte 5 compatibility syntax, TypeScript, Node test runner, Electron CDP, existing translation dictionary.

## Global Constraints

- Reuse the existing Credentials, task, Assist, import, and Overview surfaces; do not create a parallel wizard.
- Human verification is conditional and appears only when the selected task reports `waiting_for_human`.
- Credentials and onboarding state remain local to the Mac.
- The coach must remain inside the Electron window and must not intersect its highlighted target.
- Do not add dependencies or change Electron IPC, ledger data, or automation task status.
- Follow red-green TDD for every behavior change.

---

### Task 1: Require fresh collection and import milestones

**Files:**
- Modify: `src/lib/onboarding/state.ts`
- Modify: `src/lib/onboarding/state.check.ts`
- Modify: `src/routes/+page.svelte`

**Interfaces:**
- Produces: `OnboardingState` version 2 with `sourceConfiguredAt: string | null`.
- Produces: `selectOnboardingSource(groupId: string, sourceConfiguredAt: string): void`.
- Consumes: `AutomationTaskRow.latestStartedAt` and `AutomationTaskRow.latestFinishedAt`.

- [ ] **Step 1: Write failing state tests for version 2 and stale task history**

Add fixtures whose old crawler and importer are already completed, then assert that they do not advance a newly configured run:

```ts
const configuredAt = "2026-07-23T08:00:00.000Z";
const freshState = {
  ...createOnboardingState(),
  selectedCredentialGroupId: "fubon",
  sourceConfiguredAt: configuredAt,
};

assert.equal(ONBOARDING_STORAGE_KEY, "octopusbeak-onboarding-v2");
assert.equal(createOnboardingState().version, 2);

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
```

Add a fresh sequence and verify every transition:

```ts
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

assert.equal(resolveOnboardingStep(context(freshCrawler, {
  gateLocked: false,
  importTask: freshImporter,
  accounts: 1,
  overviewLoadedForImportFinishedAt: freshImporter.latestFinishedAt,
}), freshState), "overview");
```

Also assert that a fresh `waiting_for_human` crawler resolves to `assist`, while an old one remains `collection`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts
```

Expected: FAIL because storage is still version 1 and stale completed tasks still advance.

- [ ] **Step 3: Implement the versioned timestamp boundary**

Update the state schema and storage key:

```ts
export const ONBOARDING_STORAGE_KEY = "octopusbeak-onboarding-v2";

export type OnboardingState = {
  version: 2;
  status: OnboardingStatus;
  selectedCredentialGroupId: string | null;
  sourceConfiguredAt: string | null;
};

export function createOnboardingState(): OnboardingState {
  return {
    version: 2,
    status: "active",
    selectedCredentialGroupId: null,
    sourceConfiguredAt: null,
  };
}
```

Validate `sourceConfiguredAt` as either `null` or a finite ISO timestamp. Do not migrate version 1 state.

Add one comparison helper inside `state.ts`:

```ts
function taskStartedAtOrAfter(
  task: AutomationTaskRow | null,
  boundary: string | null,
) {
  const startedAt = Date.parse(task?.latestStartedAt ?? "");
  const boundaryAt = Date.parse(boundary ?? "");
  return Number.isFinite(startedAt)
    && Number.isFinite(boundaryAt)
    && startedAt >= boundaryAt;
}
```

In `resolveOnboardingStep`:

```ts
if (
  !state.selectedCredentialGroupId
  || !state.sourceConfiguredAt
  || !groupReady(context, group)
) return "credentials";

const crawler = selectedTask(context, state);
const freshCollection = taskStartedAtOrAfter(crawler, state.sourceConfiguredAt);
if (!crawler || !freshCollection) return "collection";

// Existing assist, failure, completed, and partial rules follow here.

const freshImport = taskStartedAtOrAfter(importer, crawler.latestFinishedAt);
if (!freshImport) return "import";
```

Update the successful Credentials callback in `+page.svelte`:

```ts
function selectOnboardingSource(groupId: string, sourceConfiguredAt: string) {
  const current = onboardingState ?? createOnboardingState();
  saveOnboarding({
    ...current,
    selectedCredentialGroupId: groupId,
    sourceConfiguredAt,
    status: "active",
  });
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts
```

Expected: all onboarding state checks pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/onboarding/state.ts src/lib/onboarding/state.check.ts src/routes/+page.svelte
git commit -m "fix: require fresh onboarding task runs"
```

---

### Task 2: Guide every required Credentials interaction

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Modify: `src/lib/onboarding/OnboardingCoach.svelte`
- Modify: `src/lib/onboarding/state.check.ts`
- Modify: `src/lib/i18n/i18n.ts`

**Interfaces:**
- Consumes: `onboardingSourceSelection`, `onboardingSelectedCredentialGroupId`, and the existing credential drafts.
- Produces: `onOnboardingSourceSaved(groupId: string, sourceConfiguredAt: string): void`.
- Produces target actions: `select-source`, `enter-credentials`, `select-statements`, and `save-credentials`.

- [ ] **Step 1: Write a failing target-handoff check**

Extend the existing source-level integration check:

```ts
test("credentials onboarding requires source, credentials, statements, then save", () => {
  assert.match(automationDashboard, /data-onboarding-action="select-source"/);
  assert.match(automationDashboard, /data-onboarding-action="enter-credentials"/);
  assert.match(automationDashboard, /data-onboarding-action="select-statements"/);
  assert.match(automationDashboard, /onboardingCredentialsReady[\s\S]*?data-onboarding-action="save-credentials"/);
  assert.match(automationDashboard, /onOnboardingSourceSaved\(savedGroupId, new Date\(\)\.toISOString\(\)\)/);
  assert.match(onboardingCoach, /select-source[\s\S]*?enter-credentials[\s\S]*?select-statements/);
});
```

Add an assertion that `openCredentials` leaves `selectedCredentialGroupId` empty for a new onboarding state instead of silently choosing the first row.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts
```

Expected: FAIL because only the opener and Save currently carry onboarding targets.

- [ ] **Step 3: Implement the modal target sequence**

Change the callback type:

```ts
export let onOnboardingSourceSaved:
  (groupId: string, sourceConfiguredAt: string) => void = () => {};
```

Do not auto-select a source for a new onboarding state:

```ts
function openCredentials() {
  resetCredentialChanges();
  const remembered = onboardingSelectedCredentialGroupId;
  selectCredentialGroup(
    onboardingSourceSelection
      ? remembered && collectionGroupIds.has(remembered) ? remembered : ""
      : selectedCredentialGroupId || credentialGroups[0]?.id || "",
  );
  credentialSearch = "";
  credentialsOpen = true;
}
```

Only fall back to the first visible group outside onboarding:

```ts
$: selectedCredentialGroup =
  visibleCredentialGroups.find((group) => group.id === selectedCredentialGroupId)
  ?? (!onboardingSourceSelection ? visibleCredentialGroups[0] : undefined);
```

Derive the next unmet requirement:

```ts
$: onboardingMissingCredentialKey = onboardingSourceSelection && selectedCredentialGroup
  ? selectedCredentialGroup.credentialKeys.find(
      (key) => !automation.credentials[key] && !credentialDrafts[key]?.trim(),
    ) ?? null
  : null;
$: onboardingNeedsStatements = Boolean(
  onboardingSourceSelection
  && selectedCredentialGroup?.statementTypes?.length
  && !(statementSelectionDrafts[selectedCredentialGroup.id]?.length),
);
$: onboardingCredentialsReady = Boolean(
  onboardingSourceSelection
  && selectedCredentialGroup
  && !onboardingMissingCredentialKey
  && !onboardingNeedsStatements,
);
```

Move the single `data-onboarding="automation-credentials"` marker between:

```svelte
data-onboarding={onboardingSourceSelection
  && credentialsOpen
  && !selectedCredentialGroupId
  && group === visibleCredentialGroups[0]
    ? "automation-credentials"
    : undefined}
data-onboarding-action="select-source"
```

```svelte
data-onboarding={key === onboardingMissingCredentialKey
  ? "automation-credentials"
  : undefined}
data-onboarding-action="enter-credentials"
```

```svelte
data-onboarding={onboardingNeedsStatements
  ? "automation-credentials"
  : undefined}
data-onboarding-action="select-statements"
```

```svelte
data-onboarding={onboardingCredentialsReady
  ? "automation-credentials"
  : undefined}
data-onboarding-action="save-credentials"
```

After the existing save and reload succeed:

```ts
if (onboardingSourceSelection && savedGroupId) {
  onOnboardingSourceSaved(savedGroupId, new Date().toISOString());
}
```

- [ ] **Step 4: Add phase-specific localized copy**

Add these keys to both English and Traditional Chinese onboarding dictionaries:

```ts
chooseSource: "Choose this source",
enterCredentials: "Enter sign-in details",
selectStatements: "Choose statement types",
saveCredentials: "Save this source",
```

Traditional Chinese:

```ts
chooseSource: "選擇這個來源",
enterCredentials: "輸入登入資訊",
selectStatements: "選擇要抓取的帳戶資料",
saveCredentials: "儲存這個來源",
```

Update `OnboardingCoach.svelte` so `primaryLabel` maps each target action to the matching label. The primary action continues to focus or activate the real marked control.

- [ ] **Step 5: Run focused checks and typecheck**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts src/lib/i18n/i18n.check.ts
npm run typecheck
```

Expected: all checks pass and Svelte reports 0 errors and 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/automation/AutomationDashboard.svelte src/lib/onboarding/OnboardingCoach.svelte src/lib/onboarding/state.check.ts src/lib/i18n/i18n.ts
git commit -m "fix: guide required credential setup"
```

---

### Task 3: Place the coach without covering its target

**Files:**
- Create: `src/lib/onboarding/placement.ts`
- Create: `src/lib/onboarding/placement.check.ts`
- Modify: `src/lib/onboarding/OnboardingCoach.svelte`

**Interfaces:**
- Produces: `placeOnboardingCoach(target, coach, viewport): { left: number; top: number; side: "right" | "left" | "below" | "above" }`.
- Consumes: target rectangle, rendered coach width/height, and viewport width/height.

- [ ] **Step 1: Write failing geometry tests**

Create `placement.check.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { placeOnboardingCoach } from "./placement.ts";

const intersects = (
  target: { left: number; top: number; width: number; height: number },
  coach: { left: number; top: number },
  size: { width: number; height: number },
) => !(
  coach.left + size.width <= target.left
  || coach.left >= target.left + target.width
  || coach.top + size.height <= target.top
  || coach.top >= target.top + target.height
);

test("places the credentials coach to the right without covering Save", () => {
  const target = { left: 1417, top: 147, width: 158, height: 86 };
  const size = { width: 360, height: 286 };
  const result = placeOnboardingCoach(target, size, { width: 2048, height: 1152 });
  assert.equal(result.side, "right");
  assert.equal(intersects(target, result, size), false);
});

test("falls back to the left and stays inside the viewport", () => {
  const target = { left: 900, top: 80, width: 120, height: 48 };
  const size = { width: 360, height: 286 };
  const result = placeOnboardingCoach(target, size, { width: 1100, height: 760 });
  assert.equal(result.side, "left");
  assert.ok(result.left >= 24 && result.top >= 24);
  assert.ok(result.left + size.width <= 1076);
  assert.equal(intersects(target, result, size), false);
});
```

- [ ] **Step 2: Run the geometry test and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/placement.check.ts
```

Expected: FAIL because `placement.ts` does not exist.

- [ ] **Step 3: Implement the smallest collision-free placement helper**

Create `placement.ts` with four ordered candidates:

```ts
type Rect = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };

const MARGIN = 24;
const GAP = 18;
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function placeOnboardingCoach(
  target: Rect,
  coach: Size,
  viewport: Size,
) {
  const centeredTop = clamp(
    target.top + target.height / 2 - coach.height / 2,
    MARGIN,
    viewport.height - coach.height - MARGIN,
  );
  const centeredLeft = clamp(
    target.left + target.width / 2 - coach.width / 2,
    MARGIN,
    viewport.width - coach.width - MARGIN,
  );
  const candidates = [
    { side: "right" as const, left: target.left + target.width + GAP, top: centeredTop },
    { side: "left" as const, left: target.left - coach.width - GAP, top: centeredTop },
    { side: "below" as const, left: centeredLeft, top: target.top + target.height + GAP },
    { side: "above" as const, left: centeredLeft, top: target.top - coach.height - GAP },
  ];
  return candidates.find(({ left, top }) =>
    left >= MARGIN
    && top >= MARGIN
    && left + coach.width <= viewport.width - MARGIN
    && top + coach.height <= viewport.height - MARGIN
  ) ?? candidates[0];
}
```

- [ ] **Step 4: Wire measured placement into the coach**

In `OnboardingCoach.svelte`, bind both dimensions:

```svelte
bind:clientWidth={coachWidth}
bind:clientHeight={coachHeight}
```

Track viewport width and derive placement:

```ts
let coachWidth = 360;
let viewportWidth = 0;
$: coachPosition = targetRect
  ? placeOnboardingCoach(
      targetRect,
      { width: coachWidth, height: coachHeight },
      { width: viewportWidth, height: viewportHeight },
    )
  : null;

function updateRect() {
  viewportWidth = innerWidth;
  viewportHeight = innerHeight;
  targetRect = target?.getBoundingClientRect() ?? null;
}
```

Set explicit CSS variables:

```svelte
style={coachPosition
  ? `--coach-left:${coachPosition.left}px;--coach-top:${coachPosition.top}px`
  : undefined}
```

Replace target-relative coach positioning with:

```css
.coach {
  top: var(--coach-top);
  left: var(--coach-left);
}
```

Keep the existing fixed fallback when no target is mounted.

- [ ] **Step 5: Run geometry and onboarding checks**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/placement.check.ts src/lib/onboarding/state.check.ts
npm run typecheck
```

Expected: all checks pass and Svelte reports 0 errors and 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/onboarding/placement.ts src/lib/onboarding/placement.check.ts src/lib/onboarding/OnboardingCoach.svelte
git commit -m "fix: keep onboarding coach clear of targets"
```

---

### Task 4: Verify the complete product flow

**Files:**
- Modify only if verification exposes a defect in the files changed by Tasks 1–3.

**Interfaces:**
- Consumes: all completed tasks.
- Produces: a verified Electron onboarding flow and a clean worktree.

- [ ] **Step 1: Run the serialized full suite**

Run:

```bash
npm test -- --test-concurrency=1
```

Expected: 0 failures.

- [ ] **Step 2: Run typecheck and production build**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: Svelte reports 0 errors and 0 warnings; renderer and Electron builds succeed; `git diff --check` is silent.

- [ ] **Step 3: Reload the existing Electron CDP page and verify Credentials**

Use the existing CDP endpoint on the port reported by Electron. Reset only the local onboarding key to a version 2 active state, load Overview once, return to Automation, and inspect these states:

```text
Credentials closed → coach targets the Credentials opener.
Credentials open, no source selected → coach targets the first visible source row.
Source selected, required values missing → coach targets the first missing credential input.
Credential input completed → coach advances to the next missing input.
Required statement selection missing → coach targets the statement fieldset.
All requirements satisfied → coach targets Save.
```

At every state, record the target and coach rectangles and assert they do not intersect.

- [ ] **Step 4: Verify milestone simulations**

Use the focused state checks to confirm this exact order:

```text
configured source
→ fresh collection running
→ optional waiting_for_human / Assist
→ resumed collection completed
→ fresh import running
→ fresh import completed
→ refreshed Overview with at least one account
→ complete
```

Also confirm that an old completed crawler and old completed importer both remain blocked at their respective current milestone.

- [ ] **Step 5: Capture and inspect the corrected modal**

Capture the Credentials modal at the same viewport used for the reported screenshot. Compare the uploaded reference and corrected capture side by side. Verify:

```text
The coach is fully inside the window.
The coach does not cover Save, the bank list, credential inputs, or statement types.
The spotlight ring encloses only the current real control.
The primary coach label matches the current interaction.
```

- [ ] **Step 6: Commit verification-only fixes if needed**

If Tasks 1–3 required a correction during CDP verification, rerun Steps 1–5 and commit only those corrected files:

```bash
git add src/lib/onboarding src/lib/automation/AutomationDashboard.svelte src/lib/i18n/i18n.ts src/routes/+page.svelte
git commit -m "fix: finish guided onboarding verification"
```

If no correction was required, do not create an empty commit.
