# Data Issue History and Timezone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Localize data-issue timestamps to the configured system timezone, turn the account title into a tooltip-backed deep link, and move operation history into an accessible header-triggered modal.

**Architecture:** Keep the change inside the existing data-issue dashboard and reuse the existing timezone store, formatter, Lucide dependency, native dialog pattern, and account deep link. The API and stored UTC values remain unchanged; only presentation and interaction markup change.

**Tech Stack:** Svelte 5 legacy syntax, TypeScript 5.9, Svelte stores, native `<dialog>`, `@lucide/svelte`, Node built-in test runner, Electron/CDP verification.

## Global Constraints

- Keep original UTC strings unchanged in storage and API responses.
- Use `formatUtcDateTime(value, $systemTimezone, $locale)` for source-import and operation-event timestamps.
- Make the account title the return link; remove the separate `Back to account` button.
- Show link and icon explanations on mouse hover and keyboard focus.
- The operation-history modal must receive focus, close by button, Escape, or backdrop, and restore focus to its trigger.
- Remove the inline operation-history disclosure.
- Add no route, dependency, shared modal abstraction, database change, DTO change, IPC change, filtering, export, or pagination.
- Reuse the current account deep link, event summaries, technical details, empty state, design tokens, and modal styling.

---

## File map

**Modify**

- `src/lib/data-issues/data-issues-ui.check.ts` — regression contract for timezone formatting, header actions, modal semantics, and focus restoration.
- `src/lib/data-issues/DataIssuesDashboard.svelte` — presentation-only timestamp formatting, account-title link, history trigger, and native history dialog.
- `src/lib/i18n/i18n.ts` — localized tooltip copy for the account deep link.

**Create**

- `docs/superpowers/qa/2026-07-21-data-issue-history-timezone-design-qa.md` — Electron interaction and same-viewport visual QA record.

**Reuse unchanged**

- `src/lib/time/timezone.ts` — `formatUtcDateTime(value, timeZone, locale)`.
- `src/lib/settings/system-timezone-store.ts` — `systemTimezone` store.
- `src/lib/data-issues/types.ts` and desktop APIs — UTC timestamps and event data.

---

### Task 1: Implement the presentation and modal contract with TDD

**Files:**
- Modify: `src/lib/data-issues/data-issues-ui.check.ts`
- Modify: `src/lib/data-issues/DataIssuesDashboard.svelte`
- Modify: `src/lib/i18n/i18n.ts`

**Interfaces:**
- Consumes: `formatUtcDateTime`, `systemTimezone`, `locale`, `accountReturnHref(account)`, `issue.events`, and `eventSummary(event)`.
- Produces: `openHistory()`, `closeHistory()`, `cancelHistory(event)`, `historyClosed()`, localized timestamps, account-title deep link, and the history dialog.

- [ ] **Step 1: Write the failing presentation check**

In the first test in `src/lib/data-issues/data-issues-ui.check.ts`, replace:

```ts
assert.match(dashboard, /<summary>\{\$t\.dataIssues\.operationHistory\}<\/summary>/);
```

with:

```ts
assert.match(dashboard, /formatUtcDateTime\(source\.importedAt, \$systemTimezone, \$locale\)/);
assert.match(dashboard, /formatUtcDateTime\(event\.createdAt, \$systemTimezone, \$locale\)/);
assert.match(dashboard, /class="account-return-link"[\s\S]*href=\{accountReturnHref\(issue\.account\)\}/);
assert.match(dashboard, /aria-describedby="account-return-tooltip"/);
assert.match(dashboard, /id="account-return-tooltip"[\s\S]*\{\$t\.dataIssues\.backToAccountHint\}/);
assert.doesNotMatch(dashboard, /class="button secondary" href=\{accountReturnHref\(issue\.account\)\}/);
assert.match(dashboard, /bind:this=\{historyTrigger\}[\s\S]*aria-label=\{\$t\.dataIssues\.operationHistory\}/);
assert.match(dashboard, /<dialog[\s\S]*bind:this=\{historyDialog\}[\s\S]*aria-labelledby="operation-history-title"/);
assert.match(dashboard, /oncancel=\{cancelHistory\}/);
assert.match(dashboard, /historyTrigger\?\.focus\(\)/);
assert.doesNotMatch(dashboard, /<details class="operation-history">/);
assert.match(i18n, /backToAccountHint: "Open this account page"/);
assert.match(i18n, /backToAccountHint: "回到此帳戶頁面"/);
```

Keep the existing assertions for `eventSummary(event)`, technical details, account deep links, and account screen focus.

- [ ] **Step 2: Run the focused check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/data-issues-ui.check.ts
```

Expected: FAIL because the dashboard still renders raw timestamps, a separate account button, and inline operation history.

- [ ] **Step 3: Import only existing helpers and icons**

Update the dashboard imports:

```svelte
<script lang="ts">
  import { AlertTriangle, Check, ChevronRight, History, X } from "@lucide/svelte";
  import { onMount, tick } from "svelte";
  import { slide } from "svelte/transition";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import { formatUtcDateTime } from "$lib/time/timezone.ts";
