# Data Issues Clickable Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, fully clickable in-app prototype for reporting an incorrect account value, tracing it to an import, previewing reversible quarantine, reviewing the result and audit record, and restoring the import.

**Architecture:** Keep the prototype entirely in renderer memory and clearly label it as non-destructive. A pure TypeScript state machine owns a fictional Example Bank loan scenario and all transitions; Svelte components render the report dialog and the data-issue workflow. Existing `DashboardShell`, account actions, cards, tables, buttons, modal CSS, and hash routing are reused, with no desktop API or ledger writes.

**Tech Stack:** Svelte 5 legacy component syntax, TypeScript 5.9, Svelte stores, Node built-in test runner, existing OctopusBeak CSS and i18n.

## Global Constraints

- Prototype only: no SQLite mutation, no CSV deletion, and no desktop IPC additions.
- No automatic anomaly detection, risk scoring, background scanning, or automatic import selection.
- Every destructive-looking action must display `Prototype — no ledger data will be changed`.
- Reuse existing UI primitives and installed dependencies; add no package.
- Preserve keyboard access, focus return, Escape handling, and live status announcements.
- Keep the previously approved workflow: report, diagnose, preview, quarantine result, audit, restore preview, restore result.
- Use anonymized sample import identifiers in committed source.

---

## File map

**Create**

- `src/lib/data-issues/prototype-model.ts` — types, seeded scenario, state transitions, action guards.
- `src/lib/data-issues/prototype-model.check.ts` — one runnable state-machine check covering safe, blocked, failure, and restore paths.
- `src/lib/data-issues/ReportDataIssueModal.svelte` — account-context report dialog.
- `src/lib/data-issues/DataIssuesPrototype.svelte` — list, diagnosis, preview, result, audit, and restore screens.

**Modify**

- `src/lib/shared-accounts/components/AccountTable.svelte` — optional report callback and action button.
- `src/lib/liabilities/LiabilitiesDashboard.svelte` — open the report dialog and create the in-memory case.
- `src/lib/shared-shell/components/DashboardShell.svelte` — add the `data-issues` active destination.
- `src/routes/+page.svelte` — recognize and render the `data-issues` route.
- `src/lib/i18n/i18n.ts` — English and Traditional Chinese prototype copy.

---

### Task 1: Pure prototype state machine

**Files:**
- Create: `src/lib/data-issues/prototype-model.ts`
- Create: `src/lib/data-issues/prototype-model.check.ts`

**Interfaces:**
- Produces: `DataIssuePrototypeState`, `DataIssueReportContext`, `seedDataIssuePrototype()`, `reportDataIssue()`, `transitionDataIssuePrototype()`, and `canConfirmQuarantine()`.
- Consumes: no UI or desktop API.

- [ ] **Step 1: Write the failing state-machine check**

Create `src/lib/data-issues/prototype-model.check.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  canConfirmQuarantine,
  seedDataIssuePrototype,
  transitionDataIssuePrototype,
} from "./prototype-model.ts";

test("data issue prototype completes quarantine, audit, and restore safely", () => {
  let state = seedDataIssuePrototype();
  state = transitionDataIssuePrototype(state, { type: "open-diagnosis" });
  state = transitionDataIssuePrototype(state, { type: "select-source", sourceId: "reported-import" });
  state = transitionDataIssuePrototype(state, { type: "preview", scenario: "safe" });
  assert.equal(state.screen, "preview");
  assert.equal(canConfirmQuarantine(state), false);

  state = transitionDataIssuePrototype(state, { type: "set-reason", reason: "Result from another account" });
  state = transitionDataIssuePrototype(state, { type: "acknowledge", acknowledged: true });
  assert.equal(canConfirmQuarantine(state), true);

  state = transitionDataIssuePrototype(state, { type: "start-quarantine" });
  assert.equal(state.screen, "working");
  state = transitionDataIssuePrototype(state, { type: "complete-quarantine" });
  assert.equal(state.screen, "success");
  assert.equal(state.issue.status, "resolved");
  assert.equal(state.currentValue, 63_900);

  state = transitionDataIssuePrototype(state, { type: "show-audit" });
  assert.equal(state.screen, "audit");
  state = transitionDataIssuePrototype(state, { type: "preview-restore" });
  state = transitionDataIssuePrototype(state, { type: "confirm-restore" });
  assert.equal(state.screen, "restored");
  assert.equal(state.issue.status, "restored");
  assert.equal(state.currentValue, 81_250);
});

test("blocked and failed scenarios never change the displayed value", () => {
  const diagnosis = transitionDataIssuePrototype(seedDataIssuePrototype(), { type: "open-diagnosis" });
  const selected = transitionDataIssuePrototype(diagnosis, { type: "select-source", sourceId: "reported-import" });
  const blocked = transitionDataIssuePrototype(selected, { type: "preview", scenario: "blocked" });
  assert.equal(blocked.screen, "blocked");
  assert.equal(canConfirmQuarantine(blocked), false);
  assert.equal(blocked.currentValue, 81_250);

  const failed = transitionDataIssuePrototype(selected, { type: "preview", scenario: "failure" });
  assert.equal(failed.screen, "failure");
  assert.equal(failed.currentValue, 81_250);
  assert.equal(failed.issue.status, "investigating");
});
```

