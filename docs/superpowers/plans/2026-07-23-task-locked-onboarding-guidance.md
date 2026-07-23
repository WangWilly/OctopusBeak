# Task-locked Onboarding Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make onboarding advance only after the user performs the required credential, collection, human-verification, import, and Overview actions.

**Architecture:** Keep the existing milestone resolver and product surfaces. Tighten the Credentials sub-state to require fresh interaction, make coach copy follow the current target action, and move Assist targeting into the open viewer modal. Reuse existing automation and viewer APIs; add no new routes, IPC, dependencies, or tour framework.

**Tech Stack:** Svelte, TypeScript, Node test runner, Electron CDP, existing translation dictionary and automation APIs.

## Global Constraints

- Reuse the existing Credentials modal, interactive Assist screenshot, automation runner, importer, and Overview.
- A saved placeholder is not fresh credential input during onboarding.
- The selected bank alone starts after onboarding Save; other collection sources remain disabled for the first run.
- Opening Assist must remove onboarding targeting from controls behind the modal.
- Collection and import milestones advance only from refreshed task state and existing freshness timestamps.
- Preserve keyboard access, Escape pause, reduced motion, and local-only credential storage.
- Add no dependency, route, Electron IPC, database table, or general-purpose tour abstraction.

---

### Task 1: Require real Credentials interactions

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Modify: `src/lib/onboarding/state.check.ts`

**Interfaces:**
- Consumes: `selectedCredentialGroup.credentialKeys`, `credentialDrafts`, and `statementSelectionDrafts`.
- Produces: `onboardingMissingCredentialKey: string | null`, `onboardingStatementsConfirmed: boolean`, and `onboardingCredentialsReady: boolean`.
- Preserves: `onOnboardingSourceSaved(groupId: string, sourceConfiguredAt: string): void`.

- [ ] **Step 1: Write failing source checks**

Add source-level checks proving saved values do not satisfy onboarding and statement selection requires a current-session interaction:

```ts
assert.match(automationDashboard, /selectedCredentialGroup\.credentialKeys\.find\([\s\S]*?!credentialDrafts\[key\]\?\.trim\(\)/);
assert.doesNotMatch(automationDashboard, /!automation\.credentials\[key\]\s*&&\s*!credentialDrafts/);
assert.match(automationDashboard, /statementSelectionConfirmed/);
assert.match(automationDashboard, /toggleStatementType[\s\S]*?statementSelectionConfirmed\s*=/);
assert.match(automationDashboard, /selectAllStatementTypes[\s\S]*?statementSelectionConfirmed\s*=/);
```

- [ ] **Step 2: Run the focused check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts
```

Expected: FAIL because saved credentials currently bypass field entry and existing statement selections bypass confirmation.

- [ ] **Step 3: Implement the minimum current-session gates**

In `AutomationDashboard.svelte`, track one confirmation flag and reset it whenever the modal opens or the selected source changes:

```ts
let statementSelectionConfirmed = false;

$: onboardingMissingCredentialKey = onboardingSourceSelection && selectedCredentialGroup
  ? selectedCredentialGroup.credentialKeys.find(
      (key) => !credentialDrafts[key]?.trim(),
    ) ?? null
  : null;
$: onboardingNeedsStatements = Boolean(
  onboardingSourceSelection
  && selectedCredentialGroup?.statementTypes?.length
  && (
    !(statementSelectionDrafts[selectedCredentialGroup.id]?.length)
    || !statementSelectionConfirmed
  ),
);
```

Set `statementSelectionConfirmed = true` in `toggleStatementType` and `selectAllStatementTypes`. Set it to `false` in `resetCredentialChanges` and `selectCredentialGroup`.

Keep the existing dynamic marker sequence:

```text
select-source → each enter-credentials input → select-statements → save-credentials
```

The Save marker appears only when all fresh drafts are non-empty and statement selection has been confirmed.

- [ ] **Step 4: Run the focused check and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts
npm run typecheck
```

Expected: all onboarding checks pass; Svelte reports 0 errors and 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/automation/AutomationDashboard.svelte src/lib/onboarding/state.check.ts
git commit -m "fix: require real onboarding credential input"
```

---

### Task 2: Match coach copy to the current action and start collection

**Files:**
- Modify: `src/lib/onboarding/OnboardingCoach.svelte`
- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Modify: `src/lib/onboarding/state.check.ts`

**Interfaces:**
- Consumes: `target?.dataset.onboardingAction`.
- Produces: action-specific `{ title, body, primaryLabel }` for `select-source`, `enter-credentials`, `select-statements`, and `save-credentials`.
- Consumes: `window.octopusBeak.automation.run(taskId)` after a successful onboarding credential save.

- [ ] **Step 1: Write failing copy and start checks**

Add checks that title and body use the target action, not only `onboardingCopyKey(step)`, and that successful onboarding Save starts the selected crawler:

```ts
assert.match(onboardingCoach, /coachCopy\(\$t,\s*key,\s*target\?\.dataset\.onboardingAction\)/);
assert.match(automationDashboard, /savedGroupId[\s\S]*?automation\.tasks\.find/);
assert.match(automationDashboard, /automation\.run\(selectedTask\.id\)/);
```

- [ ] **Step 2: Run checks and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts src/lib/i18n/i18n.check.ts
```