```

Do not add a local formatter, modal component, or dependency.

- [ ] **Step 4: Add minimal dialog state and focus lifecycle**

Add beside the existing component state:

```ts
let historyOpen = false;
let historyDialog: HTMLDialogElement | null = null;
let historyTrigger: HTMLButtonElement | null = null;

function openHistory() {
  historyOpen = true;
  void tick().then(() => {
    if (historyDialog && !historyDialog.open) historyDialog.showModal();
  });
}

function closeHistory() {
  if (historyDialog?.open) historyDialog.close();
  else historyOpen = false;
}

function cancelHistory(event: Event) {
  event.preventDefault();
  closeHistory();
}

function closeHistoryFromBackdrop(event: MouseEvent) {
  if (event.target === historyDialog) closeHistory();
}

function historyClosed() {
  historyOpen = false;
  void tick().then(() => historyTrigger?.focus());
}
```

Add `historyOpen = false;` to `resetWorkflow()` so a case change cannot retain an open dialog.

- [ ] **Step 5: Add the account-link tooltip translations**

Add beside `backToAccount` in both locale objects:

```ts
backToAccountHint: "Open this account page",
```

```ts
backToAccountHint: "回到此帳戶頁面",
```

- [ ] **Step 6: Replace the panel header with the linked account title and history trigger**

Replace the current panel title block with:

```svelte
<div class="panel-title">
  <div class="account-title-row">
    <h2>
      <a
        class="account-return-link"
        href={accountReturnHref(issue.account)}
        aria-describedby="account-return-tooltip"
      >
        {issue.account.label}
        <span id="account-return-tooltip" class="header-tooltip" role="tooltip">{$t.dataIssues.backToAccountHint}</span>
      </a>
    </h2>
    <span class="header-action">
      <button
        bind:this={historyTrigger}
        class="history-trigger"
        type="button"
        aria-label={$t.dataIssues.operationHistory}
        aria-describedby="operation-history-tooltip"
        onclick={openHistory}
      ><History size={18} aria-hidden="true" /></button>
      <span id="operation-history-tooltip" class="header-tooltip" role="tooltip">{$t.dataIssues.operationHistory}</span>
    </span>
  </div>
  <div class="panel-actions">
    <button class="button secondary" type="button" onclick={() => (location.hash = "/data-issues")}>{$t.dataIssues.back}</button>
  </div>