- [ ] **Step 2: Run the check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/prototype-model.check.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `prototype-model.ts`.

- [ ] **Step 3: Implement the minimum pure model**

Create `src/lib/data-issues/prototype-model.ts` with these public types and transitions:

```ts
export type DataIssueStatus = "open" | "investigating" | "resolved" | "restored";
export type PrototypeScenario = "safe" | "blocked" | "failure";
export type PrototypeScreen =
  | "list"
  | "diagnosis"
  | "preview"
  | "blocked"
  | "failure"
  | "working"
  | "success"
  | "audit"
  | "restore-preview"
  | "restored";

export type DataIssueReportContext = {
  accountId: string;
  accountLabel: string;
  institution: string;
  fieldKey: "balance";
  displayedValue: number;
  currency: string;
  dataDate: string;
  note: string;
};

export type PrototypeImport = {
  id: string;
  fileName: string;
  importedAt: string;
  csvRows: number;
  insertedRows: number;
  duplicateRows: number;
  affectedAccounts: number;
};

export type PrototypePreview = {
  beforeValue: number;
  afterValue: number;
  activeRowsBefore: number;
  activeRowsAfter: number;
  excludedRows: number;
  retainedRows: number;
  unresolvedRows: number;
};

export type DataIssuePrototypeState = {
  screen: PrototypeScreen;
  issue: DataIssueReportContext & { id: string; status: DataIssueStatus; createdAt: string };
  imports: PrototypeImport[];
  selectedSourceId: string | null;
  scenario: PrototypeScenario;
  preview: PrototypePreview | null;
  reason: string;
  acknowledged: boolean;
  currentValue: number;
  audit: Array<{ action: "invalidated" | "restored"; reason: string; at: string }>;
};

export type PrototypeEvent =
  | { type: "open-diagnosis" }
  | { type: "select-source"; sourceId: string }
  | { type: "preview"; scenario: PrototypeScenario }
  | { type: "set-reason"; reason: string }
  | { type: "acknowledge"; acknowledged: boolean }
  | { type: "start-quarantine" }
  | { type: "complete-quarantine" }
  | { type: "show-audit" }
  | { type: "preview-restore" }
  | { type: "confirm-restore" }
  | { type: "back-to-diagnosis" }
  | { type: "back-to-list" };

const safePreview: PrototypePreview = {
  beforeValue: 81_250,
  afterValue: 63_900,
  activeRowsBefore: 14,
  activeRowsAfter: 12,
  excludedRows: 2,
  retainedRows: 10,
  unresolvedRows: 0,
};

export function seedDataIssuePrototype(): DataIssuePrototypeState {
  return {
    screen: "list",
    issue: {
      id: "issue-demo-1",
      status: "open",
      accountId: "loan-example-0420",
      accountLabel: "Example Bank loan ****0420",
      institution: "Example Bank",
      fieldKey: "balance",
      displayedValue: 81_250,
      currency: "TWD",
      dataDate: "2025-01-20",
      note: "Synthetic expected principal is 63,900",
      createdAt: "2025-01-21 11:30",
    },
    imports: [{
      id: "reported-import",
      fileName: "loan-statements-<reported-import>.csv",
      importedAt: "2025-01-21 02:46",
      csvRows: 12,
      insertedRows: 2,
      duplicateRows: 10,
      affectedAccounts: 2,
    }],
    selectedSourceId: null,
    scenario: "safe",
    preview: null,
    reason: "",
    acknowledged: false,
    currentValue: 81_250,
    audit: [],
  };
}

export function reportDataIssue(
  state: DataIssuePrototypeState,
  report: DataIssueReportContext,
): DataIssuePrototypeState {
  return {
    ...state,
    screen: "diagnosis",
    issue: { ...report, id: "issue-reported", status: "open", createdAt: "剛剛" },
    currentValue: report.displayedValue,
  };
}

export function canConfirmQuarantine(state: DataIssuePrototypeState) {
  return state.screen === "preview"
    && state.preview?.unresolvedRows === 0
    && state.reason.trim().length > 0
    && state.acknowledged;
}

export function transitionDataIssuePrototype(
  state: DataIssuePrototypeState,
  event: PrototypeEvent,
): DataIssuePrototypeState {
  if (event.type === "open-diagnosis") return { ...state, screen: "diagnosis", issue: { ...state.issue, status: "investigating" } };
  if (event.type === "select-source") return { ...state, selectedSourceId: event.sourceId };
  if (event.type === "preview") {
    if (!state.selectedSourceId) return state;
    if (event.scenario === "blocked") return { ...state, scenario: event.scenario, screen: "blocked", preview: { ...safePreview, unresolvedRows: 1 } };
    if (event.scenario === "failure") return { ...state, scenario: event.scenario, screen: "failure", preview: null };
    return { ...state, scenario: event.scenario, screen: "preview", preview: safePreview };
  }
  if (event.type === "set-reason") return { ...state, reason: event.reason };
  if (event.type === "acknowledge") return { ...state, acknowledged: event.acknowledged };
  if (event.type === "start-quarantine" && canConfirmQuarantine(state)) {
    return { ...state, screen: "working" };
  }
  if (event.type === "complete-quarantine" && state.screen === "working") {
    return {
      ...state,
      screen: "success",
      issue: { ...state.issue, status: "resolved" },
      currentValue: state.preview?.afterValue ?? state.currentValue,
      audit: [...state.audit, { action: "invalidated", reason: state.reason.trim(), at: "剛剛" }],
    };
  }
  if (event.type === "show-audit") return { ...state, screen: "audit" };
  if (event.type === "preview-restore") return { ...state, screen: "restore-preview" };
  if (event.type === "confirm-restore") {
    return {
      ...state,
      screen: "restored",
      issue: { ...state.issue, status: "restored" },
      currentValue: 81_250,
      audit: [...state.audit, { action: "restored", reason: "使用者還原 prototype 匯入", at: "剛剛" }],
    };
  }
  if (event.type === "back-to-diagnosis") {
    return { ...state, screen: "diagnosis", preview: null, reason: "", acknowledged: false };
  }
  if (event.type === "back-to-list") return { ...state, screen: "list" };
  return state;
}
```