Expected: FAIL because only the primary button label is action-specific and Save does not start collection.

- [ ] **Step 3: Add action-specific copy without a new copy system**

Extend the existing `coachCopy` switch for the Credentials step:

```ts
function coachCopy(
  dictionary: Translation,
  copyKey: OnboardingCopyKey,
  targetAction?: string,
) {
  if (copyKey === "credentials") {
    if (targetAction === "select-source") return dictionary.onboarding.chooseSourceCopy;
    if (targetAction === "enter-credentials") return dictionary.onboarding.enterCredentialsCopy;
    if (targetAction === "select-statements") return dictionary.onboarding.selectStatementsCopy;
    if (targetAction === "save-credentials") return dictionary.onboarding.saveCredentialsCopy;
  }
  return copies[copyKey];
}
```

Add exact Traditional Chinese copy:

```ts
chooseSourceCopy: { title: "選擇第一間銀行", body: "選擇一間要完成首次匯入的銀行；完成後仍可加入其他來源。" },
enterCredentialsCopy: { title: "輸入登入資訊", body: "請在目前反白的欄位輸入資料。本次必須重新輸入，不會以已儲存的值略過。" },
selectStatementsCopy: { title: "確認匯入範圍", body: "選擇這次要抓取的帳戶資料，再繼續儲存。" },
saveCredentialsCopy: { title: "儲存並開始匯入", body: "儲存後會立即執行這間銀行的首次資料收集。" },
```

Add equivalent concise English copy so the translation type remains complete.

- [ ] **Step 4: Start only the selected crawler after Save**

After `saveCredentials`, `reload`, and `onOnboardingSourceSaved` succeed:

```ts
const selectedTask = automation.tasks.find(
  (task) =>
    task.kind === "crawler"
    && task.credentialGroupId === savedGroupId,
);
if (selectedTask?.canRun) {
  await window.octopusBeak.automation.run(selectedTask.id);
  await reload();
}
```

Keep the Credentials modal open and show the existing error if save fails. If start fails after save, close the modal, retain the selected source milestone, and surface the existing `actionError`; the resolver remains on collection and permits retry.

- [ ] **Step 5: Run checks and typecheck**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts src/lib/i18n/i18n.check.ts
npm run typecheck
```

Expected: all checks pass; Svelte reports 0 errors and 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/onboarding/OnboardingCoach.svelte src/lib/automation/AutomationDashboard.svelte src/lib/i18n/i18n.ts src/lib/onboarding/state.check.ts
git commit -m "fix: make onboarding guidance action specific"
```

---

### Task 3: Guide the real Assist interaction

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Modify: `src/lib/onboarding/OnboardingCoach.svelte`
- Modify: `src/lib/i18n/i18n.ts`
- Modify: `src/lib/onboarding/state.check.ts`

**Interfaces:**
- Produces Assist target actions: `open-assist`, `choose-verification-control`, `enter-verification`, and `resume-collection`.
- Consumes existing `floatingInput`, `submitFloatingInput`, `handleViewerPointerUp`, and `resumeHumanViewer`.
- Produces local `assistInteracted: boolean`; it is not persisted and does not advance the milestone.

- [ ] **Step 1: Write failing Assist target checks**

Add checks for marker ownership:

```ts
assert.match(automationDashboard, /class="viewer-frame"[\s\S]*?data-onboarding-action="choose-verification-control"/);
assert.match(automationDashboard, /class="viewer-floating-input"[\s\S]*?data-onboarding-action="enter-verification"/);
assert.match(automationDashboard, /resumeHumanViewer[\s\S]*?data-onboarding-action="resume-collection"/);
assert.match(automationDashboard, /humanTask[\s\S]*?assistInteracted/);
assert.match(onboardingCoach, /step === "assist"[\s\S]*?targetAction/);
```

- [ ] **Step 2: Run focused checks and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts src/lib/i18n/i18n.check.ts
```

Expected: FAIL because Assist currently keeps targeting the covered background task icon.

- [ ] **Step 3: Move the target into the open modal**

Track Assist interaction locally:

```ts
let assistInteracted = false;
```

Reset it in `openHumanViewer` and `closeHumanViewer`. Mark it true after a successful viewer click or text submission.

Assign exactly one `data-onboarding="automation-assist"` marker:

```svelte
<!-- Assist trigger, only while the modal is closed -->
data-onboarding={onboardingStep === "assist" && !humanTask ? "automation-assist" : undefined}
data-onboarding-action="open-assist"
```

```svelte
<!-- Interactive screenshot -->
data-onboarding={onboardingStep === "assist" && humanTask && !floatingInput && !assistInteracted
  ? "automation-assist"
  : undefined}