</div>
```

This removes only the separate account button; the existing page-level `Back` button remains.

- [ ] **Step 7: Format source-import timestamps**

Replace the raw source timestamp with:

```svelte
<small>{$t.dataIssues.importedAt} {formatUtcDateTime(source.importedAt, $systemTimezone, $locale)} · {source.affectedAccounts} {$t.dataIssues.affectedAccounts}</small>
```

- [ ] **Step 8: Replace inline operation history with the native dialog**

Delete the entire `<details class="operation-history">…</details>` block. Before the workflow card closes, render:

```svelte
{#if historyOpen}
  <dialog
    bind:this={historyDialog}
    class="modal-panel operation-history-modal"
    aria-labelledby="operation-history-title"
    onclose={historyClosed}
    oncancel={cancelHistory}
    onclick={closeHistoryFromBackdrop}
  >
    <div class="modal-head">
      <h2 id="operation-history-title">{$t.dataIssues.operationHistory}</h2>
      <button class="modal-close" type="button" aria-label={$t.common.close} onclick={closeHistory}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
    <div class="modal-body event-list">
      {#each issue.events as event}
        <article>
          <strong>{eventSummary(event)}</strong>
          <span>{formatUtcDateTime(event.createdAt, $systemTimezone, $locale)}</span>
          {#if Object.keys(event.details).length}
            <details><summary>{$t.dataIssues.technicalDetails}</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>
          {/if}
        </article>
      {:else}
        <p class="empty-state">{$t.dataIssues.noOperations}</p>
      {/each}
    </div>
  </dialog>
{/if}
```

Native `showModal()` supplies modal semantics and initial focus to the close button; do not add a custom focus-trap library.

- [ ] **Step 9: Replace inline-history CSS with header tooltip and modal CSS**

Delete `.operation-history` rules. Add:

```css
.account-title-row { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.account-title-row h2 { margin: 0; min-width: 0; }
.account-return-link, .header-action { position: relative; }
.account-return-link { color: inherit; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; }
.account-return-link:hover, .account-return-link:focus-visible { text-decoration-color: currentColor; }
.history-trigger { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; }
.history-trigger:hover, .history-trigger:focus-visible { background: var(--surface-soft); color: var(--fg); }
.header-tooltip { position: absolute; top: calc(100% + 7px); left: 50%; z-index: 8; width: max-content; max-width: min(220px, 80vw); padding: 7px 9px; border-radius: var(--radius-sm); background: color-mix(in oklch, var(--fg) 94%, transparent); color: white; font-size: 11px; font-weight: 600; opacity: 0; pointer-events: none; transform: translate(-50%, -3px); transition: opacity 120ms ease, transform 120ms ease; }
.account-return-link:hover .header-tooltip,
.account-return-link:focus-visible .header-tooltip,
.header-action:hover .header-tooltip,
.header-action:focus-within .header-tooltip { opacity: 1; transform: translate(-50%, 0); }
.operation-history-modal { width: min(720px, calc(100vw - 40px)); max-height: min(760px, calc(100vh - 40px)); padding: 0; }
.operation-history-modal::backdrop { background: rgba(14, 18, 28, 0.44); backdrop-filter: blur(10px) saturate(0.84); }
.operation-history-modal .event-list { max-height: min(640px, calc(100vh - 140px)); overflow: auto; }
.event-list { display: grid; }
.event-list article { display: grid; gap: var(--space-1); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
.event-list span { color: var(--muted); font-size: 12px; }
```

Extend the existing reduced-motion rule with `.header-tooltip { transition: none; }`. Keep the existing `pre` overflow rule and global `.modal-head`, `.modal-close`, and `.modal-body` styles.

- [ ] **Step 10: Run focused and static checks and verify GREEN**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/data-issues/data-issues-ui.check.ts
npm run typecheck
npm run build
```

Expected: the focused tests pass; typecheck and build exit 0 without Svelte accessibility or TypeScript errors.

- [ ] **Step 11: Commit the working slice**

```bash
git add src/lib/data-issues/data-issues-ui.check.ts src/lib/data-issues/DataIssuesDashboard.svelte src/lib/i18n/i18n.ts
git commit -m "feat: improve data issue history access"
```

---

### Task 2: Verify Electron interaction and visual fidelity

**Files:**
- Modify if needed: `src/lib/data-issues/DataIssuesDashboard.svelte`
- Modify if needed: `src/lib/data-issues/data-issues-ui.check.ts`
- Create: `docs/superpowers/qa/2026-07-21-data-issue-history-timezone-design-qa.md`

**Interfaces:**
- Consumes: built Electron app, isolated synthetic ledger fixture, and the four user-provided reference screenshots.
- Produces: verified mouse, keyboard, focus, timezone, modal, and layout behavior without touching the production ledger.

- [ ] **Step 1: Start the isolated desktop fixture**

Run:

```bash
npm run desktop:dev:mock
```

Expected: Electron launches with `OCTOPUSBEAK_USER_DATA` pointing at `data/mock-desktop`, never the user production data directory.

- [ ] **Step 2: Verify the source-selection screen with Electron/CDP**

At the reference viewport and an investigating synthetic issue, verify:

```text
- source import times show the configured system timezone and no trailing Z;
- account title is visibly link-like on hover/focus;
- account tooltip appears on hover and focus;
- activating the account title returns to the correct focused account;
- separate Back button still returns to the data-issue list.
```

Expected: all checks pass and no raw ISO timestamp is visible.

- [ ] **Step 3: Verify history modal focus and close paths**

Using Electron/CDP keyboard and mouse input, verify:

```text
- history icon tooltip appears on hover and focus;
- icon activation opens the modal;
- focus lands inside the modal;
- event times show the configured system timezone;
- technical details still expand;
- close button, Escape, and backdrop each close the modal;
- after every close path, focus returns to the history icon;
- operation history is absent from the bottom of the workflow card.
```

Expected: all checks pass without scrolling the page to an inline history section.

- [ ] **Step 4: Compare reference and implementation at the same viewport**

Capture the source-selection and history-modal states. Place each implementation capture beside the corresponding user reference and inspect title alignment, icon placement, tooltip position, modal width, padding, borders, typography, overflow, and focus ring.

Expected: no broken layout, clipped tooltip, cropped modal content, or unexpected spacing. If a mismatch exists, make the smallest CSS correction and repeat Steps 2–4.

- [ ] **Step 5: Record passed design QA**

Create `docs/superpowers/qa/2026-07-21-data-issue-history-timezone-design-qa.md` only after every item passes:

```markdown
# Data Issue History and Timezone Design QA

Status: Passed

- System-timezone source timestamps: Passed
- System-timezone operation timestamps: Passed
- Account title link and tooltip: Passed
- History icon tooltip: Passed
- Modal focus entry and restoration: Passed
- Escape, close button, and backdrop: Passed
- Same-viewport visual comparison: Passed
- Production ledger untouched: Confirmed
```

- [ ] **Step 6: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: tests, typecheck, build, and diff check exit 0; status contains only the intended QA document or approved final corrections.

- [ ] **Step 7: Commit verified QA and any final correction**

```bash
git add docs/superpowers/qa/2026-07-21-data-issue-history-timezone-design-qa.md src/lib/data-issues/DataIssuesDashboard.svelte src/lib/data-issues/data-issues-ui.check.ts
git commit -m "test: verify data issue history interactions"
```