- [ ] **Step 4: Run the focused check**

Run the command from Step 2.

Expected: 2 tests pass.

- [ ] **Step 5: Commit the model**

```bash
git add src/lib/data-issues/prototype-model.ts src/lib/data-issues/prototype-model.check.ts
git commit -m "feat: add data issue prototype state model"
```

---

### Task 2: Bilingual prototype copy contract

**Files:**
- Modify: `src/lib/i18n/i18n.ts`

**Interfaces:**
- Produces: `$t.dataIssues` with every label consumed by Tasks 3–5.
- Consumes: the existing English and Traditional Chinese dictionaries.

- [ ] **Step 1: Add the complete English dictionary**

Add this sibling to `accounts`, `liabilities`, and the other top-level dictionaries in `en`:

```ts
dataIssues: {
  eyebrow: "Data issues", title: "Reported data problems", sideLabel: "Case status",
  prototypeNotice: "Prototype — no ledger data will be changed",
  reportProblem: "Report data problem", account: "Account", field: "Field",
  currentValue: "Current value", reportedValue: "Reported value", dataDate: "Data date",
  note: "Note", createIssue: "Create issue", startDiagnosis: "Start diagnosis",
  valueTimeline: "Value timeline", reportedPoint: "Reported value",
  sources: "Sources for this value", viewRawData: "View original rows",
  inserted: "inserted", duplicates: "duplicates skipped",
  previewImpact: "Preview impact", prototypeScenario: "Prototype scenario",
  scenarioSafe: "Safe quarantine", scenarioBlocked: "Incomplete lineage",
  scenarioFailure: "Simulation failure", quarantineWorking: "Applying prototype quarantine…",
  quarantineComplete: "Prototype quarantine complete",
  reportedIssues: "Reported issues", open: "Open", investigating: "Investigating",
  resolved: "Resolved", restored: "Restored", before: "Current", after: "After quarantine",
  excludedRows: "Rows excluded", retainedRows: "Rows retained by another source",
  unresolvedRows: "Unresolved rows", reason: "Quarantine reason",
  acknowledgement: "I reviewed the impact above", confirmQuarantine: "Quarantine this import",
  blockedReason: "The source file or row lineage is incomplete. Quarantine is unavailable.",
  failureMessage: "Simulation failed. No ledger data was changed.", audit: "Audit history",
  restoreImport: "Restore this import", confirmRestore: "Confirm restore", back: "Back",
  backToAccount: "Back to account", viewAudit: "View audit history",
},
```

- [ ] **Step 2: Add the matching Traditional Chinese dictionary**

Add the same keys to `zhTW`:

```ts
dataIssues: {
  eyebrow: "資料問題", title: "使用者回報的資料問題", sideLabel: "案件狀態",
  prototypeNotice: "Prototype — 不會變更 ledger 資料", reportProblem: "回報資料問題",
  account: "帳戶", field: "問題欄位", currentValue: "目前顯示值", reportedValue: "回報值",
  dataDate: "資料日期", note: "補充說明", createIssue: "建立問題案件",
  startDiagnosis: "開始診斷", valueTimeline: "數值時間線", reportedPoint: "回報位置",
  sources: "產生目前數值的來源", viewRawData: "檢視原始資料列",
  inserted: "實際新增", duplicates: "重複略過",
  previewImpact: "選擇來源並預覽影響", prototypeScenario: "Prototype 情境",
  scenarioSafe: "可安全停用", scenarioBlocked: "來源關聯不完整",
  scenarioFailure: "模擬計算失敗", quarantineWorking: "正在套用 Prototype 停用…",
  quarantineComplete: "Prototype 停用完成",
  reportedIssues: "已回報問題", open: "待處理", investigating: "調查中",
  resolved: "已處理", restored: "已還原", before: "目前", after: "停用後",
  excludedRows: "實際排除", retainedRows: "由其他來源保留", unresolvedRows: "無法確認",
  reason: "停用原因", acknowledgement: "我已確認上述影響範圍",
  confirmQuarantine: "停用這次匯入",
  blockedReason: "來源檔案或資料列關聯不完整，無法停用。",
  failureMessage: "模擬計算失敗，未變更任何 ledger 資料。", audit: "操作紀錄",
  restoreImport: "還原此匯入", confirmRestore: "確認還原", back: "返回",
  backToAccount: "回到帳戶", viewAudit: "查看操作紀錄",
},
```

- [ ] **Step 3: Run typecheck and commit the copy contract**

```bash
npm run typecheck
git add src/lib/i18n/i18n.ts
git commit -m "feat: add data issue prototype copy"
```

Expected: typecheck succeeds before any component consumes the new keys.

---

### Task 3: Account-level report dialog

**Files:**
- Create: `src/lib/data-issues/ReportDataIssueModal.svelte`
- Modify: `src/lib/shared-accounts/components/AccountTable.svelte`
- Modify: `src/lib/liabilities/LiabilitiesDashboard.svelte`

**Interfaces:**
- Consumes: `DataIssueReportContext` from Task 1.
- Produces: `AccountTable.onReportDataIssue(account)` and an accessible report dialog that navigates to `#/data-issues` after submission.

- [ ] **Step 1: Add an optional account report callback**

In `AccountTable.svelte`, add:

```ts
export let onReportDataIssue: ((account: AccountRowDto) => void) | null = null;
```

After the History button, render the action only when supplied:

```svelte
{#if onReportDataIssue}
  <button class="button secondary" type="button" on:click={() => onReportDataIssue?.(selectedAccount)}>
    {$t.dataIssues.reportProblem}
  </button>
{/if}
```

- [ ] **Step 2: Create the accessible modal**

Create `ReportDataIssueModal.svelte` with props `open`, `account`, and `onSubmit`. Use the native modal `dialog`; Chromium provides focus trapping, Escape handling, and focus restoration to the trigger without custom keyboard code:

```svelte
<script lang="ts">
  import { tick } from "svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import type { AccountRowDto } from "$lib/shared-ledger/types.ts";
  import type { DataIssueReportContext } from "./prototype-model.ts";

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let onSubmit: (report: DataIssueReportContext) => void;

  let note = "";
  let dialog: HTMLDialogElement | null = null;
  $: primaryAmount = account?.amountLines[0] ?? { currency: "TWD", value: 0 };

  $: if (open) void tick().then(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  function close() {
    open = false;
    if (dialog?.open) dialog.close();
  }

  function submit() {
    if (!account) return;
    onSubmit({
      accountId: account.id,
      accountLabel: account.label,
      institution: account.institution,
      fieldKey: "balance",
      displayedValue: primaryAmount.value,
      currency: primaryAmount.currency,
      dataDate: account.lastUpdated ?? "--",
      note: note.trim(),
    });
    note = "";
    close();
  }
</script>

{#if account}
  <dialog bind:this={dialog} class="modal-panel report-modal" aria-labelledby="report-title" onclose={() => (open = false)} oncancel={() => (open = false)}>
      <div class="modal-head">
        <div><h2 id="report-title">{$t.dataIssues.reportProblem}</h2><p class="lead">{$t.dataIssues.prototypeNotice}</p></div>
        <button class="modal-close" type="button" aria-label={$t.common.close} onclick={close}>x</button>
      </div>
      <form class="modal-body report-form" onsubmit={(event) => { event.preventDefault(); submit(); }}>
        <dl class="report-context">
          <div><dt>{$t.dataIssues.account}</dt><dd>{account.label}</dd></div>
          <div><dt>{$t.dataIssues.field}</dt><dd>{$t.accounts.balance}</dd></div>
          <div><dt>{$t.dataIssues.currentValue}</dt><dd>{primaryAmount.value.toLocaleString()} {primaryAmount.currency}</dd></div>
          <div><dt>{$t.dataIssues.dataDate}</dt><dd>{account.lastUpdated ?? "--"}</dd></div>
        </dl>
        <label><span>{$t.dataIssues.note}</span><textarea bind:value={note} rows="3"></textarea></label>
        <div class="modal-footer"><button class="button secondary" type="button" onclick={close}>{$t.common.cancel}</button><button class="button" type="submit">{$t.dataIssues.createIssue}</button></div>
      </form>
  </dialog>
{/if}
```