data-onboarding-action="choose-verification-control"
```

```svelte
<!-- Floating input -->
data-onboarding={onboardingStep === "assist" && floatingInput
  ? "automation-assist"
  : undefined}
data-onboarding-action="enter-verification"
```

```svelte
<!-- Resume -->
data-onboarding={onboardingStep === "assist" && humanTask && assistInteracted && !floatingInput
  ? "automation-assist"
  : undefined}
data-onboarding-action="resume-collection"
```

Update `targetForOnboardingStep` to return `[data-onboarding="automation-assist"]` for Assist. This prevents the observer from matching a covered background control.

- [ ] **Step 4: Use compact Assist-specific instructions**

For Assist actions, use these Traditional Chinese labels:

```ts
openAssistCopy: { title: "完成銀行驗證", body: "開啟操作畫面，完成 CAPTCHA、OTP 或銀行要求的驗證。" },
chooseVerificationCopy: { title: "點選驗證欄位", body: "直接點選銀行畫面中的驗證碼或 OTP 輸入欄位。" },
enterVerificationCopy: { title: "輸入驗證碼", body: "輸入畫面或手機收到的驗證碼，按送出套用到銀行頁面。" },
resumeCollectionCopy: { title: "確認驗證完成", body: "銀行頁面完成驗證後，繼續資料收集。" },
resumeCollection: "已完成驗證，繼續收集",
```

Do not render the full-screen spotlight scrim when `step === "assist"` and the target is inside `.human-viewer-modal`. Keep the compact coach outside the target and modal actions.

- [ ] **Step 5: Verify state remains authoritative**

Keep `resumeHumanViewer` unchanged in principle:

```ts
await window.octopusBeak.automation.resume(task.id);
await reload();
```

The onboarding resolver must remain on `assist`, `collection`, or `collection-failed` until refreshed task state proves the collection completed or produced an importable partial result. Do not persist `assistInteracted`.

- [ ] **Step 6: Run checks, typecheck, and build**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/onboarding/state.check.ts src/lib/i18n/i18n.check.ts
npm run typecheck
npm run build
git diff --check
```

Expected: all checks pass; typecheck has 0 errors and 0 warnings; renderer and Electron builds succeed; `git diff --check` is silent.

- [ ] **Step 7: Commit**

```bash
git add src/lib/automation/AutomationDashboard.svelte src/lib/onboarding/OnboardingCoach.svelte src/lib/onboarding/state.ts src/lib/i18n/i18n.ts src/lib/onboarding/state.check.ts
git commit -m "fix: guide real assist interactions"
```

---

### Task 4: Verify the complete Electron flow

**Files:**
- Modify only files from Tasks 1–3 if verification exposes a defect.

**Interfaces:**
- Consumes all completed tasks.
- Produces a verified task-locked onboarding flow.

- [ ] **Step 1: Run the serialized suite**

Run:

```bash
npm test -- --test-concurrency=1
npm run typecheck
npm run build
git diff --check
```

Expected: 0 test failures, 0 type errors, successful builds, and no whitespace errors.

- [ ] **Step 2: Verify Credentials with Electron CDP**

At the same viewport as the reported screenshot, preserve and later restore the exact onboarding localStorage value. Verify:

```text
source row
→ every fresh credential input
→ explicit statement confirmation
→ Save with “儲存並開始匯入”
→ selected collection task running
```

At each state, assert one target exists, its title/body/action match, the coach stays within the viewport, and the coach does not intersect the target.

- [ ] **Step 3: Verify Assist target handoff**

Use a controlled `waiting_for_human` fixture or existing waiting task and verify:

```text
Assist trigger
→ viewer screenshot
→ floating verification input
→ “已完成驗證，繼續收集”
→ refreshed collection state
```

Assert the target rectangle is always inside the open Assist modal after it opens. Compare the corrected capture against all three user-provided screenshots and confirm no coach covers the interactive area.

- [ ] **Step 4: Verify downstream gates**

Confirm this order using refreshed product state:

```text
fresh collection completed/importable partial
→ fresh import completed
→ Overview contains a visible account
→ onboarding complete
```

Early Resume, failed collection, failed import, or empty Overview must not advance.

- [ ] **Step 5: Commit only verification fixes**

If verification exposes a defect, rerun Steps 1–4 and commit the corrected files:

```bash
git add src/lib/onboarding src/lib/automation/AutomationDashboard.svelte src/lib/i18n/i18n.ts
git commit -m "fix: finish task-locked onboarding verification"
```

If no correction is required, do not create an empty commit.