Use existing modal classes; add only `.report-modal`, `.report-form`, `.report-context`, `.modal-footer`, and `.report-modal::backdrop` layout rules in the component.

- [ ] **Step 3: Connect the liabilities page**

In `LiabilitiesDashboard.svelte`, keep prototype state at module instance scope:

```ts
import ReportDataIssueModal from "$lib/data-issues/ReportDataIssueModal.svelte";
import type { DataIssueReportContext } from "$lib/data-issues/prototype-model.ts";

let reportOpen = false;
let reportAccount: AccountRowDto | null = null;

function openReport(account: AccountRowDto) {
  reportAccount = account;
  reportOpen = true;
}

function createReport(report: DataIssueReportContext) {
  sessionStorage.setItem("octopusbeak-data-issue-report", JSON.stringify(report));
  location.hash = "/data-issues";
}
```

Pass `onReportDataIssue={openReport}` to `AccountTable`, then render:

```svelte
<ReportDataIssueModal bind:open={reportOpen} account={reportAccount} onSubmit={createReport} />
```

Session storage is used only to hand the report context across the hash route; it is not ledger persistence.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: zero Svelte or TypeScript errors.

- [ ] **Step 5: Commit the report entry point**

```bash
git add src/lib/data-issues/ReportDataIssueModal.svelte src/lib/shared-accounts/components/AccountTable.svelte src/lib/liabilities/LiabilitiesDashboard.svelte
git commit -m "feat: add account data issue report prototype"
```

---

### Task 4: Complete clickable data-issue workflow

**Files:**
- Create: `src/lib/data-issues/DataIssuesPrototype.svelte`
- Modify: `src/lib/shared-shell/components/DashboardShell.svelte`

**Interfaces:**
- Consumes: Task 1 state and transition functions.
- Produces: a single page covering list, diagnosis, safe preview, blocked preview, failure, success, audit, restore preview, and restored states.

- [ ] **Step 1: Extend the shell active-route type**

In `DashboardShell.svelte`, extend the existing `active` union with `"data-issues"`. Do not add the sidebar item until Task 5, when the route exists.

- [ ] **Step 2: Build the page shell and report hydration**

Create `DataIssuesPrototype.svelte`. Initialize from the seeded case, then replace its report context when session storage contains an account report:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import {
    canConfirmQuarantine,
    reportDataIssue,
    seedDataIssuePrototype,
    transitionDataIssuePrototype,
    type DataIssueReportContext,
    type PrototypeEvent,
    type PrototypeScenario,
  } from "./prototype-model.ts";

  let state = seedDataIssuePrototype();
  let scenario: PrototypeScenario = "safe";
  let liveMessage = "";

  onMount(() => {
    const raw = sessionStorage.getItem("octopusbeak-data-issue-report");
    if (!raw) return;
    state = reportDataIssue(state, JSON.parse(raw) as DataIssueReportContext);
    sessionStorage.removeItem("octopusbeak-data-issue-report");
  });

  function send(event: PrototypeEvent, announcement = "") {
    state = transitionDataIssuePrototype(state, event);
    liveMessage = announcement;
  }

  async function confirmQuarantine() {
    send({ type: "start-quarantine" }, $t.dataIssues.quarantineWorking);
    await new Promise((resolve) => setTimeout(resolve, 650));
    send({ type: "complete-quarantine" }, $t.dataIssues.quarantineComplete);
  }

  $: selectedImport = state.imports.find((item) => item.id === state.selectedSourceId) ?? null;
  $: statusLabel = {
    open: $t.dataIssues.open,
    investigating: $t.dataIssues.investigating,
    resolved: $t.dataIssues.resolved,
    restored: $t.dataIssues.restored,
  }[state.issue.status];
</script>

<DashboardShell
  active="data-issues"
  eyebrow={$t.dataIssues.eyebrow}
  title={$t.dataIssues.title}
  sideLabel={$t.dataIssues.sideLabel}
  sideValue={statusLabel}
  sideSub={$t.dataIssues.prototypeNotice}
>
  <div class="content data-issues-content">
    <div class="prototype-banner" role="note">{$t.dataIssues.prototypeNotice}</div>
    <p class="sr-only" aria-live="polite">{liveMessage}</p>
    {#if state.screen === "list"}
      <section class="card">
        <div class="panel-title"><div><span class="chip">{statusLabel}</span><h2>{state.issue.accountLabel}</h2></div></div>
        <dl class="issue-facts">
          <div><dt>{$t.dataIssues.reportedValue}</dt><dd>{state.issue.displayedValue.toLocaleString()} {state.issue.currency}</dd></div>
          <div><dt>{$t.dataIssues.dataDate}</dt><dd>{state.issue.dataDate}</dd></div>
          <div><dt>{$t.dataIssues.note}</dt><dd>{state.issue.note || "--"}</dd></div>
        </dl>
        <div class="card-actions"><button class="button" onclick={() => send({ type: "open-diagnosis" })}>{$t.dataIssues.startDiagnosis}</button></div>
      </section>
    {/if}
  </div>
</DashboardShell>
```

- [ ] **Step 3: Add list and diagnosis screens**

Render `state.screen === "list"` as one issue card with status, account, field, value, timestamp, and `open-diagnosis` action.

Render `state.screen === "diagnosis"` with:

```svelte
<section class="card issue-summary">
  <div class="panel-title"><div><span class="chip">{statusLabel}</span><h2>{state.issue.accountLabel}</h2></div></div>
  <dl class="issue-facts">
    <div><dt>{$t.dataIssues.reportedValue}</dt><dd>{state.issue.displayedValue.toLocaleString()} {state.issue.currency}</dd></div>
    <div><dt>{$t.dataIssues.dataDate}</dt><dd>{state.issue.dataDate}</dd></div>
    <div><dt>{$t.dataIssues.note}</dt><dd>{state.issue.note || "--"}</dd></div>
  </dl>
</section>

<section class="card">
  <div class="panel-title"><h2>{$t.dataIssues.valueTimeline}</h2></div>
  <ol class="timeline">
    <li><time>2025/01/18</time><strong>63,900</strong></li>
    <li class="reported"><time>2025/01/20</time><strong>81,250</strong><span>{$t.dataIssues.reportedPoint}</span></li>
  </ol>
</section>

<section class="card">
  <div class="panel-title"><h2>{$t.dataIssues.sources}</h2></div>
  {#each state.imports as source}
    <label class="source-option">
      <input type="radio" name="source" value={source.id} checked={state.selectedSourceId === source.id} onchange={() => send({ type: "select-source", sourceId: source.id })} />
      <span><strong>{source.fileName}</strong><small>{source.csvRows} CSV / {source.insertedRows} {$t.dataIssues.inserted} / {source.duplicateRows} {$t.dataIssues.duplicates}</small></span>
    </label>
  {/each}
  <details class="source-raw">
    <summary>{$t.dataIssues.viewRawData}</summary>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>交易日</th><th>繳款項目</th><th class="right">交易金額</th><th class="right">交易後餘額</th></tr></thead>
        <tbody>
          <tr><td>2025/01/20</td><td>Principal</td><td class="right">4,275</td><td class="right">81,250</td></tr>
          <tr><td>2025/01/20</td><td>Interest</td><td class="right">390</td><td class="right">81,250</td></tr>
        </tbody>
      </table>
    </div>
  </details>
  <div class="prototype-scenario">
    <label>{$t.dataIssues.prototypeScenario}
      <select bind:value={scenario}>
        <option value="safe">{$t.dataIssues.scenarioSafe}</option>
        <option value="blocked">{$t.dataIssues.scenarioBlocked}</option>
        <option value="failure">{$t.dataIssues.scenarioFailure}</option>
      </select>
    </label>
  </div>
  <div class="card-actions"><button class="button" disabled={!selectedImport} onclick={() => send({ type: "preview", scenario })}>{$t.dataIssues.previewImpact}</button></div>
</section>
```

- [ ] **Step 4: Add safe, blocked, and failure previews**

For `preview`, render a comparison table using `state.preview`, a required reason textarea, acknowledgement checkbox, Back, and Confirm buttons. Confirm must use `disabled={!canConfirmQuarantine(state)}`.

For `blocked`, show `unresolvedRows`, `$t.dataIssues.blockedReason`, a Back button, and no override or confirm action.

For `failure`, show `$t.dataIssues.failureMessage`, the unchanged `currentValue`, and a Back button.

For `working`, show a spinner, `$t.dataIssues.quarantineWorking`, and no enabled navigation or confirmation action.

Use these exact handlers:

```svelte
oninput={(event) => send({ type: "set-reason", reason: (event.currentTarget as HTMLTextAreaElement).value })}
onchange={(event) => send({ type: "acknowledge", acknowledged: (event.currentTarget as HTMLInputElement).checked })}
onclick={confirmQuarantine}
```

- [ ] **Step 5: Add success, audit, restore, and restored screens**

Success shows the before/after values, excluded and retained counts, and buttons for account, audit, and restore preview.

Audit renders every `state.audit` entry in a table with action, reason, and time.

Restore preview reverses the comparison and requires a separate `confirm-restore` click.

Restored shows `81,250`, status `restored`, and an audit link. All states retain the prototype banner.

Use these exact navigation handlers:

```svelte
<button class="button secondary" onclick={() => (location.hash = "/liabilities")}>{$t.dataIssues.backToAccount}</button>
<button class="button secondary" onclick={() => send({ type: "show-audit" })}>{$t.dataIssues.viewAudit}</button>
<button class="button" onclick={() => send({ type: "preview-restore" })}>{$t.dataIssues.restoreImport}</button>
<button class="button" onclick={() => send({ type: "confirm-restore" }, $t.dataIssues.restored)}>{$t.dataIssues.confirmRestore}</button>
```

- [ ] **Step 6: Add component-local responsive styles**

Use CSS grid and existing tokens only:

```css
.data-issues-content { display: grid; gap: var(--space-5); }
.prototype-banner { padding: var(--space-3) var(--space-4); border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--surface-soft); }
.issue-facts, .preview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); padding: var(--space-5); }
.issue-facts div, .preview-cell { display: grid; gap: var(--space-1); }
.issue-facts dt, .preview-label, .source-option small { color: var(--muted); font-size: 12px; }
.issue-facts dd { margin: 0; font-weight: 700; }
.timeline { list-style: none; margin: 0; padding: var(--space-5); display: grid; gap: var(--space-3); }
.timeline li, .source-option { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--space-4); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.timeline .reported { border-color: var(--danger, #b42318); }
.source-option span { display: grid; gap: var(--space-1); }
.card-actions { display: flex; justify-content: flex-end; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
@media (max-width: 760px) { .issue-facts, .preview-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 7: Run focused checks and typecheck**

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/prototype-model.check.ts
npm run typecheck
```

Expected: 2 focused tests pass and typecheck reports zero errors.

- [ ] **Step 8: Commit the complete page flow**

```bash
git add src/lib/data-issues/DataIssuesPrototype.svelte src/lib/shared-shell/components/DashboardShell.svelte
git commit -m "feat: add clickable data issue quarantine prototype"
```

---

### Task 5: Route and navigation

**Files:**
- Modify: `src/lib/shared-shell/components/DashboardShell.svelte`
- Modify: `src/routes/+page.svelte`
- Modify: `src/lib/i18n/i18n.ts`

**Interfaces:**
- Consumes: `DataIssuesPrototype.svelte` from Task 4.
- Produces: `#/data-issues` navigation in both English and Traditional Chinese.

- [ ] **Step 1: Add the route**

In `src/routes/+page.svelte`:

```ts
import DataIssuesPrototype from "$lib/data-issues/DataIssuesPrototype.svelte";
type RouteId = "overview" | "assets" | "liabilities" | "spending" | "automation" | "data-issues" | "settings";
```

Add `data-issues` to `normalizeRoute()` and render:

```svelte
{:else if route === "data-issues"}
  <DataIssuesPrototype />
```

- [ ] **Step 2: Add the sidebar destination**

The `DashboardShell.active` union already includes `"data-issues"` from Task 4. Add a nav item between Automation and Settings:

```ts
{
  id: "data-issues",
  label: $t.nav.dataIssues,
  href: "#/data-issues",
  path: "M12 2 1 21h22L12 2Zm0 5.5 6.5 11H5.5L12 7.5ZM11 11v4h2v-4h-2Zm0 5.5v2h2v-2h-2Z",
},
```

- [ ] **Step 3: Add the navigation label and verify the copy contract**

Add `nav.dataIssues` (`"Data issues"` / `"資料問題"`). Confirm the Task 2 dictionaries still match these expected English values:

```ts
dataIssues: {
  eyebrow: "Data issues",
  title: "Reported data problems",
  sideLabel: "Case status",
  prototypeNotice: "Prototype — no ledger data will be changed",
  reportProblem: "Report data problem",
  account: "Account",
  field: "Field",
  currentValue: "Current value",
  reportedValue: "Reported value",
  dataDate: "Data date",
  note: "Note",
  createIssue: "Create issue",
  startDiagnosis: "Start diagnosis",
  valueTimeline: "Value timeline",
  reportedPoint: "Reported value",
  sources: "Sources for this value",
  viewRawData: "View original rows",
  inserted: "inserted",
  duplicates: "duplicates skipped",
  previewImpact: "Preview impact",
  prototypeScenario: "Prototype scenario",
  scenarioSafe: "Safe quarantine",
  scenarioBlocked: "Incomplete lineage",
  scenarioFailure: "Simulation failure",
  quarantineWorking: "Applying prototype quarantine…",
  quarantineComplete: "Prototype quarantine complete",
  reportedIssues: "Reported issues",
  open: "Open",
  investigating: "Investigating",
  resolved: "Resolved",
  restored: "Restored",
  before: "Current",
  after: "After quarantine",
  excludedRows: "Rows excluded",
  retainedRows: "Rows retained by another source",
  unresolvedRows: "Unresolved rows",
  reason: "Quarantine reason",
  acknowledgement: "I reviewed the impact above",
  confirmQuarantine: "Quarantine this import",
  blockedReason: "The source file or row lineage is incomplete. Quarantine is unavailable.",
  failureMessage: "Simulation failed. No ledger data was changed.",
  audit: "Audit history",
  restoreImport: "Restore this import",
  confirmRestore: "Confirm restore",
  back: "Back",
  backToAccount: "Back to account",
  viewAudit: "View audit history",
}
```

Traditional Chinese values:

```ts
dataIssues: {
  eyebrow: "資料問題",
  title: "使用者回報的資料問題",
  sideLabel: "案件狀態",
  prototypeNotice: "Prototype — 不會變更 ledger 資料",
  reportProblem: "回報資料問題",
  account: "帳戶",
  field: "問題欄位",
  currentValue: "目前顯示值",
  reportedValue: "回報值",
  dataDate: "資料日期",
  note: "補充說明",
  createIssue: "建立問題案件",
  startDiagnosis: "開始診斷",
  valueTimeline: "數值時間線",
  reportedPoint: "回報位置",
  sources: "產生目前數值的來源",
  viewRawData: "檢視原始資料列",
  inserted: "實際新增",
  duplicates: "重複略過",
  previewImpact: "選擇來源並預覽影響",
  prototypeScenario: "Prototype 情境",
  scenarioSafe: "可安全停用",
  scenarioBlocked: "來源關聯不完整",
  scenarioFailure: "模擬計算失敗",
  quarantineWorking: "正在套用 Prototype 停用…",
  quarantineComplete: "Prototype 停用完成",
  reportedIssues: "已回報問題",
  open: "待處理",
  investigating: "調查中",
  resolved: "已處理",
  restored: "已還原",
  before: "目前",
  after: "停用後",
  excludedRows: "實際排除",
  retainedRows: "由其他來源保留",
  unresolvedRows: "無法確認",
  reason: "停用原因",
  acknowledgement: "我已確認上述影響範圍",
  confirmQuarantine: "停用這次匯入",
  blockedReason: "來源檔案或資料列關聯不完整，無法停用。",
  failureMessage: "模擬計算失敗，未變更任何 ledger 資料。",
  audit: "操作紀錄",
  restoreImport: "還原此匯入",
  confirmRestore: "確認還原",
  back: "返回",
  backToAccount: "回到帳戶",
  viewAudit: "查看操作紀錄",
}
```

Keep all remaining page-only labels in the same dictionaries rather than hard-coding English; the only fixed sample data may remain Traditional Chinese because it represents the reported source record.

- [ ] **Step 4: Run typecheck and full tests**

```bash
npm run typecheck
npm test
```

Expected: typecheck succeeds and all existing plus 2 new tests pass.

- [ ] **Step 5: Commit routing and copy**

```bash
git add src/lib/shared-shell/components/DashboardShell.svelte src/routes/+page.svelte src/lib/i18n/i18n.ts
git commit -m "feat: expose data issue prototype in app navigation"
```

---

### Task 6: Visual and interaction verification

**Files:**
- Modify only files from Tasks 3–5 if verification finds a concrete defect.

**Interfaces:**
- Consumes: complete renderer prototype.
- Produces: verified screenshots and an operable Electron flow; no new production interface.

- [ ] **Step 1: Build the application**

```bash
npm run build
```

Expected: renderer and Electron builds succeed.

- [ ] **Step 2: Launch one Electron debug session**

Use the `electron-cdp-debugging` skill. Start the app with its remote-debugging port, keep the returned terminal session alive, and connect through `/json/list` without launching a second competing Electron process.

- [ ] **Step 3: Verify the primary flow visually**

At desktop width, complete:

```text
Liabilities → select loan account → Report data problem → Create issue
→ select reported import → safe preview → enter reason → acknowledge
→ quarantine success → audit → restore preview → restored
```

Expected:

- Prototype notice remains visible on every data-issue screen.
- No real account value changes after returning to Liabilities.
- Focus moves into the report dialog and returns after Escape.
- Confirm remains disabled until reason and acknowledgement are present.
- Success shows 63,900 and restored shows 81,250.

- [ ] **Step 4: Verify blocked and failure flows**

From diagnosis, choose `Incomplete lineage`, then `Simulation failure`.

Expected:

- Blocked flow exposes no override button.
- Failure flow states that no ledger data changed.
- Both flows preserve 81,250 and allow returning to diagnosis.

- [ ] **Step 5: Verify narrow layout and keyboard flow**

Set the Electron viewport to approximately `900 × 700`; traverse all interactive controls with Tab, activate with Enter/Space, close the report dialog with Escape, and inspect the accessibility tree for dialog title and live status text.

Expected: no clipped primary action, no horizontal page overflow, and every action has an accessible name.

- [ ] **Step 6: Run final verification**

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: all commands pass. Confirm `git status --short` lists only intentional prototype changes plus pre-existing workflow changes.

- [ ] **Step 7: Commit verification fixes, if any**

If verification required code changes, stage only those exact files and commit:

```bash
git commit -m "fix: polish data issue prototype interactions"
```

If no code changed, do not create an empty commit.

---

## Deferred production plan

After the user validates the prototype, write a separate implementation plan for:

- `source_row_occurrences` migration and historical backfill
- active-row query boundary across all ledger products
- derived snapshot and aggregate refresh contracts
- `data_issues` and `import_quarantine_actions` persistence
- desktop IPC and preview-token validation
- transactional quarantine and restore

These are intentionally excluded from this prototype so the approved interaction can be evaluated without touching real ledger data.
